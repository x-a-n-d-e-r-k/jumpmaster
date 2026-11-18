import type { ArtifactRow } from '../artifacts.js';
import {
  type About,
  type Briefing,
  effectText,
  HELD_MODES,
  type HeldZone,
  issueUrl,
  optionsDigest,
  type Ruling,
  WAITS_FOR_CREW,
} from '../briefings.js';
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
import { currentObjective, type GoalRow } from '../goals.js';
import { forgetSubmitKey, submitKey } from '../intake.js';
import type { Status } from '../status.js';
import type { Gate } from '../usage.js';
import { floorCounts, sticksSummary, totalsStrip, zoneCards } from './floor.js';
import { linkTarget } from './links.js';
import { STYLE } from './theme.js';
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
  merges24h?: Array<{ zoneId: string; at: string }>;
  /** Open briefings, for "Waiting on you": a paused or observing zone's are held back. */
  briefings?: Briefing[];
  /** The zones whose briefings are held back, one collapsed line each. */
  heldBriefings?: HeldZone[];
  /** One line per zone about its crew. */
  crew?: CrewLine[];
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

/**
 * A floor card: an eyebrow with the plain-English name (§4: the UI says each airborne term in
 * plain words too), the section's heading, and its body.
 */
const card = (plain: string, heading: string, body: string, cls = ''): string =>
  `<section class="card${cls ? ` ${cls}` : ''}"><span class="term">${plain}</span>${heading}${body}</section>`;

/** The kill control. It posts with the session's CSRF header, so a page visit cannot trigger it. */
function killSection(killed: boolean): string {
  const label = killed ? 'Reset kill switch' : 'Engage kill switch';
  return `<div class="kill"><h2>Kill switch</h2><form id="kill"><button class="${killed ? 'primary' : 'danger'}">${label}</button></form><script>document.getElementById('kill').addEventListener('submit',async(e)=>{e.preventDefault();const r=await jmFetch('/api/control/kill',{engaged:${killed ? 'false' : 'true'}});if(r.ok)location.reload();else alert('Refused: '+r.status);});</script></div>`;
}

/** The engaged kill switch, said first and in red: nothing else on the floor matters as much. */
const KILLED_NOTICE =
  '<div class="kill-on" role="alert"><p><strong>The kill switch is engaged.</strong> No work runs and no forge writes happen. Forge and Claude tokens stay valid until you revoke them with their providers.</p></div>';

/** The credits stop, in words: why nothing leases, or the Resume in force. */
function creditsLine(u: NonNullable<HomeState['usage']>): string | null {
  const s = u.state;
  if (u.gate === 'stopped') {
    return `stopped: drop ${s.overageDropId} ran on usage credits at ${s.overageStoppedAt}. Nothing leases, reviews included, until ${s.overageUntil} (the exhausted window resets) or you rule Run on credits.`;
  }
  if (u.gate === 'credits_resume') {
    const n = u.creditDropsSinceResume ?? 0;
    return `resumed on credits until ${s.overageResumeUntil}; ${n} drop${n === 1 ? '' : 's'} reported credits since. Only the resumed work item's drops lease.`;
  }
  const lifted = s.overageProbeSince ?? s.overageUntil ?? s.overageResumeUntil;
  if (u.gate === 'probe' && lifted !== null) {
    return `probing: the credits stop ended at ${lifted}; one drop runs until a drop reports running in plan.`;
  }
  return null;
}

/** A utilisation meter: the figure, and a bar that warms at 80% and goes red at 95%. */
function meter(label: string, v: number | null, note?: string): string {
  const w = v === null ? 0 : Math.min(100, Math.max(0, Math.round(v * 100)));
  const tone = v === null ? '' : v >= 0.95 ? ' class="full"' : v >= 0.8 ? ' class="hot"' : '';
  const small = note ? `<small class="note">${escapeHtml(note)}</small>` : '';
  return `<div class="meter"><div class="meter-row"><span>${escapeHtml(label)}</span><b>${pct(v)}</b></div>${small}<div class="bar" role="presentation"><i${tone} style="width:${w}%"></i></div></div>`;
}

/** The windows usage_state already carries, read by the gate. */
const GATE_WINDOWS = new Set(['five_hour', 'seven_day']);

/**
 * Windows that belong to one model the key does not name (#377): `seven_day_overage_included` is
 * Claude's "per-model bucket", labelled by the model of the drop that reported it.
 */
export const PER_MODEL_WINDOWS = new Set(['seven_day_overage_included']);

/** A model id's family: `claude-fable-5-2` reads `Fable`; null for any other shape. */
export function modelFamily(model: string | null): string | null {
  const m = model === null ? null : /^claude-([a-z]+)-/.exec(model);
  const f = m?.[1];
  return f ? f[0]?.toUpperCase() + f.slice(1) : null;
}

/** The Fable window: its key names Fable, or it is a per-model window a Fable drop reported. */
const isFableWindow = (row: UsageWindowRow): boolean =>
  row.key.includes('fable') ||
  (PER_MODEL_WINDOWS.has(row.key) && modelFamily(row.model) === 'Fable');
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

/** The Fable window: the one whose key names Fable, the most recently observed if several. */
function fableWindow(windows: readonly UsageWindowRow[]): UsageWindowRow | undefined {
  return windows
    .filter(isFableWindow)
    .reduce<UsageWindowRow | undefined>(
      (best, w) =>
        best === undefined || (w.observedAt ?? '') > (best.observedAt ?? '') ? w : best,
      undefined,
    );
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

function usageSection(u: HomeState['usage']): string {
  if (!u) return '';
  const s = u.state;
  const row = (k: string, v: unknown) => `<dt>${k}</dt><dd>${escapeHtml(v ?? '-')}</dd>`;
  const credits = creditsLine(u);
  return card(
    'Claude subscription',
    '<h2>Usage</h2>',
    usageMeters(u) +
      '<dl class="kv">' +
      row('Gate', u.gate) +
      (credits ? row('Credits', credits) : '') +
      row('Overage status', u.overageStatus) +
      row('Status', s.status) +
      row('Paused until', s.pausedUntil) +
      row('Observed', s.observedAt) +
      row('Cause drop', s.causeDropId) +
      '</dl>',
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A zone's page. */
export const zoneHref = (id: string): string => `/zones/${encodeURIComponent(id)}`;

/** A file on GitHub at the default branch, each segment of the repo and path URI-encoded. */
const githubBlobHref = (repo: string, path: string): string => {
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${enc(repo)}/blob/HEAD/${enc(path)}`;
};

/** A zone's briefings view: where the floor's held line and the zone page link. */
export const zoneBriefingsHref = (zoneId: string): string =>
  `/briefings?zone=${encodeURIComponent(zoneId)}`;

/** The page sizes the briefings pages offer (#132); anything else is the first. */
export const PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageParams = { per: number; page: number; rpage: number };

const positiveInt = (v: unknown): number =>
  typeof v === 'string' && /^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : 1;

/**
 * The briefings pages' paging: `per` among PAGE_SIZES, else 10; `page` and `rpage` positive
 * integers, else 1. Never refused: a stale bookmark still opens a page. Clamping to the last page
 * is the renderer's, which knows the counts.
 */
export function pageParams(q: { per?: unknown; page?: unknown; rpage?: unknown }): PageParams {
  const per = PAGE_SIZES.find((n) => String(n) === q.per) ?? PAGE_SIZES[0];
  return { per, page: positiveInt(q.page), rpage: positiveInt(q.rpage) };
}

/** A project's open briefings (newest first) and rulings, as the briefings pages group them. */
type Project = { id: string; text: string; mode: string; open: Briefing[]; rulings: Ruling[] };

const newestFirst = <T extends { id: number }>(xs: readonly T[]): T[] =>
  [...xs].sort((x, y) => y.id - x.id);

/** Most open briefings first, ties by repository name: the order of sections and floor lines. */
const byWaiting = (a: Project, b: Project): number =>
  b.open.length - a.open.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);

/**
 * One project per configured zone, and per zone still named by a briefing or ruling though no
 * longer configured.
 */
function projectsOf(
  zones: readonly (ZoneRef & { mode?: string })[],
  open: readonly Briefing[],
  rulings: readonly Ruling[],
  modes: Readonly<Record<string, string>> = {},
): Project[] {
  const text = zoneTextNamer(zones);
  const byId = new Map<string, Project>();
  const at = (id: string, mode?: string): Project => {
    let p = byId.get(id);
    if (!p) {
      p = { id, text: text(id), mode: modes[id] ?? mode ?? 'active', open: [], rulings: [] };
      byId.set(id, p);
    }
    return p;
  };
  for (const z of zones) at(z.id, z.mode);
  for (const b of newestFirst(open)) at(b.zoneId).open.push(b);
  for (const r of newestFirst(rulings)) at(r.zoneId).rulings.push(r);
  return [...byId.values()];
}

/**
 * The home page's Waiting on you card: one line per project with open briefings, counted and
 * linking to that project's briefings, in the order of the /briefings sections. No briefing's text
 * shows here. A paused or observing zone's briefings are not counted: it gets one held line.
 */
export function waitingOnYou(
  open: Briefing[],
  held: HeldZone[] = [],
  zones: readonly ZoneRef[] = [],
): string {
  const name = zoneNamer(zones);
  const heldLines =
    held.length === 0
      ? ''
      : `<ul class="held">${held
          .map(
            (z) =>
              `<li><a href="${escapeHtml(zoneBriefingsHref(z.zoneId))}">${name(z.zoneId, z.repo)}: ${escapeHtml(z.mode)}, ${plural(z.count, 'briefing')} held</a></li>`,
          )
          .join('')}</ul>`;
  if (open.length === 0) {
    return card(
      'Briefings',
      '<h2>Waiting on you</h2>',
      `<p class="empty">Nothing is waiting on you. <a href="/briefings">Briefings and rulings</a></p>${heldLines}`,
    );
  }
  const rows = projectsOf(zones, open, [])
    .filter((p) => p.open.length > 0)
    .sort(byWaiting)
    .map(
      (p) =>
        `<li><a href="${escapeHtml(zoneBriefingsHref(p.id))}">${name(p.id)}: ${p.open.length} waiting</a></li>`,
    )
    .join('');
  return card(
    'Briefings',
    '<h2>Waiting on you</h2>',
    `<p>${plural(open.length, 'decision')} waiting. <a href="/briefings">Answer them on the briefings page</a>.</p><ul>${rows}</ul>${heldLines}`,
    'attention',
  );
}

function crewSection(lines: CrewLine[] | undefined, name: (id: string) => string): string {
  if (!lines || lines.length === 0) return '';
  const rows = lines
    .map(
      (c) =>
        `<tr><td>${name(c.zoneId)}</td><td>${c.enabled ? 'on' : 'off'}</td><td>${escapeHtml(c.lastCycle ?? '-')}</td><td>${escapeHtml(c.enabled ? (c.nextDue ?? 'now') : '-')}</td><td>${escapeHtml(c.fable)}</td><td><a href="/zones/${encodeURIComponent(c.zoneId)}/goals">Goals</a> <a href="/zones/${encodeURIComponent(c.zoneId)}/intake">Intake</a></td></tr>`,
    )
    .join('');
  return card(
    'Per-project judgment agents',
    '<h2>Crew</h2>',
    `<table><tr><th>Zone</th><th>Crew</th><th>Last cycle</th><th>Next due</th><th>Fable</th><th></th></tr>${rows}</table>`,
  );
}

/** The sticks, collapsed: a summary line, the table inside (`#sticks`, where the status links). */
function sticksSection(
  lines: StickLine[] | undefined,
  name: (id: string) => string,
  now: Date,
): string {
  if (!lines) return '';
  const body =
    lines.length === 0
      ? '<p class="empty">No stick has enrolled.</p>'
      : `<table><tr><th>Stick</th><th>Version</th><th>Last seen</th><th>Capabilities</th><th>Image policy</th><th>Zones</th></tr>${lines
          .map((s) => {
            const runs =
              s.cannotRun.length === 0
                ? 'all zones'
                : s.cannotRun
                    .map(
                      (c) =>
                        `cannot run ${name(c.zoneId)}: lacks ${escapeHtml(c.missing.join(', '))}`,
                    )
                    .join('<br>');
            return `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.version ?? '-')}</td><td>${escapeHtml(s.lastSeenAt ?? 'never')}</td><td>${escapeHtml(s.capabilities.join(', ') || '-')}</td><td>${escapeHtml(s.imagePolicy)}</td><td>${runs}</td></tr>`;
          })
          .join('')}</table>`;
  const manage = '<p><a href="/sticks">Set each stick\'s troopers on the sticks page</a></p>';
  return `<details id="sticks" class="card sticks"><summary>${escapeHtml(sticksSummary(lines, now))}</summary>${body}${manage}</details>`;
}

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
  /** Where `Ruling n` links; else its row on /briefings. */
  rulingHref?: (n: number) => string;
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
        word === 'Ruling'
          ? (refs.rulingHref?.(n) ?? `/briefings#ruling-${n}`)
          : (refs.briefingHref?.(n) ?? `/briefings/${n}`);
      out += anchor(href, all);
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
};

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
  const form =
    b.state === 'open'
      ? `<form class="rule" data-briefing="${escapeHtml(b.id)}" data-options="${optionsDigest(b)}">${options}<textarea name="note" maxlength="2000" placeholder="Note (optional)"></textarea><br><button>Rule</button></form>`
      : `<p>${escapeHtml(b.state)}</p><ul>${b.options.map((o) => `<li>${escapeHtml(o.label)} <small><code>${escapeHtml(o.id)}</code></small> <small class="effect">${escapeHtml(effectText(b.kind, o.effect))}</small></li>`).join('')}</ul>`;
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
 * Dismisses all the zone's open briefings, every page of them, after a confirmation that states
 * the count. It posts the ids it was rendered with, so a briefing raised since is not dismissed
 * unseen.
 */
function dismissAllForm(zoneId: string, open: Briefing[], zones: readonly ZoneRef[]): string {
  const what = `${plural(open.length, 'briefing')} of`;
  const ask = `Dismiss ${what} ${zoneTextNamer(zones)(zoneId)}? Each is taken off the floor without a ruling: nothing it is about is ruled on, and nothing is written to GitHub.`;
  return `<form id="dismiss-all" data-zone="${escapeHtml(zoneId)}" data-ids="${escapeHtml(JSON.stringify(open.map((b) => b.id)))}" data-ask="${escapeHtml(ask)}"><button class="danger">Dismiss all ${escapeHtml(what)} ${zoneNamer(zones)(zoneId)}</button></form><script>{const f=document.getElementById('dismiss-all');f.addEventListener('submit',async(e)=>{e.preventDefault();if(!confirm(f.dataset.ask))return;const r=await jmFetch('/api/control/zones/'+encodeURIComponent(f.dataset.zone)+'/briefings/dismiss',{ids:JSON.parse(f.dataset.ids)});if(r.ok)location.reload();else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});}</script>`;
}

/** A /briefings URL, unescaped: the zone id is URL-encoded, a page of 1 or less is left out. */
function briefingsHref(q: { zone?: string; per: number; page?: number; rpage?: number }): string {
  const parts = [
    ...(q.zone !== undefined ? [`zone=${encodeURIComponent(q.zone)}`] : []),
    `per=${q.per}`,
    ...(q.page !== undefined ? [`page=${q.page}`] : []),
    ...(q.rpage !== undefined ? [`rpage=${q.rpage}`] : []),
  ];
  return `/briefings?${parts.join('&')}`;
}

/** The page-size links; each keeps the zone and starts again at page 1. */
function sizeSelector(zone: string | undefined, per: number): string {
  const links = PAGE_SIZES.map(
    (n) =>
      `<a href="${escapeHtml(briefingsHref({ ...(zone !== undefined ? { zone } : {}), per: n }))}"${n === per ? ' aria-current="page"' : ''}>${n}</a>`,
  ).join(' · ');
  return `<nav class="filters" aria-label="Page size"><p>Per page: ${links}</p></nav>`;
}

/** One page of `xs`, clamped to the last page, and its Previous / Page X of Y / Next line. */
function paged<T>(
  xs: readonly T[],
  per: number,
  asked: number,
  label: string,
  href: (page: number) => string,
): { rows: T[]; nav: string } {
  const pages = Math.max(1, Math.ceil(xs.length / per));
  const at = Math.min(Math.max(1, asked), pages);
  const link = (n: number, text: string) => `<a href="${escapeHtml(href(n))}">${text}</a>`;
  const nav = [
    ...(at > 1 ? [link(at - 1, 'Previous')] : []),
    `Page ${at} of ${pages}`,
    ...(at < pages ? [link(at + 1, 'Next')] : []),
  ].join(' · ');
  return {
    rows: xs.slice((at - 1) * per, at * per),
    nav: `<nav class="pager" aria-label="${label}"><p>${nav}</p></nav>`,
  };
}

const RULINGS_HEAD =
  '<tr><th>Ruling</th><th>Zone</th><th>Briefing</th><th>Choice</th><th>Note</th><th>Ruled</th><th>Applied</th><th>Error</th><th>Diagnosis</th></tr>';

/** Briefings waiting on Command, with a rule form each, and the rulings recorded so far. */
export function renderBriefings(s: {
  open: Briefing[];
  rulings: Ruling[];
  zones: DropZoneConfig[];
  /** Hold-until per subject, for held refute promotions. */
  holds?: Map<string, string>;
  /** One zone's view (`open` and `rulings` are that zone's): paged, with the bulk dismiss. */
  zone?: { id: string; mode: string };
  /** Each zone's mode as stored (getZoneMode), for the all-projects view; else its config's. */
  modes?: Readonly<Record<string, string>>;
  per?: number;
  page?: number;
  rpage?: number;
  /** Each briefing's subject resolved (briefingAbout), by briefing id; else the raw subject. */
  about?: ReadonlyMap<number, About>;
  /** Each zone's filed crew issues by key (crewKeyNumbers), by zone id. */
  crewKeys?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}): string {
  const name = zoneNamer(s.zones);
  const per = s.per ?? PAGE_SIZES[0];
  const crewOff = new Set(s.zones.filter((z) => !z.crew?.enabled).map((z) => z.id));
  // Recorded, and held until the zone's crew is enabled again (applyPendingRulings).
  const waiting = (r: Ruling) =>
    r.appliedAt === null &&
    r.applyError === null &&
    r.effect !== null &&
    WAITS_FOR_CREW.has(r.effect) &&
    crewOff.has(r.zoneId);
  const rulingRows = (rs: readonly Ruling[]) =>
    rs
      .map(
        (r) =>
          `<tr id="ruling-${escapeHtml(r.id)}"><td>${escapeHtml(r.id)}</td><td>${name(r.zoneId)}</td><td>${escapeHtml(r.briefingId)}</td><td>${escapeHtml(r.choice)}</td><td>${escapeHtml(r.note)}</td><td>${escapeHtml(r.createdAt)}</td><td>${escapeHtml(r.appliedAt ?? (waiting(r) ? 'waiting: crew disabled' : '-'))}</td><td>${escapeHtml(r.applyError ?? '')}</td><td>${escapeHtml(r.diagnosis ?? '')}</td></tr>`,
      )
      .join('');
  // What this page shows, so a reference to it is an anchor here and to anything else a link away.
  const shown = { briefings: new Set<number>(), rulings: new Set<number>() };
  const ctx: BlockContext = {
    holds: s.holds,
    name,
    about: s.about,
    refs: briefingRefs(s.zones, s.rulings, s.crewKeys, shown),
  };
  const blocks = (bs: readonly Briefing[], heading: 'h3' | 'h4') =>
    bs.map((b) => briefingBlock(b, ctx, heading)).join('');

  if (s.zone) {
    const zone = s.zone.id;
    const open = newestFirst(s.open);
    const rulings = newestFirst(s.rulings);
    const b = paged(open, per, s.page ?? 1, 'Briefing pages', (page) =>
      briefingsHref({ zone, per, page }),
    );
    const r = paged(
      rulings,
      per,
      s.rpage ?? 1,
      'Ruling pages',
      (rpage) => `${briefingsHref({ zone, per, rpage })}#rulings`,
    );
    for (const x of b.rows) shown.briefings.add(x.id);
    for (const x of r.rows) shown.rulings.add(x.id);
    const list =
      open.length === 0 ? '<p>Nothing is waiting on you.</p>' : blocks(b.rows, 'h3') + RULE_SCRIPT;
    return page(
      `<p><a href="/">Back</a> · <a href="/briefings">All briefings</a></p><h2>Briefings of ${name(zone)} <small>(${escapeHtml(s.zone.mode)})</small></h2>` +
        (open.length > 0 ? dismissAllForm(zone, s.open, s.zones) : '') +
        sizeSelector(zone, per) +
        list +
        (open.length > 0 ? b.nav : '') +
        `<h2 id="rulings">Rulings (decisions recorded)</h2>` +
        (rulings.length === 0
          ? '<p class="empty">No rulings yet.</p>'
          : `<table>${RULINGS_HEAD}${rulingRows(r.rows)}</table>${r.nav}`),
    );
  }

  const projects = projectsOf(s.zones, s.open, s.rulings, s.modes);
  const held = (p: Project) => HELD_MODES.has(p.mode) && p.open.length > 0;
  const busy = projects.filter((p) => !held(p) && p.open.length > 0).sort(byWaiting);
  const quiet = projects.filter((p) => p.open.length === 0).sort(byWaiting);
  const heldOnes = projects.filter(held).sort(byWaiting);
  const total = busy.reduce((n, p) => n + p.open.length, 0);
  for (const p of projects) {
    for (const x of p.open.slice(0, per)) shown.briefings.add(x.id);
    for (const x of p.rulings.slice(0, per)) shown.rulings.add(x.id);
  }

  const showAll = (p: Project) =>
    p.open.length > per
      ? `<p><a href="${escapeHtml(briefingsHref({ zone: p.id, per }))}">Show all ${p.open.length} in ${name(p.id)}</a></p>`
      : '';
  const rulingsOf = (p: Project) =>
    `<details class="rulings"><summary>Rulings (${p.rulings.length})</summary>` +
    (p.rulings.length === 0
      ? '<p class="empty">No rulings yet.</p>'
      : `<table>${RULINGS_HEAD}${rulingRows(p.rulings.slice(0, per))}</table>`) +
    (p.rulings.length > per
      ? `<p><a href="${escapeHtml(`${briefingsHref({ zone: p.id, per })}#rulings`)}">All ${p.rulings.length} rulings of ${name(p.id)}</a></p>`
      : '') +
    '</details>';
  // Each section ends with a marker, so a section can be told from the next in tests.
  const sections = [
    ...busy.map(
      (p) =>
        `<section class="project" data-zone="${escapeHtml(p.id)}"><h3>${name(p.id)} ${badge(p.mode)} <small>${p.open.length} waiting</small></h3>${blocks(p.open.slice(0, per), 'h4')}${showAll(p)}${rulingsOf(p)}</section><!--/project-->`,
    ),
    ...quiet.map(
      (p) =>
        `<section class="project quiet" data-zone="${escapeHtml(p.id)}"><p>${name(p.id)} ${badge(p.mode)} Nothing waiting</p>${rulingsOf(p)}</section><!--/project-->`,
    ),
    ...heldOnes.map(
      (p) =>
        `<details class="project held" data-zone="${escapeHtml(p.id)}"><summary>${name(p.id)}: ${p.open.length} held while ${escapeHtml(p.mode)}</summary>${blocks(p.open.slice(0, per), 'h4')}${showAll(p)}${rulingsOf(p)}</details><!--/project-->`,
    ),
  ].join('');
  const anyBlock = busy.length > 0 || heldOnes.length > 0;
  return page(
    '<p><a href="/">Back</a></p><h2>Briefings (decisions waiting on you)</h2>' +
      (total === 0
        ? '<p>Nothing is waiting on you.</p>'
        : `<p>${plural(total, 'decision')} waiting.</p>`) +
      sizeSelector(undefined, per) +
      sections +
      (anyBlock ? RULE_SCRIPT : ''),
  );
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
    return b === undefined ? `/briefings#ruling-${n}` : `/briefings/${b}#ruling-${n}`;
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
  };
  const rows = own
    .map(
      (r) =>
        `<tr id="ruling-${escapeHtml(r.id)}"><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.label ?? r.choice)} <small><code>${escapeHtml(r.choice)}</code></small></td><td>${escapeHtml(r.note)}</td><td>${escapeHtml(r.createdAt)}</td><td>${escapeHtml(r.appliedAt ?? '-')}</td><td>${escapeHtml(r.applyError ?? '')}</td></tr>`,
    )
    .join('');
  return page(
    `<p><a href="/briefings">All briefings</a> · <a href="${escapeHtml(zoneBriefingsHref(b.zoneId))}">Briefings of ${name(b.zoneId)}</a></p><h2>Briefing ${escapeHtml(b.id)}</h2>` +
      briefingBlock(b, ctx, 'h3') +
      (b.state === 'open' ? RULE_SCRIPT : '') +
      `<h3 id="rulings">Rulings</h3>` +
      (own.length === 0
        ? '<p class="empty">No ruling on this briefing.</p>'
        : `<table><tr><th>Ruling</th><th>Choice</th><th>Note</th><th>Ruled</th><th>Applied</th><th>Error</th></tr>${rows}</table>`),
  );
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
}): string {
  const path = s.zone.crew?.goalPath ?? 'GOAL.md';
  const missing = s.goals?.parse.ok === false && s.goals.parse.error === `${path} not found`;
  // Until the goal can change in the app (#336), the owner edits it on GitHub: a protected path.
  const edit = missing
    ? `<p>${escapeHtml(path)} isn't in the repository yet. <a href="${escapeHtml(zoneHref(s.zone.id))}/intake">Write one with the intake page</a>.</p>`
    : `<p>The goals live in ${escapeHtml(path)} in ${escapeHtml(s.zone.repo)}. Jumpmaster never commits it, because it is a protected path. <a href="${escapeHtml(githubBlobHref(s.zone.repo, path))}">Open ${escapeHtml(path)} on GitHub</a> and use the pencil to edit it. The crew reads the change at its next cycle.</p>`;
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
  return page(
    `<p><a href="/">Back</a> · <a href="${escapeHtml(zoneHref(s.zone.id))}">Zone</a></p><h2>Objectives (goal ladder): ${zoneName(s.zone, s.zones)}</h2>${ladder}${edit}` +
      `<h2>Crew issues</h2><table><tr><th>Objective</th><th>Key</th><th>Title</th><th>State</th><th>Issue</th><th>Work item</th><th>Findings</th></tr>${issues}</table>` +
      `<h2>Crew issues not started (no recorded promotion)</h2>${skipped}`,
  );
}

function detailCells(d: ItemDetail | undefined): string {
  const allowed = d?.gateAllowedSha
    ? `<br><small>gate change allowed by Command for ${escapeHtml(d.gateAllowedSha.slice(0, 7))}</small>`
    : '';
  const head = d?.headSha ? escapeHtml(d.headSha.slice(0, 7)) : '-';
  const v = d?.verdict;
  const verdict = v
    ? `${escapeHtml(v.decision)}${v.forced ? ' (forced)' : ''}<br><small>${escapeHtml(v.summary)}</small>`
    : '-';
  const attempts = d
    ? Object.entries(d.attempts)
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([k, n]) => `${escapeHtml(k)} ${escapeHtml(n)}`)
        .join(', ') || '-'
    : '-';
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
 * Where the store-only links (Zones, Settings) go. `page()` cannot know the install's mode, so
 * the app fills this in for a store install (`withStoreNav`); a config-file install keeps the
 * comment, and links nowhere that would 404.
 */
export const STORE_NAV_SLOT = '<!--jm-store-nav-->';
export const STORE_NAV = `<a href="/zones">Zones</a><a href="/settings">Settings</a>`;

/** The pages every install has, in the order the operator reaches for them. */
const NAV = `<a href="/">Floor</a><a href="/work">Work</a><a href="/drops">Drops</a><a href="/briefings">Briefings</a><a href="/sticks">Sticks</a>${STORE_NAV_SLOT}<a href="/doctor">Doctor</a><a href="/observations">Observations</a>`;

/** Marks the link for the current page; the longest matching prefix wins. */
const NAV_SCRIPT = `<script>(()=>{const p=location.pathname;let best=null,len=-1;for(const a of document.querySelectorAll('.topnav a')){const h=a.getAttribute('href');const hit=h==='/'?p==='/':p===h||p.startsWith(h+'/');if(hit&&h.length>len){best=a;len=h.length;}}if(best)best.setAttribute('aria-current','page');})();</script>`;

/**
 * The page shell. With `chrome` (the default, for pages behind the login) it carries an empty
 * `jm-csrf` meta for the guard to fill, `jmFetch`, the navigation and the logout button; the login
 * and setup pages go without.
 */
export const page = (body: string, opts: { chrome?: boolean; title?: string } = {}): string => {
  const chrome = opts.chrome ?? true;
  const title = opts.title ? `Jumpmaster: ${escapeHtml(opts.title)}` : 'Jumpmaster';
  const nav = chrome ? `<nav class="topnav" aria-label="Main">${NAV}</nav>${LOGOUT}` : '';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${chrome ? `<meta name="jm-csrf" content="">` : ''}<title>${title}</title>${FAVICON_LINK}<style>${STYLE}</style>${chrome ? JM_FETCH : ''}</head>` +
    `<body><a class="skip" href="#main">Skip to content</a><header class="topbar"><div class="topbar-in"><h1 class="brand">${MARK}Jumpmaster</h1>${nav}</div></header>` +
    `<main id="main">${body}</main>${chrome ? NAV_SCRIPT : ''}</body></html>`
  );
};

function elapsed(drop: Drop, now: Date): string {
  if (!drop.startedAt) return '-';
  const end = drop.finishedAt ? Date.parse(drop.finishedAt) : now.getTime();
  const total = Math.max(0, Math.round((end - Date.parse(drop.startedAt)) / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

function gateSummary(drop: Drop): string {
  if (!drop.resultJson) return '-';
  try {
    const result = JSON.parse(drop.resultJson) as {
      gates?: { name: string; exitCode: number | null; timedOut: boolean }[];
    };
    const gates = result.gates ?? [];
    if (gates.length === 0) return '-';
    return gates
      .map(
        (g) =>
          `${escapeHtml(g.name)}: ${g.timedOut ? 'timeout' : g.exitCode === 0 ? 'pass' : 'fail'}`,
      )
      .join('<br>');
  } catch {
    return '-';
  }
}

/** How a drop's gates stand so far, or nothing when it has reported none. */
function gateCount(drop: Drop): { total: number; passed: number; failed: number } | null {
  if (!drop.resultJson) return null;
  try {
    const gates =
      (JSON.parse(drop.resultJson) as { gates?: { exitCode: number | null; timedOut: boolean }[] })
        .gates ?? [];
    if (gates.length === 0) return null;
    const passed = gates.filter((g) => !g.timedOut && g.exitCode === 0).length;
    return { total: gates.length, passed, failed: gates.length - passed };
  } catch {
    return null;
  }
}

/** The work-item ledger's header row, on /work. */
export const WORK_HEAD =
  '<tr><th>Zone</th><th>Issue</th><th>Title</th><th>State</th><th>Reason</th><th>PR</th><th>Head</th><th>Verdict</th><th>Attempts</th></tr>';

/** The drop ledger's header row, on /drops. */
export const DROP_HEAD =
  '<tr><th>Drop</th><th>Issue</th><th>Role</th><th>State</th><th>Elapsed</th><th>Gates</th></tr>';

/** What a ready item waits on, in words, or nothing. */
const waitingOn = (i: WorkItem): string =>
  i.state === 'ready' && i.blockedBy.length > 0 ? `waiting on ${i.blockedBy.join(', ')}` : '';

/** The work-item ledger's rows (/work's), zones named by repository. */
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
    const href = `https://github.com/${repo}/pull/${i.prNumber}`;
    return `<a href="${escapeHtml(href)}"${linkTarget(href)}>#${escapeHtml(i.prNumber)}</a>`;
  };
  return items
    .map(
      (i) =>
        `<tr><td>${name(i.dropZoneId)}</td><td>#${escapeHtml(i.issueNumber)}</td><td>${escapeHtml(i.title)}</td><td>${badge(i.state)}</td><td>${escapeHtml(i.reason ?? waitingOn(i))}</td><td>${prLink(i)}</td>${detailCells(details?.get(i.id))}</tr>`,
    )
    .join('');
}

/** What a drop works on: its issue, or the crew or doctor. */
function dropTarget(d: Drop, itemById: Map<number, WorkItem>): string {
  if (d.workItemId === null) return d.role === 'doctor' ? 'doctor' : 'crew';
  const wi = itemById.get(d.workItemId);
  return wi ? `#${escapeHtml(wi.issueNumber)}` : '-';
}

/** The drop ledger's rows (/drops'); `items` resolve each drop's issue. */
export function dropRows(drops: readonly Drop[], items: readonly WorkItem[], now: Date): string {
  const itemById = new Map(items.map((i) => [i.id, i]));
  return drops
    .map(
      (d) =>
        `<tr><td><a href="/drops/${encodeURIComponent(d.id)}">${escapeHtml(d.id)}</a></td><td>${dropTarget(d, itemById)}</td><td>${escapeHtml(d.role)}</td><td>${badge(d.state)}</td><td class="num">${escapeHtml(elapsed(d, now))}</td><td>${gateSummary(d)}</td></tr>`,
    )
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
  /** The heading, as HTML. */
  title: string;
  /** The heading as plain text, for the document title. */
  titleText: string;
  zones: readonly ZoneRef[];
  zone: string | undefined;
  state: string;
  defaultState: string;
  states: { value: string; label: string }[];
  head: string;
  rows: string;
  empty: string;
  note?: string;
}): string {
  const href = (zone: string | undefined, state: string): string => {
    const q = new URLSearchParams();
    if (zone !== undefined) q.set('zone', zone);
    if (state !== p.defaultState) q.set('state', state);
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
  const body = p.rows
    ? `<table>${p.head}${p.rows}</table>${p.note ? `<p class="muted">${p.note}</p>` : ''}`
    : `<p class="empty">${p.empty}</p>`;
  return page(
    `<p><a href="/">Back</a></p><h2>${p.title}</h2>` +
      `<nav class="filters" aria-label="Project"><p>${zoneLinks}</p></nav>` +
      `<nav class="filters" aria-label="State"><p>${stateLinks}</p></nav>${body}`,
    { title: p.titleText },
  );
}

/** /work: work items of one zone or all, in one state or every state but done. */
export function renderWorkList(s: {
  zones: readonly ZoneRef[];
  zone?: string;
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
    path: '/work',
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

/** /drops: drops newest first, of one zone or all, in one state, the active ones or any. */
export function renderDropList(s: {
  zones: readonly ZoneRef[];
  zone?: string;
  state: DropFilter;
  /** Already filtered, newest first, at most DROP_LIST_LIMIT. */
  drops: readonly Drop[];
  /** Work items, to name each drop's issue. */
  items: readonly WorkItem[];
  /** More drops matched than are shown. */
  limited: boolean;
  now?: Date;
}): string {
  const z = s.zone === undefined ? undefined : s.zones.find((x) => x.id === s.zone);
  const words = s.state === 'all' ? '' : `${stateWords(s.state)} `;
  const where = z ? ` in ${zoneName(z, s.zones)}` : '';
  const heading = (w: string): string =>
    z ? `${capital(`${words}drops`)}${w}` : `All ${words}drops`;
  return listPage({
    path: '/drops',
    title: heading(where),
    titleText: heading(z ? ` in ${zoneNameText(z, s.zones)}` : ''),
    zones: s.zones,
    zone: z?.id,
    state: s.state,
    defaultState: 'all',
    states: [
      { value: 'all', label: 'All states' },
      { value: 'active', label: 'Active' },
      ...DROP_STATES.map((v) => ({ value: v, label: capital(stateWords(v)) })),
    ],
    head: DROP_HEAD,
    rows: dropRows(s.drops, s.items, s.now ?? new Date()),
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
  return `<p class="warn token-age"><strong>The Claude token is ${days} days old</strong> ${when}. Run <code>claude setup-token</code> on your own computer and replace it under <a href="/settings/credentials">Settings, Credentials</a>.</p>`;
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
  const itemById = new Map(state.items.map((i) => [i.id, i]));

  // The slots (§10.1): what each trooper is doing right now, one card per live drop.
  // Everything active but still queued, which nothing has started; a pending push still holds its slot.
  const live = state.drops.filter(
    (d) => (ACTIVE_DROP_STATES as readonly string[]).includes(d.state) && d.state !== 'queued',
  );
  const slotCard = (d: Drop): string => {
    const wi = d.workItemId === null ? undefined : itemById.get(d.workItemId);
    const what = `${name(wi ? wi.dropZoneId : d.dropZoneId)} ${dropTarget(d, itemById)}`;
    const title = wi ? `<span class="muted">${escapeHtml(wi.title)}</span>` : '';
    const g = gateCount(d);
    const gates = g
      ? ` · gates ${g.passed}/${g.total} passed${g.failed ? `, ${g.failed} failed` : ''}`
      : '';
    return `<article class="card slot"><div>${badge(d.state)} <small>${escapeHtml(d.role)}</small></div><a class="what" href="/drops/${encodeURIComponent(d.id)}">${what}</a>${title}<span class="meta">${escapeHtml(elapsed(d, now))}${gates} · ${escapeHtml(d.id)}</span></article>`;
  };
  const slots =
    live.length === 0
      ? '<p class="empty">No drop is running.</p>'
      : `<div class="grid">${live.map(slotCard).join('')}</div>`;

  const setupFrame = state.setup?.active
    ? `<div class="warn setup-frame"><p><strong>Finish setting up Jumpmaster.</strong> <a href="/setup/next">Continue where you left off</a>: connect Claude and GitHub, check the runner, add a project and run the doctor.</p><form method="post" action="/setup/dismiss"><button>Dismiss</button></form></div>`
    : '';
  const addProject = state.setup?.addProject
    ? '<p class="quick"><a href="/zones/new">Add a project</a></p>'
    : '';
  // The dashboard (#120): every number from floorCounts.
  const counts = floorCounts(state, now);
  const dashboard =
    state.zones.length === 0
      ? `<div class="grid">${card('Projects', '<h2>No project yet</h2>', addProject)}</div>`
      : totalsStrip(counts) + zoneCards(counts, state.zones) + addProject;
  return page(
    (state.killed ? KILLED_NOTICE : '') +
      `<div class="floor-head">${statusBanner(state.status) || '<div class="status" data-waiting-on="nothing"><p><strong>Factory floor</strong></p></div>'}${killSection(state.killed ?? false)}</div>` +
      tokenAgeBanner(state.claudeTokenDays) +
      setupFrame +
      starterBanner +
      dashboard +
      (state.briefings
        ? `<div class="grid">${waitingOnYou(state.briefings, state.heldBriefings, state.zones)}</div>`
        : '') +
      `<h2 class="section-h">Running now <small class="muted">Troopers: one job slot each</small></h2>${slots}` +
      `<div class="grid">${usageSection(state.usage) || card('Claude subscription', '<h2>Usage</h2>', '<p class="empty">No usage reported yet.</p>')}</div>` +
      (state.crew && state.crew.length > 0
        ? `<div class="grid">${crewSection(state.crew, name)}</div>`
        : '') +
      sticksSection(state.sticks, name, now),
    state.status ? { title: state.status.headline } : {},
  );
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
  return `<div class="status" data-waiting-on="${escapeHtml(s.waitingOn)}"><p><strong>${codeHtml(s.headline)}</strong>${since}</p>${detail}${also}${action}</div>`;
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
  return `<section class="transcript"><h3>Transcript</h3>${note}${sorted.map(transcriptEvent).join('')}</section>`;
}

/** A drop whose events retention pruned (issue #197): when, and its archive under the data dir. */
export type TranscriptPruned = { prunedAt: string; archive: string | null };

export function renderDrop(
  drop: Drop,
  events: StoredEvent[],
  artifacts: ArtifactRow[] = [],
  pruned: TranscriptPruned | null = null,
): string {
  const rows = events
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.seq)}</td><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(e.kind)}</td><td><pre>${escapeHtml(JSON.stringify(e.data))}</pre></td></tr>`,
    )
    .join('');
  return page(
    `<p><a href="/">Back</a></p><h2>Drop ${escapeHtml(drop.id)}</h2><p>State: ${escapeHtml(drop.state)}</p>` +
      modelLines(drop) +
      egressSection(events) +
      transcriptSection(events, pruned) +
      `<details class="raw-events"><summary>Raw events (${events.length})</summary><table><tr><th>Seq</th><th>Time</th><th>Kind</th><th>Data</th></tr>${rows}</table></details>` +
      artifactsSection(artifacts),
  );
}

/** Observe mode's would-do list, newest first. */
export function renderObservations(rows: Observation[], zones: readonly ZoneRef[] = []): string {
  const name = zoneNamer(zones);
  const body = rows
    .map(
      (o) =>
        `<tr><td>${name(o.zoneId)}</td><td>${escapeHtml(o.itemId ?? '')}</td><td>${escapeHtml(o.action)}</td><td>${escapeHtml(o.detail)}</td><td>${o.count}</td><td>${escapeHtml(o.firstAt)}</td><td>${escapeHtml(o.lastAt)}</td></tr>`,
    )
    .join('');
  return page(
    `<h2>Observations</h2><table><tr><th>Zone</th><th>Item</th><th>Would do</th><th>Detail</th><th>Count</th><th>First</th><th>Last</th></tr>${body}</table>`,
  );
}

/** The doctor page's actions: each posts with the session's CSRF header. */
const DOCTOR_SCRIPT = `<script>for(const b of document.querySelectorAll('button[data-doctor]'))b.addEventListener('click',async()=>{b.disabled=true;const r=await jmFetch(b.dataset.doctor,JSON.parse(b.dataset.body||'{}'));b.disabled=false;if(r.ok)location.reload();else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});</script>`;

/** The readiness doctor's latest run: every check, with its fix for any that did not pass. */
export function renderDoctor(
  run: { id: number; finishedAt: string | null; checks: DoctorCheckView[] } | null,
  zones: DropZoneConfig[],
): string {
  const name = zoneNamer(zones);
  // One doctor drop button per project, as a list under its explanation.
  const drops = zones
    .map(
      (z) =>
        `<li><button data-doctor="/api/control/doctor/drop" data-body="${escapeHtml(JSON.stringify({ zone: z.id }))}">Doctor drop: ${name(z.id)}</button></li>`,
    )
    .join('');
  const controls = `<p><button data-doctor="/api/control/doctor">Run the doctor</button></p><p>A doctor drop proves the Claude token, the clone, services and gates on a stick; it spends one turn of usage.</p>${drops ? `<ul class="doctor-drops">${drops}</ul>` : ''}${zones.length > 0 ? `<p>GitHub setup (token links, the ruleset file, CODEOWNERS): ${zones.map((z) => `<a href="/zones/${encodeURIComponent(z.id)}/github">${name(z.id)}</a>`).join(', ')}</p>` : ''}`;
  if (!run)
    return page(
      `<h2>Doctor</h2><p>No doctor run has finished yet. Run one here or with <code>jumpmaster ctl doctor</code>.</p>${controls}${DOCTOR_SCRIPT}`,
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
      return `<tr class="${escapeHtml(c.status)}"><td>${escapeHtml(c.status.toUpperCase())}</td><td>${c.zoneId === null ? '' : name(c.zoneId)}</td><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.summary)}${help}</td></tr>`;
    })
    .join('');
  return page(
    `<h2>Doctor</h2><p>Run ${run.id}, finished ${escapeHtml(run.finishedAt ?? '-')}: ${n('pass')} pass, ${n('warn')} warn, ${n('fail')} fail, ${n('skip')} skip${n('info') > 0 ? `, ${n('info')} info` : ''}.</p>${controls}<table><tr><th>Status</th><th>Zone</th><th>Check</th><th>Finding</th></tr>${rows}</table>${DOCTOR_SCRIPT}`,
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

/**
 * The intake page's script. The idempotency key is minted per submit and kept in sessionStorage
 * under a hash of the form's content until the server confirms, so a retry or a reload and
 * resubmit of the same content reuses it; the helpers are the tested ones, embedded by source.
 * Server text is shown with textContent only.
 */
const INTAKE_SCRIPT = `<script>
const submitKey = ${submitKey.toString()};
const forgetSubmitKey = ${forgetSubmitKey.toString()};
const root = document.getElementById('intake');
const base = root.dataset.base;
const lines = (id) => document.getElementById(id).value.split('\\n').map((s) => s.trim()).filter(Boolean);
const val = (id) => document.getElementById(id).value.trim();
const say = (id, text) => { document.getElementById(id).textContent = text; };
async function call(path, body) {
  const r = await jmFetch(base + path, body);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
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
document.getElementById('issue-form').addEventListener('submit', async (e) => {
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
    say('issue-status', r.body.number != null ? 'Filed as issue #' + r.body.number + ', ready. It starts on the next pass.' : 'Already filed (' + r.body.state + ').');
  } else if (r.status === 502) {
    forgetSubmitKey(sessionStorage, content);
    say('issue-status', 'Nothing was filed: ' + (r.body.error ?? 'GitHub refused it') + ' Submitting again starts a fresh filing.');
  } else if (r.status === 202) {
    say('issue-status', 'The forge has not confirmed the issue yet. Submit again: the same key is reused, so it is never filed twice.');
  } else {
    say('issue-status', 'Refused: ' + r.status + ' ' + (r.body.error ?? ''));
  }
});
</script>`;

/** The minimal intake: the GOAL.md stub, how to commit it, and the first ready issue. */
export function renderIntake(zone: ZoneRef, zones: readonly ZoneRef[] = [zone]): string {
  const base = `/api/control/zones/${encodeURIComponent(zone.id)}/intake`;
  const field = (id: string, label: string, input: string) =>
    `<p><label for="${id}">${label}</label><br>${input}</p>`;
  const area = (id: string, rows: number, required = false) =>
    `<textarea id="${id}" rows="${rows}" cols="80"${required ? ' required' : ''}></textarea>`;
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
  const first = `<h3>Step 3: the first issue</h3><p>Filed ready, under objective 1, as soon as you submit: the first issue doesn't need GOAL.md merged first.</p><form id="issue-form">${field('issue-title', 'Title (at most 120 characters)', '<input id="issue-title" size="80" maxlength="120" required>')}${field('issue-context', 'Context', area('issue-context', 6, true))}${field('issue-acceptance', 'Acceptance criteria, one per line', area('issue-acceptance', 5, true))}${field('issue-tests', 'Required tests, one per line', area('issue-tests', 3, true))}${field('issue-out', 'Out of scope, one per line (optional)', area('issue-out', 3))}<button>File the issue</button> <span id="issue-status"></span></form>`;
  return page(
    `<h2>Intake: ${zoneName(zone, zones)}</h2><div id="intake" data-base="${escapeHtml(base)}">${goal}${commit}${first}</div>${INTAKE_SCRIPT}`,
  );
}
