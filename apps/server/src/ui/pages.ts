import type { ArtifactRow } from '../artifacts.js';
import { type Briefing, optionsDigest, type Ruling, WAITS_FOR_CREW } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
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
import type { GoalRow } from '../goals.js';
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

export interface HomeState {
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

/** The kill control. The token field keeps a page visit from being able to trigger it. */
function killSection(killed: boolean): string {
  const notice = killed
    ? '<p><strong>The kill switch is engaged.</strong> No work runs and no forge writes happen. Forge and Claude tokens stay valid until you revoke them with their providers.</p>'
    : '';
  const label = killed ? 'Reset kill switch' : 'Engage kill switch';
  return `<h2>Kill switch</h2>${notice}<form id="kill"><input id="kill-token" type="password" placeholder="Operator token" autocomplete="off" required> <button>${label}</button></form><script>document.getElementById('kill').addEventListener('submit',async(e)=>{e.preventDefault();const r=await fetch('/api/control/kill',{method:'POST',headers:{authorization:'Bearer '+document.getElementById('kill-token').value,'content-type':'application/json'},body:JSON.stringify({engaged:${killed ? 'false' : 'true'}})});if(r.ok)location.reload();else alert('Refused: '+r.status);});</script>`;
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
        `<tr><td>${escapeHtml(c.zoneId)}</td><td>${c.enabled ? 'on' : 'off'}</td><td>${escapeHtml(c.lastCycle ?? '-')}</td><td>${escapeHtml(c.enabled ? (c.nextDue ?? 'now') : '-')}</td><td>${escapeHtml(c.fable)}</td><td><a href="/zones/${encodeURIComponent(c.zoneId)}/goals">Goals</a></td></tr>`,
    )
    .join('');
  return `<h2>Crew</h2><table><tr><th>Zone</th><th>Crew</th><th>Last cycle</th><th>Next due</th><th>Fable</th><th></th></tr>${rows}</table>`;
}

/** One shared handler for every rule form: the operator token comes from a password field. */
const RULE_SCRIPT = `<script>for(const f of document.querySelectorAll('form.rule'))f.addEventListener('submit',async(e)=>{e.preventDefault();const o=f.querySelector('input[name=option]:checked');if(!o){alert('Choose an option');return;}const r=await fetch('/api/control/briefings/'+f.dataset.briefing+'/rule',{method:'POST',headers:{authorization:'Bearer '+f.querySelector('input[type=password]').value,'content-type':'application/json'},body:JSON.stringify({optionId:o.value,optionsDigest:f.dataset.options,note:f.querySelector('textarea').value})});if(r.ok)location.reload();else alert('Refused: '+r.status);});</script>`;

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
    `<form class="rule" data-briefing="${escapeHtml(b.id)}" data-options="${optionsDigest(b.options)}">${options}<textarea name="note" maxlength="2000" placeholder="Note (optional)"></textarea><br><input type="password" placeholder="Operator token" autocomplete="off" required> <button>Rule</button></form>`
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

const page = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Jumpmaster</title><style>${STYLE}</style></head><body><h1>Jumpmaster</h1>${body}</body></html>`;

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

export function renderHome(state: HomeState): string {
  const now = state.now ?? new Date();
  const repoOf = new Map(state.zones.map((z) => [z.id, z.repo]));
  const itemById = new Map(state.items.map((i) => [i.id, i]));

  const zones = state.zones
    .map(
      (z) =>
        `<tr><td>${escapeHtml(z.id)}</td><td>${escapeHtml(z.repo)}</td><td>${escapeHtml(z.readyLabel)}</td><td>${escapeHtml(z.model)}</td><td>${escapeHtml(state.modes?.[z.id] ?? 'active')}</td></tr>`,
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
      const target = d.workItemId === null ? 'crew' : wi ? `#${escapeHtml(wi.issueNumber)}` : '-';
      return `<tr><td><a href="/drops/${encodeURIComponent(d.id)}">${escapeHtml(d.id)}</a></td><td>${target}</td><td>${escapeHtml(d.role)}</td><td>${escapeHtml(d.state)}</td><td>${escapeHtml(elapsed(d, now))}</td><td>${gateSummary(d)}</td></tr>`;
    })
    .join('');

  const rl = state.lastRateLimit
    ? `<p>Drop ${escapeHtml(state.lastRateLimit.dropId)} at ${escapeHtml(state.lastRateLimit.ts)}: <code>${escapeHtml(JSON.stringify(state.lastRateLimit.data))}</code></p>`
    : '<p>None seen.</p>';

  return page(
    killSection(state.killed ?? false) +
      (state.briefings ? waitingOnYou(state.briefings) : '') +
      usageSection(state.usage) +
      crewSection(state.crew) +
      `<h2>Drop zones</h2><table><tr><th>Id</th><th>Repo</th><th>Label</th><th>Model</th><th>Mode</th></tr>${zones}</table>` +
      `<h2>Work items</h2><table><tr><th>Zone</th><th>Issue</th><th>Title</th><th>State</th><th>Reason</th><th>PR</th><th>Head</th><th>Verdict</th><th>Attempts</th></tr>${items}</table>` +
      `<h2>Drops</h2><table><tr><th>Drop</th><th>Issue</th><th>Role</th><th>State</th><th>Elapsed</th><th>Gates</th></tr>${drops}</table>` +
      outboxSection(state.outbox) +
      `<h2>Last rate limit</h2>${rl}`,
  );
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
