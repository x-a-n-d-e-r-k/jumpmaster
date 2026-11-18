import { protectedPathMatches } from '@jumpmaster/protocol';
import { type Briefing, type BriefingSource, briefingContext, getBriefing } from '../briefings.js';
import type { Config, DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  type Drop,
  getPullRequest,
  getWorkItem,
  getZoneMode,
  latestVerdict,
  listWorkItems,
} from '../db/repo.js';
import { getGoals, zoneObjective } from '../goals.js';
import { type Fence, fencer, PREAMBLE, type Trust } from '../mcp/kit.js';
import { redactionList } from '../scrub.js';
import type { FocusKind } from './store.js';

/**
 * Focused threads (#336 slice 4, #103): a thread opened from a zone, its goals or a briefing. Its
 * first turn is given the object's context. Everything the forge or an agent wrote goes inside a
 * `jm-data` fence, labelled `(data)` or `(data, untrusted)`, redacted and neutralised.
 */

/** What a thread is about: `ref` is the briefing id, or the zone id for `zone` and `goals`. */
export type Focus = { kind: FocusKind; zoneId: string; ref: string };

/** How many of the briefing item's latest drops the context lists. */
export const FOCUS_DROPS = 5;
/** The longest thread title, as the thread route allows. */
const MAX_TITLE = 200;

const zoneOf = (config: Config, id: string): DropZoneConfig | undefined =>
  config.dropZones.find((z) => z.id === id);

const briefingOf = (db: Db, f: Focus): Briefing | undefined => {
  if (!/^[1-9]\d{0,15}$/.test(f.ref)) return undefined;
  const b = getBriefing(db, Number(f.ref));
  return b && b.zoneId === f.zoneId ? b : undefined;
};

/** Whether the focus names a zone of the install, and for a briefing, one of that zone's. */
export function focusKnown(db: Db, config: Config, f: Focus): boolean {
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
  if (f.kind === 'zone') return clip(`Zone ${f.zoneId}`);
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
  if (!zone) lines = [`(trusted) The zone this thread was opened from no longer exists.`];
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
