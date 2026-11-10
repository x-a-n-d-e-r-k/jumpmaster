import type { ArtifactRow } from '../artifacts.js';
import { type Briefing, optionsDigest, type Ruling, WAITS_FOR_CREW } from '../briefings.js';
import { type DropZoneConfig, STARTER_WARNING } from '../config.js';
import type { CrewIssue } from '../crew/store.js';
import type {
  AttemptKey,
  Drop,
  Observation,
  OutboxRow,
  StoredEvent,
  UsageStateRow,
  WorkItem,
} from '../db/repo.js';
import type { DoctorAction } from '../doctor/checks.js';
import type { GoalRow } from '../goals.js';
import { forgetSubmitKey, submitKey } from '../intake.js';
import type { Status } from '../status.js';
import type { Gate } from '../usage.js';

export const escapeHtml = (v: unknown): string =>
  String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export interface RateLimitSeen extends StoredEvent {
  dropId: string;
}

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
  items: WorkItem[];
  drops: Drop[];
  lastRateLimit?: RateLimitSeen;
  now?: Date;
  usage?: {
    gate: Gate;
    state: UsageStateRow;
    /** Drops that reported usage credits since Command's Resume. */
    creditDropsSinceResume?: number;
    /** The account's `overageStatus` as last reported (raw, pending rehearsal). */
    overageStatus?: string | null;
  };
  /** Per work item: PR head, latest verdict and attempt counts. */
  details?: Map<number, ItemDetail>;
  /** Outbox ops needing attention (`unknown` or `failed`). */
  outbox?: OutboxRow[];
  /** Open briefings, for "Waiting on you". */
  briefings?: Briefing[];
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

/** The kill control. It posts with the session's CSRF header, so a page visit cannot trigger it. */
function killSection(killed: boolean): string {
  const notice = killed
    ? '<p><strong>The kill switch is engaged.</strong> No work runs and no forge writes happen. Forge and Claude tokens stay valid until you revoke them with their providers.</p>'
    : '';
  const label = killed ? 'Reset kill switch' : 'Engage kill switch';
  return `<h2>Kill switch</h2>${notice}<form id="kill"><button>${label}</button></form><script>document.getElementById('kill').addEventListener('submit',async(e)=>{e.preventDefault();const r=await jmFetch('/api/control/kill',{engaged:${killed ? 'false' : 'true'}});if(r.ok)location.reload();else alert('Refused: '+r.status);});</script>`;
}

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

function usageSection(u: HomeState['usage']): string {
  if (!u) return '';
  const s = u.state;
  const row = (k: string, v: unknown) => `<tr><th>${k}</th><td>${escapeHtml(v ?? '-')}</td></tr>`;
  const credits = creditsLine(u);
  return (
    `<h2>Usage</h2><table>` +
    row('Gate', u.gate) +
    (credits ? row('Credits', credits) : '') +
    row('Overage status', u.overageStatus) +
    row('Status', s.status) +
    row('Paused until', s.pausedUntil) +
    row('5-hour', pct(s.fiveHourUtil)) +
    row('7-day', pct(s.sevenDayUtil)) +
    row('Observed', s.observedAt) +
    row('Cause drop', s.causeDropId) +
    `</table>`
  );
}

function outboxSection(ops: OutboxRow[] | undefined): string {
  if (!ops || ops.length === 0) return '';
  const rows = ops
    .map(
      (o) =>
        `<tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.kind)}</td><td>${escapeHtml(o.workItemId ?? `zone ${o.zoneId}`)}</td><td>${escapeHtml(o.state)}</td><td>${escapeHtml(o.error ?? '')}</td><td>${escapeHtml(o.updatedAt)}</td></tr>`,
    )
    .join('');
  return `<h2>Outbox</h2><table><tr><th>Op</th><th>Kind</th><th>Item</th><th>State</th><th>Error</th><th>Updated</th></tr>${rows}</table>`;
}

/** The home page's list of open briefings, each linking to where it is answered. */
export function waitingOnYou(open: Briefing[]): string {
  if (open.length === 0) {
    return '<h2>Waiting on you</h2><p>Nothing is waiting on you. <a href="/briefings">Briefings and rulings</a></p>';
  }
  const rows = open
    .map(
      (b) =>
        `<li>${escapeHtml(b.zoneId)}: ${escapeHtml(b.decision)} <small>(${escapeHtml(b.kind)})</small></li>`,
    )
    .join('');
  return `<h2>Waiting on you</h2><p>${open.length} decision${open.length === 1 ? '' : 's'} waiting. <a href="/briefings">Answer them on the briefings page</a>.</p><ul>${rows}</ul>`;
}

function crewSection(lines: CrewLine[] | undefined): string {
  if (!lines || lines.length === 0) return '';
  const rows = lines
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.zoneId)}</td><td>${c.enabled ? 'on' : 'off'}</td><td>${escapeHtml(c.lastCycle ?? '-')}</td><td>${escapeHtml(c.enabled ? (c.nextDue ?? 'now') : '-')}</td><td>${escapeHtml(c.fable)}</td><td><a href="/zones/${encodeURIComponent(c.zoneId)}/goals">Goals</a> <a href="/zones/${encodeURIComponent(c.zoneId)}/intake">Intake</a></td></tr>`,
    )
    .join('');
  return `<h2>Crew</h2><table><tr><th>Zone</th><th>Crew</th><th>Last cycle</th><th>Next due</th><th>Fable</th><th></th></tr>${rows}</table>`;
}

function sticksSection(lines: StickLine[] | undefined): string {
  if (!lines) return '';
  if (lines.length === 0) return '<h2>Sticks</h2><p>No stick has enrolled.</p>';
  const rows = lines
    .map((s) => {
      const runs =
        s.cannotRun.length === 0
          ? 'all zones'
          : s.cannotRun
              .map(
                (c) =>
                  `cannot run ${escapeHtml(c.zoneId)}: lacks ${escapeHtml(c.missing.join(', '))}`,
              )
              .join('<br>');
      return `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.version ?? '-')}</td><td>${escapeHtml(s.lastSeenAt ?? 'never')}</td><td>${escapeHtml(s.capabilities.join(', ') || '-')}</td><td>${escapeHtml(s.imagePolicy)}</td><td>${runs}</td></tr>`;
    })
    .join('');
  return `<h2>Sticks</h2><table><tr><th>Stick</th><th>Version</th><th>Last seen</th><th>Capabilities</th><th>Image policy</th><th>Zones</th></tr>${rows}</table>`;
}

/** One shared handler for every rule form: it posts with the session's CSRF header. */
const RULE_SCRIPT = `<script>for(const f of document.querySelectorAll('form.rule'))f.addEventListener('submit',async(e)=>{e.preventDefault();const o=f.querySelector('input[name=option]:checked');if(!o){alert('Choose an option');return;}const r=await jmFetch('/api/control/briefings/'+f.dataset.briefing+'/rule',{optionId:o.value,optionsDigest:f.dataset.options,note:f.querySelector('textarea').value});if(r.ok)location.reload();else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});</script>`;

function briefingBlock(b: Briefing, holds: Map<string, string> | undefined): string {
  const hold = b.kind === 'promote_held' ? holds?.get(b.subject) : undefined;
  const options = b.options
    .map(
      (o) =>
        `<label><input type="radio" name="option" value="${escapeHtml(o.id)}" required> ${escapeHtml(o.label)}</label> <small><code>${escapeHtml(o.id)}</code></small><br>`,
    )
    .join('');
  const row = (k: string, v: string) =>
    v ? `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>` : '';
  return (
    `<h3>${escapeHtml(b.decision)}</h3>` +
    `<table>${row('Zone', b.zoneId)}${row('Kind', b.kind)}${row('About', b.subject)}${b.why ? `<tr><th>Why</th><td><pre>${escapeHtml(b.why)}</pre></td></tr>` : ''}${b.diagnosis ? `<tr><th>Diagnosis</th><td><pre>${escapeHtml(b.diagnosis)}</pre></td></tr>` : ''}${row('Recommendation', b.recommendation)}${row('On hold', b.onHold)}${row('Raised by', b.source === 'mcp' ? 'assistant (MCP)' : b.source)}${row('Raised', b.createdAt)}</table>` +
    (hold ? `<p>Promotes at ${escapeHtml(hold)} unless you reject it.</p>` : '') +
    `<form class="rule" data-briefing="${escapeHtml(b.id)}" data-options="${optionsDigest(b)}">${options}<textarea name="note" maxlength="2000" placeholder="Note (optional)"></textarea><br><button>Rule</button></form>`
  );
}

/** Briefings waiting on Command, with a rule form each, and the rulings recorded so far. */
export function renderBriefings(s: {
  open: Briefing[];
  rulings: Ruling[];
  zones: DropZoneConfig[];
  /** Hold-until per subject, for held refute promotions. */
  holds?: Map<string, string>;
}): string {
  const open =
    s.open.length === 0
      ? '<p>Nothing is waiting on you.</p>'
      : s.open.map((b) => briefingBlock(b, s.holds)).join('') + RULE_SCRIPT;
  const crewOff = new Set(s.zones.filter((z) => !z.crew?.enabled).map((z) => z.id));
  // Recorded, and held until the zone's crew is enabled again (applyPendingRulings).
  const waiting = (r: Ruling) =>
    r.appliedAt === null &&
    r.applyError === null &&
    r.effect !== null &&
    WAITS_FOR_CREW.has(r.effect) &&
    crewOff.has(r.zoneId);
  const rulings = s.rulings
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.zoneId)}</td><td>${escapeHtml(r.briefingId)}</td><td>${escapeHtml(r.choice)}</td><td>${escapeHtml(r.note)}</td><td>${escapeHtml(r.createdAt)}</td><td>${escapeHtml(r.appliedAt ?? (waiting(r) ? 'waiting: crew disabled' : '-'))}</td><td>${escapeHtml(r.applyError ?? '')}</td><td>${escapeHtml(r.diagnosis ?? '')}</td></tr>`,
    )
    .join('');
  return page(
    `<p><a href="/">Back</a></p><h2>Briefings (decisions waiting on you)</h2>${open}` +
      `<h2>Rulings (decisions recorded)</h2><table><tr><th>Ruling</th><th>Zone</th><th>Briefing</th><th>Choice</th><th>Note</th><th>Ruled</th><th>Applied</th><th>Error</th><th>Diagnosis</th></tr>${rulings}</table>`,
  );
}

/** A zone's goal ladder, its crew issues, and marker-bearing issues intake did not start. */
export function renderGoals(s: {
  zone: DropZoneConfig;
  goals: GoalRow | undefined;
  crewIssues: CrewIssue[];
  items: WorkItem[];
  skippedCrewUnpromoted: number[];
}): string {
  const path = s.zone.crew?.goalPath ?? 'GOAL.md';
  let ladder: string;
  if (!s.goals) {
    ladder = `<p>${escapeHtml(path)} has not been read yet.</p>`;
  } else if (!s.goals.parse.ok) {
    ladder = `<p>${escapeHtml(path)} could not be parsed: ${escapeHtml(s.goals.parse.error)}</p>`;
  } else {
    const current = s.goals.parse.objectives.find((o) => !o.done);
    const rows = s.goals.parse.objectives
      .map((o) => {
        const status = o.done ? 'done' : o === current ? 'Current objective' : 'open';
        return `<tr><td>${escapeHtml(o.title)}</td><td>${status}</td><td><code>${escapeHtml(o.key)}</code></td></tr>`;
      })
      .join('');
    ladder =
      `<p>${escapeHtml(s.goals.parse.lighthouse)}</p>` +
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
    `<p><a href="/">Back</a></p><h2>Objectives (goal ladder): ${escapeHtml(s.zone.id)}</h2>${ladder}` +
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
  return `<td><code>${head}</code>${allowed}</td><td>${verdict}</td><td>${attempts}</td>`;
}

const STYLE = `body{font:14px/1.4 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#222}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}th,td{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top}
h1,h2{margin:1rem 0 .5rem}pre{white-space:pre-wrap;margin:0}`;

/**
 * Every write from a page goes through `jmFetch`: JSON, with the session's CSRF token (from the
 * `jm-csrf` meta the guard fills per session) in `x-jm-csrf`. The session cookie rides along.
 */
const JM_FETCH = `<script>function jmFetch(path,body,method){return fetch(path,{method:method||'POST',headers:{'content-type':'application/json','x-jm-csrf':document.querySelector('meta[name=jm-csrf]').content},body:JSON.stringify(body===undefined?{}:body)});}</script>`;

const LOGOUT = `<form method="post" action="/logout" style="float:right;margin-top:1rem"><button>Log out</button></form>`;

/**
 * The page shell. With `chrome` (the default, for pages behind the login) it carries an empty
 * `jm-csrf` meta for the guard to fill, `jmFetch` and the logout button; the login and setup pages
 * go without.
 */
export const page = (body: string, opts: { chrome?: boolean; title?: string } = {}): string => {
  const chrome = opts.chrome ?? true;
  const title = opts.title ? `Jumpmaster: ${escapeHtml(opts.title)}` : 'Jumpmaster';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${chrome ? `<meta name="jm-csrf" content="">` : ''}<title>${title}</title><style>${STYLE}</style>${chrome ? JM_FETCH : ''}</head><body>${chrome ? LOGOUT : ''}<h1>Jumpmaster</h1>${body}</body></html>`;
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
  const starterBanner = state.zones
    .filter((z) => z.identity === 'starter')
    .map(
      (z) =>
        `<p class="warn"><strong>Starter mode in zone ${escapeHtml(z.id)}.</strong> ${escapeHtml(STARTER_WARNING)}</p>`,
    )
    .join('');
  const repoOf = new Map(state.zones.map((z) => [z.id, z.repo]));
  const itemById = new Map(state.items.map((i) => [i.id, i]));

  const zones = state.zones
    .map(
      (z) =>
        `<tr><td>${escapeHtml(z.id)}</td><td>${escapeHtml(z.repo)}</td><td>${escapeHtml(z.readyLabel)}</td><td>${escapeHtml(z.model)}</td><td>${escapeHtml(state.modes?.[z.id] ?? 'active')}</td><td><a href="/zones/${encodeURIComponent(z.id)}/github">GitHub</a></td></tr>`,
    )
    .join('');

  const items = state.items
    .map((i) => {
      const repo = repoOf.get(i.dropZoneId);
      const pr =
        i.prNumber !== null && repo
          ? `<a href="${escapeHtml(`https://github.com/${repo}/pull/${i.prNumber}`)}">#${escapeHtml(i.prNumber)}</a>`
          : '-';
      const waiting =
        i.state === 'ready' && i.blockedBy.length > 0 ? `waiting on ${i.blockedBy.join(', ')}` : '';
      return `<tr><td>${escapeHtml(i.dropZoneId)}</td><td>#${escapeHtml(i.issueNumber)}</td><td>${escapeHtml(i.title)}</td><td>${escapeHtml(i.state)}</td><td>${escapeHtml(i.reason ?? waiting)}</td><td>${pr}</td>${detailCells(state.details?.get(i.id))}</tr>`;
    })
    .join('');

  const drops = state.drops
    .map((d) => {
      const wi = d.workItemId === null ? undefined : itemById.get(d.workItemId);
      const target =
        d.workItemId === null
          ? d.role === 'doctor'
            ? 'doctor'
            : 'crew'
          : wi
            ? `#${escapeHtml(wi.issueNumber)}`
            : '-';
      return `<tr><td><a href="/drops/${encodeURIComponent(d.id)}">${escapeHtml(d.id)}</a></td><td>${target}</td><td>${escapeHtml(d.role)}</td><td>${escapeHtml(d.state)}</td><td>${escapeHtml(elapsed(d, now))}</td><td>${gateSummary(d)}</td></tr>`;
    })
    .join('');

  const rl = state.lastRateLimit
    ? `<p>Drop ${escapeHtml(state.lastRateLimit.dropId)} at ${escapeHtml(state.lastRateLimit.ts)}: <code>${escapeHtml(JSON.stringify(state.lastRateLimit.data))}</code></p>`
    : '<p>None seen.</p>';

  const setupFrame = state.setup?.active
    ? `<div class="warn setup-frame"><p><strong>Finish setting up Jumpmaster.</strong> <a href="/setup/next">Continue where you left off</a>: connect Claude and GitHub, check the runner, add a project and run the doctor.</p><form method="post" action="/setup/dismiss"><button>Dismiss</button></form></div>`
    : '';
  const addProject = state.setup?.addProject
    ? '<p><a href="/zones">Zones</a> · <a href="/zones/new">Add a project</a></p>'
    : '';
  const settingsLink = state.settings ? '<p><a href="/settings">Settings</a></p>' : '';
  return page(
    statusBanner(state.status) +
      tokenAgeBanner(state.claudeTokenDays) +
      setupFrame +
      addProject +
      settingsLink +
      starterBanner +
      killSection(state.killed ?? false) +
      (state.briefings ? waitingOnYou(state.briefings) : '') +
      usageSection(state.usage) +
      crewSection(state.crew) +
      sticksSection(state.sticks) +
      `<h2>Drop zones</h2><table><tr><th>Id</th><th>Repo</th><th>Label</th><th>Model</th><th>Mode</th><th>GitHub setup</th></tr>${zones}</table>` +
      `<h2>Work items</h2><table><tr><th>Zone</th><th>Issue</th><th>Title</th><th>State</th><th>Reason</th><th>PR</th><th>Head</th><th>Verdict</th><th>Attempts</th></tr>${items}</table>` +
      `<h2>Drops</h2><table><tr><th>Drop</th><th>Issue</th><th>Role</th><th>State</th><th>Elapsed</th><th>Gates</th></tr>${drops}</table>` +
      outboxSection(state.outbox) +
      `<h2>Last rate limit</h2>${rl}`,
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
              `<li>${codeHtml(a.text)}${a.href && safeHref(a.href) ? ` <a href="${escapeHtml(a.href)}">Fix</a>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  const action =
    s.action && safeHref(s.action.href)
      ? `<p><a href="${escapeHtml(s.action.href)}">${escapeHtml(s.action.label)}</a></p>`
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

export function renderDrop(
  drop: Drop,
  events: StoredEvent[],
  artifacts: ArtifactRow[] = [],
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
      `<table><tr><th>Seq</th><th>Time</th><th>Kind</th><th>Data</th></tr>${rows}</table>` +
      artifactsSection(artifacts),
  );
}

/** Observe mode's would-do list, newest first. */
export function renderObservations(rows: Observation[]): string {
  const body = rows
    .map(
      (o) =>
        `<tr><td>${escapeHtml(o.zoneId)}</td><td>${escapeHtml(o.itemId ?? '')}</td><td>${escapeHtml(o.action)}</td><td>${escapeHtml(o.detail)}</td><td>${o.count}</td><td>${escapeHtml(o.firstAt)}</td><td>${escapeHtml(o.lastAt)}</td></tr>`,
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
  const controls = `<p><button data-doctor="/api/control/doctor">Run the doctor</button></p><p>A doctor drop proves the Claude token, the clone, services and gates on a stick; it spends one turn of usage.${zones
    .map(
      (z) =>
        ` <button data-doctor="/api/control/doctor/drop" data-body="${escapeHtml(JSON.stringify({ zone: z.id }))}">Doctor drop: ${escapeHtml(z.id)}</button>`,
    )
    .join(
      '',
    )}</p>${zones.length > 0 ? `<p>GitHub setup (token links, the ruleset file, CODEOWNERS): ${zones.map((z) => `<a href="/zones/${encodeURIComponent(z.id)}/github">${escapeHtml(z.id)}</a>`).join(', ')}</p>` : ''}`;
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
      return `<tr class="${escapeHtml(c.status)}"><td>${escapeHtml(c.status.toUpperCase())}</td><td>${escapeHtml(c.zoneId ?? '')}</td><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.summary)}${help}</td></tr>`;
    })
    .join('');
  return page(
    `<h2>Doctor</h2><p>Run ${run.id}, finished ${escapeHtml(run.finishedAt ?? '-')}: ${n('pass')} pass, ${n('warn')} warn, ${n('fail')} fail, ${n('skip')} skip.</p>${controls}<table><tr><th>Status</th><th>Zone</th><th>Check</th><th>Finding</th></tr>${rows}</table>${DOCTOR_SCRIPT}`,
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
    control = a.href.startsWith('/')
      ? `<a href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`
      : `<a href="${escapeHtml(a.href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(a.label)}</a>`;
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
export function renderIntake(zone: Pick<DropZoneConfig, 'id' | 'repo'>): string {
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
    `<h2>Intake: ${escapeHtml(zone.id)}</h2><div id="intake" data-base="${escapeHtml(base)}">${goal}${commit}${first}</div>${INTAKE_SCRIPT}`,
  );
}
