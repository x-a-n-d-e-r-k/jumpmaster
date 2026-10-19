import { describe, expect, test } from 'vitest';
import { openDb } from './db/open.js';
import {
  getDrop,
  insertDrop,
  setWorkItemState,
  upsertDropZone,
  upsertWorkItem,
} from './db/repo.js';
import { applyResult } from './results.js';
import { enqueueNext } from './scheduler.js';
import { fakeForge } from './test/fakes.js';
import { t0, tmpDbFile, workItem } from './test/helpers.js';

const zone = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img',
  model: 'm',
  maxTurns: 200,
};

const gateOk = {
  name: 'test',
  exitCode: 0,
  durationMs: 1500,
  timedOut: false,
  outputTail: 'SECRET-TAIL',
};
const gateTimeout = {
  name: 'slow | gate',
  exitCode: null,
  durationMs: 60000,
  timedOut: true,
  outputTail: '',
};

function setup() {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'develop', configJson: '{}' });
  const wi = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 7,
    title: 'Add widget',
    body: 'b',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  setWorkItemState(db, wi.id, 'in_flight');
  insertDrop(db, {
    id: 'd1',
    dropZoneId: 'main',
    workItemId: wi.id,
    role: 'implement',
    state: 'running',
  });
  return { db, forge: fakeForge({ issues: [], trusted: [] }) };
}

describe('applyResult', () => {
  test('completed opens one PR with Closes #N and a gate table', async () => {
    const { db, forge } = setup();
    await applyResult(db, forge, 'd1', {
      status: 'completed',
      headSha: 'abc',
      gates: [gateOk, gateTimeout],
    });
    expect(forge.created).toEqual([
      expect.objectContaining({
        head: 'agent/issue-7',
        base: 'develop',
        title: 'Add widget',
        body: expect.stringContaining('Closes #7'),
      }),
    ]);
    const body = forge.created[0]?.body ?? '';
    expect(body).toContain('| Gate | Exit | Duration (s) |');
    expect(body).toContain('| test | 0 | 1.5 |');
    expect(body).toContain('| slow \\| gate | timeout | 60.0 |');
    expect(body).not.toContain('SECRET-TAIL');
    expect(workItem(db, 1)).toMatchObject({ state: 'pr_open', prNumber: 101 });
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
  });

  test('parks no_changes with reason no_changes and the drop succeeds', async () => {
    const { db, forge } = setup();
    await applyResult(db, forge, 'd1', { status: 'no_changes', gates: [] });
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'no_changes' });
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
    expect(enqueueNext(db, zone, 'v1')).toBeNull();
    expect(forge.created).toHaveLength(0);
  });

  test('blocked parks with its reason; the drop succeeds', async () => {
    const { db, forge } = setup();
    await applyResult(db, forge, 'd1', { status: 'blocked', reason: 'needs design', gates: [] });
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'needs design' });
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
  });

  test('blocked without reason falls back to the status', async () => {
    const { db, forge } = setup();
    await applyResult(db, forge, 'd1', { status: 'blocked', gates: [] });
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'blocked' });
  });

  test('failed parks with the reason and fails the drop', async () => {
    const { db, forge } = setup();
    await applyResult(db, forge, 'd1', {
      status: 'failed',
      reason: 'gates failed',
      gates: [gateOk],
    });
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'gates failed' });
    expect(getDrop(db, 'd1')?.state).toBe('failed');
  });

  test('completed without headSha is a failure', async () => {
    const { db, forge } = setup();
    await applyResult(db, forge, 'd1', { status: 'completed', gates: [] });
    expect(workItem(db, 1)).toMatchObject({
      state: 'parked',
      reason: 'completed without headSha',
    });
    expect(getDrop(db, 'd1')?.state).toBe('failed');
    expect(forge.created).toHaveLength(0);
  });
});
