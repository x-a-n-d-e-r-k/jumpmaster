import { DropResultSchema, type GateResult, redact } from '@jumpmaster/protocol';
import type { Db } from './db/open.js';
import type { Drop } from './db/repo.js';
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
