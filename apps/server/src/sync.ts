import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import {
  listWorkItems,
  setDropZoneDefaultBranch,
  setWorkItemState,
  upsertDropZone,
  upsertWorkItem,
  type WorkItem,
} from './db/repo.js';
import type { Forge, ForgeIssue } from './forge/github.js';

const PRIORITY_LABELS = ['highest', 'high', 'low', 'lowest'] as const;
const PRIORITY_VALUE: Record<(typeof PRIORITY_LABELS)[number], number> = {
  highest: 0,
  high: 1,
  low: 3,
  lowest: 4,
};
const DEFAULT_PRIORITY = 2;

function priorityOf(labels: string[]): number {
  const names = new Set(labels.map((l) => l.toLowerCase()));
  for (const name of PRIORITY_LABELS) if (names.has(name)) return PRIORITY_VALUE[name];
  return DEFAULT_PRIORITY;
}

const isFixTitle = (title: string): boolean => /^fix:/i.test(title);

/** Orders by priority, then fix: items first, then oldest issue. Does not mutate the input. */
export function rankItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort(
    (a, b) =>
      a.priority - b.priority ||
      Number(b.isFix) - Number(a.isFix) ||
      Date.parse(a.issueCreatedAt) - Date.parse(b.issueCreatedAt),
  );
}

export async function syncDropZone(
  db: Db,
  forge: Forge,
  zone: DropZoneConfig,
): Promise<{ added: number; skippedUntrusted: number }> {
  const defaultBranch = await forge.getDefaultBranch();
  const issues = await forge.listReadyIssues(zone.readyLabel);

  const trust = new Map<string, boolean>();
  for (const author of new Set(issues.map((i: ForgeIssue) => i.author)))
    trust.set(author, await forge.isTrusted(author));

  let added = 0;
  let skippedUntrusted = 0;
  const run = db.transaction(() => {
    upsertDropZone(db, {
      id: zone.id,
      repo: zone.repo,
      defaultBranch,
      configJson: JSON.stringify(zone),
    });
    setDropZoneDefaultBranch(db, zone.id, defaultBranch);

    const known = new Set(listWorkItems(db, zone.id).map((w) => w.issueNumber));
    for (const issue of issues) {
      if (!trust.get(issue.author)) {
        skippedUntrusted++;
        continue;
      }
      upsertWorkItem(db, {
        dropZoneId: zone.id,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        author: issue.author,
        priority: priorityOf(issue.labels),
        isFix: isFixTitle(issue.title),
        issueCreatedAt: issue.createdAt,
      });
      if (!known.has(issue.number)) added++;
    }

    const listed = new Set(issues.map((i) => i.number));
    for (const w of listWorkItems(db, zone.id, 'ready'))
      if (!listed.has(w.issueNumber)) setWorkItemState(db, w.id, 'done', 'no longer ready');
  });
  run();
  return { added, skippedUntrusted };
}
