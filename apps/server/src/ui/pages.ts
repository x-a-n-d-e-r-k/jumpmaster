import type { ArtifactRow } from '../artifacts.js';
import type { Briefing, Ruling } from '../briefings.js';
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
  usage?: { gate: Gate; state: UsageStateRow };
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

function usageSection(u: HomeState['usage']): string {
  if (!u) return '';
  const s = u.state;
  const row = (k: string, v: unknown) => `<tr><th>${k}</th><td>${escapeHtml(v ?? '-')}</td></tr>`;
  return (
    `<h2>Usage</h2><table>` +
    row('Gate', u.gate) +
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
const RULE_SCRIPT = `<script>for(const f of document.querySelectorAll('form.rule'))f.addEventListener('submit',async(e)=>{e.preventDefault();const o=f.querySelector('input[name=option]:checked');if(!o){alert('Choose an option');return;}const r=await fetch('/api/control/briefings/'+f.dataset.briefing+'/rule',{method:'POST',headers:{authorization:'Bearer '+f.querySelector('input[type=password]').value,'content-type':'application/json'},body:JSON.stringify({optionId:o.value,note:f.querySelector('textarea').value})});if(r.ok)location.reload();else alert('Refused: '+r.status);});</script>`;

function briefingBlock(b: Briefing, holds: Map<string, string> | undefined): string {
  const hold = b.kind === 'promote_held' ? holds?.get(b.subject) : undefined;
  const options = b.options
    .map(
      (o) =>
        `<label><input type="radio" name="option" value="${escapeHtml(o.id)}" required> ${escapeHtml(o.label)}</label><br>`,
    )
    .join('');
  const row = (k: string, v: string) =>
    v ? `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>` : '';
  return (
    `<h3>${escapeHtml(b.decision)}</h3>` +
    `<table>${row('Zone', b.zoneId)}${row('Kind', b.kind)}${row('About', b.subject)}${row('Why', b.why)}${row('Recommendation', b.recommendation)}${row('On hold', b.onHold)}${row('Raised by', b.source)}${row('Raised', b.createdAt)}</table>` +
    (hold ? `<p>Promotes at ${escapeHtml(hold)} unless you reject it.</p>` : '') +
    `<form class="rule" data-briefing="${escapeHtml(b.id)}">${options}<textarea name="note" maxlength="2000" placeholder="Note (optional)"></textarea><br><input type="password" placeholder="Operator token" autocomplete="off" required> <button>Rule</button></form>`
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
  const rulings = s.rulings
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.zoneId)}</td><td>${escapeHtml(r.briefingId)}</td><td>${escapeHtml(r.choice)}</td><td>${escapeHtml(r.note)}</td><td>${escapeHtml(r.createdAt)}</td><td>${escapeHtml(r.appliedAt ?? '-')}</td><td>${escapeHtml(r.applyError ?? '')}</td></tr>`,
    )
    .join('');
  return page(
    `<p><a href="/">Back</a></p><h2>Briefings (decisions waiting on you)</h2>${open}` +
      `<h2>Rulings (decisions recorded)</h2><table><tr><th>Ruling</th><th>Zone</th><th>Briefing</th><th>Choice</th><th>Note</th><th>Ruled</th><th>Applied</th><th>Error</th></tr>${rulings}</table>`,
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
  const skipped =
    s.skippedCrewUnpromoted.length === 0
      ? '<p>None.</p>'
      : `<ul>${s.skippedCrewUnpromoted.map((n) => `<li>#${escapeHtml(n)}</li>`).join('')}</ul>`;
  return page(
    `<p><a href="/">Back</a></p><h2>Objectives (goal ladder): ${escapeHtml(s.zone.id)}</h2>${ladder}` +
      `<h2>Crew issues</h2><table><tr><th>Objective</th><th>Key</th><th>Title</th><th>State</th><th>Issue</th><th>Work item</th><th>Findings</th></tr>${issues}</table>` +
      `<h2>Crew issues not started (no recorded promotion)</h2>${skipped}`,
  );
}

function detailCells(d: ItemDetail | undefined): string {
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
  return `<td><code>${head}</code></td><td>${verdict}</td><td>${attempts}</td>`;
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
