import { type Briefing, isNotice } from '../briefings.js';
import type { Pending } from '../config/confirm.js';
import { ACTIVE_DROP_STATES, type WorkItem } from '../db/repo.js';
import { STICK_LIVE_MS } from '../doctor/checks.js';
import { ACTIVITY_DROPS_HREF, ACTIVITY_WORK_HREF, projectHref, SYSTEM_HREF } from './links.js';
import type { HomeState, StickLine } from './pages.js';
import { relativeTime } from './time.js';
import { type ZoneRef, zoneName, zoneNamer } from './zone-name.js';

/**
 * Home (#625, was the floor of #120): Needs you, then a row per project with its state sentence.
 * Every project number comes from `floorCounts`, a pure function of the home state.
 */

const esc = (v: unknown): string =>
  String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export type CardState = 'needs-you' | 'blocked' | 'working' | 'held' | 'idle';

/** The Working counts. `merged24h` is null when the merges could not be read: unknown, not 0. */
export interface WorkingCounts {
  running: number;
  queued: number;
  prOpen: number;
  merged24h: number | null;
}

export interface ZoneCounts extends WorkingCounts {
  parked: number;
  /** Outbox ops `unknown` or `failed` for the zone. */
  outbox: number;
  /** Live sticks exist and none of them can run this zone. */
  noStick: boolean;
  /** Open briefings listed under "Waiting on you" (0 for a held zone). */
  needsYou: number;
  /** Open briefings held back because the zone is paused or observing. */
  held: number;
}

export interface ZoneFloor {
  zoneId: string;
  mode: string;
  counts: ZoneCounts;
  /** The zone is paused or observing: its briefings are held, not needs-you. */
  held: boolean;
  state: CardState;
}

/**
 * A guarded change this session staged and has not confirmed (#507), and the chat thread whose
 * pending card links to it, if one does. Its row reads `change.guarded` only, never its patch.
 */
export interface PendingLine {
  change: Pending;
  chat?: { threadId: number; title: string };
}

export interface FloorCounts {
  /** `pending`: this session's pending guarded changes, a part of `needsYou` (#507). */
  totals: WorkingCounts & { parked: number; needsYou: number; pending: number };
  zones: ZoneFloor[];
}

/** The parts of the home state a zone card counts: what the floor and a project's Overview read. */
export type FloorInputs = Pick<
  HomeState,
  | 'zones'
  | 'modes'
  | 'items'
  | 'drops'
  | 'merges24h'
  | 'outbox'
  | 'briefings'
  | 'heldBriefings'
  | 'sticks'
>;

const HELD_MODES: ReadonlySet<string> = new Set(['paused', 'observe']);
const DAY_MS = 24 * 3_600_000;
const STATE_RANK: Record<CardState, number> = {
  'needs-you': 0,
  blocked: 1,
  working: 2,
  held: 3,
  idle: 4,
};

/** Live drops: active and started (a pending push still holds its slot). */
export const isRunning = (state: string): boolean =>
  state !== 'queued' && (ACTIVE_DROP_STATES as readonly string[]).includes(state);

export const liveSticks = (sticks: readonly StickLine[], now: Date): StickLine[] =>
  sticks.filter(
    (s) => s.lastSeenAt !== null && now.getTime() - Date.parse(s.lastSeenAt) <= STICK_LIVE_MS,
  );

/**
 * The card's state. A paused or observing zone starts nothing, so its ready work reads `held`,
 * not `working`; a drop still running there finishes, so that zone stays `working` (#495).
 */
function cardState(c: ZoneCounts, held: boolean): CardState {
  if (c.needsYou > 0) return 'needs-you';
  if (c.parked > 0 || c.outbox > 0 || c.noStick) return 'blocked';
  if (c.running > 0) return 'working';
  if (held) return 'held';
  if (c.queued + c.prOpen > 0) return 'working';
  return 'idle';
}

/** Every number on the floor, per zone and across the install. Pure: no database access. */
export function floorCounts(
  state: FloorInputs & Pick<HomeState, 'pending'>,
  now: Date,
): FloorCounts {
  const items = state.items;
  const itemZone = new Map(items.map((i) => [i.id, i.dropZoneId]));
  const merges =
    state.merges24h === undefined
      ? undefined
      : state.merges24h.filter((m) => {
          const t = Date.parse(m.at);
          return t <= now.getTime() && now.getTime() - t < DAY_MS;
        });
  const outbox = (state.outbox ?? []).filter((o) => o.state === 'unknown' || o.state === 'failed');
  const outboxZone = (o: (typeof outbox)[number]): string =>
    (o.workItemId === null ? undefined : itemZone.get(o.workItemId)) ?? o.zoneId;
  const live = liveSticks(state.sticks ?? [], now);
  const briefings = state.briefings ?? [];
  const heldBriefings = new Map((state.heldBriefings ?? []).map((h) => [h.zoneId, h.count]));
  const count = <T>(xs: readonly T[], p: (x: T) => boolean): number => xs.filter(p).length;

  const zones = state.zones.map((z): ZoneFloor => {
    const mode = state.modes?.[z.id] ?? 'active';
    const held = HELD_MODES.has(mode);
    const open = count(briefings, (b) => b.zoneId === z.id);
    // A notice (a held promotion) goes ahead unless stopped: it never needs you (#449).
    const needs = count(briefings, (b) => b.zoneId === z.id && !isNotice(b));
    const counts: ZoneCounts = {
      running: count(state.drops, (d) => d.dropZoneId === z.id && isRunning(d.state)),
      queued: count(items, (i) => i.dropZoneId === z.id && i.state === 'ready'),
      prOpen: count(items, (i) => i.dropZoneId === z.id && i.state === 'pr_open'),
      merged24h: merges ? count(merges, (m) => m.zoneId === z.id) : null,
      parked: count(items, (i) => i.dropZoneId === z.id && i.state === 'parked'),
      outbox: count(outbox, (o) => outboxZone(o) === z.id),
      noStick: live.length > 0 && live.every((s) => s.cannotRun.some((c) => c.zoneId === z.id)),
      needsYou: held ? 0 : needs,
      held: held ? (heldBriefings.get(z.id) ?? 0) + open : 0,
    };
    return { zoneId: z.id, mode, counts, held, state: cardState(counts, held) };
  });

  const heldZones = new Set(zones.filter((z) => z.held).map((z) => z.zoneId));
  return {
    totals: {
      running: count(state.drops, (d) => isRunning(d.state)),
      queued: count(items, (i) => i.state === 'ready'),
      prOpen: count(items, (i) => i.state === 'pr_open'),
      merged24h: merges ? merges.length : null,
      parked: count(items, (i) => i.state === 'parked'),
      // This session's pending guarded changes wait on you as an open briefing does (#507).
      needsYou:
        count(briefings, (b) => !heldZones.has(b.zoneId) && !isNotice(b)) +
        (state.pending ?? []).length,
      pending: (state.pending ?? []).length,
    },
    zones,
  };
}

/**
 * A list page's URL, filtered to a zone and a state; the values URL-encoded. Drop-list links ask for
 * every kind, so the list matches the count that links to it, crew drops included (#497).
 */
export function listHref(path: string, zone: string | undefined, state?: string): string {
  // A project's work is its Work tab (#619), not the install-wide list filtered to it.
  if (path === ACTIVITY_WORK_HREF && zone !== undefined)
    return `${projectHref(zone, 'work')}${state === undefined ? '' : `?state=${encodeURIComponent(state)}`}`;
  const q: string[] = [];
  if (zone !== undefined) q.push(`zone=${encodeURIComponent(zone)}`);
  if (state !== undefined) q.push(`state=${encodeURIComponent(state)}`);
  if (path === ACTIVITY_DROPS_HREF) q.push('kind=all');
  return q.length === 0 ? path : `${path}?${q.join('&')}`;
}

/** The home card that lists what needs you (#625): `/briefings` redirects here. */
export const WAITING_ON_YOU_ID = 'waiting-on-you';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const STATE_LABEL: Record<CardState, string> = {
  'needs-you': 'Needs you',
  blocked: 'Blocked',
  working: 'Working',
  held: 'Held',
  idle: 'Idle',
};
/** A held card names its mode (#495). */
const HELD_LABEL: Record<string, string> = { paused: 'PAUSED', observe: 'OBSERVING' };
const MODE_TONE: Record<string, string> = { active: 'ok', observe: 'info', paused: 'warn-b' };
const HELD_WORD: Record<string, string> = { paused: 'paused', observe: 'observing' };

/** The card's state word: a held card names its mode. */
const cardLabel = (z: ZoneFloor): string =>
  z.state === 'held' ? (HELD_LABEL[z.mode] ?? STATE_LABEL.held) : STATE_LABEL[z.state];

/** Nothing queued, running, open or merged, and nothing else to say: the card's idle line. */
const IDLE_LINE = 'Idle: nothing queued or running.';
const isAllIdle = (z: ZoneFloor): boolean => {
  const c = z.counts;
  return (
    c.running === 0 && c.queued === 0 && c.prOpen === 0 && c.merged24h === 0 && z.state === 'idle'
  );
};

/**
 * A project's state as one sentence, in its floor card's words (#616): the card's state word,
 * then its counts, or the card's idle line. HTML-safe: only numbers and fixed words.
 */
export function stateSentence(z: ZoneFloor): string {
  if (isAllIdle(z)) return IDLE_LINE;
  const c = z.counts;
  const parts = [
    `${c.running} running`,
    `${c.queued} queued`,
    `${c.prOpen} ${c.prOpen === 1 ? 'PR' : 'PRs'} open`,
    c.merged24h === null ? 'merged (24h) unavailable' : `${c.merged24h} merged (24h)`,
    c.parked > 0 ? `${c.parked} parked` : '',
    c.outbox > 0 ? `${plural(c.outbox, 'forge write')} unknown or failed` : '',
    c.noStick ? 'no stick can run it' : '',
    z.held
      ? c.held > 0
        ? `${c.held} held while ${HELD_WORD[z.mode] ?? esc(z.mode)}`
        : ''
      : c.needsYou > 0
        ? `${plural(c.needsYou, 'briefing')} need${c.needsYou === 1 ? 's' : ''} you`
        : '',
  ].filter(Boolean);
  return `${cardLabel(z)}: ${parts.join(', ')}.`;
}

/** A failing doctor check of a configured project: a row of Needs you, grouped per project. */
export interface FailingCheck {
  zoneId: string;
  id: string;
  summary: string;
}

/** What a Needs you row is, ranked in this order (#625): checks first, parked work last. */
export const NEEDS_KINDS = ['check', 'change', 'briefing', 'parked'] as const;
export type NeedsKind = (typeof NEEDS_KINDS)[number];
const NEEDS_CHIP: Record<NeedsKind, string> = {
  check: 'Failing check',
  change: 'Guarded change',
  briefing: 'Briefing',
  parked: 'Parked',
};

/** One row of Needs you: its kind, what it is (HTML, escaped), and its one action link. */
export interface NeedsRow {
  kind: NeedsKind;
  what: string;
  action: { label: string; href: string };
}

/** The rows by kind in NEEDS_KINDS' order; within a kind, as given. */
export function rankNeeds(rows: readonly NeedsRow[]): NeedsRow[] {
  const rank = (r: NeedsRow) => NEEDS_KINDS.indexOf(r.kind);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** What Needs you reads: each source, already the viewer's (the floor's listed briefings). */
export interface NeedsInputs {
  zones: readonly ZoneRef[];
  /** Each zone's mode: a paused or observing zone's briefings are held, not listed. */
  modes?: Readonly<Record<string, string>>;
  fails?: readonly FailingCheck[];
  pending?: readonly PendingLine[];
  briefings?: readonly Briefing[];
  items: readonly WorkItem[];
  now: Date;
}

/** A zone's name, never empty: zone `''` is the credits stop's. */
const namer = (zones: readonly ZoneRef[]): ((id: string) => string) => {
  const name = zoneNamer(zones);
  return (id) => (id === '' ? 'All dispatch stopped' : name(id));
};

/** A work item's own page (#498), under its project's Work tab (#619). */
const itemHref = (i: Pick<WorkItem, 'dropZoneId' | 'issueNumber'>): string =>
  `${projectHref(i.dropZoneId, 'work')}/${encodeURIComponent(String(i.issueNumber))}`;

/** A time that changes with the clock alone: the live script ignores it. */
const when = (iso: string, now: Date): string =>
  `<span data-live-ignore>${relativeTime(iso, now)}</span>`;

/**
 * Every Needs you row, ranked: failing checks that block a project (one row per project), this
 * session's pending guarded changes (#507), open briefings, then parked work items.
 */
export function needsRows(s: NeedsInputs): NeedsRow[] {
  const name = namer(s.zones);
  const configured = new Set(s.zones.map((z) => z.id));
  const rows: NeedsRow[] = [];

  for (const i of s.items.filter((x) => x.state === 'parked'))
    rows.push({
      kind: 'parked',
      what: `${name(i.dropZoneId)} #${esc(i.issueNumber)} ${esc(i.title)}${i.reason ? ` <small>${esc(i.reason)}</small>` : ''}`,
      action: { label: 'Open', href: itemHref(i) },
    });

  const held = (zoneId: string) => HELD_MODES.has(s.modes?.[zoneId] ?? 'active');
  // A notice (a held promotion) goes ahead unless stopped: it never needs you (#449).
  for (const b of (s.briefings ?? []).filter((x) => !isNotice(x) && !held(x.zoneId)))
    rows.push({
      kind: 'briefing',
      what: `${name(b.zoneId)}: ${esc(b.decision)} <small>${when(b.createdAt, s.now)}</small>`,
      action: { label: 'Answer', href: `/briefings/${encodeURIComponent(String(b.id))}` },
    });

  for (const { change, chat } of s.pending ?? []) {
    const [first, ...rest] = change.guarded;
    const left = Math.max(0, Math.ceil((change.expiresAt.getTime() - s.now.getTime()) / 60_000));
    const from = chat
      ? ` <small>from chat: <a href="${esc(`/chat/${chat.threadId}`)}">${esc(chat.title)}</a></small>`
      : '';
    rows.push({
      kind: 'change',
      what:
        `${esc(first?.consequence ?? 'A guarded change')}${rest.length > 0 ? ` and ${rest.length} more` : ''}` +
        ` <small class="expiry">expires in ${left} min</small>${from}`,
      action: {
        label: 'Review and confirm',
        href: `/config/confirm/${encodeURIComponent(change.id)}`,
      },
    });
  }

  const byZone = new Map<string, FailingCheck[]>();
  for (const f of s.fails ?? []) {
    if (!configured.has(f.zoneId)) continue;
    byZone.set(f.zoneId, [...(byZone.get(f.zoneId) ?? []), f]);
  }
  for (const [zoneId, fails] of byZone)
    rows.push({
      kind: 'check',
      what: `${name(zoneId)}: ${plural(fails.length, 'failing check')} (${fails.map((f) => esc(f.id)).join(', ')})`,
      action: { label: 'Fix in System', href: SYSTEM_HREF },
    });

  return rankNeeds(rows);
}

/** A project whose briefings are held while it is paused or observing: one muted line. */
export interface HeldLine {
  zoneId: string;
  mode: string;
  count: number;
  repo?: string;
}

/**
 * Home's Needs you (`#waiting-on-you`): the ranked rows, each a kind chip, what it is and one
 * action link; "Nothing needs you" when every source is empty. Held briefings follow, muted.
 */
export function needsYouSection(
  rows: readonly NeedsRow[],
  held: readonly HeldLine[] = [],
  zones: readonly ZoneRef[] = [],
): string {
  const name = zoneNamer(zones);
  const list =
    rows.length === 0
      ? '<p class="empty">Nothing needs you</p>'
      : `<ul class="needs-list">${rows
          .map(
            (r) =>
              `<li class="needs-row" data-kind="${r.kind}"><span class="chip">${NEEDS_CHIP[r.kind]}</span> ${r.what} <a href="${esc(r.action.href)}">${esc(r.action.label)}</a></li>`,
          )
          .join('')}</ul>`;
  const heldLines =
    held.length === 0
      ? ''
      : `<ul class="held">${held
          .map(
            (z) =>
              `<li><a class="muted" href="${esc(projectHref(z.zoneId))}">${name(z.zoneId, z.repo)}: ${HELD_WORD[z.mode] ?? esc(z.mode)}, ${plural(z.count, 'briefing')} held</a></li>`,
          )
          .join('')}</ul>`;
  return `<section id="${WAITING_ON_YOU_ID}" class="card${rows.length > 0 ? ' attention' : ''}"><h2>Needs you</h2>${list}${heldLines}</section>`;
}

/**
 * Home's Projects: one row per project, needs-you first as the state ranks it, config order
 * within: its name, mode badge, state sentence, and New issue and Open.
 */
export function projectsSection(f: FloorCounts, zones: readonly ZoneRef[], extra = ''): string {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const rows = f.zones
    .map((z, i) => ({ z, i }))
    .sort((a, b) => STATE_RANK[a.z.state] - STATE_RANK[b.z.state] || a.i - b.i)
    .flatMap(({ z }) => {
      const ref = byId.get(z.zoneId);
      if (!ref) return [];
      const id = ref.id;
      return [
        `<li class="project-row" data-state="${z.state}" data-zone="${esc(id)}">` +
          `<a href="${esc(projectHref(id))}">${zoneName(ref, zones)}</a>` +
          ` <span class="badge ${MODE_TONE[z.mode] ?? ''}">${esc(z.mode)}</span>` +
          ` <span class="state">${stateSentence(z)}</span>` +
          ` <a href="${esc(projectHref(id, 'issues/new'))}">New issue</a>` +
          ` <a href="${esc(projectHref(id))}">Open</a></li>`,
      ];
    });
  const body =
    rows.length === 0
      ? '<p class="empty">No project yet.</p>'
      : `<ul class="project-rows">${rows.join('')}</ul>`;
  return `<section id="projects" class="card"><h2>Projects</h2>${body}${extra}</section>`;
}
