import type { ArtifactRow } from '../artifacts.js';
import {
  type About,
  type Briefing,
  effectText,
  type HeldZone,
  issueUrl,
  optionsDigest,
  type Ruling,
  WAITS_FOR_CREW,
} from '../briefings.js';
import { type Focus, INSTALL_ZONE } from '../chat/focus.js';
import { type ClaudePlan, type DropZoneConfig, STARTER_WARNING } from '../config.js';
import type { CrewIssue } from '../crew/store.js';
import type {
  AttemptKey,
  Drop,
  DropState,
  Observation,
  OutboxRow,
  StoredEvent,
  UsageStateRow,
  UsageWindowRow,
  WorkItem,
  WorkItemState,
} from '../db/repo.js';
import { ACTIVE_DROP_STATES } from '../db/repo.js';
import type { DoctorAction } from '../doctor/checks.js';
import { fableWindow, isFableWindow, modelFamily, PER_MODEL_WINDOWS } from '../fable.js';
import type { GoalChange } from '../goal-change.js';
import { currentObjective, type GoalRow } from '../goals.js';
import { forgetSubmitKey, submitKey } from '../intake.js';
import { sliceWhole } from '../slice-whole.js';
import type { Status } from '../status.js';
import type { Gate } from '../usage.js';
import {
  type FailingCheck,
  floorCounts,
  isRunning,
  listHref,
  liveSticks,
  needsRows,
  needsYouSection,
  type PendingLine,
  projectsSection,
} from './floor.js';
import {
  ACTIVITY_DROPS_HREF,
  ACTIVITY_HREF,
  ACTIVITY_LOG_HREF,
  ACTIVITY_WORK_HREF,
  githubSetupHref,
  linkTarget,
  PROJECTS_HREF,
  projectHref,
  SYSTEM_ADVANCED_HREF,
  SYSTEM_CREDENTIALS_HREF,
  SYSTEM_HISTORY_HREF,
  SYSTEM_HREF,
  SYSTEM_MCP_TOKENS_HREF,
  SYSTEM_SERVER_HREF,
  SYSTEM_STICKS_HREF,
} from './links.js';
import { STYLE } from './theme.js';
import { relativeTime } from './time.js';
import { type ZoneRef, zoneName, zoneNamer, zoneNameText, zoneTextNamer } from './zone-name.js';

export const escapeHtml = (v: unknown): string =>
  String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Each zone mode with its plain-English meaning (§4), as the pages and `ctl zones` say it. */
export const MODE_LABELS: Record<string, string> = {
  active: 'active: takes ready issues and runs drops',
  paused: 'paused: starts nothing new; running drops finish',
  observe: 'observe: plans and records, but writes nothing to GitHub',
};

export interface HomeState {
  /** The setup wizard's frame on home, and the "Add a project" link. */
  setup?: { active: boolean; addProject: boolean };
  /** The settings pages exist (a store install): home links to them. */
  settings?: boolean;
  /** What Jumpmaster is doing and why it waits (status.ts): the page opens with it. */
  status?: Status;
  /** The Claude token's age in days, when dated: a banner from day 330. */
  claudeTokenDays?: number;
  zones: DropZoneConfig[];
  /** Each zone's current mode; absent means active. */
  modes?: Record<string, string>;
  killed?: boolean;
  /** Every work item of the configured zones. */
  items: WorkItem[];
  /** The active drops (queued, leased, running, pending push): the slots and the Running counts. */
  drops: Drop[];
  now?: Date;
  usage?: {
    gate: Gate;
    state: UsageStateRow;
    /** The declared plan: `ultra` has no 5-hour window, so no 5-hour meter (#144). */
    plan: ClaudePlan;
    /** Every usage window as last reported (Fable's and other models' among them). */
    windows: UsageWindowRow[];
    /** Drops that reported usage credits since Command's Resume. */
    creditDropsSinceResume?: number;
    /** The account's `overageStatus` as last reported (raw, pending rehearsal). */
    overageStatus?: string | null;
  };
  /** Outbox ops needing attention (`unknown` or `failed`): counted on the zone cards. */
  outbox?: OutboxRow[];
  /**
   * Merges done in the last 24 hours, by zone. Absent when they could not be read: the floor
   * then says "unavailable", never 0.
   */
  merges24h?: Array<{ zoneId: string; at: string; workItemId?: number | null }>;
  /** List every Needs you row (`/?needs=all`), not the first NEEDS_CAP. */
  needsAll?: boolean;
  /** Failing doctor checks of configured projects, for Needs you (#625). */
  doctorFails?: FailingCheck[];
  /** Open briefings, for Needs you: a paused or observing zone's are held back. */
  briefings?: Briefing[];
  /** The zones whose briefings are held back, one collapsed line each. */
  heldBriefings?: HeldZone[];
  /** The viewing session's unexpired pending guarded changes, oldest first (#507). */
  pending?: PendingLine[];
  /** Every enrolled stick, and the zones each can't run. */
  sticks?: StickLine[];
}

export interface StickLine {
  id: string;
  name: string;
  version: string | null;
  lastSeenAt: string | null;
  capabilities: string[];
  imagePolicy: string;
  /** Zones whose requirements this stick lacks, and what it lacks for each. */
  cannotRun: { zoneId: string; missing: string[] }[];
  /** How many troopers it runs at once (`effectiveSlots`): Home's Capacity (#625). */
  slots?: number;
}

export interface CrewLine {
  zoneId: string;
  enabled: boolean;
  /** When the last lead cycle's drop was created, if any. */
  lastCycle: string | null;
  /** When the next lead cycle is due by time (null: due now, or crew off). */
  nextDue: string | null;
  /** Fable's status reason (`available`, or why not). */
  fable: string;
}

export interface ItemDetail {
  headSha?: string;
  /** The head whose gate changes Command allowed (set only when it is the current head). */
  gateAllowedSha?: string;
  /** The head a carried allowance came from (main merged in, the branch unchanged). */
  gateCarriedFrom?: string;
  verdict?: { decision: string; forced: boolean; summary: string };
  attempts: Partial<Record<AttemptKey, number>>;
}

const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`);

/** A state word as an AlignUI StatusBadge; the tone says how much attention it wants. */
const TONES: Record<string, string> = {
  running: 'info',
  leased: 'info',
  push_pending: 'info',
  in_flight: 'info',
  observe: 'info',
  pr_open: 'crew',
  succeeded: 'ok',
  done: 'ok',
  active: 'ok',
  parked: 'warn-b',
  paused: 'warn-b',
  unknown: 'warn-b',
  failed: 'bad',
  lost: 'bad',
};
export const badge = (state: string): string =>
  `<span class="badge ${TONES[state] ?? ''}">${escapeHtml(state)}</span>`;

/** The engaged kill switch, said first and in red on every page: nothing else matters as much. */
export const KILLED_NOTICE =
  '<div class="kill-on" role="alert"><p><strong>The kill switch is engaged.</strong> No work runs and no forge writes happen. Forge and Claude tokens stay valid until you revoke them with their providers.</p></div>';

/** A utilisation meter: the figure, and a bar that warms at 80% and goes red at 95%. */
function meter(label: string, v: number | null, note?: string): string {
  const w = v === null ? 0 : Math.min(100, Math.max(0, Math.round(v * 100)));
  const tone = v === null ? '' : v >= 0.95 ? ' class="full"' : v >= 0.8 ? ' class="hot"' : '';
  const small = note ? `<small class="note">${escapeHtml(note)}</small>` : '';
  return `<div class="meter"><div class="meter-row"><span>${escapeHtml(label)}</span><b>${pct(v)}</b></div>${small}<div class="bar" role="presentation"><i${tone} style="width:${w}%"></i></div></div>`;
}

/** The windows usage_state already carries, read by the gate. */
const GATE_WINDOWS = new Set(['five_hour', 'seven_day']);

export { modelFamily, PER_MODEL_WINDOWS };

const PERIODS: [string, string][] = [
  ['five_hour', '5-hour'],
  ['seven_day', '7-day'],
];

/** A per-model window's meter: by its model's family, or saying Claude didn't name it. */
function perModelMeter(w: UsageWindowRow): string {
  const family = modelFamily(w.model);
  return family
    ? meter(`${family} (7-day)`, w.utilization)
    : meter('Model weekly limit (7-day)', w.utilization, "Claude didn't say which model");
}

/** A model window's meter label from its key: `seven_day_opus` reads `Opus (7-day)`. */
export function windowLabel(key: string): string {
  const [prefix, period] = PERIODS.find(([p]) => key.startsWith(`${p}_`)) ?? ['', ''];
  const rest = (prefix ? key.slice(prefix.length + 1) : key)
    .split('_')
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
  return period ? `${rest} (${period})` : rest;
}

/**
 * The card's meters: 5-hour (not on Ultra, which has no such window), 7-day, Fable on every plan
 * ("-" with a note until Claude reports it, never 0), then each other reported model window.
 */
function usageMeters(u: NonNullable<HomeState['usage']>): string {
  const s = u.state;
  const fable = fableWindow(u.windows);
  const others = u.windows
    .filter((w) => !GATE_WINDOWS.has(w.key) && !isFableWindow(w))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return (
    (u.plan === 'ultra' ? '' : meter('5-hour', s.fiveHourUtil)) +
    meter('7-day', s.sevenDayUtil) +
    (fable && fable.utilization !== null
      ? meter('Fable (7-day)', fable.utilization)
      : meter('Fable (7-day)', null, 'not reported by Claude yet')) +
    others
      .map((w) =>
        PER_MODEL_WINDOWS.has(w.key) ? perModelMeter(w) : meter(windowLabel(w.key), w.utilization),
      )
      .join('')
  );
}

/** A time that changes with the clock alone, as `relativeTime` says it: no reload for it. */
const at = (iso: string, now: Date): string => volatile(relativeTime(iso, now));

/**
 * The usage gate in words (#625): whether dispatch is open, and until when it is paused. The
 * gate's own name, and the raw usage fields, are never shown.
 */
export function gateWords(u: NonNullable<HomeState['usage']>, now: Date): string {
  const s = u.state;
  const until = (iso: string | null | undefined, rest = ''): string =>
    iso ? `Dispatch paused until ${at(iso, now)}${rest}` : `Dispatch paused${rest}`;
  switch (u.gate) {
    case 'open':
      return 'Dispatch open';
    case 'finishing_only':
      return 'Dispatch open to finishing work only: usage is near its limit';
    case 'probe':
      return 'Dispatch probing: one drop at a time until Claude allows more';
    case 'closed':
      return until(laterOf(s.pausedUntil, s.probeNotBefore), ': Claude usage is at its limit');
    case 'stopped':
      return until(
        s.overageUntil,
        `: drop ${escapeHtml(s.overageDropId ?? '-')} ran on usage credits. Rule Run on credits to go on`,
      );
    case 'credits_resume': {
      const n = u.creditDropsSinceResume ?? 0;
      return `Dispatch open on credits${s.overageResumeUntil ? ` until ${at(s.overageResumeUntil, now)}` : ''}, for the resumed work only; ${n} drop${n === 1 ? '' : 's'} used credits since`;
    }
    default: {
      const never: never = u.gate;
      return never;
    }
  }
}

/** The later of two ISO times, either possibly absent. */
const laterOf = (a?: string | null, b?: string | null): string | null =>
  a == null ? (b ?? null) : b == null ? a : Date.parse(a) >= Date.parse(b) ? a : b;

/**
 * Home's Capacity (#625): the Claude usage bars, each stick's troopers busy out of its total, and
 * the gate in words.
 */
function capacitySection(state: HomeState, now: Date): string {
  const u = state.usage;
  const bars = u ? usageMeters(u) : '<p class="empty">No usage reported yet.</p>';
  const gate = u ? `<p class="gate-words">${gateWords(u, now)}.</p>` : '';
  const sticks = state.sticks ?? [];
  const live = new Set(liveSticks(sticks, now).map((s) => s.id));
  const busy = (id: string): number =>
    state.drops.filter((d) => d.stickId === id && isRunning(d.state)).length;
  const name = zoneNamer(state.zones);
  // What a stick cannot run and what it lacks: the diagnostic the sticks table carried.
  const cannot = (s: StickLine): string =>
    s.cannotRun.length === 0
      ? ''
      : ` <small class="cannot-run">${s.cannotRun
          .map((c) => `cannot run ${name(c.zoneId)}: lacks ${escapeHtml(c.missing.join(', '))}`)
          .join('; ')}</small>`;
  const lines =
    sticks.length === 0
      ? '<p class="empty">No stick has enrolled.</p>'
      : `<ul class="stick-capacity">${sticks
          .map(
            (s) =>
              `<li data-stick="${escapeHtml(s.id)}">${escapeHtml(s.name)}: ${busy(s.id)} of ${s.slots ?? 0} troopers busy${live.has(s.id) ? '' : ' <small class="muted">offline</small>'}${cannot(s)}</li>`,
          )
          .join('')}</ul>`;
  return (
    `<section id="capacity" class="card"><h2>Capacity</h2>${gate}${bars}` +
    `<div id="sticks"><h3>Sticks</h3>${lines}<p><a href="${SYSTEM_STICKS_HREF}">Manage sticks</a></p></div></section>`
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A project's page and its sub-pages (defined in `links.ts`, which has no imports). */
export {
  ACTIVITY_DROPS_HREF,
  ACTIVITY_HREF,
  ACTIVITY_LOG_HREF,
  ACTIVITY_WORK_HREF,
  PROJECTS_HREF,
  projectHref,
};

/** A zone's page: an alias of `projectHref` (zones are projects in the UI). */
export const zoneHref = projectHref;

/** A file on GitHub at the default branch, each segment of the repo and path URI-encoded. */
const githubBlobHref = (repo: string, path: string): string => {
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${enc(repo)}/blob/HEAD/${enc(path)}`;
};

/** A project's open briefings: its Overview's Needs you (#625: `/briefings?zone=` redirects there). */
export const zoneBriefingsHref = (zoneId: string): string => `${projectHref(zoneId)}#needs-you`;

const newestFirst = <T extends { id: number }>(xs: readonly T[]): T[] =>
  [...xs].sort((x, y) => y.id - x.id);

/** One shared handler for every rule form: it posts with the session's CSRF header. */
const RULE_SCRIPT = `<script>for(const f of document.querySelectorAll('form.rule'))f.addEventListener('submit',async(e)=>{e.preventDefault();const o=f.querySelector('input[name=option]:checked');if(!o){alert('Choose an option');return;}const r=await jmFetch('/api/control/briefings/'+f.dataset.briefing+'/rule',{optionId:o.value,optionsDigest:f.dataset.options,note:f.querySelector('textarea').value});if(r.ok)location.reload();else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});</script>`;

/** What a briefing's references resolve against: the zone's repository and crew issues. */
export type LinkRefs = {
  /** The zone's repository (`owner/name`): `#n` and crew keys link only with it. */
  repo?: string;
  /** The zone's filed crew issues, key to number. */
  crewKeys?: ReadonlyMap<string, number>;
  /** Where `Briefing n` links; else its own page. */
  briefingHref?: (n: number) => string;
  /** Where `Ruling n` links; unset, or `undefined` for it, leaves it text (no page shows it). */
  rulingHref?: (n: number) => string | undefined;
};

/**
 * The references a briefing's text may carry: `#n`, `Ruling n`, `Briefing n`, a refute's
 * `full text: /drops/<id>`, and a word shaped like a crew key (linked only if it is one).
 */
const REFERENCE =
  /(?<![\w&#])#(\d{1,9})(?!\w)|\b(Ruling|Briefing) (\d{1,9})\b|full text: \/drops\/([A-Za-z0-9_-]{1,80})(?![\w-])|(?<![\w-])([a-z0-9][a-z0-9-]{0,39})(?![\w-])/g;

const anchor = (href: string, text: string): string =>
  `<a href="${escapeHtml(href)}"${linkTarget(href)}>${escapeHtml(text)}</a>`;

/**
 * Briefing text as HTML (D4): every character escaped, and links built only from the fixed
 * reference patterns, to the zone's own repository or this app's pages. No other markup passes.
 */
export function linkify(text: string, refs: LinkRefs): string {
  const issue = (n: number) =>
    refs.repo === undefined ? escapeHtml(`#${n}`) : anchor(issueUrl(refs.repo, n), `#${n}`);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(REFERENCE)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [all, hash, word, wordN, dropId, key] = m;
    if (hash !== undefined) out += issue(Number(hash));
    else if (word !== undefined) {
      const n = Number(wordN);
      const href =
        word === 'Ruling' ? refs.rulingHref?.(n) : (refs.briefingHref?.(n) ?? `/briefings/${n}`);
      out += href === undefined ? escapeHtml(all) : anchor(href, all);
    } else if (dropId !== undefined) out += anchor(`/drops/${dropId}`, 'full text');
    else {
      const n = key !== undefined && /[a-z]/.test(key) ? refs.crewKeys?.get(key) : undefined;
      out +=
        n === undefined || refs.repo === undefined
          ? escapeHtml(all)
          : `${escapeHtml(all)} (${issue(n)})`;
    }
  }
  return out + escapeHtml(text.slice(last));
}

/** The About cell: the resolved subject, linked when it has a URL. */
const aboutHtml = (a: About): string =>
  a.url && /^https:\/\//.test(a.url) ? anchor(a.url, a.text) : escapeHtml(a.text);

/** What a briefing block needs beyond the briefing: its zone's references and its About. */
type BlockContext = {
  holds?: Map<string, string> | undefined;
  name: (id: string) => string;
  refs: (zoneId: string) => LinkRefs;
  about?: ReadonlyMap<number, About> | undefined;
  /** Briefings the crew is still to diagnose (`diagnosePending`): no rule form yet. */
  pending?: ReadonlySet<number> | undefined;
};

/** In place of the rule form while the crew is still to diagnose a parked briefing. */
const PENDING_NOTICE = `<p class="pending">${escapeHtml("The crew is looking at this. You'll be asked if it needs you.")}</p>`;

function briefingBlock(b: Briefing, ctx: BlockContext, heading: 'h3' | 'h4' = 'h3'): string {
  const hold = b.kind === 'promote_held' ? ctx.holds?.get(b.subject) : undefined;
  const refs = ctx.refs(b.zoneId);
  const text = (v: string) => linkify(v, refs);
  const options = b.options
    .map(
      (o) =>
        `<label><input type="radio" name="option" value="${escapeHtml(o.id)}" required> ${escapeHtml(o.label)}</label> <small><code>${escapeHtml(o.id)}</code></small> <small class="effect">${escapeHtml(effectText(b.kind, o.effect))}</small><br>`,
    )
    .join('');
  const row = (k: string, v: string) =>
    v ? `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>` : '';
  const rich = (k: string, v: string) => (v ? `<tr><th>${k}</th><td>${text(v)}</td></tr>` : '');
  const pre = (k: string, v: string | null) =>
    v ? `<tr><th>${k}</th><td><pre>${text(v)}</pre></td></tr>` : '';
  const about = ctx.about?.get(b.id) ?? { text: b.subject };
  const readOnly = `<ul>${b.options.map((o) => `<li>${escapeHtml(o.label)} <small><code>${escapeHtml(o.id)}</code></small> <small class="effect">${escapeHtml(effectText(b.kind, o.effect))}</small></li>`).join('')}</ul>`;
  const form =
    b.state !== 'open'
      ? `<p>${escapeHtml(b.state)}</p>${readOnly}`
      : ctx.pending?.has(b.id)
        ? PENDING_NOTICE + readOnly
        : `<form class="rule" data-briefing="${escapeHtml(b.id)}" data-options="${optionsDigest(b)}">${options}<textarea name="note" maxlength="2000" placeholder="Note (optional)"></textarea><br><button>Rule</button></form>`;
  return (
    `<div class="briefing" id="briefing-${escapeHtml(b.id)}">` +
    `<${heading}>${text(b.decision)}</${heading}>` +
    `<table><tr><th>Briefing</th><td><a href="/briefings/${escapeHtml(b.id)}">${escapeHtml(b.id)}</a></td></tr><tr><th>Zone</th><td>${ctx.name(b.zoneId)}</td></tr>${row('Kind', b.kind)}<tr><th>About</th><td>${aboutHtml(about)}</td></tr>${pre('Why', b.why)}${pre('Diagnosis', b.diagnosis)}${rich('Recommendation', b.recommendation)}${rich('On hold', b.onHold)}${row('Raised by', b.source === 'mcp' ? 'assistant (MCP)' : b.source)}${row('Raised', b.createdAt)}</table>` +
    (hold ? `<p>Promotes at ${escapeHtml(hold)} unless you reject it.</p>` : '') +
    form +
    '</div>'
  );
}

/**
 * Dismisses all the zone's open briefings after a confirmation that states the count: on its
 * project's Overview, under Needs you (#625). It posts the ids it was rendered with, so a briefing raised since is not dismissed
 * unseen.
 */
export function dismissAllForm(
  zoneId: string,
  open: readonly Briefing[],
  zones: readonly ZoneRef[],
): string {
  const what = `${plural(open.length, 'briefing')} of`;
  const ask = `Dismiss ${what} ${zoneTextNamer(zones)(zoneId)}? Each is taken off Needs you without a ruling: nothing it is about is ruled on, and nothing is written to GitHub.`;
  return `<form id="dismiss-all" data-zone="${escapeHtml(zoneId)}" data-ids="${escapeHtml(JSON.stringify(open.map((b) => b.id)))}" data-ask="${escapeHtml(ask)}"><button class="danger">Dismiss all ${escapeHtml(what)} ${zoneNamer(zones)(zoneId)}</button></form><script>{const f=document.getElementById('dismiss-all');f.addEventListener('submit',async(e)=>{e.preventDefault();if(!confirm(f.dataset.ask))return;const r=await jmFetch('/api/control/zones/'+encodeURIComponent(f.dataset.zone)+'/briefings/dismiss',{ids:JSON.parse(f.dataset.ids)});if(r.ok)location.reload();else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});}</script>`;
}

/**
 * Each zone's references: its repository and crew keys; `Briefing n` and `Ruling n` to their anchor
 * when this page shows them, else to the briefing's own page.
 */
function briefingRefs(
  zones: readonly Pick<DropZoneConfig, 'id' | 'repo'>[],
  rulings: readonly Ruling[],
  crewKeys: ReadonlyMap<string, ReadonlyMap<string, number>> | undefined,
  shown: { briefings: ReadonlySet<number>; rulings: ReadonlySet<number> },
): (zoneId: string) => LinkRefs {
  const repos = new Map(zones.map((z) => [z.id, z.repo]));
  const briefingOf = new Map(rulings.map((r) => [r.id, r.briefingId]));
  const briefingHref = (n: number) =>
    shown.briefings.has(n) ? `#briefing-${n}` : `/briefings/${n}`;
  const rulingHref = (n: number) => {
    if (shown.rulings.has(n)) return `#ruling-${n}`;
    const b = briefingOf.get(n);
    return b === undefined ? undefined : `/briefings/${b}#ruling-${n}`;
  };
  return (zoneId) => {
    const repo = repos.get(zoneId);
    const keys = crewKeys?.get(zoneId);
    return {
      ...(repo !== undefined ? { repo } : {}),
      ...(keys !== undefined ? { crewKeys: keys } : {}),
      briefingHref,
      rulingHref,
    };
  };
}

/**
 * The script behind every Ask about this button: it opens the Ask panel focused on the button's
 * object (`jmAsk`, the panel script's). A page without the panel opens a thread focused on it
 * (`POST /api/chat/threads {focus}`) and goes to it. It binds each form once, so a page may carry
 * it more than once.
 */
const ASK_SCRIPT = `<script>for(const f of document.querySelectorAll('form.ask')){if(f.dataset.bound)continue;f.dataset.bound='1';f.addEventListener('submit',async(e)=>{e.preventDefault();const focus={kind:f.dataset.focusKind,zoneId:f.dataset.focusZone,ref:f.dataset.focusRef};if(typeof window.jmAsk==='function'){window.jmAsk(focus,f.querySelector('button'));return;}const r=await jmFetch('/api/chat/threads',{focus});if(r.ok){const b=await r.json();location.href='/chat/'+encodeURIComponent(b.thread.id);}else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});}</script>`;

/**
 * Ask about this (#103): a form that opens the Ask panel (#626) focused on a zone, its goals or a
 * briefing. The focus rides in escaped `data-focus-*` attributes; `chip`, the focus as the panel
 * header's chip shows it (escaped HTML), in an inert template the page shell moves there.
 */
export function askButton(focus: Focus, chip?: string): string {
  return `${askForm(focus, 'Ask about this', chip)}${ASK_SCRIPT}`;
}

/** The Ask about this form alone, its button reading `button`; the page adds ASK_SCRIPT once. */
function askForm(focus: Focus, button: string, chip?: string, title?: string): string {
  const label = chip === undefined ? '' : `<template class="ask-chip">${chip}</template>`;
  const t = title === undefined ? '' : ` title="${escapeHtml(title)}"`;
  return `<form class="ask" data-focus-kind="${escapeHtml(focus.kind)}" data-focus-zone="${escapeHtml(focus.zoneId)}" data-focus-ref="${escapeHtml(focus.ref)}">${label}<button${t}>${escapeHtml(button)}</button></form>`;
}

/** The tabs of a project's pages (#616), in the order the tab bar shows them. */
export type ProjectTab = 'overview' | 'work' | 'goals' | 'setup' | 'log';

/** Where each project tab goes. */
const PROJECT_TABS: readonly { tab: ProjectTab; label: string; href: (id: string) => string }[] = [
  { tab: 'overview', label: 'Overview', href: (id) => projectHref(id) },
  { tab: 'work', label: 'Work', href: (id) => projectHref(id, 'work') },
  { tab: 'goals', label: 'Goals', href: (id) => projectHref(id, 'goals') },
  { tab: 'setup', label: 'Setup', href: (id) => projectHref(id, 'setup') },
  { tab: 'log', label: 'Log', href: (id) => projectLogHref(id) },
];

/** A project's tab bar (#616): every project page carries it, the current tab marked. */
export function projectTabs(zone: Pick<ZoneRef, 'id'>, current: ProjectTab | undefined): string {
  const links = PROJECT_TABS.map(
    (t) =>
      `<a href="${escapeHtml(t.href(zone.id))}"${t.tab === current ? ' aria-current="page"' : ''}>${t.label}</a>`,
  ).join('');
  return `<nav class="settings-tabs project-tabs" aria-label="Project tabs">${links}</nav>`;
}

/**
 * A project page's breadcrumb (#628): Projects › the project › its tab (none for Overview) ›
 * whatever `trail` adds, the page itself last.
 */
function projectCrumbs(
  zone: ZoneRef,
  zones: readonly ZoneRef[],
  current: ProjectTab | undefined,
  trail: readonly Crumb[],
): string {
  const tab = PROJECT_TABS.find((t) => t.tab === current && t.tab !== 'overview');
  return breadcrumb([
    { label: 'Projects', href: PROJECTS_HREF },
    { label: zoneName(zone, zones), href: projectHref(zone.id) },
    ...(tab ? [{ label: tab.label, href: tab.href(zone.id) }] : []),
    ...trail,
  ]);
}

/** The header's Pause or Resume button: it sets the zone's mode as the projects list's buttons do. */
const PROJECT_MODE_SCRIPT = `<script>for(const b of document.querySelectorAll('button.project-mode')){if(b.dataset.bound)continue;b.dataset.bound='1';b.addEventListener('click',async()=>{const r=await jmFetch('/api/control/zones/'+encodeURIComponent(b.dataset.zone),{mode:b.dataset.mode});if(r.ok){location.reload();return;}const j=await r.json().catch(()=>({}));document.getElementById('project-mode-out').textContent=b.dataset.name+': '+(j.error||('refused ('+r.status+')'));});}</script>`;

/**
 * A project's header (#616), on every project page: the repository name and mode badge, the
 * Briefings count, then Ask about this (zone focus unless the page names its own), Pause or
 * Resume, and New issue; then the tab bar.
 */
export function projectHeader(p: {
  zone: ZoneRef;
  zones: readonly ZoneRef[];
  /** The zone's current mode (`getZoneMode`). */
  mode: string;
  openBriefings: number;
  current: ProjectTab | undefined;
  ask?: Focus;
  /** The breadcrumb's steps below the project's tab (the page itself last), if any. */
  trail?: readonly Crumb[];
}): string {
  const { zone, zones, mode } = p;
  const id = zone.id;
  const [label, next] = mode === 'active' ? ['Pause', 'paused'] : ['Resume', 'active'];
  const ask = p.ask ?? { kind: 'zone', zoneId: id, ref: id };
  const control = `<button type="button" class="project-mode" data-zone="${escapeHtml(id)}" data-name="${escapeHtml(zoneNameText(zone, zones))}" data-mode="${next}">${label}</button>`;
  return (
    projectCrumbs(zone, zones, p.current, p.trail ?? []) +
    `<p class="project-links"><a href="${escapeHtml(githubSetupHref(id))}">GitHub</a> · <a href="${escapeHtml(zoneBriefingsHref(id))}">Briefings (${escapeHtml(p.openBriefings)} open)</a></p>` +
    `<header class="project-header"><h2>${zoneName(zone, zones)} ${badge(mode)}</h2>` +
    `<p class="project-mode-label">${escapeHtml(MODE_LABELS[mode] ?? mode)}</p>` +
    `<div class="project-actions">${askButton(ask, ask.kind === 'goals' ? `${zoneName(zone, zones)} · goals` : zoneName(zone, zones))} ${control} <a href="${escapeHtml(projectHref(id, 'issues/new'))}">New issue</a> <span id="project-mode-out" role="status"></span></div>` +
    `${PROJECT_MODE_SCRIPT}</header>${projectTabs(zone, p.current)}`
  );
}

/**
 * One briefing on its own page (`/briefings/<n>`), open or not, with its rulings: where a
 * reference to it from another page, or `ctl briefings`, leads.
 */
export function renderBriefing(s: {
  briefing: Briefing;
  /** The zone's rulings: this briefing's are listed, the rest resolve `Ruling n` references. */
  rulings: Ruling[];
  zones: DropZoneConfig[];
  holds?: Map<string, string>;
  about?: About;
  crewKeys?: ReadonlyMap<string, number>;
  /** The crew is still to diagnose it (`diagnosePending`). */
  pending?: boolean;
}): string {
  const b = s.briefing;
  const name = zoneNamer(s.zones);
  const own = newestFirst(s.rulings.filter((r) => r.briefingId === b.id));
  const shown = { briefings: new Set([b.id]), rulings: new Set(own.map((r) => r.id)) };
  const ctx: BlockContext = {
    holds: s.holds,
    name,
    about: s.about ? new Map([[b.id, s.about]]) : undefined,
    refs: briefingRefs(
      s.zones,
      s.rulings,
      s.crewKeys ? new Map([[b.zoneId, s.crewKeys]]) : undefined,
      shown,
    ),
    pending: s.pending ? new Set([b.id]) : undefined,
  };
  const rows = own
    .map(
      (r) =>
        `<tr id="ruling-${escapeHtml(r.id)}"><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.label ?? r.choice)} <small><code>${escapeHtml(r.choice)}</code></small></td><td>${escapeHtml(r.note)}</td><td>${escapeHtml(r.createdAt)}</td><td>${escapeHtml(r.appliedAt ?? '-')}</td><td>${escapeHtml(r.applyError ?? '')}</td></tr>`,
    )
    .join('');
  return page(
    breadcrumb([
      { label: 'Home', href: '/' },
      { label: 'Needs you', href: '/#waiting-on-you' },
      { label: `Briefing ${escapeHtml(b.id)}` },
    ]) +
      `${s.zones.some((z) => z.id === b.zoneId) ? `<p><a href="${escapeHtml(zoneBriefingsHref(b.zoneId))}">Briefings of ${name(b.zoneId)}</a></p>` : ''}<h2>Briefing ${escapeHtml(b.id)}</h2>` +
      askButton(
        { kind: 'briefing', zoneId: b.zoneId, ref: String(b.id) },
        `Briefing ${escapeHtml(b.id)}`,
      ) +
      briefingBlock(b, ctx, 'h3') +
      (b.state === 'open' ? RULE_SCRIPT : '') +
      `<h3 id="rulings">Rulings</h3>` +
      (own.length === 0
        ? '<p class="empty">No ruling on this briefing.</p>'
        : `<table><tr><th>Ruling</th><th>Choice</th><th>Note</th><th>Ruled</th><th>Applied</th><th>Error</th></tr>${rows}</table>`),
  );
}

/** How many ended goal changes (merged, refused, closed) the goals page still lists. */
const ENDED_GOAL_CHANGES = 3;

/**
 * The zone's goal changes still in flight, each with what happens next (an open one: its Approve
 * and merge link), and the last few that ended, with why.
 */
function goalChangesBlock(changes: readonly GoalChange[]): string {
  const live = changes.filter((c) => ['proposed', 'open', 'confirmed'].includes(c.state));
  const ended = changes
    .filter((c) => !live.includes(c))
    .slice(-ENDED_GOAL_CHANGES)
    .reverse();
  if (live.length === 0 && ended.length === 0) return '';
  const pr = (c: GoalChange) =>
    c.prNumber === null ? '' : ` (pull request #${escapeHtml(c.prNumber)})`;
  const next = (c: GoalChange): string => {
    switch (c.state) {
      case 'proposed':
        // A crew proposal opens only once Command rules on its goal-change briefing (#645).
        return c.source === 'crew'
          ? 'Waits for your ruling on its briefing.'
          : 'Its pull request opens at the next pass.';
      case 'open':
        return `<a href="/goal-changes/${escapeHtml(c.id)}/confirm">Approve and merge</a>`;
      case 'confirmed':
        return `Confirmed at <code>${escapeHtml((c.confirmedSha ?? '').slice(0, 7))}</code>: Jumpmaster merges it once its required checks pass.`;
      case 'merged':
        return 'Merged.';
      default:
        return `Not merged (${escapeHtml(c.state)}).`;
    }
  };
  const rows = [...live, ...ended]
    .map(
      (c) =>
        `<li>Goal change ${escapeHtml(c.id)}${pr(c)}, from the ${escapeHtml(c.source)}: ${next(c)}${c.error ? ` <small>${escapeHtml(c.error)}</small>` : ''}</li>`,
    )
    .join('');
  return `<h3>Goal changes</h3><ul>${rows}</ul>`;
}

/** A zone's goal ladder, its crew issues, and marker-bearing issues intake did not start. */
export function renderGoals(s: {
  zone: DropZoneConfig;
  /** Every zone, to tell apart zones sharing a repository. */
  zones: readonly ZoneRef[];
  goals: GoalRow | undefined;
  crewIssues: CrewIssue[];
  items: WorkItem[];
  skippedCrewUnpromoted: number[];
  /** Objectives Command marked done by a ruling: key to the ruling's id. */
  doneByRuling: ReadonlyMap<string, number>;
  /** The zone's goal changes (#363), oldest first. */
  goalChanges?: readonly GoalChange[];
  /** The zone's current mode, for the project header (#616); its configured mode when absent. */
  mode?: string;
  /** The zone's open briefings, counted in the project header. */
  openBriefings?: number;
  /** The zone's crew row (#620), as Floor shows it: at the top of the page. */
  crew?: CrewLine;
  /** Now, for the crew row's relative times. */
  now?: Date;
}): string {
  const path = s.zone.crew?.goalPath ?? 'GOAL.md';
  const missing = s.goals?.parse.ok === false && s.goals.parse.error === `${path} not found`;
  // No goal file yet (or not read yet): the stub builder opens, above the empty ladder (#620).
  const noGoal = missing || s.goals === undefined;
  // Until the goal can change in the app (#336), the owner edits it on GitHub: a protected path.
  const edit = missing
    ? `<p>${escapeHtml(path)} isn't in the repository yet. <a href="#goal-stub">Draft one with the GOAL.md stub builder</a>.</p>`
    : `<p>The goals live in ${escapeHtml(path)} in ${escapeHtml(s.zone.repo)}. It is a protected path: agent pull requests never change it, and Jumpmaster merges a change to it only when you approve it here. Propose a change in the chat, or <a href="${escapeHtml(githubBlobHref(s.zone.repo, path))}">open ${escapeHtml(path)} on GitHub</a> and use the pencil to edit it. The crew reads the change at its next cycle.</p>`;
  let ladder: string;
  if (!s.goals) {
    ladder = `<p>${escapeHtml(path)} has not been read yet.</p>`;
  } else if (!s.goals.parse.ok) {
    ladder = `<p>${escapeHtml(path)} could not be parsed: ${escapeHtml(s.goals.parse.error)}</p>`;
  } else {
    const current = currentObjective(s.goals.parse, new Set(s.doneByRuling.keys()));
    const rows = s.goals.parse.objectives
      .map((o) => {
        const ruling = s.doneByRuling.get(o.key);
        const status = o.done
          ? 'done'
          : ruling !== undefined
            ? `done (ruling #${escapeHtml(ruling)})`
            : o.key === current?.key
              ? 'Current objective'
              : 'open';
        return `<tr><td>${escapeHtml(o.title)}</td><td>${status}</td><td><code>${escapeHtml(o.key)}</code></td></tr>`;
      })
      .join('');
    ladder =
      `<p>${escapeHtml(s.goals.parse.lighthouse)}</p>` +
      (current === null
        ? `<p>Every objective is done. Add the next objective to ${escapeHtml(path)} to give the crew more work.</p>`
        : '') +
      `<table><tr><th>Objective</th><th>Status</th><th>Key</th></tr>${rows}</table>` +
      `<p><small>Read ${escapeHtml(s.goals.readAt)}</small></p>`;
  }
  const byNumber = new Map(s.items.map((i) => [i.issueNumber, i]));
  const issues = s.crewIssues
    .map((c) => {
      const wi = c.number === null ? undefined : byNumber.get(c.number);
      let findings = '';
      try {
        const list = JSON.parse(c.findingsJson ?? '[]') as unknown[];
        findings = list.map((f) => escapeHtml(f)).join('<br>');
      } catch {
        findings = '';
      }
      return `<tr><td>${escapeHtml(c.objective)}</td><td><code>${escapeHtml(c.key)}</code></td><td>${escapeHtml(c.title)}</td><td>${escapeHtml(c.state)}</td><td>${c.number === null ? '-' : `#${escapeHtml(c.number)}`}</td><td>${escapeHtml(wi?.state ?? '-')}</td><td>${findings}</td></tr>`;
    })
    .join('');
  const rowByNumber = new Map(
    s.crewIssues.flatMap((c) => (c.number === null ? [] : [[c.number, c] as const])),
  );
  // Why it was skipped: its crew row's state, if it has one (else a marker, bot author or the
  // staged label marked it crew). A rejected or failed row never starts: say what to do instead.
  const skippedLine = (n: number): string => {
    const c = rowByNumber.get(n);
    if (!c) return `#${escapeHtml(n)}`;
    if (c.state === 'rejected' || c.state === 'failed') {
      return `#${escapeHtml(n)}: crew issue ${escapeHtml(c.state)}. It can never start: close it, or file a fresh issue for the work.`;
    }
    return `#${escapeHtml(n)}: crew issue ${escapeHtml(c.state)}, not promoted`;
  };
  const skipped =
    s.skippedCrewUnpromoted.length === 0
      ? '<p>None.</p>'
      : `<ul>${s.skippedCrewUnpromoted.map((n) => `<li>${skippedLine(n)}</li>`).join('')}</ul>`;
  const stub = goalStub(s.zone, noGoal);
  return page(
    projectHeader({
      zone: s.zone,
      zones: s.zones,
      mode: s.mode ?? s.zone.mode ?? 'active',
      openBriefings: s.openBriefings ?? 0,
      current: 'goals',
      ask: { kind: 'goals', zoneId: s.zone.id, ref: s.zone.id },
    }) +
      crewRow(s.crew, s.now ?? new Date()) +
      (noGoal ? stub : '') +
      `<h2>Objectives (goal ladder)</h2>` +
      `${ladder}${edit}${goalChangesBlock(s.goalChanges ?? [])}` +
      `<h2>Crew issues</h2><table><tr><th>Objective</th><th>Key</th><th>Title</th><th>State</th><th>Issue</th><th>Work item</th><th>Findings</th></tr>${issues}</table>` +
      `<h2>Crew issues not started (no recorded promotion)</h2>${skipped}` +
      (noGoal ? '' : stub),
  );
}

/** The project's crew row on Goals (#620): on or off, the last cycle, the next due, Fable. */
function crewRow(c: CrewLine | undefined, now: Date): string {
  if (!c) return '';
  const last = c.lastCycle ? relativeTime(c.lastCycle, now) : '-';
  const next = !c.enabled ? '-' : c.nextDue ? relativeTime(c.nextDue, now) : 'now';
  return (
    `<section id="crew"><h2>Crew</h2><table><tr><th>Crew</th><th>Last cycle</th><th>Next due</th><th>Fable</th></tr>` +
    `<tr><td>${c.enabled ? 'on' : 'off'}</td><td>${last}</td><td>${next}</td><td>${escapeHtml(c.fable)}</td></tr></table></section>`
  );
}

function detailCells(d: ItemDetail | undefined): string {
  const allowed = d?.gateAllowedSha
    ? `<br><small>gate change allowed by Command for ${escapeHtml(d.gateAllowedSha.slice(0, 7))}${
        d.gateCarriedFrom ? ` (carried from ${escapeHtml(d.gateCarriedFrom.slice(0, 7))})` : ''
      }</small>`
    : '';
  const head = d?.headSha ? escapeHtml(d.headSha.slice(0, 7)) : '-';
  const v = d?.verdict;
  const verdict = v
    ? `${escapeHtml(v.decision)}${v.forced ? ' (forced)' : ''}<br><small>${escapeHtml(v.summary)}</small>`
    : '-';
  const attempts = d ? attemptPairs(d.attempts) : '-';
  return `<td>${d?.headSha ? `<code>${head}</code>` : '-'}${allowed}</td><td>${verdict}</td><td>${attempts}</td>`;
}

/**
 * Every write from a page goes through `jmFetch`: JSON, with the session's CSRF token (from the
 * `jm-csrf` meta the guard fills per session) in `x-jm-csrf`. The session cookie rides along.
 */
const JM_FETCH = `<script>function jmFetch(path,body,method){return fetch(path,{method:method||'POST',headers:{'content-type':'application/json','x-jm-csrf':document.querySelector('meta[name=jm-csrf]').content},body:JSON.stringify(body===undefined?{}:body)});}</script>`;

const LOGOUT = `<form method="post" action="/logout" class="logout"><button>Log out</button></form>`;

/**
 * The mark's drawing, once: a canopy over a trooper's lines, after the airborne vocabulary (§4).
 * `paint` is the color the shapes take; the top bar and the tab icon differ only in that.
 */
const markShapes = (paint: string): string =>
  `<path d="M2 9a8 8 0 0 1 16 0" fill="${paint}"/><path d="M2.5 9.5 10 17l7.5-7.5M7 9.5l3 7.5 3-7.5" stroke="${paint}" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="17" r="1.6" fill="${paint}"/>`;

/** The mark in the top bar, painted with the brand color through `.brand svg`'s `color`. */
export const MARK = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">${markShapes('currentColor')}</svg>`;

/** The top bar's brand color (`--primary-base`, `--blue-500` in `STYLE`): a favicon has no text color to inherit. */
const BRAND_COLOR = '#335cff';

/** The mark as the browser tab's icon: an SVG `data:` URI, so it needs no route and no CSP change. */
export const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">${markShapes(BRAND_COLOR)}</svg>`,
)}`;

const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">`;

/**
 * Where the store-only links (Projects) go. `page()` cannot know the install's mode, so
 * the app fills this in for a store install (`withStoreNav`); a config-file install keeps the
 * comment, and links nowhere that would 404.
 */
export const STORE_NAV_SLOT = '<!--jm-store-nav-->';
export const STORE_NAV = `<a href="${PROJECTS_HREF}" data-area="projects">Projects</a>`;

/** Where Needs you's count goes, on Home's top bar link: `fillChrome` fills it from the request. */
export const NEEDS_SLOT = '<!--jm-needs-you-->';
/** Where the kill switch control goes in the top bar, and its engaged notice atop `<main>`. */
export const KILL_SLOT = '<!--jm-kill-->';
export const KILL_NOTICE_SLOT = '<!--jm-kill-notice-->';

/** The top bar's five areas (#628). */
export type NavArea = 'home' | 'projects' | 'activity' | 'chat' | 'system';

/**
 * Which area each path belongs to, by prefix (the path itself, or under it): a drop, a work
 * item's legacy page and the old lists are Activity's; a briefing and a pending change Home's.
 */
const AREA_PREFIXES: readonly [NavArea, readonly string[]][] = [
  ['home', ['/briefings', '/config/confirm']],
  ['projects', [PROJECTS_HREF, '/zones', '/goal-changes']],
  ['activity', [ACTIVITY_HREF, '/drops', '/work', '/board', '/log', '/observations']],
  ['chat', ['/chat']],
  ['system', [SYSTEM_HREF, '/setup', '/sticks', '/settings', '/doctor', '/credentials']],
];

/** The top bar area a path is in: `/` is Home; an unknown path is in none. */
export function navArea(path: string): NavArea | undefined {
  const p = path.split(/[?#]/)[0] ?? '';
  if (p === '/') return 'home';
  return AREA_PREFIXES.find(([, prefixes]) =>
    prefixes.some((x) => p === x || p.startsWith(`${x}/`)),
  )?.[0];
}

/** The pages every install has, in the order the operator reaches for them. */
const NAV = `<a href="/" data-area="home">Home${NEEDS_SLOT}</a>${STORE_NAV_SLOT}<a href="${ACTIVITY_HREF}" data-area="activity">Activity</a><a href="/chat" data-area="chat">Chat</a><a href="${SYSTEM_HREF}" data-area="system">System</a>`;

/** Needs you's count on Home's link: nothing at 0. */
export const needsBadge = (n: number): string =>
  n > 0
    ? `<span class="nav-badge" title="${n} need${n === 1 ? 's' : ''} you"><span class="sr-only">, </span>${n}<span class="sr-only"> need${n === 1 ? 's' : ''} you</span></span>`
    : '';

/**
 * The kill switch control's script (#628): the button opens the confirmation dialog, Cancel and
 * Escape shut it, and only its Engage (or Reset) posts, once at a time; a refusal or a network
 * failure is said inside the dialog. It never calls `alert()`.
 */
export const KILL_SCRIPT = `<script>(()=>{const $=(i)=>document.getElementById(i);const o=$('kill-open'),d=$('kill-dialog'),c=$('kill-confirm'),x=$('kill-cancel'),e=$('kill-err');if(!o||!d||!c||!x||!e)return;const on=o.dataset.engaged==='true';let busy=false;
const show=()=>{e.textContent='';if(typeof d.showModal==='function')d.showModal();else d.setAttribute('open','');if(c.focus)c.focus();};
const hide=()=>{if(typeof d.close==='function')d.close();else d.removeAttribute('open');if(o.focus)o.focus();};
o.addEventListener('click',show);x.addEventListener('click',hide);
c.addEventListener('click',async()=>{if(busy)return;busy=true;c.disabled=true;e.textContent='';try{const r=await jmFetch('/api/control/kill',{engaged:!on});if(r.ok){location.reload();return;}const j=await r.json().catch(()=>({}));e.textContent='Refused ('+r.status+')'+(j&&j.error?': '+j.error:'');}catch(err){e.textContent='Could not reach the server: '+((err&&err.message)||err);}finally{busy=false;c.disabled=false;}});})();</script>`;

/**
 * The kill switch control (#628): a compact button in the top bar, red and reading "Kill switch
 * on" while engaged, and the confirmation it opens. It posts with the session's CSRF header, so a
 * page visit cannot trigger it.
 */
export function killControl(killed: boolean): string {
  const [label, title, what, confirm, tone] = killed
    ? [
        'Kill switch on',
        'Reset the kill switch?',
        'Work runs again and forge writes resume at the next pass.',
        'Reset',
        'primary',
      ]
    : [
        'Kill switch',
        'Engage the kill switch?',
        'No work runs and no forge writes happen until you reset it. Forge and Claude tokens stay valid until you revoke them with their providers.',
        'Engage',
        'danger-filled',
      ];
  return (
    `<button type="button" id="kill-open" class="kill-btn${killed ? ' on' : ''}" aria-haspopup="dialog" aria-controls="kill-dialog" data-engaged="${killed}">${label}</button>` +
    `<dialog id="kill-dialog" class="kill-dialog" aria-labelledby="kill-title"><h2 id="kill-title">${title}</h2><p>${what}</p>` +
    `<p id="kill-err" class="kill-err" role="alert"></p>` +
    `<div class="kill-actions"><button type="button" id="kill-confirm" class="${tone}">${confirm}</button><button type="button" id="kill-cancel">Cancel</button></div></dialog>` +
    KILL_SCRIPT
  );
}

/** What the top bar shows that only the server knows: the path, the kill switch, Needs you. */
export type ChromeState = { path?: string; killed?: boolean; needsYou?: number };

/**
 * Fills a page's top bar slots (#628): marks the path's area `aria-current="page"`, draws the kill
 * switch control and, engaged, its notice atop the page, and Needs you's count on Home. A value
 * not given leaves its slot for a later fill.
 */
export function fillChrome(html: string, s: ChromeState): string {
  let out = html;
  if (s.killed !== undefined)
    out = out
      .replace(KILL_SLOT, killControl(s.killed))
      .replace(KILL_NOTICE_SLOT, s.killed ? KILLED_NOTICE : '');
  if (s.needsYou !== undefined) out = out.replace(NEEDS_SLOT, needsBadge(s.needsYou));
  const area = s.path === undefined ? undefined : navArea(s.path);
  if (area !== undefined && !out.includes('aria-current="page" data-area='))
    out = out.replace(`data-area="${area}">`, `aria-current="page" data-area="${area}">`);
  return out;
}

/** A step of a breadcrumb: its label (HTML, escaped) and, but for the page itself, a link. */
export type Crumb = { label: string; href?: string };

/**
 * The one breadcrumb (#628), on every page below an area's own pages: area › object › sub-page.
 * The last step is the page itself, marked current and not a link.
 */
export function breadcrumb(trail: readonly Crumb[]): string {
  const steps = trail.map((c, i) =>
    i === trail.length - 1
      ? `<li><span aria-current="page">${c.label}</span></li>`
      : `<li>${c.href === undefined ? c.label : `<a href="${escapeHtml(c.href)}">${c.label}</a>`}</li>`,
  );
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${steps.join('')}</ol></nav>`;
}

/** The System area's pages (#623), in its sub-nav's order; all but Health and Sticks are a store install's. */
export type SystemPage =
  | 'health'
  | 'sticks'
  | 'credentials'
  | 'server'
  | 'mcp-tokens'
  | 'history'
  | 'advanced';
const SYSTEM_PAGES: readonly [SystemPage, string, string][] = [
  ['health', SYSTEM_HREF, 'Health'],
  ['sticks', SYSTEM_STICKS_HREF, 'Sticks'],
  ['credentials', SYSTEM_CREDENTIALS_HREF, 'Credentials'],
  ['server', SYSTEM_SERVER_HREF, 'Server'],
  ['mcp-tokens', SYSTEM_MCP_TOKENS_HREF, 'MCP tokens'],
  ['history', SYSTEM_HISTORY_HREF, 'History'],
  ['advanced', SYSTEM_ADVANCED_HREF, 'Advanced'],
];
const systemLinks = (pages: typeof SYSTEM_PAGES, current?: SystemPage): string =>
  pages
    .map(
      ([key, href, label]) =>
        `<a href="${href}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`,
    )
    .join(' · ');
const SYSTEM_ALWAYS = SYSTEM_PAGES.slice(0, 2);
const SYSTEM_STORE = SYSTEM_PAGES.slice(2);

/**
 * Where the System sub-nav's store-only links go on Health and Sticks: as `STORE_NAV_SLOT`, the
 * app fills it in for a store install, and a config-file install links nowhere that would 404.
 */
export const SYSTEM_STORE_NAV_SLOT = '<!--jm-system-store-nav-->';
export const SYSTEM_STORE_NAV = ` · ${systemLinks(SYSTEM_STORE)}`;

/**
 * The System sub-nav (#623): Health · Sticks · Credentials · Server · MCP tokens · History ·
 * Advanced, the current page marked. A store-only page draws every link; Health and Sticks leave
 * the store-only ones to the slot.
 */
export function systemNav(current: SystemPage): string {
  const links = SYSTEM_STORE.some(([key]) => key === current)
    ? systemLinks(SYSTEM_PAGES, current)
    : `${systemLinks(SYSTEM_ALWAYS, current)}${SYSTEM_STORE_NAV_SLOT}`;
  return `<nav class="subnav" aria-label="System"><p>${links}</p></nav>`;
}

/** A credential a zone needs and lacks, as the config store reports it. */
export type ZoneProblemView = { zoneId: string; credential: string; kind: string; message: string };

/** Zone problems (moved from Credentials to Health, #623): each zone's missing credential. */
export function zoneProblemsSection(
  problems: readonly ZoneProblemView[],
  zones: readonly ZoneRef[],
): string {
  const name = zoneNamer(zones);
  const list =
    problems.length === 0
      ? '<p>No zone is missing a credential it needs.</p>'
      : `<ul class="problems">${problems
          .map(
            (p) =>
              `<li><strong>${name(p.zoneId)}</strong> (${escapeHtml(p.credential)}, ${escapeHtml(p.kind)}): ${escapeHtml(p.message)}</li>`,
          )
          .join('')}</ul>`;
  return `<h3>Zone problems</h3>${list}`;
}

/** The Activity area's pages (#622), in its sub-nav's order. */
export type ActivityPage = 'board' | 'work' | 'drops' | 'log';
const ACTIVITY_PAGES: readonly [ActivityPage, string, string][] = [
  ['board', ACTIVITY_HREF, 'Board'],
  ['work', ACTIVITY_WORK_HREF, 'Work'],
  ['drops', ACTIVITY_DROPS_HREF, 'Drops'],
  ['log', ACTIVITY_LOG_HREF, 'Log'],
];

/** The Activity sub-nav (#622): Board · Work · Drops · Log, the current page marked. */
export function activityNav(current: ActivityPage): string {
  const links = ACTIVITY_PAGES.map(
    ([key, href, label]) =>
      `<a href="${href}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join(' · ');
  return `<nav class="subnav" aria-label="Activity"><p>${links}</p></nav>`;
}

/** Marks a page that refreshes itself (`page({ live: true })`): a comment inside LIVE_SCRIPT. */
export const LIVE_MARKER = 'jm-live';

/**
 * Refreshes a live page (#404): every 10 seconds, while the tab is visible, it fetches the page
 * again and reloads when `<main>`, less every `[data-live-ignore]`, differs from the last fetch's
 * (the first fetch is the baseline). It holds the reload while the owner types in `<main>` or has
 * an unsaved change in one of its forms, while the kill switch confirmation is open (#628), and
 * while the Ask panel is open (#626: a draft in its frame is invisible from here), checks at
 * once when the tab comes back, ignores a failed fetch or a non-200, and stops on a 401 or a
 * redirect to the login page.
 */
export const LIVE_SCRIPT = `<script>/*${LIVE_MARKER}*/(()=>{let base=null,pending=false,stopped=false,busyFetch=false,timer=null;const stop=()=>{stopped=true;if(timer!==null)clearInterval(timer);};const dirty=(f)=>{const t=f.tagName;if(t==='SELECT'){for(const o of f.options||[])if(o.selected!==o.defaultSelected)return true;return false;}if(t==='INPUT'&&(f.type==='checkbox'||f.type==='radio'))return f.checked!==f.defaultChecked;if(t==='INPUT'||t==='TEXTAREA')return f.value!==f.defaultValue;return false;};const busy=()=>{const k=document.getElementById&&document.getElementById('ask-panel');if(k&&!k.hidden)return true;const kd=document.getElementById&&document.getElementById('kill-dialog');if(kd&&kd.open)return true;const m=document.querySelector('main');if(!m)return false;const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName||'')&&m.contains(a))return true;for(const f of m.querySelectorAll('form'))for(const e of f.elements)if(dirty(e))return true;return false;};const tick=async()=>{if(stopped||busyFetch||document.visibilityState!=='visible')return;busyFetch=true;try{const r=await fetch(location.pathname+location.search,{credentials:'same-origin',cache:'no-store'});if(r.status===401||(r.redirected&&new URL(r.url,location.origin).pathname==='/login')){stop();return;}if(r.status!==200)return;const m=new DOMParser().parseFromString(await r.text(),'text/html').querySelector('main');if(!m)return;for(const e of m.querySelectorAll('[data-live-ignore]'))e.remove();const html=m.innerHTML;if(base!==null&&html!==base)pending=true;base=html;if(pending&&!busy()){stop();location.reload();}}catch{}finally{busyFetch=false;}};timer=setInterval(tick,10000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tick();});})();</script>`;

/** A value that changes on every render while the page's state does not: no reload for it. */
const volatile = (html: string): string => `<span data-live-ignore>${html}</span>`;

/**
 * A page's first Ask about this form: its focus, as the form escaped it, and its chip. A doctor
 * finding's form is one row's of many on Health, never the page's own focus.
 */
const ASK_FORM =
  /<form class="ask" data-focus-kind="(zone|goals|briefing|drop)" data-focus-zone="([^"]*)" data-focus-ref="([^"]*)">(?:<template class="ask-chip">(.*?)<\/template>)?/;

/** A page's focus: the escaped values and the chip HTML. */
type PageFocus = Focus & { chip: string | undefined };

/**
 * The focus of what a page shows (#626): a project page's (its zone, or Goals' goals) or a
 * briefing's, as its Ask about this form names it; any other page has none. Values stay escaped.
 */
export function pageFocus(body: string): PageFocus | undefined {
  const m = ASK_FORM.exec(body);
  if (!m) return undefined;
  return { kind: m[1] as Focus['kind'], zoneId: m[2] as string, ref: m[3] as string, chip: m[4] };
}

/** The panel header's chip for a page's focus. */
const askChip = (f: PageFocus | undefined): string =>
  f === undefined ? '' : `<span class="chip">${f.chip ?? f.kind}</span>`;

/** The header's Ask button: it carries the page's focus (already escaped) for the panel script. */
const askOpen = (f: PageFocus | undefined): string =>
  `<button type="button" id="ask-open" class="ask-open" aria-controls="ask-panel" aria-expanded="false"${f ? ` data-focus-kind="${f.kind}" data-focus-zone="${f.zoneId}" data-focus-ref="${f.ref}"` : ''}>Ask</button>`;

/**
 * The Ask panel (#626): a complementary region beside the page, not a modal, holding the thread
 * view (`/chat/<id>?panel=1`) in a same-origin frame.
 */
const askPanel = (f: PageFocus | undefined): string =>
  `<aside id="ask-panel" class="ask-panel" role="complementary" aria-label="Ask Jumpmaster" aria-modal="false" tabindex="-1" hidden>` +
  `<div class="ask-head"><h2>Ask</h2>${askChip(f)}<a id="ask-full" href="/chat">Open in Chat</a><button type="button" id="ask-close">Close</button></div>` +
  `<p id="ask-out" role="status"></p><iframe id="ask-frame" title="Ask Jumpmaster thread"></iframe></aside>`;

/** How long a focused thread stays the one the panel reopens: a day. */
export const ASK_REUSE_MS = 24 * 60 * 60 * 1000;

/**
 * The Ask panel's script (#626). Ask opens the panel: the tab's own thread for the same focus
 * (`sessionStorage`) while the server still has it and it is under a day old, else the newest
 * thread with that focus made in the last day, else a new one (`POST /api/chat/threads`). The open
 * state and the thread persist per tab, so the next page with the same focus shows the same
 * thread; a page loaded with the panel open never makes a thread, it stays shut instead until Ask.
 * Escape (here, unless a dialog on the page has it, or, by message, in the frame) and Close shut
 * it and give focus back to whatever opened it; a close while the lookup runs abandons it.
 * `jmAsk(focus, opener)` is what Ask about this calls. A `sessionStorage` that throws only loses
 * the persistence.
 */
export const ASK_PANEL_SCRIPT = `<script>(()=>{const b=document.getElementById('ask-open');const p=document.getElementById('ask-panel');if(!b||!p)return;const fr=document.getElementById('ask-frame');const full=document.getElementById('ask-full');const out=document.getElementById('ask-out');const K='jm-ask';const DAY=${ASK_REUSE_MS};
const load=()=>{try{const v=JSON.parse(sessionStorage.getItem(K)||'null');return v&&typeof v==='object'?v:{};}catch{return {};}};
const save=(v)=>{try{sessionStorage.setItem(K,JSON.stringify(v));}catch{}};
const pf=()=>b.dataset.focusKind?{kind:b.dataset.focusKind,zoneId:b.dataset.focusZone,ref:b.dataset.focusRef}:null;
const key=(f)=>f?[f.kind,f.zoneId,f.ref].join('\\n'):'';
let back=null;let gen=0;
const same=(t,f)=>f?t.focusKind===f.kind&&t.focusZoneId===f.zoneId&&t.focusRef===f.ref:t.focusKind===null;
const find=async(f,mine)=>{const r=await fetch('/api/chat/threads',{credentials:'same-origin',headers:{accept:'application/json'}});if(!r.ok)return null;const j=await r.json();const now=Date.now();let best=null;for(const t of (j&&j.threads)||[]){const at=Date.parse(t.createdAt);if(!same(t,f)||!(now-at<DAY))continue;if(mine!=null&&String(t.id)===String(mine))return t;if(!best||at>Date.parse(best.createdAt))best=t;}return best;};
const create=async(f)=>{const r=await jmFetch('/api/chat/threads',f?{focus:f}:{});const j=await r.json().catch(()=>({}));if(!r.ok||!j.thread)throw new Error(r.status+' '+(j.error??''));return j.thread;};
const show=(id)=>{const u='/chat/'+encodeURIComponent(id);full.href=u;const src=u+'?panel=1';if(fr.getAttribute('src')!==src)fr.setAttribute('src',src);};
const shut=()=>{gen++;p.hidden=true;b.setAttribute('aria-expanded','false');document.body.classList.remove('ask-on');};
const open=async(f,from,move)=>{if(f===undefined)f=pf();const n=++gen;back=from||b;p.hidden=false;b.setAttribute('aria-expanded','true');document.body.classList.add('ask-on');if(move!==false&&p.focus)p.focus();out.textContent='';
const s=load();const mine=s.focus===key(f)&&s.thread?s.thread:null;save({open:true,focus:key(f),thread:mine});let id;
try{let t=await find(f,mine);if(n!==gen)return;if(!t){if(move===false){shut();save({open:false,focus:key(f),thread:null});return;}t=await create(f);}id=t.id;}catch(x){if(n===gen)out.textContent='Could not open a thread: '+((x&&x.message)||x);return;}
if(n!==gen)return;show(id);save({open:true,focus:key(f),thread:id});};
const close=()=>{if(p.hidden)return;shut();save({...load(),open:false});const t=back||b;back=null;if(t&&t.focus)t.focus();};
b.addEventListener('click',()=>{if(p.hidden)open(pf(),b);else close();});
document.getElementById('ask-close').addEventListener('click',close);
document.addEventListener('keydown',(e)=>{if(e.key!=='Escape'||p.hidden||e.defaultPrevented||(document.querySelector&&document.querySelector('dialog[open]')))return;e.preventDefault();close();});
window.addEventListener('message',(e)=>{if(e.origin===location.origin&&e.data&&e.data.jmAsk==='close')close();});
window.jmAsk=(f,from)=>open(f||null,from);
if(load().open)open(pf(),b,false);})();</script>`;

/**
 * The page shell. With `chrome` (the default, for pages behind the login) it carries an empty
 * `jm-csrf` meta for the guard to fill, `jmFetch`, the navigation, the Ask button and panel (#626,
 * focused on the page's Ask about this object, if any) and the logout button; the login and setup
 * pages go without. `panel` is a page drawn inside the Ask panel: `jmFetch` and the CSRF meta but
 * no top bar, its links leaving the frame.
 */
export const page = (
  body: string,
  opts: {
    chrome?: boolean;
    title?: string;
    live?: boolean;
    panel?: boolean;
    /** Whether the kill switch is engaged; absent, the app fills it in (`fillChrome`). */
    killed?: boolean;
    /** Needs you's count; absent, the app fills it in (`fillChrome`). */
    needsYou?: number;
  } = {},
): string => {
  const panel = opts.panel ?? false;
  const chrome = !panel && (opts.chrome ?? true);
  const title = opts.title ? `Jumpmaster: ${escapeHtml(opts.title)}` : 'Jumpmaster';
  const focus = chrome ? pageFocus(body) : undefined;
  const nav = chrome
    ? `<nav class="topnav" aria-label="Main">${NAV}</nav><div class="topbar-tools">${askOpen(focus)}<div class="kill-ctl">${KILL_SLOT}</div>${LOGOUT}</div>`
    : '';
  const scripted = chrome || panel;
  const top = panel
    ? ''
    : `<a class="skip" href="#main">Skip to content</a><header class="topbar"><div class="topbar-in"><h1 class="brand">${MARK}Jumpmaster</h1>${nav}</div></header>`;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${scripted ? `<meta name="jm-csrf" content="">` : ''}<title>${title}</title>${panel ? '<base target="_top">' : ''}${FAVICON_LINK}<style>${STYLE}</style>${scripted ? JM_FETCH : ''}</head>` +
    `<body${panel ? ' class="in-panel"' : ''}>${top}` +
    `<main id="main">${chrome ? KILL_NOTICE_SLOT : ''}${body}</main>${chrome ? `${askPanel(focus)}${ASK_PANEL_SCRIPT}` : ''}${opts.live ? LIVE_SCRIPT : ''}</body></html>`;
  return chrome
    ? fillChrome(html, {
        ...(opts.killed !== undefined ? { killed: opts.killed } : {}),
        ...(opts.needsYou !== undefined ? { needsYou: opts.needsYou } : {}),
      })
    : html;
};

function elapsed(drop: Drop, now: Date): string {
  if (!drop.startedAt) return '-';
  const end = drop.finishedAt ? Date.parse(drop.finishedAt) : now.getTime();
  const total = Math.max(0, Math.round((end - Date.parse(drop.startedAt)) / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

type GateResult = { name: string; exitCode: number | null; timedOut: boolean };
type GateOutcome = 'pass' | 'fail' | 'timeout';

/** A drop's gates from its result, each with its outcome; empty when it reported none. */
function gateOutcomes(drop: Drop): { name: string; outcome: GateOutcome }[] {
  if (!drop.resultJson) return [];
  try {
    const gates = (JSON.parse(drop.resultJson) as { gates?: GateResult[] }).gates ?? [];
    return gates.map((g) => ({
      name: String(g.name),
      outcome: g.timedOut ? 'timeout' : g.exitCode === 0 ? 'pass' : 'fail',
    }));
  } catch {
    return [];
  }
}

function gateSummary(drop: Drop): string {
  const gates = gateOutcomes(drop);
  if (gates.length === 0) return '-';
  return gates.map((g) => `${escapeHtml(g.name)}: ${g.outcome}`).join('<br>');
}

/** Each gate as `name: outcome`, a failed or timed-out one marked `fail`; `-` when none. */
function gateMarks(drop: Drop): string {
  const gates = gateOutcomes(drop);
  if (gates.length === 0) return '-';
  return gates
    .map(
      (g) =>
        `<span class="gate ${g.outcome === 'pass' ? 'pass' : 'fail'}">${escapeHtml(g.name)}: ${g.outcome}</span>`,
    )
    .join('<br>');
}
/** The work-item ledger's header row, on Activity's Work. */
export const WORK_HEAD =
  '<tr><th>Zone</th><th>Issue</th><th>Title</th><th>State</th><th>Reason</th><th>PR</th><th>Head</th><th>Verdict</th><th>Attempts</th></tr>';

/** The drop ledger's header row, on /drops. */
export const DROP_HEAD =
  '<tr><th>Drop</th><th>Project</th><th>Work</th><th>Role</th><th>State</th><th>Started</th><th>Elapsed</th><th>Gates</th></tr>';

/** What a ready item waits on, in words, or nothing. */
const waitingOn = (i: WorkItem): string =>
  i.state === 'ready' && i.blockedBy.length > 0 ? `waiting on ${i.blockedBy.join(', ')}` : '';

/** A work item's own page (#498), under its project's Work tab (#619). */
export const workItemHref = (i: Pick<WorkItem, 'dropZoneId' | 'issueNumber'>): string =>
  `${projectHref(i.dropZoneId, 'work')}/${i.issueNumber}`;

/** A project's work list (#619), in `state` unless it is the default (active). */
export const projectWorkHref = (zone: string, state?: string): string =>
  `${projectHref(zone, 'work')}${state === undefined || state === 'active' ? '' : `?${new URLSearchParams({ state })}`}`;

/** An issue's drop list on Activity's Drops. */
const issueDropsHref = (i: Pick<WorkItem, 'dropZoneId' | 'issueNumber'>): string =>
  `${ACTIVITY_DROPS_HREF}?${new URLSearchParams({ zone: i.dropZoneId, issue: String(i.issueNumber) })}`;

/** A GitHub link `#N` to an issue or pull request, or plain `#N` without the repository. */
function githubRef(repo: string | undefined, kind: 'issues' | 'pull', n: number): string {
  if (!repo) return `#${escapeHtml(n)}`;
  const href = `https://github.com/${repo}/${kind}/${n}`;
  return `<a href="${escapeHtml(href)}"${linkTarget(href)}>#${escapeHtml(n)}</a>`;
}

/** Attempt counts as `key N` pairs, those above zero; `-` when none. */
const attemptPairs = (attempts: ItemDetail['attempts']): string =>
  Object.entries(attempts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${escapeHtml(k)} ${escapeHtml(n)}`)
    .join(', ') || '-';

/** The work-item ledger's rows (Activity's Work), zones named by repository. */
export function workItemRows(
  items: readonly WorkItem[],
  zones: readonly Pick<DropZoneConfig, 'id' | 'repo'>[],
  details?: Map<number, ItemDetail>,
): string {
  const name = zoneNamer(zones);
  const repoOf = new Map(zones.map((z) => [z.id, z.repo]));
  const prLink = (i: WorkItem): string => {
    const repo = repoOf.get(i.dropZoneId);
    if (i.prNumber === null || !repo) return '-';
    return githubRef(repo, 'pull', i.prNumber);
  };
  const issueLink = (i: WorkItem): string =>
    githubRef(repoOf.get(i.dropZoneId), 'issues', i.issueNumber);
  const titleLink = (i: WorkItem): string =>
    `<a href="${escapeHtml(workItemHref(i))}">${escapeHtml(i.title)}</a>`;
  return items
    .map(
      (i) =>
        `<tr><td>${name(i.dropZoneId)}</td><td>${issueLink(i)}</td><td>${titleLink(i)}</td><td>${badge(i.state)}</td><td>${escapeHtml(i.reason ?? waitingOn(i))}</td><td>${prLink(i)}</td>${detailCells(details?.get(i.id))}</tr>`,
    )
    .join('');
}

/** What a drop works on: its issue, or the crew or doctor. */
function dropTarget(d: Drop, itemById: Map<number, WorkItem>): string {
  if (d.workItemId === null) return d.role === 'doctor' ? 'doctor' : 'crew';
  const wi = itemById.get(d.workItemId);
  return wi ? `#${escapeHtml(wi.issueNumber)}` : '-';
}

/** The longest issue title a drop row shows; a longer one is cut with "…". */
const DROP_TITLE_MAX = 60;

/** A drop row's Work cell: `#N <title>` for issue work, else `crew` or `doctor`. */
function dropWork(d: Drop, itemById: Map<number, WorkItem>): string {
  const wi = d.workItemId === null ? undefined : itemById.get(d.workItemId);
  if (!wi) return dropTarget(d, itemById);
  const title =
    wi.title.length > DROP_TITLE_MAX ? `${sliceWhole(wi.title, DROP_TITLE_MAX)}…` : wi.title;
  return `#${escapeHtml(wi.issueNumber)} ${escapeHtml(title)}`;
}

/**
 * The drop ledger's rows (/drops'): a short id, the project, the work, and when it started (or was
 * created, if it has not started); `items` resolve each drop's issue, `zones` name its project.
 */
export function dropRows(
  drops: readonly Drop[],
  items: readonly WorkItem[],
  zones: readonly ZoneRef[],
  now: Date,
): string {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const name = zoneNamer(zones);
  return drops
    .map((d) => {
      const id = escapeHtml(d.id);
      const link = `<a href="/drops/${encodeURIComponent(d.id)}" title="${id}">${escapeHtml(d.id.slice(0, 8))}</a>`;
      const started = relativeTime(d.startedAt ?? d.createdAt, now);
      return `<tr><td>${link}</td><td>${name(d.dropZoneId)}</td><td>${dropWork(d, itemById)}</td><td>${escapeHtml(d.role)}</td><td>${badge(d.state)}</td><td>${started}</td><td class="num">${escapeHtml(elapsed(d, now))}</td><td>${gateSummary(d)}</td></tr>`;
    })
    .join('');
}

export const WORK_STATES = ['ready', 'in_flight', 'pr_open', 'parked', 'done'] as const;
export type WorkFilter = WorkItemState | 'active';
export const DROP_STATES = [
  'queued',
  'leased',
  'running',
  'push_pending',
  'succeeded',
  'failed',
  'lost',
  'cancelled',
] as const satisfies readonly DropState[];
export type DropFilter = DropState | 'active' | 'all';
/** /drops' kind filter: issue work (the default), crew, doctor, or every kind. */
export const DROP_KINDS = ['work', 'crew', 'doctor', 'all'] as const;
export type DropKind = (typeof DROP_KINDS)[number];
const KIND_LABEL: Record<DropKind, string> = {
  work: 'Issue work',
  crew: 'Crew',
  doctor: 'Doctor',
  all: 'All kinds',
};
/** The most drops /drops lists. */
export const DROP_LIST_LIMIT = 200;

/** A state in words, as headings and filter links say it. */
const stateWords = (s: string): string =>
  s === 'pr_open' ? 'PR open' : s.replaceAll('_', ' ').replace('in flight', 'in-flight');
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A list page: back link, heading, the zone and state filter links, then the table or the empty
 * line. `zone`/`state` absent from a link's query mean "all projects" and the page's default.
 */
function listPage(p: {
  path: string;
  /** The Activity sub-nav's current page (#622), on an install-wide list. */
  activity?: ActivityPage;
  /**
   * A project page's header and tab bar (#619): it replaces the back link, and the page is that
   * project's alone, so there is no project filter and links carry no `zone`.
   */
  header?: string;
  /** The heading, as HTML. */
  title: string;
  /** The heading as plain text, for the document title. */
  titleText: string;
  zones: readonly ZoneRef[];
  zone: string | undefined;
  /** An issue filter within `zone`: kept by links to that zone, dropped by links to another. */
  issue?: number;
  state: string;
  defaultState: string;
  states: { value: string; label: string }[];
  /** A third filter row, by kind: kept by every link, omitted from the query at its default. */
  kinds?: { value: string; label: string }[];
  kind?: string;
  defaultKind?: string;
  head: string;
  rows: string;
  empty: string;
  note?: string;
}): string {
  const href = (zone: string | undefined, state: string, kind = p.kind): string => {
    // A project's own list is its project page; Activity's Work links to one go there directly (#619).
    if (p.path === ACTIVITY_WORK_HREF && zone !== undefined && p.header === undefined)
      return escapeHtml(projectWorkHref(zone, state));
    const q = new URLSearchParams();
    if (zone !== undefined && p.header === undefined) q.set('zone', zone);
    if (zone !== undefined && zone === p.zone && p.issue !== undefined)
      q.set('issue', String(p.issue));
    if (state !== p.defaultState) q.set('state', state);
    if (kind !== undefined && kind !== p.defaultKind) q.set('kind', kind);
    const qs = q.toString();
    return escapeHtml(qs ? `${p.path}?${qs}` : p.path);
  };
  const link = (to: string, label: string, current: boolean): string =>
    `<a href="${to}"${current ? ' aria-current="page"' : ''}>${label}</a>`;
  const zoneLinks = [
    link(href(undefined, p.state), 'All projects', p.zone === undefined),
    ...p.zones.map((z) => link(href(z.id, p.state), zoneName(z, p.zones), p.zone === z.id)),
  ].join(' · ');
  const stateLinks = p.states
    .map((s) => link(href(p.zone, s.value), escapeHtml(s.label), p.state === s.value))
    .join(' · ');
  const kindLinks = p.kinds
    ?.map((k) => link(href(p.zone, p.state, k.value), escapeHtml(k.label), p.kind === k.value))
    .join(' · ');
  const kindNav = kindLinks
    ? `<nav class="filters" aria-label="Kind"><p>${kindLinks}</p></nav>`
    : '';
  const body = p.rows
    ? `<table>${p.head}${p.rows}</table>${p.note ? `<p class="muted">${p.note}</p>` : ''}`
    : `<p class="empty">${p.empty}</p>`;
  const top =
    p.header === undefined
      ? `${p.activity ? activityNav(p.activity) : ''}<h2>${p.title}</h2><nav class="filters" aria-label="Project"><p>${zoneLinks}</p></nav>`
      : `${p.header}<h2>${p.title}</h2>`;
  return page(
    `${top}<nav class="filters" aria-label="State"><p>${stateLinks}</p></nav>${kindNav}${body}`,
    { title: p.titleText },
  );
}

/**
 * /activity/work (#622): work items of one zone or all, in one state or every state but done. With `header`, it is
 * `/projects/:id/work` (#619): that project's list under its header and tab bar.
 */
export function renderWorkList(s: {
  zones: readonly ZoneRef[];
  zone?: string;
  /** The project header and tab bar (`projectHeaderFor`), on a project's own list. */
  header?: string;
  state: WorkFilter;
  /** Already filtered. */
  items: readonly WorkItem[];
  details?: Map<number, ItemDetail>;
}): string {
  const z = s.zone === undefined ? undefined : s.zones.find((x) => x.id === s.zone);
  const words = stateWords(s.state);
  const where = z ? ` in ${zoneName(z, s.zones)}` : '';
  const heading = (w: string): string => (z ? `${capital(words)} work${w}` : `All ${words} work`);
  return listPage({
    path: z && s.header !== undefined ? projectHref(z.id, 'work') : ACTIVITY_WORK_HREF,
    ...(z && s.header !== undefined ? { header: s.header } : { activity: 'work' as const }),
    title: heading(where),
    titleText: heading(z ? ` in ${zoneNameText(z, s.zones)}` : ''),
    zones: s.zones,
    zone: z?.id,
    state: s.state,
    defaultState: 'active',
    states: [
      { value: 'active', label: 'Active' },
      ...WORK_STATES.map((v) => ({ value: v, label: capital(stateWords(v)) })),
    ],
    head: WORK_HEAD,
    rows: workItemRows(s.items, s.zones, s.details),
    empty: `No ${words} work${where}.`,
  });
}

/**
 * /projects/:zone/work/:issue (#498, #619): one issue's whole story, under the project header. The header (issue, project, state, PR, head
 * and verdict), the attempt counts, then every drop for it oldest first with its gates.
 */
export function renderWorkItem(s: {
  item: WorkItem;
  zones: readonly ZoneRef[];
  detail?: ItemDetail;
  /** The item's drops, in any order: shown oldest first. */
  drops: readonly Drop[];
  now?: Date;
  /** The project header and tab bar (`projectHeaderFor`). */
  header?: string;
}): string {
  const { item: i, zones, detail: d } = s;
  const now = s.now ?? new Date();
  const zone = zones.find((z) => z.id === i.dropZoneId) ?? { id: i.dropZoneId, repo: i.dropZoneId };
  const repo = zones.some((z) => z.id === i.dropZoneId) ? zone.repo : undefined;
  const project = zoneName(zone, zones);
  const workZoneHref = projectWorkHref(i.dropZoneId);
  const crumbs =
    s.header === undefined
      ? breadcrumb([
          { label: 'Activity', href: ACTIVITY_HREF },
          { label: 'Work', href: ACTIVITY_WORK_HREF },
          { label: project, href: workZoneHref },
          { label: `#${escapeHtml(i.issueNumber)}` },
        ])
      : '';
  const why = i.reason ?? waitingOn(i);
  const pr = i.prNumber === null ? '-' : githubRef(repo, 'pull', i.prNumber);
  const head = d?.headSha ? `<code>${escapeHtml(d.headSha.slice(0, 7))}</code>` : '-';
  const v = d?.verdict;
  const verdict = v
    ? `${escapeHtml(v.decision)}${v.forced ? ' (forced)' : ''} <small>${escapeHtml(v.summary)}</small>`
    : '-';
  const header =
    `<h2>${githubRef(repo, 'issues', i.issueNumber)} ${escapeHtml(i.title)}</h2>` +
    `<p>Project: <a href="${escapeHtml(zoneHref(i.dropZoneId))}">${project}</a> · ${badge(i.state)}${
      why ? ` ${escapeHtml(why)}` : ''
    }</p>` +
    `<p>PR: ${pr} · Head: ${head} · Verdict: ${verdict}</p>` +
    `<p>Attempt counts: ${d ? attemptPairs(d.attempts) : '-'}</p>`;
  const oldestFirst = [...s.drops].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const rows = oldestFirst
    .map((dr) => {
      const link = `<a href="/drops/${encodeURIComponent(dr.id)}" title="${escapeHtml(dr.id)}">${escapeHtml(dr.id.slice(0, 8))}</a>`;
      const started = relativeTime(dr.startedAt ?? dr.createdAt, now);
      const drPr = dr.prNumber === null ? '-' : githubRef(repo, 'pull', dr.prNumber);
      return `<tr class="attempt"><td>${escapeHtml(dr.role)}</td><td>${badge(dr.state)}</td><td>${started}</td><td class="num">${escapeHtml(elapsed(dr, now))}</td><td>${gateMarks(dr)}</td><td>${drPr}</td><td>${link}</td></tr>`;
    })
    .join('');
  const attempts = rows
    ? `<table><tr><th>Role</th><th>State</th><th>Started</th><th>Elapsed</th><th>Gates</th><th>PR</th><th>Drop</th></tr>${rows}</table>`
    : '<p class="empty">No attempts yet.</p>';
  return page(
    (s.header ?? '') +
      crumbs +
      header +
      `<h3>Attempts</h3>${attempts}` +
      `<p><a href="${escapeHtml(issueDropsHref(i))}">All drops for this issue</a></p>`,
    { title: `#${i.issueNumber} ${i.title}` },
  );
}

/** /drops: drops newest first, of one zone or all, in one state, the active ones or any. */
export function renderDropList(s: {
  zones: readonly ZoneRef[];
  zone?: string;
  /** An issue number within `zone`: the drops are that issue's. */
  issue?: number;
  state: DropFilter;
  /** Which drops by kind; issue work when absent. */
  kind?: DropKind;
  /** Already filtered, newest first, at most DROP_LIST_LIMIT. */
  drops: readonly Drop[];
  /** Work items, to name each drop's issue. */
  items: readonly WorkItem[];
  /** More drops matched than are shown. */
  limited: boolean;
  now?: Date;
}): string {
  const z = s.zone === undefined ? undefined : s.zones.find((x) => x.id === s.zone);
  const issue = z ? s.issue : undefined;
  const words = s.state === 'all' ? '' : `${stateWords(s.state)} `;
  const forIssue = issue !== undefined ? ` for #${issue}` : '';
  const where = z ? `${forIssue} in ${zoneName(z, s.zones)}` : '';
  const heading = (w: string): string =>
    z ? `${capital(`${words}drops`)}${w}` : `All ${words}drops`;
  return listPage({
    path: ACTIVITY_DROPS_HREF,
    activity: 'drops',
    title: heading(where),
    titleText: heading(z ? `${forIssue} in ${zoneNameText(z, s.zones)}` : ''),
    zones: s.zones,
    zone: z?.id,
    ...(issue !== undefined ? { issue } : {}),
    state: s.state,
    defaultState: 'all',
    states: [
      { value: 'all', label: 'All states' },
      { value: 'active', label: 'Active' },
      ...DROP_STATES.map((v) => ({ value: v, label: capital(stateWords(v)) })),
    ],
    kinds: DROP_KINDS.map((v) => ({ value: v, label: KIND_LABEL[v] })),
    kind: s.kind ?? 'work',
    defaultKind: 'work',
    head: DROP_HEAD,
    rows: dropRows(s.drops, s.items, s.zones, s.now ?? new Date()),
    empty: `No ${words}drops${where}.`,
    ...(s.limited ? { note: `Showing the newest ${DROP_LIST_LIMIT}.` } : {}),
  });
}

/** From this day the Claude token's age is a banner on home and the Credentials tab. */
export const TOKEN_BANNER_DAYS = 330;
const TOKEN_LIFE_DAYS = 365;

/** The Claude token's expiry banner, or nothing before day 330 (or when its age is unknown). */
export function tokenAgeBanner(days: number | undefined): string {
  if (days === undefined || days < TOKEN_BANNER_DAYS) return '';
  const when =
    days >= TOKEN_LIFE_DAYS
      ? 'past its one-year life: drops fail to authenticate until it is replaced'
      : `and expires around day ${TOKEN_LIFE_DAYS}`;
  return `<p class="warn token-age"><strong>The Claude token is ${days} days old</strong> ${when}. Run <code>claude setup-token</code> on your own computer and replace it under <a href="${SYSTEM_CREDENTIALS_HREF}">System, Credentials</a>.</p>`;
}

export function renderHome(state: HomeState): string {
  const now = state.now ?? new Date();
  const name = zoneNamer(state.zones);
  const starterBanner = state.zones
    .filter((z) => z.identity === 'starter')
    .map(
      (z) =>
        `<p class="warn"><strong>Starter mode in ${name(z.id)}.</strong> ${escapeHtml(STARTER_WARNING)}</p>`,
    )
    .join('');
  const setupFrame = state.setup?.active
    ? `<div class="warn setup-frame"><p><strong>Finish setting up Jumpmaster.</strong> <a href="/setup/next">Continue where you left off</a>: connect Claude and GitHub, check the runner, add a project and run the doctor.</p><form method="post" action="/setup/dismiss"><button>Dismiss</button></form></div>`
    : '';
  const addProject = state.setup?.addProject
    ? `<p class="quick"><a href="${PROJECTS_HREF}/new">Add a project</a></p>`
    : '';
  const needs = needsRows({
    zones: state.zones,
    ...(state.modes ? { modes: state.modes } : {}),
    ...(state.doctorFails ? { fails: state.doctorFails } : {}),
    ...(state.pending ? { pending: state.pending } : {}),
    ...(state.briefings ? { briefings: state.briefings } : {}),
    items: state.items,
    now,
  });
  return page(
    `<h2 class="page-h">Home</h2>` +
      `<div class="floor-head">${statusBanner(state.status)}</div>` +
      tokenAgeBanner(state.claudeTokenDays) +
      setupFrame +
      starterBanner +
      needsYouSection(needs, state.heldBriefings, state.zones, state.needsAll ?? false) +
      projectsSection(floorCounts(state, now), state.zones, addProject) +
      capacitySection(state, now) +
      pipelineSection(state, now),
    { live: true, title: 'Home', killed: state.killed ?? false, needsYou: needs.length },
  );
}

/** Home's Pipeline numbers: the Activity board's column counts, linking to its lists. */
const PIPELINE_HREF: Record<BoardColumn, string> = {
  ready: listHref(ACTIVITY_WORK_HREF, undefined, 'ready'),
  running: listHref(ACTIVITY_DROPS_HREF, undefined, 'active'),
  'in-review': listHref(ACTIVITY_WORK_HREF, undefined, 'pr_open'),
  parked: listHref(ACTIVITY_WORK_HREF, undefined, 'parked'),
  merged: listHref(ACTIVITY_WORK_HREF, undefined, 'done'),
};

/**
 * Home's Pipeline (#625): five numbers, Ready, Running, In review, Parked and Merged 24 h, each
 * the count the Activity board shows in that column (`boardColumns`), linking to Activity's list
 * filtered to it. A merge count that could not be read is "–", never 0.
 */
function pipelineSection(state: HomeState, now: Date): string {
  const cols = boardColumns({
    items: state.items,
    drops: state.drops,
    ...(state.merges24h ? { merges: state.merges24h } : {}),
    now,
  }).cols;
  const tiles = BOARD_COLUMNS.map((c) => {
    const n =
      c === 'merged' && state.merges24h === undefined
        ? '<b title="unavailable">–</b>'
        : `<b>${cols.get(c)?.length ?? 0}</b>`;
    return `<a class="tile" data-tile="${c}" href="${escapeHtml(PIPELINE_HREF[c])}">${n}<span>${BOARD_LABEL[c]}</span></a>`;
  }).join('');
  return `<section id="pipeline" class="card"><h2>Pipeline</h2><nav class="totals" aria-label="Pipeline">${tiles}</nav></section>`;
}

/** Plain status text as HTML: escaped, with `code` in backticks rendered as <code>. */
const codeHtml = (text: string): string =>
  escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * The status line: the headline, the detail behind it, every other blocker as a short item with
 * its Fix link, and the control that moves it on. Every href passes `safeHref`, as the doctor's.
 */
export function statusBanner(s: Status | undefined): string {
  if (!s) return '';
  const detail = s.detail ? `<p>${codeHtml(s.detail)}</p>` : '';
  const since = s.since ? ` <small>since ${escapeHtml(s.since)}</small>` : '';
  const also =
    s.also && s.also.length > 0
      ? `<ul class="also">${s.also
          .map(
            (a) =>
              `<li>${codeHtml(a.text)}${a.href && safeHref(a.href) ? ` <a href="${escapeHtml(a.href)}"${linkTarget(a.href)}>Fix</a>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  const action =
    s.action && safeHref(s.action.href)
      ? `<p><a href="${escapeHtml(s.action.href)}"${linkTarget(s.action.href)}>${escapeHtml(s.action.label)}</a></p>`
      : '';
  return `<div class="status" data-waiting-on="${escapeHtml(s.waitingOn)}"><p><strong>${headlineHtml(s)}</strong>${since}</p>${detail}${also}${action}</div>`;
}

/** The headline, its clock-driven part (`volatile`) in a span the live script ignores. */
function headlineHtml(s: Status): string {
  const at = s.volatile ? s.headline.lastIndexOf(s.volatile) : -1;
  if (!s.volatile || at < 0) return codeHtml(s.headline);
  const end = at + s.volatile.length;
  return `${codeHtml(s.headline.slice(0, at))}${volatile(codeHtml(s.volatile))}${codeHtml(s.headline.slice(end))}`;
}

function artifactsSection(artifacts: ArtifactRow[]): string {
  if (artifacts.length === 0) return '';
  const rows = artifacts
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.rule)}</td><td><a href="/artifacts/${a.id}">${escapeHtml(a.name)}</a></td><td>${escapeHtml(a.mediaType)}</td><td>${a.bytes}</td></tr>`,
    )
    .join('');
  return `<h2>Artifacts</h2><table><tr><th>Rule</th><th>Name</th><th>Type</th><th>Bytes</th></tr>${rows}</table>`;
}

/** The model a drop asked for and the one that served it, flagging a difference. */
function modelLines(drop: Drop): string {
  const requested = drop.requestedModel ?? null;
  const served = drop.servedModel ?? null;
  const mismatch =
    requested !== null && served !== null && requested !== served
      ? ` (mismatch: requested ${escapeHtml(requested)})`
      : '';
  return `<p>Requested model: ${escapeHtml(requested ?? '-')}<br>Served model: ${escapeHtml(served ?? '-')}${mismatch}</p>`;
}

/** Denied first, then hosts monitor let through unlisted, then allowed; busiest first within each. */
const EGRESS_ORDER: Record<string, number> = { deny: 0, unlisted: 1, allow: 2 };
const MAX_EGRESS_ROWS = 200;

/** The drop's egress events summed per host and decision, or nothing when it had none. */
function egressSection(events: StoredEvent[]): string {
  const totals = new Map<string, { host: string; decision: string; count: number }>();
  for (const e of events) {
    if (e.kind !== 'egress') continue;
    const host = typeof e.data.host === 'string' ? e.data.host : '';
    const decision = typeof e.data.decision === 'string' ? e.data.decision : 'allow';
    const count = typeof e.data.count === 'number' && e.data.count > 0 ? e.data.count : 0;
    const key = `${decision}\u0000${host}`;
    const t = totals.get(key) ?? { host, decision, count: 0 };
    t.count += count;
    totals.set(key, t);
  }
  if (totals.size === 0) return '';
  const rows = [...totals.values()]
    .sort(
      (a, b) =>
        (EGRESS_ORDER[a.decision] ?? 3) - (EGRESS_ORDER[b.decision] ?? 3) ||
        b.count - a.count ||
        a.host.localeCompare(b.host),
    )
    .slice(0, MAX_EGRESS_ROWS)
    .map(
      (t) =>
        `<tr class="egress"><td>${escapeHtml(t.host)}</td><td>${escapeHtml(t.decision)}</td><td>${t.count}</td></tr>`,
    )
    .join('');
  return `<h3>Egress</h3><table><tr><th>Host</th><th>Decision</th><th>Connections</th></tr>${rows}</table>`;
}

/** A tool result shows this many characters; the rest is stated, not shown. */
const RESULT_CHARS = 4000;
/** A tool call's one-line summary falls back to this much of its input JSON. */
const INPUT_SUMMARY_CHARS = 200;
/** The trooper's per-event cap (`MAX_EVENT_DATA_BYTES` in apps/trooper/src/events.ts). */
const CUT_MARKER = '<p class="t-cut">cut when stored (over 63 KB)</p>';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const seconds = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : null;

/** One collapsed raw-JSON line: how a shape the transcript does not know is still shown. */
const rawLine = (label: string, v: unknown): string =>
  `<details class="t-raw"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(JSON.stringify(v) ?? String(v))}</pre></details>`;

function toolUse(b: Json): string {
  const fields = isObj(b.input) ? b.input : {};
  const named = [fields.file_path, fields.command, fields.pattern].find(
    (v): v is string => typeof v === 'string',
  );
  const json = JSON.stringify(b.input ?? null);
  const summary = named ?? json.slice(0, INPUT_SUMMARY_CHARS);
  return `<div class="t-tool"><b>${escapeHtml(b.name ?? 'tool')}</b> ${escapeHtml(summary)}<details><summary>input</summary><pre>${escapeHtml(json)}</pre></details></div>`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((c) =>
      isObj(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c),
    )
    .join('\n');
}

function toolResult(b: Json): string {
  const text = resultText(b.content);
  const cut = text.length > RESULT_CHARS;
  const note = cut
    ? `<p><small>First ${RESULT_CHARS} of ${text.length} characters.</small></p>`
    : '';
  return `<details class="t-result"><summary>${b.is_error === true ? 'error' : 'result'}</summary><pre>${escapeHtml(cut ? text.slice(0, RESULT_CHARS) : text)}</pre>${note}</details>`;
}

const runEnd = (parts: unknown[]): string => {
  const shown = parts.filter((p) => p !== null && p !== undefined && p !== '').map(String);
  return `<p class="t-end">Run ended: ${escapeHtml(shown.join(', ') || 'no details')}</p>`;
};

/** A stream-json line (an `agent` event's `raw`) as transcript blocks. */
function agentRaw(raw: unknown): string {
  if (!isObj(raw)) return rawLine('agent', raw);
  const type = raw.type;
  if (type === 'result') {
    return runEnd([
      raw.subtype,
      seconds(raw.duration_ms),
      typeof raw.num_turns === 'number' ? `${raw.num_turns} turns` : null,
      typeof raw.total_cost_usd === 'number' ? `$${raw.total_cost_usd}` : null,
    ]);
  }
  const content = isObj(raw.message) ? raw.message.content : undefined;
  if ((type !== 'assistant' && type !== 'user') || !Array.isArray(content)) {
    return rawLine(`agent: ${String(type)}`, raw);
  }
  return content
    .map((b) => {
      if (isObj(b) && type === 'assistant' && b.type === 'text') {
        return `<div class="t-text"><b>Claude</b><p>${escapeHtml(b.text)}</p></div>`;
      }
      if (isObj(b) && type === 'assistant' && b.type === 'tool_use') return toolUse(b);
      if (isObj(b) && type === 'user' && b.type === 'tool_result') return toolResult(b);
      return rawLine(`${type}: ${String(isObj(b) ? b.type : typeof b)}`, b);
    })
    .join('');
}

function transcriptEvent(e: StoredEvent): string {
  const d = e.data;
  let body: string;
  if (e.kind === 'phase' && typeof d.phase === 'string') {
    body = `<div class="t-phase">${escapeHtml(d.phase)}</div>`;
  } else if (e.kind === 'gate') {
    const parts = [
      `exit ${String(d.exitCode ?? '-')}`,
      seconds(d.durationMs),
      d.timedOut === true ? 'timed out' : null,
    ].filter((p) => p !== null);
    body = `<div class="t-gate">Gate <b>${escapeHtml(d.name ?? '-')}</b>: ${escapeHtml(parts.join(', '))}<details><summary>output</summary><pre>${escapeHtml(d.outputTail ?? '')}</pre></details></div>`;
  } else if (e.kind === 'agent' && 'raw' in d) {
    body = agentRaw(d.raw);
  } else if (e.kind === 'agent' && d.result === true) {
    // The trooper stores the stream's result line as this summary, not as `raw`.
    body = runEnd([d.isError === true ? 'error' : null, d.terminalReason]);
  } else {
    body = rawLine(e.kind, d);
  }
  return body + (d.truncated === true ? CUT_MARKER : '');
}

/** The drop's stored events as a readable transcript, in seq order. Every field is escaped. */
export function transcriptSection(
  events: readonly StoredEvent[],
  pruned?: TranscriptPruned | null,
): string {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const note =
    sorted.length === 0
      ? pruned
        ? `<p>Transcript pruned on ${escapeHtml(pruned.prunedAt.slice(0, 10))}; ${
            pruned.archive === null ? 'not archived' : `archived at ${escapeHtml(pruned.archive)}`
          }.</p>`
        : '<p>No events recorded.</p>'
      : sorted.some((e) => e.kind === 'agent')
        ? ''
        : '<p>No agent transcript in this drop.</p>';
  return `<section class="transcript"><h3>Transcript</h3>${note}${transcriptBody(sorted)}</section>`;
}

/** An agent event whose stream-json line is a `system` one: init, hooks, status. */
const isSystemEvent = (e: StoredEvent): boolean =>
  e.kind === 'agent' && isObj(e.data.raw) && e.data.raw.type === 'system';

/**
 * The events in order, each run of two or more consecutive system events folded into one
 * `t-system` disclosure (#499); a lone system event, and every other event, renders as is.
 */
function transcriptBody(sorted: readonly StoredEvent[]): string {
  let html = '';
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && isSystemEvent(sorted[j] as StoredEvent)) j++;
    if (j - i >= 2) {
      const run = sorted.slice(i, j);
      html += `<details class="t-system"><summary>${run.length} system events</summary>${run.map(transcriptEvent).join('')}</details>`;
      i = j;
    } else {
      html += transcriptEvent(sorted[i] as StoredEvent);
      i++;
    }
  }
  return html;
}

/** A drop whose events retention pruned (issue #197): when, and its archive under the data dir. */
export type TranscriptPruned = { prunedAt: string; archive: string | null };

/** What the drop page knows besides the drop (#499): its work item, the zones, and now. */
export type DropContext = { item?: WorkItem; zones?: readonly ZoneRef[]; now?: Date };

/** The drop page's breadcrumb: under its issue for issue work, else under Drops. */
function dropCrumbs(drop: Drop, item: WorkItem | undefined, project: string): string {
  const short = { label: `Drop ${escapeHtml(drop.id.slice(0, 8))}` };
  return breadcrumb(
    item
      ? [
          { label: 'Activity', href: ACTIVITY_HREF },
          { label: 'Work', href: ACTIVITY_WORK_HREF },
          { label: project, href: projectWorkHref(item.dropZoneId) },
          { label: `#${escapeHtml(item.issueNumber)}`, href: workItemHref(item) },
          short,
        ]
      : [
          { label: 'Activity', href: ACTIVITY_HREF },
          { label: 'Drops', href: ACTIVITY_DROPS_HREF },
          short,
        ],
  );
}

/** The drop page's summary: project, work, state, stick, times, PR, head, gates and models. */
function dropSummary(
  drop: Drop,
  item: WorkItem | undefined,
  project: string,
  repo: string | undefined,
  now: Date,
): string {
  const time = (iso: string | null | undefined) => (iso ? relativeTime(iso, now) : '-');
  const work =
    drop.workItemId === null
      ? drop.role === 'doctor'
        ? 'doctor'
        : 'crew'
      : item
        ? `<a href="${escapeHtml(workItemHref(item))}">#${escapeHtml(item.issueNumber)} ${escapeHtml(item.title)}</a>`
        : '-';
  const fields: [string, string][] = [
    ['Project', `<a href="${escapeHtml(zoneHref(drop.dropZoneId))}">${project}</a>`],
    ['Work', work],
    ['State', badge(drop.state)],
    ['Stick', drop.stickId ? escapeHtml(drop.stickId) : '-'],
    ['Created', time(drop.createdAt)],
    ['Started', time(drop.startedAt)],
    ['Finished', time(drop.finishedAt)],
    ['Elapsed', escapeHtml(elapsed(drop, now))],
    ['PR', drop.prNumber == null ? '-' : githubRef(repo, 'pull', drop.prNumber)],
    ['Head', drop.headSha ? `<code>${escapeHtml(drop.headSha.slice(0, 7))}</code>` : '-'],
    ['Gates', gateSummary(drop)],
  ];
  const rows = fields.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return `<dl class="drop-summary">${rows}</dl>${modelLines(drop)}`;
}

export function renderDrop(
  drop: Drop,
  events: StoredEvent[],
  artifacts: ArtifactRow[] = [],
  pruned: TranscriptPruned | null = null,
  ctx: DropContext = {},
): string {
  const zones = ctx.zones ?? [];
  const now = ctx.now ?? new Date();
  const item = ctx.item && ctx.item.id === drop.workItemId ? ctx.item : undefined;
  const known = zones.find((z) => z.id === drop.dropZoneId);
  const project = zoneName(known ?? { id: drop.dropZoneId, repo: drop.dropZoneId }, zones);
  const rows = events
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.seq)}</td><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(e.kind)}</td><td><pre>${escapeHtml(JSON.stringify(e.data))}</pre></td></tr>`,
    )
    .join('');
  const id = escapeHtml(drop.id);
  const short = escapeHtml(drop.id.slice(0, 8));
  return page(
    dropCrumbs(drop, item, project) +
      `<h2 title="${id}">${escapeHtml(drop.role)} drop ${short}</h2>` +
      `<p><small><code>${id}</code></small></p>` +
      askButton({ kind: 'drop', zoneId: drop.dropZoneId, ref: drop.id }, `Drop ${short}`) +
      dropSummary(drop, item, project, known?.repo, now) +
      egressSection(events) +
      transcriptSection(events, pruned) +
      `<details class="raw-events"><summary>Raw events (${events.length})</summary><table><tr><th>Seq</th><th>Time</th><th>Kind</th><th>Data</th></tr>${rows}</table></details>` +
      artifactsSection(artifacts),
    { title: `${drop.role} drop ${drop.id.slice(0, 8)}` },
  );
}

/**
 * The base codes the server records as observations today (#621), each before any `:<suffix>`.
 * Every one has words in {@link observationWords}; a test fails when the server passes
 * `recordObservation` a code not here. A `would_` code is a decision observe mode did not carry
 * out; any other code (`adopt_refused`, `audit_skipped`) is an event that happened.
 */
export const OBSERVATION_ACTIONS = [
  'adopt_refused',
  'audit_skipped',
  'would_carry_verdict',
  'would_done',
  'would_enqueue',
  'would_merge',
  'would_park',
  'would_post_review',
  'would_update_branch',
  'would_wait',
] as const;

/** ` <it>`, or with `sep` before it, or nothing when there is no item. */
const on = (it: string, sep = ' '): string => (it ? `${sep}${it}` : '');
/** The detail, escaped, in parentheses; nothing when empty. */
const why = (detail: string): string => (detail ? ` (${escapeHtml(detail)})` : '');

/** `would_enqueue:<role>`: what starting the role's drop is, the item (HTML) given or `''`. */
const ENQUEUE_WORDS: Readonly<Record<string, (it: string) => string>> = {
  implement: (it) => `start implementing${on(it)}`,
  resume: (it) => `resume${on(it) || ' work'}`,
  review: (it) => `start reviewing${on(it)}`,
  heal: (it) => `start healing${on(it)}`,
  resolve: (it) => `start resolving conflicts${on(it, ' on ')}`,
  arbitrate: (it) => `start an arbitration${on(it, ' on ')}`,
  audit: (it) => `start an audit${on(it, ' of ')}`,
  crew: (it) => `start a crew drop${on(it, ' on ')}`,
  'crew-lead': (it) => `start a crew lead drop${on(it, ' on ')}`,
  refute: (it) => `start a refute drop${on(it, ' on ')}`,
  diagnose: (it) => `start a diagnosis${on(it, ' of ')}`,
  triage: (it) => `start triage${on(it, ' of ')}`,
};

/**
 * The words of each base code, the item (HTML) given or `''`: `told` when the sentence already
 * carries the detail, so the row need not repeat it. A `would_` code's words follow "Would "; any
 * other code's words are the whole sentence, capitalised.
 */
const OBSERVATION_WORDS: Readonly<
  Record<
    (typeof OBSERVATION_ACTIONS)[number],
    (
      it: string,
      detail: string,
      suffix: string | undefined,
    ) => { text: string; told: boolean } | undefined
  >
> = {
  adopt_refused: (it, d) => ({
    text: `Refused to adopt a pull request${on(it, ' for ')}${why(d)}`,
    told: true,
  }),
  audit_skipped: (it, d) => ({ text: `Skipped audits${on(it, ' on ')}${why(d)}`, told: true }),
  would_carry_verdict: (it) => ({
    text: `carry the verdict forward${on(it, ' on ')}`,
    told: false,
  }),
  would_done: (it, d) => ({ text: `mark ${it || 'the item'} done${why(d)}`, told: true }),
  would_enqueue: (it, _d, suffix) => {
    const words = suffix === undefined ? undefined : ENQUEUE_WORDS[suffix];
    // A role without its own words is still a drop to start, named by the role.
    const role = suffix ? ` ${escapeHtml(suffix)}` : '';
    return { text: words ? words(it) : `start a${role} drop${on(it, ' on ')}`, told: false };
  },
  would_merge: (it) => ({ text: `merge${on(it)}`, told: false }),
  would_park: (it, d) => ({ text: `park${on(it)}${why(d)}`, told: true }),
  would_post_review: (it) => ({ text: `post the review${on(it, ' on ')}`, told: false }),
  would_update_branch: (it) => ({ text: `update the branch${on(it, ' of ')}`, told: false }),
  // `blocked` and `overlap` today; the detail says on what, whatever the suffix.
  would_wait: (it, d) => ({ text: `hold${on(it) || ' work'}${why(d)}`, told: true }),
};

/**
 * An observation as the Log shows it: the row, and its item's issue number when the item is known
 * (`itemId` is the work item's id, not the issue's).
 */
export type LogObservation = Observation & { issueNumber?: number | null };

/** The item an observation is about: its issue linked to its work item page, or its id. */
function observedItem(row: Pick<LogObservation, 'zoneId' | 'itemId' | 'issueNumber'>): string {
  if (row.issueNumber !== undefined && row.issueNumber !== null) {
    const href = workItemHref({ dropZoneId: row.zoneId, issueNumber: row.issueNumber });
    return `<a href="${escapeHtml(href)}">#${escapeHtml(row.issueNumber)}</a>`;
  }
  return row.itemId === null ? '' : `item ${escapeHtml(row.itemId)}`;
}

function observationLine(
  row: Pick<LogObservation, 'zoneId' | 'itemId' | 'issueNumber' | 'action' | 'detail'>,
): { text: string; told: boolean } {
  const it = observedItem(row);
  const at = row.action.indexOf(':');
  const base = at === -1 ? row.action : row.action.slice(0, at);
  const suffix = at === -1 ? undefined : row.action.slice(at + 1);
  const known = OBSERVATION_ACTIONS.find((a) => a === base);
  const words = known ? OBSERVATION_WORDS[known](it, row.detail, suffix) : undefined;
  // A code without words is shown as it is, never dropped.
  const { text, told } = words ?? {
    text: `${escapeHtml(row.action)}${on(it, ' on ')}${why(row.detail)}`,
    told: true,
  };
  // Only a decision observe mode did not carry out is hypothetical.
  return { text: base.startsWith('would_') ? `Would ${text}` : text, told };
}

/**
 * Observe mode's record in words (#621), as HTML: `would_enqueue:implement` on issue #4154 is
 * "Would start implementing #4154", the issue linked to its work item; `adopt_refused` is
 * "Refused to adopt a pull request (…)", an event that happened. A code without words is shown
 * escaped, after "Would " only when it is a `would_` code.
 */
export function observationWords(
  row: Pick<LogObservation, 'zoneId' | 'itemId' | 'issueNumber' | 'action' | 'detail'>,
): string {
  return observationLine(row).text;
}

/** The Log's filters (#621): every entry, observe mode's only, or rulings only. */
export const LOG_KINDS = ['all', 'observed', 'rulings'] as const;
export type LogKind = (typeof LOG_KINDS)[number];
const LOG_KIND_LABELS: Record<LogKind, string> = {
  all: 'All',
  observed: 'Observed',
  rulings: 'Rulings',
};

/** A project's Log tab (#621), filtered to `kind` unless it is all. */
export const projectLogHref = (zoneId: string, kind: LogKind = 'all'): string =>
  `${projectHref(zoneId, 'log')}${kind === 'all' ? '' : `?${new URLSearchParams({ kind })}`}`;

/** One entry of the Log: when it happened, and its cells after When and Project. */
type LogEntry = { at: string; zoneId: string; kind: 'observed' | 'ruling'; cells: string };

/**
 * The Log's entries newest first, both kinds merged by time (an observation by its last time), so
 * a ruling made between two decisions sits between them.
 */
export function logEntries(
  observations: readonly LogObservation[],
  rulings: readonly Ruling[],
  now: Date,
  /** Zones whose crew is disabled: a recorded ruling that waits for the crew says so. */
  crewOff: ReadonlySet<string> = new Set(),
): LogEntry[] {
  const observed = observations.map((o): LogEntry => {
    const { text, told } = observationLine(o);
    const detail = told || !o.detail ? '' : ` <small>${escapeHtml(o.detail)}</small>`;
    return {
      at: o.lastAt,
      zoneId: o.zoneId,
      kind: 'observed',
      cells: `<td>${text}${detail}</td><td>${escapeHtml(o.count)}</td><td>${relativeTime(o.firstAt, now)}</td>`,
    };
  });
  const ruled = rulings.map((r): LogEntry => {
    const briefing = `/briefings/${encodeURIComponent(r.briefingId)}`;
    // Recorded, and held until the zone's crew is enabled again (applyPendingRulings).
    const waits = r.effect !== null && WAITS_FOR_CREW.has(r.effect) && crewOff.has(r.zoneId);
    const state = r.applyError
      ? `apply failed: ${escapeHtml(r.applyError)}`
      : r.appliedAt
        ? 'applied'
        : waits
          ? 'waiting: crew disabled'
          : 'not applied yet';
    const note = r.note ? ` · ${escapeHtml(r.note)}` : '';
    const diagnosis = r.diagnosis ? ` · diagnosis: ${escapeHtml(r.diagnosis)}` : '';
    return {
      at: r.createdAt,
      zoneId: r.zoneId,
      kind: 'ruling',
      cells:
        `<td><a href="${escapeHtml(`${briefing}#ruling-${r.id}`)}">Ruling ${escapeHtml(r.id)}</a> on ` +
        `<a href="${escapeHtml(briefing)}">Briefing ${escapeHtml(r.briefingId)}</a>: ` +
        `${escapeHtml(r.label ?? r.choice)} <small>${state}${note}${diagnosis}</small></td><td>-</td><td>-</td>`,
    };
  });
  // ISO times sort as text; the sort is stable, so equal times keep their list order.
  return [...observed, ...ruled].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * A project's Log tab (`/projects/:id/log`, with `header`) and the install-wide `/activity/log`
 * (#621): one list, newest first, of observe mode's decisions in words and the rulings. Filtered to
 * a project, the global page drops its Project column and shows the same rows as the project's tab.
 */
export function renderLog(s: {
  zones: readonly (ZoneRef & { crew?: { enabled?: boolean } })[];
  /** The project shown, on its tab or the global page filtered to it. */
  zone?: string;
  /** The project header and tab bar (`projectHeaderFor`): the page is the project's Log tab. */
  header?: string;
  kind: LogKind;
  /** Already filtered to `zone`, when given. */
  observations: readonly LogObservation[];
  /** Already filtered to `zone`, when given. */
  rulings: readonly Ruling[];
  now: Date;
}): string {
  const tab = s.header !== undefined && s.zone !== undefined;
  const name = zoneNamer(s.zones);
  const href = (zone: string | undefined, kind: LogKind): string => {
    if (tab && zone !== undefined) return projectLogHref(zone, kind);
    const q = new URLSearchParams();
    if (zone !== undefined) q.set('project', zone);
    if (kind !== 'all') q.set('kind', kind);
    const qs = q.toString();
    return qs ? `${ACTIVITY_LOG_HREF}?${qs}` : ACTIVITY_LOG_HREF;
  };
  const link = (to: string, label: string, current: boolean): string =>
    `<a href="${escapeHtml(to)}"${current ? ' aria-current="page"' : ''}>${label}</a>`;
  const kindLinks = LOG_KINDS.map((k) =>
    link(href(s.zone, k), LOG_KIND_LABELS[k], s.kind === k),
  ).join(' · ');
  const projectLinks = [
    link(href(undefined, s.kind), 'All projects', s.zone === undefined),
    ...s.zones.map((z) => link(href(z.id, s.kind), zoneName(z, s.zones), s.zone === z.id)),
  ].join(' · ');
  const entries = logEntries(
    s.kind === 'rulings' ? [] : s.observations,
    s.kind === 'observed' ? [] : s.rulings,
    s.now,
    new Set(s.zones.filter((z) => !z.crew?.enabled).map((z) => z.id)),
  );
  const withProject = s.zone === undefined;
  const rows = entries
    .map(
      (e) =>
        `<tr class="log-${e.kind}"><td>${relativeTime(e.at, s.now)}</td>${withProject ? `<td>${name(e.zoneId)}</td>` : ''}${e.cells}</tr>`,
    )
    .join('');
  const head = `<tr><th>When</th>${withProject ? '<th>Project</th>' : ''}<th>What</th><th>Count</th><th>First</th></tr>`;
  const empty = {
    all: 'Nothing logged yet.',
    observed: 'Nothing observed yet.',
    rulings: 'No rulings yet.',
  }[s.kind];
  const top = tab
    ? `${s.header}<h2>Log</h2>`
    : `${activityNav('log')}<h2>Log${s.zone === undefined ? '' : ` of ${name(s.zone)}`}</h2><nav class="filters" aria-label="Project"><p>${projectLinks}</p></nav>`;
  const titleText = s.zone === undefined ? 'Log' : `Log of ${zoneTextNamer(s.zones)(s.zone)}`;
  return page(
    `${top}<nav class="filters" aria-label="Kind"><p>${kindLinks}</p></nav>` +
      (rows ? `<table>${head}${rows}</table>` : `<p class="empty">${empty}</p>`),
    { title: titleText },
  );
}

/** The lifecycle board's columns (#622), left to right. */
export const BOARD_COLUMNS = ['ready', 'running', 'in-review', 'parked', 'merged'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
const BOARD_LABEL: Record<BoardColumn, string> = {
  ready: 'Ready',
  running: 'Running',
  'in-review': 'In review',
  parked: 'Parked',
  merged: 'Merged (24 h)',
};
/** The most cards a board column shows; the rest are "and N more", linking to the list. */
export const BOARD_COLUMN_LIMIT = 20;
const BOARD_DAY_MS = 24 * 3_600_000;

/**
 * Which column a work item is in, or none. An active drop on it means Running, whatever its state;
 * otherwise its state places it, as Floor counts it: ready, PR open (In review), parked, and done
 * with a merge in the 24 hours before `now` (Merged). An older merge is in no column.
 */
export function boardColumn(
  i: WorkItem,
  active: ReadonlySet<number>,
  mergedAt: ReadonlyMap<number, string>,
  now: Date,
): BoardColumn | undefined {
  if (active.has(i.id) || i.state === 'in_flight') return 'running';
  if (i.state === 'ready') return 'ready';
  if (i.state === 'pr_open') return 'in-review';
  if (i.state === 'parked') return 'parked';
  const at = mergedAt.get(i.id);
  if (i.state === 'done' && at !== undefined) {
    const age = now.getTime() - Date.parse(at);
    if (age >= 0 && age < BOARD_DAY_MS) return 'merged';
  }
  return undefined;
}

/**
 * The board's columns (#622): every item in the column `boardColumn` places it, Merged newest
 * first, the rest in the list's order. Home's Pipeline counts these same columns (#625).
 */
export function boardColumns(s: {
  items: readonly WorkItem[];
  drops: readonly Drop[];
  merges?: readonly { workItemId?: number | null; at: string }[];
  now: Date;
}): {
  cols: Map<BoardColumn, WorkItem[]>;
  dropOf: Map<number, Drop>;
  mergedAt: Map<number, string>;
} {
  const dropOf = new Map<number, Drop>();
  for (const d of s.drops)
    if (d.workItemId !== null && (ACTIVE_DROP_STATES as readonly string[]).includes(d.state))
      dropOf.set(d.workItemId, d);
  const mergedAt = new Map<number, string>();
  for (const m of s.merges ?? [])
    if (
      m.workItemId !== undefined &&
      m.workItemId !== null &&
      (mergedAt.get(m.workItemId) ?? '') < m.at
    )
      mergedAt.set(m.workItemId, m.at);
  const cols = new Map<BoardColumn, WorkItem[]>(BOARD_COLUMNS.map((c) => [c, []]));
  const active = new Set(dropOf.keys());
  for (const i of s.items) {
    const c = boardColumn(i, active, mergedAt, s.now);
    if (c) cols.get(c)?.push(i);
  }
  // Merged newest first; the rest keep the list's order.
  cols
    .get('merged')
    ?.sort((a, b) => (mergedAt.get(b.id) ?? '').localeCompare(mergedAt.get(a.id) ?? ''));
  return { cols, dropOf, mergedAt };
}

/**
 * `/activity` (#622): the Activity sub-nav, project filter links, and the lifecycle board: five
 * columns of work-item cards across projects, each with its count, at most BOARD_COLUMN_LIMIT
 * cards, and "and N more" linking to the filtered list.
 */
export function renderBoard(s: {
  zones: readonly ZoneRef[];
  /** The project shown, when filtered to one. */
  zone?: string;
  /** Work items, already filtered to `zone`. */
  items: readonly WorkItem[];
  /** Active drops (any of ACTIVE_DROP_STATES), already filtered to `zone`. */
  drops: readonly Drop[];
  /** Merges done in the last 24 hours, or undefined when they could not be read. */
  merges?: readonly { workItemId: number | null; at: string }[];
  details?: Map<number, ItemDetail>;
  now: Date;
}): string {
  const name = zoneNamer(s.zones);
  const repoOf = new Map(s.zones.map((z) => [z.id, z.repo]));
  const { cols, dropOf, mergedAt } = boardColumns(s);
  const detail = (c: BoardColumn, i: WorkItem): string => {
    const parts: string[] = [];
    const d = dropOf.get(i.id);
    if (c === 'running' && d)
      parts.push(`${escapeHtml(d.role)} ${escapeHtml(stateWords(d.state))}`);
    if (i.blockedBy.length > 0) parts.push(`blocked by ${escapeHtml(i.blockedBy.join(', '))}`);
    if (c === 'parked' && i.reason) parts.push(escapeHtml(i.reason));
    if (i.prNumber !== null)
      parts.push(`PR ${githubRef(repoOf.get(i.dropZoneId), 'pull', i.prNumber)}`);
    const attempts = s.details?.get(i.id)?.attempts;
    const chain = attempts ? attemptPairs(attempts) : '-';
    if (chain !== '-') parts.push(`attempts: ${chain}`);
    const at = mergedAt.get(i.id);
    if (c === 'merged' && at) parts.push(`merged ${volatile(relativeTime(at, s.now))}`);
    return parts.length > 0 ? `<span class="detail">${parts.join(' · ')}</span>` : '';
  };
  const card = (c: BoardColumn, i: WorkItem): string =>
    `<article class="board-card" data-item="${escapeHtml(`${i.dropZoneId}#${i.issueNumber}`)}"><span class="project">${name(i.dropZoneId)}</span> <a href="${escapeHtml(workItemHref(i))}">#${escapeHtml(i.issueNumber)} ${escapeHtml(i.title)}</a>${detail(c, i)}</article>`;
  const moreHref = (c: BoardColumn): string =>
    c === 'running'
      ? listHref(ACTIVITY_DROPS_HREF, s.zone, 'active')
      : listHref(
          ACTIVITY_WORK_HREF,
          s.zone,
          { ready: 'ready', 'in-review': 'pr_open', parked: 'parked', merged: 'done' }[c],
        );
  const column = (c: BoardColumn): string => {
    const all = cols.get(c) ?? [];
    const unknown = c === 'merged' && s.merges === undefined;
    const count = unknown
      ? '<span class="count" title="unavailable">–</span>'
      : `<span class="count">${all.length}</span>`;
    const rest = all.length - BOARD_COLUMN_LIMIT;
    const body = unknown
      ? '<p class="empty">Unavailable.</p>'
      : all.length === 0
        ? '<p class="empty">None.</p>'
        : all
            .slice(0, BOARD_COLUMN_LIMIT)
            .map((i) => card(c, i))
            .join('') +
          (rest > 0
            ? `<p class="more"><a href="${escapeHtml(moreHref(c))}">and ${rest} more</a></p>`
            : '');
    return `<section class="board-col" data-column="${c}"><h3>${BOARD_LABEL[c]} ${count}</h3>${body}</section>`;
  };
  const link = (to: string, label: string, current: boolean): string =>
    `<a href="${escapeHtml(to)}"${current ? ' aria-current="page"' : ''}>${label}</a>`;
  const projectLinks = [
    link(ACTIVITY_HREF, 'All projects', s.zone === undefined),
    ...s.zones.map((z) =>
      link(
        `${ACTIVITY_HREF}?${new URLSearchParams({ project: z.id })}`,
        zoneName(z, s.zones),
        s.zone === z.id,
      ),
    ),
  ].join(' · ');
  const where = s.zone === undefined ? '' : ` of ${name(s.zone)}`;
  return page(
    `${activityNav('board')}<h2>Board${where}</h2>` +
      `<nav class="filters" aria-label="Project"><p>${projectLinks}</p></nav>` +
      `<div class="board">${BOARD_COLUMNS.map(column).join('')}</div>`,
    {
      title: s.zone === undefined ? 'Board' : `Board of ${zoneTextNamer(s.zones)(s.zone)}`,
      live: true,
    },
  );
}

/** The doctor page's actions: each posts with the session's CSRF header. */
const DOCTOR_SCRIPT = `<script>for(const b of document.querySelectorAll('button[data-doctor]'))b.addEventListener('click',async()=>{b.disabled=true;const r=await jmFetch(b.dataset.doctor,JSON.parse(b.dataset.body||'{}'));b.disabled=false;if(r.ok)location.reload();else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});</script>`;

/** The readiness doctor's latest run: every check, with its fix for any that did not pass. */
export function renderDoctor(
  run: { id: number; finishedAt: string | null; checks: DoctorCheckView[] } | null,
  zones: DropZoneConfig[],
  /** A store install's zone problems (#623: shown above the check table); none in file mode. */
  problems?: readonly ZoneProblemView[],
): string {
  const head = `${systemNav('health')}<h2>Health</h2>`;
  const zoneProblems = problems ? zoneProblemsSection(problems, zones) : '';
  const name = zoneNamer(zones);
  // One doctor drop button per project, as a list under its explanation.
  const drops = zones
    .map(
      (z) =>
        `<li><button data-doctor="/api/control/doctor/drop" data-body="${escapeHtml(JSON.stringify({ zone: z.id }))}">Doctor drop: ${name(z.id)}</button></li>`,
    )
    .join('');
  const controls = `<p><button data-doctor="/api/control/doctor">Run the doctor</button></p><p>A doctor drop proves the Claude token, the clone, services and gates on a stick; it spends one turn of usage.</p>${drops ? `<ul class="doctor-drops">${drops}</ul>` : ''}${zones.length > 0 ? `<p>GitHub setup (token links, the ruleset file, CODEOWNERS): ${zones.map((z) => `<a href="${escapeHtml(githubSetupHref(z.id))}">${name(z.id)}</a>`).join(', ')}</p>` : ''}`;
  if (!run)
    return page(
      `${head}<p>No doctor run has finished yet. Run one here or with <code>jumpmaster ctl doctor</code>.</p>${controls}${zoneProblems}${DOCTOR_SCRIPT}`,
      { title: 'Health' },
    );
  const n = (s: string) => run.checks.filter((c) => c.status === s).length;
  // Fails first, then warns, then the rest, each group in the run's order.
  const rank: Record<string, number> = { fail: 0, warn: 1 };
  const ordered = run.checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rank[a.c.status] ?? 2) - (rank[b.c.status] ?? 2) || a.i - b.i)
    .map((x) => x.c);
  const rows = ordered
    .map((c) => {
      const help =
        c.status === 'pass'
          ? ''
          : `${c.action ? renderAction(c.action) : ''}${c.fix ? `<pre>${escapeHtml(c.fix)}</pre>` : ''}${c.doc ? `<div>See ${escapeHtml(c.doc)}</div>` : ''}`;
      // Ask (#627): a thread focused on this finding of this run.
      const ask = askForm(
        { kind: 'doctor', zoneId: c.zoneId ?? INSTALL_ZONE, ref: c.id },
        'Ask',
        `Doctor: ${escapeHtml(c.id)}`,
        `Ask about ${c.id}`,
      );
      return `<tr class="${escapeHtml(c.status)}"><td>${escapeHtml(c.status.toUpperCase())}</td><td>${c.zoneId === null ? '' : name(c.zoneId)}</td><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.summary)}${help}</td><td>${ask}</td></tr>`;
    })
    .join('');
  return page(
    `${head}<p>Run ${run.id}, finished ${escapeHtml(run.finishedAt ?? '-')}: ${n('pass')} pass, ${n('warn')} warn, ${n('fail')} fail, ${n('skip')} skip${n('info') > 0 ? `, ${n('info')} info` : ''}.</p>${controls}${zoneProblems}<table><tr><th>Status</th><th>Zone</th><th>Check</th><th>Finding</th><th>Ask</th></tr>${rows}</table>${DOCTOR_SCRIPT}${ASK_SCRIPT}`,
    { title: 'Health' },
  );
}

export type DoctorCheckView = {
  id: string;
  zoneId: string | null;
  status: string;
  summary: string;
  fix?: string;
  doc?: string;
  action?: DoctorAction;
};

/** A path on this server (one leading slash), or an https page: nothing else becomes a link. */
const safeHref = (href: string): boolean =>
  (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')) ||
  /^https:\/\/[^\s"'<>]+$/.test(href);

/**
 * A fail's fix control: a link to a page here or on GitHub (a new tab), or, for a write, a
 * button that POSTs with the session's CSRF header; never a link that writes on GET. A generated
 * file is offered as a download beside it.
 */
function renderAction(a: DoctorAction): string {
  let control = '';
  if (a.method === 'POST' && safeHref(a.href) && a.href.startsWith('/'))
    control = `<button data-doctor="${escapeHtml(a.href)}" data-body="${escapeHtml(JSON.stringify(a.body ?? {}))}">${escapeHtml(a.label)}</button>`;
  else if (!a.method && safeHref(a.href))
    control = `<a href="${escapeHtml(a.href)}"${linkTarget(a.href)}>${escapeHtml(a.label)}</a>`;
  const file = a.artifact
    ? ` <a download="${escapeHtml(a.artifact.filename)}" href="data:text/plain;charset=utf-8,${encodeURIComponent(a.artifact.text)}">Download ${escapeHtml(a.artifact.filename)}</a>`
    : '';
  return control || file ? `<div class="action">${control}${file}</div>` : '';
}

/** The helpers both intake forms' scripts share; server text is shown with textContent only. */
const FORM_HELPERS = `const base = root.dataset.base;
const lines = (id) => document.getElementById(id).value.split('\\n').map((s) => s.trim()).filter(Boolean);
const val = (id) => document.getElementById(id).value.trim();
const say = (id, text) => { document.getElementById(id).textContent = text; };
async function call(path, body) {
  const r = await jmFetch(base + path, body);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}`;

/** The GOAL.md stub builder's script: render the stub, then copy it. */
export const STUB_SCRIPT = `<script>
const root = document.getElementById('intake');
${FORM_HELPERS}
document.getElementById('stub-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { template: val('stub-template'), lighthouse: val('stub-lighthouse'), objectives: lines('stub-objectives') };
  const nonGoals = lines('stub-nongoals'); if (nonGoals.length) body.nonGoals = nonGoals;
  const constraints = lines('stub-constraints'); if (constraints.length) body.constraints = constraints;
  const r = await call('/goal-stub', body);
  if (r.status !== 200) { say('stub-status', 'Refused: ' + r.status + ' ' + (r.body.error ?? '')); return; }
  document.getElementById('stub-out').value = r.body.markdown;
  say('stub-status', 'Rendered. Copy it into GOAL.md and open a pull request (step 2).');
});
document.getElementById('stub-copy').addEventListener('click', () => navigator.clipboard.writeText(document.getElementById('stub-out').value));
</script>`;

/**
 * The New issue page's script. The idempotency key is minted per submit and kept in sessionStorage
 * under a hash of the form's content until the server confirms, so a retry or a reload and
 * resubmit of the same content reuses it; the helpers are the tested ones, embedded by source.
 * A filing links the issue and offers "File another", which clears the form.
 */
export const ISSUE_SCRIPT = `<script>
const submitKey = ${submitKey.toString()};
const forgetSubmitKey = ${forgetSubmitKey.toString()};
const root = document.getElementById('new-issue');
${FORM_HELPERS}
const form = document.getElementById('issue-form');
const again = document.getElementById('issue-again');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const issue = { title: val('issue-title'), context: val('issue-context'), acceptance: lines('issue-acceptance'), tests: lines('issue-tests') };
  const out = lines('issue-out'); if (out.length) issue.outOfScope = out;
  const content = JSON.stringify(issue);
  const idempotencyKey = submitKey(sessionStorage, content, () => crypto.randomUUID());
  const button = e.submitter; if (button) button.disabled = true;
  const r = await call('/issue', { idempotencyKey, ...issue });
  if (button) button.disabled = false;
  if (r.status === 200 || r.status === 201) {
    forgetSubmitKey(sessionStorage, content);
    if (r.body.number != null) {
      const a = document.createElement('a');
      a.href = root.dataset.issues + Number(r.body.number);
      a.textContent = 'issue #' + Number(r.body.number);
      document.getElementById('issue-status').replaceChildren('Filed as ', a, ', ready. It starts on the next pass.');
    } else say('issue-status', 'Already filed (' + r.body.state + ').');
    again.hidden = false;
  } else if (r.status === 502) {
    forgetSubmitKey(sessionStorage, content);
    say('issue-status', 'Nothing was filed: ' + (r.body.error ?? 'GitHub refused it') + ' Submitting again starts a fresh filing.');
  } else if (r.status === 202) {
    say('issue-status', 'The forge has not confirmed the issue yet. Submit again: the same key is reused, so it is never filed twice.');
  } else {
    say('issue-status', 'Refused: ' + r.status + ' ' + (r.body.error ?? ''));
  }
});
again.addEventListener('click', () => {
  form.reset();
  document.getElementById('issue-status').replaceChildren();
  again.hidden = true;
  document.getElementById('issue-title').focus();
});
</script>`;

const intakeField = (id: string, label: string, input: string) =>
  `<p><label for="${id}">${label}</label><br>${input}</p>`;
const intakeArea = (id: string, rows: number, required = false) =>
  `<textarea id="${id}" rows="${rows}" cols="80"${required ? ' required' : ''}></textarea>`;
const intakeBase = (zone: ZoneRef) => `/api/control/zones/${encodeURIComponent(zone.id)}/intake`;

/**
 * The GOAL.md stub builder (#620), a section of Goals: the stub, then how to commit it; issues are
 * filed on New issue. Collapsed unless the project has no goal file yet (`open`).
 */
export function goalStub(zone: ZoneRef, open: boolean): string {
  const field = intakeField;
  const area = intakeArea;
  const goal = `<h3>Step 1: the goal</h3><form id="stub-form">${field(
    'stub-template',
    'Where the project starts',
    `<select id="stub-template">${[
      ['existing', 'An existing codebase'],
      ['idea', 'An idea, nothing built yet'],
      ['partial', 'Partly built'],
    ]
      .map(([v, l]) => `<option value="${v}">${l}</option>`)
      .join('')}</select>`,
  )}${field('stub-lighthouse', 'Lighthouse: what the project is for, in a few sentences', area('stub-lighthouse', 4, true))}${field('stub-objectives', 'Objectives, one per line, first first (at most 5)', area('stub-objectives', 5, true))}${field('stub-nongoals', 'Non-goals, one per line (optional)', area('stub-nongoals', 3))}${field('stub-constraints', 'Constraints, one per line (optional)', area('stub-constraints', 3))}<button>Render the stub</button> <span id="stub-status"></span></form>`;
  const commit = `<h3>Step 2: commit it by pull request</h3><p>GOAL.md is a protected path, so no agent may write it and Jumpmaster doesn't commit it either. Copy the stub, then on a branch of ${escapeHtml(zone.repo)}: save it as GOAL.md, commit, push, open a pull request, and merge it yourself. The crew reads it once it is on the default branch.</p><p><textarea id="stub-out" rows="16" cols="80" readonly></textarea><br><button type="button" id="stub-copy">Copy</button></p>`;
  const next = `<p>To file an issue, use <a href="${escapeHtml(zoneHref(zone.id))}/issues/new"><strong>New issue</strong></a>.</p>`;
  return `<details id="goal-stub"${open ? ' open' : ''}><summary>Draft a GOAL.md</summary><div id="intake" data-base="${escapeHtml(intakeBase(zone))}">${goal}${commit}</div>${next}${STUB_SCRIPT}</details>`;
}

/** The New issue page: one ready issue, filed under objective 1 as soon as it is submitted. */
export function renderNewIssue(
  zone: ZoneRef,
  zones: readonly ZoneRef[] = [zone],
  /** The project header and tab bar (#616), in place of the link back to the project. */
  header?: string,
): string {
  const field = intakeField;
  const area = intakeArea;
  const form = `<p>Filed ready, under objective 1, as soon as you submit: it doesn't need GOAL.md merged first.</p><form id="issue-form">${field('issue-title', 'Title (at most 120 characters)', '<input id="issue-title" size="80" maxlength="120" required>')}${field('issue-context', 'Context', area('issue-context', 6, true))}${field('issue-acceptance', 'Acceptance criteria, one per line', area('issue-acceptance', 5, true))}${field('issue-tests', 'Required tests, one per line', area('issue-tests', 3, true))}${field('issue-out', 'Out of scope, one per line (optional)', area('issue-out', 3))}<button>File the issue</button> <span id="issue-status" role="status"></span> <button type="button" id="issue-again" hidden>File another</button></form>`;
  return page(
    `${header ?? `<p><a href="${escapeHtml(zoneHref(zone.id))}">${zoneName(zone, zones)}</a></p>`}<h2>New issue: ${zoneName(zone, zones)}</h2><div id="new-issue" data-base="${escapeHtml(intakeBase(zone))}" data-issues="${escapeHtml(issueUrl(zone.repo, 0).replace(/0$/, ''))}">${form}</div>${ISSUE_SCRIPT}`,
  );
}
