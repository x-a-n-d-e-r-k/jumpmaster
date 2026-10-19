import type { DropZoneConfig } from '../config.js';
import type { Drop, StoredEvent, WorkItem } from '../db/repo.js';

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
      return `<tr><td>${escapeHtml(i.dropZoneId)}</td><td>#${escapeHtml(i.issueNumber)}</td><td>${escapeHtml(i.title)}</td><td>${escapeHtml(i.state)}</td><td>${escapeHtml(i.reason ?? '')}</td><td>${pr}</td></tr>`;
    })
    .join('');

  const drops = state.drops
    .map((d) => {
      const wi = itemById.get(d.workItemId);
      return `<tr><td><a href="/drops/${encodeURIComponent(d.id)}">${escapeHtml(d.id)}</a></td><td>${wi ? `#${escapeHtml(wi.issueNumber)}` : '-'}</td><td>${escapeHtml(d.state)}</td><td>${escapeHtml(elapsed(d, now))}</td><td>${gateSummary(d)}</td></tr>`;
    })
    .join('');

  const rl = state.lastRateLimit
    ? `<p>Drop ${escapeHtml(state.lastRateLimit.dropId)} at ${escapeHtml(state.lastRateLimit.ts)}: <code>${escapeHtml(JSON.stringify(state.lastRateLimit.data))}</code></p>`
    : '<p>None seen.</p>';

  return page(
    `<h2>Drop zones</h2><table><tr><th>Id</th><th>Repo</th><th>Label</th><th>Model</th></tr>${zones}</table>` +
      `<h2>Work items</h2><table><tr><th>Zone</th><th>Issue</th><th>Title</th><th>State</th><th>Reason</th><th>PR</th></tr>${items}</table>` +
      `<h2>Drops</h2><table><tr><th>Drop</th><th>Issue</th><th>State</th><th>Elapsed</th><th>Gates</th></tr>${drops}</table>` +
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
