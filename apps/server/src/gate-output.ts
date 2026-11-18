import { DropResultSchema, type GateResult, redact } from '@jumpmaster/protocol';
import type { Db } from './db/open.js';
import type { Drop } from './db/repo.js';
import { serverScrubSet } from './forge/scrub-set.js';
import { fence, neutralise } from './payloads.js';

/** ANSI CSI sequences (8-bit or `ESC [`) and OSC sequences ended by BEL or `ESC \`. */
const ANSI = new RegExp(
  [
    // OSC: hyperlinks and window titles.
    '(?:\\u001b\\]|\\u009d)[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
    // CSI: colours, cursor moves, erasures.
    '(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]',
    // Any other two-character escape (`ESC c`, `ESC =`).
    '\\u001b[@-Z\\\\-_]',
  ].join('|'),
  'g',
);

/** Removes ANSI CSI and OSC escape sequences (colour codes, cursor moves, hyperlinks). */
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** The most of a failing gate's output a later attempt sees: its end, where the summary is. */
export const MAX_PREVIOUS_FAILURE_CHARS = 3000;

/** Longest error line a later attempt sees. */
const MAX_LINE_CHARS = 500;

/** How the item's last implement attempt failed. */
export type LastFailure =
  | { kind: 'gate'; dropId: string; gate: string; exit: string; tail: string }
  | { kind: 'error'; dropId: string; line: string }
  | { kind: 'lost'; dropId: string };

/** The same rule as `isRed` in results.ts. */
const isRed = (g: GateResult): boolean => g.timedOut || g.exitCode !== 0;

const exitOf = (g: GateResult): string =>
  g.timedOut ? 'timed out' : g.exitCode === null ? 'no exit code' : `exit ${g.exitCode}`;

/**
 * How the newest implement drop of the item created at or before `drop` (not `drop` itself)
 * failed. Undefined when there is none, or when it did not fail or get lost: a succeeded,
 * interrupted or cancelled attempt carries nothing. A result that does not parse reads as lost.
 */
export function lastFailure(
  db: Db,
  itemId: number,
  drop: Pick<Drop, 'id' | 'createdAt'>,
): LastFailure | undefined {
  const row = db
    .prepare(
      `SELECT id, state, result_json AS resultJson FROM drops
       WHERE work_item_id = ? AND role = 'implement' AND id <> ? AND created_at <= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId, drop.id, drop.createdAt) as
    | { id: string; state: string; resultJson: string | null }
    | undefined;
  if (!row || (row.state !== 'failed' && row.state !== 'lost')) return undefined;
  const dropId = row.id;
  if (row.state === 'lost' || row.resultJson === null) return { kind: 'lost', dropId };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.resultJson);
  } catch {
    return { kind: 'lost', dropId };
  }
  const result = DropResultSchema.safeParse(parsed);
  if (!result.success) return { kind: 'lost', dropId };
  const red = result.data.gates.find(isRed);
  if (red) {
    const tail = stripAnsi(red.outputTail).slice(-MAX_PREVIOUS_FAILURE_CHARS);
    return { kind: 'gate', dropId, gate: red.name, exit: exitOf(red), tail };
  }
  const first = (result.data.reason ?? result.data.status).split(/\r?\n/)[0] ?? '';
  return { kind: 'error', dropId, line: first.slice(0, MAX_LINE_CHARS) };
}

const bodyOf = (f: LastFailure): string => {
  switch (f.kind) {
    case 'gate':
      return `The previous attempt on this issue failed the ${f.gate} gate (${f.exit}). The end of its output:\n\n${f.tail}`;
    case 'error':
      return `The previous attempt on this issue failed: ${f.line}`;
    case 'lost':
      return 'The previous attempt on this issue was lost before it reported a result.';
  }
};

/**
 * The `Previous attempt` section of an implement prompt: redacted (the given secrets and token
 * shapes) before it is neutralised, so a joiner `neutralise` inserts cannot split a secret, then
 * fenced as untrusted data.
 */
export function renderLastFailure(f: LastFailure, dropId: string, secrets: string[]): string {
  const body = neutralise(redact(bodyOf(f), secrets));
  return `## Previous attempt (data, untrusted)\n\n${fence(dropId, 'previous-attempt', body)}`;
}

/** A vitest failure line: ` FAIL  <file> > <describe> > <test>`. */
const FAIL_LINE = /^\s*FAIL\s+(\S+)\s+>\s+(.+?)\s*$/;
/** An error line after it: `AssertionError: <message>`. */
const ERROR_LINE = /^\s*([A-Za-z]*Error):\s*(.+)$/;
/** Longest test name, assertion message and output line a gate-failure why quotes. */
const MAX_TEST_NAME = 200;
const MAX_MESSAGE = 300;
const MAX_TAIL_LINE = 200;
/** How many of the output's last non-empty lines the fallback form quotes. */
const TAIL_LINES = 10;

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * A failing gate in plain words, for a parked briefing's why: from its stripped output tail, the
 * first vitest `FAIL <file> > <test>` line and the first error line after it, with how many other
 * distinct tests failed. Output that does not parse (another tool, a FAIL line outside the tail)
 * and a gate that timed out give the gate, its exit and the output's last 10 non-empty lines.
 * Redacted (the server's scrub set and token shapes) on top of the trooper's own redaction.
 */
export function gateFailureWhy(gate: GateResult): string {
  const lines = stripAnsi(gate.outputTail)
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, ''));
  return redact(
    (gate.timedOut ? undefined : vitestWhy(gate.name, lines)) ?? fallbackWhy(gate, lines),
    [...serverScrubSet.values()],
  );
}

function vitestWhy(name: string, lines: string[]): string | undefined {
  const at = lines.findIndex((l) => FAIL_LINE.test(l));
  const fail = at === -1 ? null : FAIL_LINE.exec(lines[at] ?? '');
  if (!fail) return undefined;
  const [, file = '', test = ''] = fail;
  let why = `The ${name} gate failed: \`${file}\` > ${cut(test, MAX_TEST_NAME)}`;
  const error = lines
    .slice(at + 1)
    .map((l) => ERROR_LINE.exec(l))
    .find((m) => m !== null);
  if (error) why += ` (${error[1]}: ${cut((error[2] ?? '').trim(), MAX_MESSAGE)})`;
  // vitest repeats a test's FAIL line (its summary section): count each test once.
  const failing = new Set(
    lines.flatMap((l) => {
      const m = FAIL_LINE.exec(l);
      return m ? [`${m[1]} > ${m[2]}`] : [];
    }),
  );
  const more = failing.size - 1;
  if (more > 0) why += ` and ${more} more failing test${more === 1 ? '' : 's'}`;
  return why;
}

function fallbackWhy(gate: GateResult, lines: string[]): string {
  const how = gate.timedOut ? 'timed out' : `failed (${exitOf(gate)})`;
  const last = lines.filter((l) => l.trim() !== '').slice(-TAIL_LINES);
  if (last.length === 0) return `The ${gate.name} gate ${how} with no output.`;
  const quoted = last.map((l) => cut(l, MAX_TAIL_LINE));
  return [`The ${gate.name} gate ${how}. Its output ended with:`, '', ...quoted].join('\n');
}
