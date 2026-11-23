import { type GateResult, GateResultSchema, protectedPathMatches } from '@jumpmaster/protocol';
import { type Briefing, type BriefingSource, briefingContext, getBriefing } from '../briefings.js';
import type { Config, DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  type Drop,
  getDrop,
  getPullRequest,
  getWorkItem,
  getZoneMode,
  latestVerdict,
  listWorkItems,
} from '../db/repo.js';
import type { DoctorCheck } from '../doctor/checks.js';
import { latestDoctorRun } from '../doctor/run.js';
import { stripAnsi } from '../gate-output.js';
import { getGoals, zoneObjective } from '../goals.js';
import { type Fence, fencer, PREAMBLE, type Trust } from '../mcp/kit.js';
import { redactionList } from '../scrub.js';
import type { FocusKind } from './store.js';

/**
 * Focused threads (#336 slice 4, #103, #627): a thread opened from a zone, its goals, a briefing,
 * a drop or a doctor finding. Its
 * first turn is given the object's context. Everything the forge or an agent wrote goes inside a
 * `jm-data` fence, labelled `(data)` or `(data, untrusted)`, redacted and neutralised.
 */

/**
 * What a thread is about: `ref` is the briefing id, the drop id (`zoneId` its zone), the doctor
 * check id (`zoneId` its zone, or {@link INSTALL_ZONE} for an install-wide check), or the zone id
 * for `zone` and `goals`.
 */
export type Focus = { kind: FocusKind; zoneId: string; ref: string };

/** A doctor focus's `zoneId` for a check of the whole install, not of one zone. */
export const INSTALL_ZONE = 'install';

/** How many of the briefing item's latest drops the context lists. */
export const FOCUS_DROPS = 5;
/** How many lines of the end of a failing gate's output a drop focus carries. */
export const FOCUS_GATE_LINES = 40;
/** The longest thread title, as the thread route allows. */
const MAX_TITLE = 200;

const zoneOf = (config: Config, id: string): DropZoneConfig | undefined =>
  config.dropZones.find((z) => z.id === id);

const briefingOf = (db: Db, f: Focus): Briefing | undefined => {
  if (!/^[1-9]\d{0,15}$/.test(f.ref)) return undefined;
  const b = getBriefing(db, Number(f.ref));
  return b && b.zoneId === f.zoneId ? b : undefined;
};

const dropOf = (db: Db, f: Focus): Drop | undefined => {
  const d = getDrop(db, f.ref);
  return d && d.dropZoneId === f.zoneId ? d : undefined;
};

/** The check of the doctor's latest finished run the focus names, and that run. */
function checkOf(
  db: Db,
  f: Focus,
): { check: DoctorCheck; run: { id: number; finishedAt: string | null } } | undefined {
  const run = latestDoctorRun(db);
  const check = run?.checks.find((c) => c.id === f.ref && (c.zoneId ?? INSTALL_ZONE) === f.zoneId);
  return run && check ? { check, run } : undefined;
}

/**
 * Whether the focus names something that exists: a drop of that zone, a check of the doctor's
 * latest run, or a zone of the install, and for a briefing, one of that zone's.
 */
export function focusKnown(db: Db, config: Config, f: Focus): boolean {
  if (f.kind === 'drop') return dropOf(db, f) !== undefined;
  if (f.kind === 'doctor') return checkOf(db, f) !== undefined;
  if (!zoneOf(config, f.zoneId)) return false;
  if (f.kind === 'briefing') return briefingOf(db, f) !== undefined;
  return f.ref === f.zoneId;
}

const clip = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_TITLE ? flat : `${flat.slice(0, MAX_TITLE - 1)}…`;
};

/** The thread's title: the object it is about, e.g. `Briefing 12: <decision>`. */
export function focusTitle(db: Db, config: Config, f: Focus): string {
  if (f.kind === 'drop') {
    const d = dropOf(db, f);
    return clip(`Drop ${f.ref.slice(0, 8)}${d ? ` (${d.role}, ${d.state})` : ''}`);
  }
  if (f.kind === 'doctor') return clip(`Doctor: ${f.ref}`);
  if (f.kind === 'zone') return clip(`Project ${f.zoneId}`);
  if (f.kind === 'goals') return clip(`Goals of ${f.zoneId}`);
  const b = briefingOf(db, f);
  return clip(b ? `Briefing ${b.id}: ${b.decision}` : `Briefing ${f.ref}`);
}

/** Briefing text the server built is data; text the crew or assistant wrote is untrusted. */
const briefingTrust = (source: BriefingSource): Trust =>
  source === 'server' ? 'data' : 'untrusted';

/** A drop's result status and reason, as the drop reported them (agent-written). */
function dropResult(d: Drop): { status?: string; reason?: string } {
  if (!d.resultJson) return {};
  try {
    const r = JSON.parse(d.resultJson) as { status?: unknown; reason?: unknown };
    return {
      ...(typeof r.status === 'string' ? { status: r.status } : {}),
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    };
  } catch {
    return {};
  }
}

function itemDrops(db: Db, itemId: number): Drop[] {
  return db
    .prepare(
      `SELECT id, role, state, result_json AS resultJson FROM drops WHERE work_item_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(itemId, FOCUS_DROPS) as Drop[];
}

function briefingLines(
  db: Db,
  zone: DropZoneConfig,
  b: Briefing,
  fx: Fence,
  extraRefs: Record<string, string[]>,
): string[] {
  const t = briefingTrust(b.source);
  const about = briefingContext(db, [zone], [b]).about.get(b.id);
  const lines = [
    `(trusted) The owner opened this thread from briefing ${b.id} in zone ${zone.id} (kind ${b.kind}, ${b.state}, raised by ${b.source === 'mcp' ? 'assistant' : b.source}).`,
    `decision ${fx(t, 'decision', b.decision)}`,
    `why ${fx(t, 'why', b.why)}`,
    `options ${fx(t, 'options', b.options.map((o) => `${o.id}: ${o.label}`).join('\n'))}`,
  ];
  if (b.recommendation) lines.push(`recommendation ${fx(t, 'recommendation', b.recommendation)}`);
  if (b.diagnosis) lines.push(`diagnosis ${fx('untrusted', 'diagnosis', b.diagnosis)}`);
  if (about) lines.push(`about ${fx('data', 'about', about.text)}`);

  const itemId = /^item:(\d+)$/.exec(b.subject)?.[1];
  const item = itemId === undefined ? undefined : getWorkItem(db, Number(itemId));
  if (!item || item.dropZoneId !== zone.id) return lines;
  lines.push(
    '',
    `Work item #${item.issueNumber} state=${item.state}`,
    `title ${fx('data', 'title', item.title)}`,
    `body ${fx('data', 'body', item.body)}`,
  );
  if (item.reason) lines.push(`reason ${fx('untrusted', 'reason', item.reason)}`);

  lines.push('', `Latest drops (newest first, at most ${FOCUS_DROPS}):`);
  const drops = itemDrops(db, item.id);
  if (drops.length === 0) lines.push('- none');
  for (const d of drops) {
    const r = dropResult(d);
    lines.push(`- drop ${d.id} role=${d.role} state=${d.state} status=${r.status ?? 'none'}`);
    if (r.reason) lines.push(`  reason ${fx('untrusted', 'drop-reason', r.reason)}`);
  }

  const v = latestVerdict(db, item.id);
  lines.push('');
  if (v) {
    lines.push(
      `Latest verdict: ${v.decision}${v.forced ? ' (forced)' : ''} on ${v.headSha}`,
      `summary ${fx('untrusted', 'verdict', v.summary)}`,
    );
  } else lines.push('Latest verdict: none');

  const pr = getPullRequest(db, item.id);
  if (pr) {
    lines.push(
      `Pull request #${pr.number} (${pr.state}) head ${pr.headSha}. Its head is fetched as refs/pull/${pr.number}/head in the zone's clone.`,
    );
    extraRefs[zone.id] = [`pull/${pr.number}/head`];
  } else lines.push('Pull request: none');
  return lines;
}

function goalsLines(db: Db, zone: DropZoneConfig, fx: Fence): string[] {
  const head = `(trusted) The owner opened this thread from the goals of zone ${zone.id}.`;
  const row = getGoals(db, zone.id);
  if (!row) return [head, 'The goal file has not been read yet.'];
  if (!row.parse.ok)
    return [head, `The goal file does not parse: ${fx('data', 'error', row.parse.error)}`];
  // Trusted only while the goal file is a protected path no drop can change.
  const trust: Trust = zone.protectedPaths.some((g) => protectedPathMatches(zone.crew.goalPath, g))
    ? 'trusted'
    : 'untrusted';
  const current = zoneObjective(db, zone.id);
  return [
    head,
    `Lighthouse: ${fx(trust, 'lighthouse', row.parse.lighthouse)}`,
    'Objectives (key: title):',
    ...row.parse.objectives.map(
      (o) => `- [${o.done ? 'x' : ' '}] ${o.key}: ${fx(trust, 'objective', o.title)}`,
    ),
    `Current objective: ${current ? current.key : 'none (all done)'}`,
  ];
}

function zoneLines(db: Db, zone: DropZoneConfig, fx: Fence): string[] {
  const counts = new Map<string, number>();
  for (const w of listWorkItems(db, zone.id)) counts.set(w.state, (counts.get(w.state) ?? 0) + 1);
  const open = db
    .prepare(`SELECT COUNT(*) AS n FROM briefings WHERE zone_id = ? AND state = 'open'`)
    .get(zone.id) as { n: number };
  const objective = zoneObjective(db, zone.id);
  return [
    `(trusted) The owner opened this thread from zone ${zone.id} (repository ${zone.repo}).`,
    `Mode: ${getZoneMode(db, zone.id, zone.mode)}`,
    `Work items by state: ${['ready', 'in_flight', 'pr_open', 'parked', 'done']
      .map((s) => `${s}=${counts.get(s) ?? 0}`)
      .join(' ')}`,
    `Open briefings: ${open.n}`,
    objective
      ? `Current objective: ${objective.key}: ${fx('data', 'objective', objective.title)}`
      : 'Current objective: none',
  ];
}

/** A drop's reported gate results; none when its result is missing or does not parse. */
function dropGates(d: Drop): GateResult[] {
  if (!d.resultJson) return [];
  try {
    const r = JSON.parse(d.resultJson) as { gates?: unknown };
    if (!Array.isArray(r.gates)) return [];
    return r.gates.flatMap((g) => {
      const p = GateResultSchema.safeParse(g);
      return p.success ? [p.data] : [];
    });
  } catch {
    return [];
  }
}

const isRed = (g: GateResult): boolean => g.timedOut || g.exitCode !== 0;

const exitOf = (g: GateResult): string =>
  g.timedOut ? 'timed out' : g.exitCode === null ? 'no exit code' : `exit ${g.exitCode}`;

/** The last `n` lines of a gate's output, its escape sequences removed. */
export const lastLines = (text: string, n: number): string =>
  stripAnsi(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').slice(-n).join('\n');

function dropLines(db: Db, d: Drop, fx: Fence): string[] {
  const r = dropResult(d);
  const lines = [
    `(trusted) The owner opened this thread from drop ${d.id} in zone ${d.dropZoneId}.`,
    `Role: ${d.role}`,
    `State: ${d.state}`,
    `Result status: ${r.status ?? 'none'}`,
    `Stick: ${d.stickId ?? 'none'}`,
    `Created: ${d.createdAt}`,
    `Started: ${d.startedAt ?? 'not yet'}`,
    `Finished: ${d.finishedAt ?? 'not yet'}`,
  ];
  if (d.startedAt && d.finishedAt) {
    const ms = Date.parse(d.finishedAt) - Date.parse(d.startedAt);
    if (Number.isFinite(ms)) lines.push(`Elapsed: ${Math.round(ms / 1000)} s`);
  }
  const item = d.workItemId === null ? undefined : getWorkItem(db, d.workItemId);
  if (item) lines.push(`Issue #${item.issueNumber}`, `title ${fx('data', 'title', item.title)}`);
  else lines.push(`Issue: none (${d.role === 'doctor' ? 'a doctor drop' : 'a crew drop'})`);
  lines.push(
    d.prNumber === null ? 'Pull request: none' : `Pull request #${d.prNumber}`,
    `Head: ${d.headSha ?? 'none'}`,
  );
  if (r.reason) lines.push(`reason ${fx('untrusted', 'drop-reason', r.reason)}`);

  const gates = dropGates(d);
  if (gates.length === 0) {
    lines.push('Gates: none reported');
    return lines;
  }
  lines.push(
    `gates (name, exit, duration) ${fx(
      'untrusted',
      'gates',
      gates.map((g) => `${g.name}: ${exitOf(g)}, ${g.durationMs} ms`).join('\n'),
    )}`,
  );
  for (const g of gates.filter(isRed)) {
    lines.push(
      '',
      `The last ${FOCUS_GATE_LINES} lines of failing gate ${fx('untrusted', 'gate-name', g.name)}`,
      `output ${fx('untrusted', 'gate-output', lastLines(g.outputTail, FOCUS_GATE_LINES))}`,
    );
  }
  return lines;
}

const DOCTOR_STATUSES = new Set(['pass', 'warn', 'fail', 'skip', 'info']);

function doctorLines(
  check: DoctorCheck,
  run: { id: number; finishedAt: string | null },
  fx: Fence,
): string[] {
  const where = check.zoneId === null ? 'the whole install' : `zone ${check.zoneId}`;
  const lines = [
    `(trusted) The owner opened this thread from doctor check ${check.id} (${where}) of doctor run ${run.id}, finished ${run.finishedAt ?? 'unknown'}.`,
    `Status: ${DOCTOR_STATUSES.has(check.status) ? check.status : 'unknown'}`,
    `finding ${fx('untrusted', 'finding', check.summary)}`,
  ];
  if (check.fix) lines.push(`fix ${fx('untrusted', 'fix', check.fix)}`);
  const a = check.action;
  if (a) lines.push(`action ${fx('untrusted', 'action', `${a.label} (${a.kind}): ${a.href}`)}`);
  if (check.doc) lines.push(`doc ${fx('untrusted', 'doc', check.doc)}`);
  if (!check.fix && !a && !check.doc) lines.push('Fix actions: none');
  return lines;
}

/**
 * The focused object's context for the thread's first turn, fenced with `nonce`, and the refs the
 * chat service fetches beside each zone's default branch (a briefing's PR head).
 */
export function focusContext(
  db: Db,
  config: Config,
  f: Focus,
  nonce: string,
): { text: string; extraRefs: Record<string, string[]> } {
  const extraRefs: Record<string, string[]> = {};
  const zone = zoneOf(config, f.zoneId);
  const fx = fencer(redactionList(config.secrets), nonce);
  let lines: string[];
  if (f.kind === 'drop') {
    const d = dropOf(db, f);
    lines = d
      ? dropLines(db, d, fx)
      : ['(trusted) The drop this thread was opened from no longer exists.'];
  } else if (f.kind === 'doctor') {
    const c = checkOf(db, f);
    lines = c
      ? doctorLines(c.check, c.run, fx)
      : ['(trusted) The doctor check this thread was opened from is not in the latest doctor run.'];
  } else if (!zone) lines = [`(trusted) The zone this thread was opened from no longer exists.`];
  else if (f.kind === 'zone') lines = zoneLines(db, zone, fx);
  else if (f.kind === 'goals') lines = goalsLines(db, zone, fx);
  else {
    const b = briefingOf(db, f);
    lines = b
      ? briefingLines(db, zone, b, fx, extraRefs)
      : [`(trusted) Briefing ${f.ref}, which this thread was opened from, no longer exists.`];
  }
  return { text: [PREAMBLE, '', ...lines].join('\n'), extraRefs };
}
