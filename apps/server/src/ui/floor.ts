import { isNotice } from '../briefings.js';
import type { Pending } from '../config/confirm.js';
import { ACTIVE_DROP_STATES } from '../db/repo.js';
import { STICK_LIVE_MS } from '../doctor/checks.js';
import { projectHref } from './links.js';
import type { HomeState, StickLine } from './pages.js';
import { type ZoneRef, zoneName } from './zone-name.js';

/**
 * The floor as a dashboard (#120): install totals, then a card per zone with counts. Every number
 * comes from `floorCounts`, a pure function of the home state; the renderers only read it.
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
const isRunning = (state: string): boolean =>
  state !== 'queued' && (ACTIVE_DROP_STATES as readonly string[]).includes(state);

const liveSticks = (sticks: readonly StickLine[], now: Date): StickLine[] =>
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
export function floorCounts(state: HomeState, now: Date): FloorCounts {
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
 * A list page's URL, filtered to a zone and a state; the values URL-encoded. /drops links ask for
 * every kind, so the list matches the count that links to it, crew drops included (#497).
 */
export function listHref(path: string, zone: string | undefined, state?: string): string {
  const q: string[] = [];
  if (zone !== undefined) q.push(`zone=${encodeURIComponent(zone)}`);
  if (state !== undefined) q.push(`state=${encodeURIComponent(state)}`);
  if (path === '/drops') q.push('kind=all');
  return q.length === 0 ? path : `${path}?${q.join('&')}`;
}

/** A count tile: the figure over its label, linking to the list behind it. */
function tile(key: string, n: number | null, label: string, href: string): string {
  const figure = n === null ? '<b title="unavailable">–</b>' : `<b>${n}</b>`;
  return `<a class="tile" data-tile="${key}" href="${esc(href)}">${figure}<span>${label}</span></a>`;
}

/** The Working tiles of a zone (or of the install, with `zone` undefined). */
function workingTiles(c: WorkingCounts, zone: string | undefined): string {
  return (
    tile('running', c.running, 'Running', listHref('/drops', zone, 'active')) +
    tile('queued', c.queued, 'Queued', listHref('/work', zone, 'ready')) +
    tile('pr-open', c.prOpen, 'PRs open', listHref('/work', zone, 'pr_open')) +
    tile('merged', c.merged24h, 'Merged (24h)', listHref('/work', zone, 'done'))
  );
}

/** The home card that lists pending guarded changes and briefings, linking on to /briefings. */
export const WAITING_ON_YOU_ID = 'waiting-on-you';

/**
 * Where the Needs you tile links: /briefings lists briefings only, so with a pending guarded change
 * counted the tile goes to the Waiting on you card, which lists both (#585).
 */
function needsYouHref(pending: number): string {
  return pending > 0 ? `#${WAITING_ON_YOU_ID}` : '/briefings';
}

/** The totals strip: one line of tiles across the install. */
export function totalsStrip(f: FloorCounts): string {
  const t = f.totals;
  return (
    `<nav class="totals" aria-label="Totals">${workingTiles(t, undefined)}` +
    tile('parked', t.parked, 'Parked', listHref('/work', undefined, 'parked')) +
    tile('needs-you', t.needsYou, 'Needs you', needsYouHref(t.pending)) +
    '</nav>'
  );
}

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

function zoneCard(z: ZoneFloor, zone: ZoneRef, zones: readonly ZoneRef[]): string {
  const c = z.counts;
  const id = zone.id;
  const heading =
    `<h2><a href="${esc(projectHref(id))}">${zoneName(zone, zones)}</a>` +
    ` <span class="badge ${MODE_TONE[z.mode] ?? ''}">${esc(z.mode)}</span>` +
    ` <span class="card-state">${z.state === 'held' ? (HELD_LABEL[z.mode] ?? STATE_LABEL.held) : STATE_LABEL[z.state]}</span></h2>`;
  const allZero =
    c.running === 0 && c.queued === 0 && c.prOpen === 0 && c.merged24h === 0 && z.state === 'idle';
  const working = allZero
    ? '<p class="empty">Idle: nothing queued or running.</p>'
    : `<div class="tiles">${workingTiles(c, id)}</div>`;
  const blocked = [
    c.parked > 0
      ? `<li><a href="${esc(listHref('/work', id, 'parked'))}">${c.parked} parked</a></li>`
      : '',
    c.outbox > 0
      ? `<li><a href="${esc(listHref('/work', id))}">${plural(c.outbox, 'forge write')} unknown or failed</a></li>`
      : '',
    c.noStick ? '<li><a href="#sticks">No stick can run it</a></li>' : '',
  ].join('');
  const briefings = listHref('/briefings', id);
  const needs = z.held
    ? c.held > 0
      ? `<p class="muted"><a class="muted" href="${esc(briefings)}">${c.held} held while ${HELD_WORD[z.mode] ?? esc(z.mode)}</a></p>`
      : ''
    : c.needsYou > 0
      ? `<p class="needs"><a href="${esc(briefings)}">${plural(c.needsYou, 'briefing')} need${c.needsYou === 1 ? 's' : ''} you</a></p>`
      : '';
  return (
    `<section class="card zone-card" data-state="${z.state}" data-zone="${esc(id)}">${heading}` +
    `${working}${blocked ? `<ul class="blocked">${blocked}</ul>` : ''}${needs}</section>`
  );
}

/** One card per zone: needs-you first, then blocked, working, held and idle; config order within. */
export function zoneCards(f: FloorCounts, zones: readonly ZoneRef[]): string {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const cards = f.zones
    .map((z, i) => ({ z, i }))
    .sort((a, b) => STATE_RANK[a.z.state] - STATE_RANK[b.z.state] || a.i - b.i)
    .flatMap(({ z }) => {
      const ref = byId.get(z.zoneId);
      return ref ? [zoneCard(z, ref, zones)] : [];
    });
  return `<div class="grid zone-cards">${cards.join('')}</div>`;
}

/** The sticks' summary line: how many are live, and how many can't run some zone. */
export function sticksSummary(sticks: readonly StickLine[], now: Date): string {
  const live = liveSticks(sticks, now).length;
  const cannot = sticks.filter((s) => s.cannotRun.length > 0).length;
  return `Sticks: ${live} live${cannot > 0 ? `, ${cannot} can't run a zone` : ''}`;
}

/**
 * This session's pending guarded changes, one row each: the first guarded consequence (and how
 * many more), the minutes left, the confirm page's link, and the chat thread that staged it. The
 * patch is never read here: what the row says comes from `guarded` alone.
 */
export function pendingRows(lines: readonly PendingLine[], now: Date): string {
  if (lines.length === 0) return '';
  const rows = lines.map(({ change, chat }) => {
    const [first, ...rest] = change.guarded;
    const what = `${esc(first?.consequence ?? 'A guarded change')}${rest.length > 0 ? ` and ${rest.length} more` : ''}`;
    const left = Math.max(0, Math.ceil((change.expiresAt.getTime() - now.getTime()) / 60_000));
    const from = chat
      ? ` <small>from chat: <a href="${esc(`/chat/${chat.threadId}`)}">${esc(chat.title)}</a></small>`
      : '';
    return (
      `<li class="pending-change" data-pending="${esc(change.id)}">${what}` +
      ` <small class="expiry">expires in ${left} min</small>${from}` +
      ` <a href="${esc(`/config/confirm/${encodeURIComponent(change.id)}`)}">Review and confirm</a></li>`
    );
  });
  return `<p>${plural(lines.length, 'guarded change')} to confirm.</p><ul class="pending-changes">${rows.join('')}</ul>`;
}
