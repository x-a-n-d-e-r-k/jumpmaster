import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import { type Db, openDb } from './db/open.js';
import {
  getDrop,
  getWorkItem,
  listWorkItems,
  setWorkItemPrFiles,
  setWorkItemState,
  updateDrop,
  upsertDropZone,
  upsertPullRequest,
  upsertWorkItem,
} from './db/repo.js';
import { enqueueNext, OVERLAP_PREFIX, placementPaths, zoneHold, zonePass } from './scheduler.js';
import { t0, tmpDbFile } from './test/helpers.js';
import { DEFAULT_USAGE_CONFIG } from './usage.js';
import type { CredentialProblem } from './vault/problems.js';

const zone: DropZoneConfig = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img:1',
  model: 'm',
  maxTurns: 10,
};

let db: Db;
const add = (n: number, priority: number, body = 'b') =>
  upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: n,
    title: 't',
    body,
    author: 'a',
    priority,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });

beforeEach(() => {
  db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
});

describe('enqueueNext', () => {
  test('one implement drop per zone at a time', () => {
    add(1, 2);
    add(2, 2);
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).not.toBeNull();
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).toBeNull();
  });

  test('queues an implement drop for the top item and marks it in_flight', () => {
    add(1, 2);
    const top = add(2, 0);
    const id = enqueueNext(db, zone, 'v7', DEFAULT_USAGE_CONFIG, t0)!;
    expect(getDrop(db, id)).toMatchObject({
      state: 'queued',
      role: 'implement',
      workItemId: top.id,
      promptVersion: 'v7',
      image: 'img:1',
    });
    expect(listWorkItems(db, 'main', 'in_flight').map((w) => w.id)).toEqual([top.id]);
  });

  test('skips a blocked ready item and starts the next', () => {
    const blocked = add(1, 0);
    upsertWorkItem(db, { ...blocked, blockedBy: ['#9'] });
    const next = add(2, 2);
    const id = enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)!;
    expect(getDrop(db, id)?.workItemId).toBe(next.id);
    expect(listWorkItems(db, 'main', 'ready').map((w) => w.id)).toEqual([blocked.id]);
  });

  test('a lone blocked item starts nothing', () => {
    const blocked = add(1, 0);
    upsertWorkItem(db, { ...blocked, blockedBy: ['1 unreadable blocker'] });
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).toBeNull();
  });

  test('returns null when nothing is ready', () => {
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).toBeNull();
  });

  test('enqueues again once the previous drop is finished', () => {
    add(1, 2);
    add(2, 2);
    const id = enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)!;
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = ?").run(id);
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).not.toBeNull();
  });
});

describe('credential problems park dispatch (Task 4)', () => {
  const problem: CredentialProblem = {
    zoneId: 'main',
    kind: 'missing',
    credential: 'githubReviewerToken',
    message: 'zone main uses two bots, and no GitHub reviewer token is set',
  };

  test('a zone with a credential problem is parked by the scheduler with the problem as its reason, and dispatches once the credential arrives', async () => {
    add(1, 0);
    const logs: string[] = [];
    const run = async () => {
      enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0);
    };
    const drops = () => (db.prepare('SELECT COUNT(*) AS n FROM drops').get() as { n: number }).n;
    expect(await zonePass(zone, [problem], run, (l) => logs.push(l))).toEqual({
      held: `credentials: ${problem.message}`,
    });
    expect(zoneHold('main')).toBe(`credentials: ${problem.message}`);
    expect(drops()).toBe(0);
    // Said once while it lasts, not every pass.
    await zonePass(zone, [problem], run, (l) => logs.push(l));
    expect(logs).toEqual([`zone main parked: credentials: ${problem.message}`]);
    // The credential arrives: the next pass dispatches and the hold clears.
    expect(await zonePass(zone, [], run, (l) => logs.push(l))).toEqual({ held: null });
    expect(zoneHold('main')).toBeUndefined();
    expect(drops()).toBe(1);
    expect(logs.at(-1)).toBe('zone main: credentials in order, dispatch resumes');
  });
});

describe('an app zone whose recorded ids GitHub refuses is parked (issue #267)', () => {
  test('the refusal is the park reason; nothing of the zone runs; it dispatches once the ids verify', async () => {
    add(1, 0);
    const logs: string[] = [];
    let ran = 0;
    const run = async () => {
      ran++;
    };
    let refusal: string | undefined =
      'main: the recorded author repository id does not match octo/demo';
    const verify = async () => refusal;
    expect(await zonePass(zone, [], run, (l) => logs.push(l), verify)).toEqual({
      held: `app: ${refusal}`,
    });
    expect(zoneHold('main')).toBe(`app: ${refusal}`);
    expect(ran).toBe(0);
    expect(logs).toEqual([`zone main parked: app: ${refusal}`]);
    refusal = undefined;
    expect(await zonePass(zone, [], run, (l) => logs.push(l), verify)).toEqual({ held: null });
    expect(zoneHold('main')).toBeUndefined();
    expect(ran).toBe(1);
  });

  test('a credential problem parks first, without asking GitHub', async () => {
    let asked = 0;
    const problem: CredentialProblem = {
      zoneId: 'main',
      kind: 'missing',
      credential: 'claudeToken',
      message: 'no Claude token is set',
    };
    await zonePass(
      zone,
      [problem],
      async () => {},
      () => {},
      async () => {
        asked++;
        return 'refused';
      },
    );
    expect(asked).toBe(0);
    await zonePass(
      zone,
      [],
      async () => {},
      () => {},
    );
  });
});

describe('push_pending', () => {
  test('scheduler counts pending pushes toward maxConcurrentImplement', () => {
    add(1, 2);
    add(2, 2);
    const first = enqueueNext(
      db,
      { ...zone, maxConcurrentImplement: 1 },
      'v1',
      DEFAULT_USAGE_CONFIG,
      t0,
    )!;
    updateDrop(db, first, { state: 'push_pending' });
    expect(
      enqueueNext(db, { ...zone, maxConcurrentImplement: 1 }, 'v1', DEFAULT_USAGE_CONFIG, t0),
    ).toBeNull();
    expect(
      enqueueNext(db, { ...zone, maxConcurrentImplement: 2 }, 'v1', DEFAULT_USAGE_CONFIG, t0),
    ).not.toBeNull();
  });
});

const placement = (...spans: string[]) =>
  `## Summary\n\nx\n\n## Placement\n\n${spans.map((p) => `\`${p}\``).join(', ')}\n\n## Out of scope\n\n- none\n`;

describe('placementPaths', () => {
  test('the issue examples', () => {
    expect(
      placementPaths(
        placement('apps/server/src/flow/decide.ts', 'apps/server/src/flow/snapshot.ts'),
      ),
    ).toEqual(['apps/server/src/flow/decide.ts', 'apps/server/src/flow/snapshot.ts']);
    expect(placementPaths(placement('apps/server/src/flow/'))).toEqual(['apps/server/src/flow/']);
    expect(placementPaths('## Placement\n\nTests beside each.\n')).toEqual([]);
  });

  test('[] without a Placement section', () => {
    expect(placementPaths('## Summary\n\nSee `apps/x.ts`.\n')).toEqual([]);
    expect(placementPaths('')).toEqual([]);
  });

  test('a fenced block under Placement is ignored', () => {
    const body = [
      '## Placement',
      '',
      '`apps/a.ts`',
      '```',
      '`apps/fenced.ts`',
      '```',
      '~~~ts',
      'const x = `apps/tilde.ts`;',
      '~~~',
      '`apps/b.ts`',
    ].join('\n');
    expect(placementPaths(body)).toEqual(['apps/a.ts', 'apps/b.ts']);
  });

  test('spans outside Placement are ignored', () => {
    const body =
      '## Summary\n\n`apps/before.ts`\n\n## Placement\n\n`apps/in.ts`\n\n## Order\n\n`apps/after.ts`\n';
    expect(placementPaths(body)).toEqual(['apps/in.ts']);
  });

  test('a leading ./ is stripped, duplicates go, and the result is sorted', () => {
    expect(placementPaths(placement('./src/z.ts', 'src/a.ts', 'src/z.ts'))).toEqual([
      'src/a.ts',
      'src/z.ts',
    ]);
  });

  test('a directory keeps its trailing /', () => {
    expect(placementPaths(placement('./apps/server/src/db/', 'docs/'))).toEqual([
      'apps/server/src/db/',
      'docs/',
    ]);
  });

  test('spans that are not paths are ignored', () => {
    expect(
      placementPaths(placement('npm test', 'maxOpenPrs', 'pr_open', 'README.md', 'enqueueNext()')),
    ).toEqual(['README.md']);
  });

  test("this issue's own Placement", () => {
    const body =
      '## Placement\n\n`apps/server/src/scheduler.ts`, `apps/server/src/flow/snapshot.ts`, `apps/server/src/flow/reconcile.ts` (observe mode), the zone config schema and docs, a migration under `apps/server/src/db/`, the status text on the floor and in `ctl`, and tests beside each.\n\n## Out of scope\n';
    expect(placementPaths(body)).toEqual([
      'apps/server/src/db/',
      'apps/server/src/flow/reconcile.ts',
      'apps/server/src/flow/snapshot.ts',
      'apps/server/src/scheduler.ts',
    ]);
  });
});

describe('enqueueNext holds back overlap and caps open PRs (issue #291)', () => {
  /** A pr_open item with PR #`pr` whose stored file list is `files` (null: unknown). */
  const openPr = (n: number, pr: number, files: string[] | null) => {
    const item = add(n, 5);
    setWorkItemState(db, item.id, 'pr_open', undefined, t0);
    upsertPullRequest(
      db,
      { workItemId: item.id, number: pr, headRef: `agent/issue-${n}`, headSha: 's', state: 'open' },
      t0,
    );
    setWorkItemPrFiles(db, item.id, files);
    return item;
  };
  const started = (id: string | null) => (id === null ? null : getDrop(db, id)?.workItemId);

  test('an overlapping top item is skipped and the next starts; the held one says why', () => {
    openPr(10, 257, ['apps/server/src/flow/decide.ts', 'docs/x.md']);
    const top = add(
      1,
      0,
      placement('apps/server/src/flow/decide.ts', 'apps/server/src/flow/snapshot.ts'),
    );
    const next = add(2, 1, placement('apps/stick/src/runner.ts'));
    expect(started(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0))).toBe(next.id);
    expect(getWorkItem(db, top.id)).toMatchObject({
      state: 'ready',
      reason: 'waiting: overlaps #257 on apps/server/src/flow/decide.ts',
    });
    expect(getWorkItem(db, top.id)?.reason?.startsWith(OVERLAP_PREFIX)).toBe(true);
  });

  test('the hold goes once the PR leaves pr_open, and the item starts', () => {
    const pr = openPr(10, 257, ['src/a.ts']);
    const top = add(1, 0, placement('src/a.ts'));
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).toBeNull();
    expect(getWorkItem(db, top.id)?.reason).toBe('waiting: overlaps #257 on src/a.ts');
    setWorkItemState(db, pr.id, 'done', 'merged', t0);
    expect(started(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0))).toBe(top.id);
    expect(getWorkItem(db, top.id)).toMatchObject({ state: 'in_flight', reason: null });
  });

  test('a directory in Placement overlaps a PR file under it', () => {
    openPr(10, 31, ['apps/server/src/flow/decide.ts']);
    const top = add(1, 0, placement('apps/server/src/flow/'));
    const next = add(2, 1, placement('apps/server/src/flowers.ts'));
    expect(started(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0))).toBe(next.id);
    expect(getWorkItem(db, top.id)?.reason).toBe(
      'waiting: overlaps #31 on apps/server/src/flow/decide.ts',
    );
  });

  test('the first match in sorted order is the one named', () => {
    openPr(10, 40, ['b/z.ts']);
    openPr(11, 41, ['a/y.ts']);
    const top = add(1, 0, placement('b/z.ts', 'a/y.ts'));
    enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0);
    expect(getWorkItem(db, top.id)?.reason).toBe('waiting: overlaps #41 on a/y.ts');
  });

  test('an open PR with an unknown file list holds nothing back', () => {
    openPr(10, 257, null);
    const top = add(1, 0, placement('src/a.ts'));
    expect(started(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0))).toBe(top.id);
  });

  test('an item with no Placement paths is never held', () => {
    openPr(10, 257, ['src/a.ts']);
    const top = add(1, 0, '## Placement\n\nTests beside each.\n');
    expect(started(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0))).toBe(top.id);
  });

  test('maxOpenPrs reached starts no implement drop; one leaving pr_open lets one start', () => {
    const capped = { ...zone, maxOpenPrs: 2 };
    const a = openPr(10, 100, ['x/a.ts']);
    openPr(11, 101, ['x/b.ts']);
    const top = add(1, 0, placement('y/c.ts'));
    expect(enqueueNext(db, capped, 'v1', DEFAULT_USAGE_CONFIG, t0)).toBeNull();
    expect(getWorkItem(db, top.id)?.state).toBe('ready');
    setWorkItemState(db, a.id, 'done', 'merged', t0);
    expect(started(enqueueNext(db, capped, 'v1', DEFAULT_USAGE_CONFIG, t0))).toBe(top.id);
  });

  test('maxOpenPrs absent: open PRs never cap', () => {
    for (let n = 10; n < 15; n++) openPr(n, n, null);
    const top = add(1, 0);
    expect(started(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0))).toBe(top.id);
  });
});
