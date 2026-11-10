import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import { type Db, openDb } from './db/open.js';
import { getDrop, listWorkItems, upsertDropZone, upsertWorkItem } from './db/repo.js';
import { enqueueNext, zoneHold, zonePass } from './scheduler.js';
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
const add = (n: number, priority: number) =>
  upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: n,
    title: 't',
    body: 'b',
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
