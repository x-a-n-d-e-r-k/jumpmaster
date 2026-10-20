import type { DropZoneConfig } from '../config.js';
import type {
  AttemptKey,
  Drop,
  OutboxRow,
  StoredEvent,
  UsageStateRow,
  WorkItem,
} from '../db/repo.js';
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
  items: WorkItem[];
  drops: Drop[];
  lastRateLimit?: RateLimitSeen;
  now?: Date;
  usage?: { gate: Gate; state: UsageStateRow };
  /** Per work item: PR head, latest verdict and attempt counts. */
  details?: Map<number, ItemDetail>;
  /** Outbox ops needing attention (`unknown` or `failed`). */
  outbox?: OutboxRow[];
}

export interface ItemDetail {
  headSha?: string;
  verdict?: { decision: string; forced: boolean; summary: string };
  attempts: Partial<Record<AttemptKey, number>>;
}

const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`);

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
        `<tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.kind)}</td><td>${escapeHtml(o.workItemId)}</td><td>${escapeHtml(o.state)}</td><td>${escapeHtml(o.error ?? '')}</td><td>${escapeHtml(o.updatedAt)}</td></tr>`,
    )
    .join('');
  return `<h2>Outbox</h2><table><tr><th>Op</th><th>Kind</th><th>Item</th><th>State</th><th>Error</th><th>Updated</th></tr>${rows}</table>`;
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
        `<tr><td>${escapeHtml(z.id)}</td><td>${escapeHtml(z.repo)}</td><td>${escapeHtml(z.readyLabel)}</td><td>${escapeHtml(z.model)}</td></tr>`,
    )
    .join('');

  const items = state.items
    .map((i) => {
      const repo = repoOf.get(i.dropZoneId);
      const pr =
        i.prNumber !== null && repo
          ? `<a href="${escapeHtml(`https://github.com/${repo}/pull/${i.prNumber}`)}">#${escapeHtml(i.prNumber)}</a>`
          : '-';
      return `<tr><td>${escapeHtml(i.dropZoneId)}</td><td>#${escapeHtml(i.issueNumber)}</td><td>${escapeHtml(i.title)}</td><td>${escapeHtml(i.state)}</td><td>${escapeHtml(i.reason ?? '')}</td><td>${pr}</td>${detailCells(state.details?.get(i.id))}</tr>`;
    })
    .join('');

  const drops = state.drops
    .map((d) => {
      const wi = itemById.get(d.workItemId);
      return `<tr><td><a href="/drops/${encodeURIComponent(d.id)}">${escapeHtml(d.id)}</a></td><td>${wi ? `#${escapeHtml(wi.issueNumber)}` : '-'}</td><td>${escapeHtml(d.role)}</td><td>${escapeHtml(d.state)}</td><td>${escapeHtml(elapsed(d, now))}</td><td>${gateSummary(d)}</td></tr>`;
    })
    .join('');

  const rl = state.lastRateLimit
    ? `<p>Drop ${escapeHtml(state.lastRateLimit.dropId)} at ${escapeHtml(state.lastRateLimit.ts)}: <code>${escapeHtml(JSON.stringify(state.lastRateLimit.data))}</code></p>`
    : '<p>None seen.</p>';

  return page(
    usageSection(state.usage) +
      `<h2>Drop zones</h2><table><tr><th>Id</th><th>Repo</th><th>Label</th><th>Model</th></tr>${zones}</table>` +
      `<h2>Work items</h2><table><tr><th>Zone</th><th>Issue</th><th>Title</th><th>State</th><th>Reason</th><th>PR</th><th>Head</th><th>Verdict</th><th>Attempts</th></tr>${items}</table>` +
      `<h2>Drops</h2><table><tr><th>Drop</th><th>Issue</th><th>Role</th><th>State</th><th>Elapsed</th><th>Gates</th></tr>${drops}</table>` +
      outboxSection(state.outbox) +
      `<h2>Last rate limit</h2>${rl}`,
  );
}

export function renderDrop(drop: Drop, events: StoredEvent[]): string {
  const rows = events
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.seq)}</td><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(e.kind)}</td><td><pre>${escapeHtml(JSON.stringify(e.data))}</pre></td></tr>`,
    )
    .join('');
  return page(
    `<p><a href="/">Back</a></p><h2>Drop ${escapeHtml(drop.id)}</h2><p>State: ${escapeHtml(drop.state)}</p>` +
      `<table><tr><th>Seq</th><th>Time</th><th>Kind</th><th>Data</th></tr>${rows}</table>`,
  );
}
