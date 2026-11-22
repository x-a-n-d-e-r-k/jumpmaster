/**
 * #659: a heal, resolve or implement whose agent run is malformed (two final results, none, a
 * trooper that exited without one) is retried once on the same head before the item parks.
 * Driven through the real result route, reconcile pass, decide and database.
 */
import type { DropResult, GateResult, Verdict } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { getAttempts } from '../db/repo.js';
import { type Harness, harness, toPrOpen } from '../test/flowHarness.js';
import { workItem } from '../test/helpers.js';

const gateOk: GateResult = {
  name: 'test',
  exitCode: 0,
  durationMs: 10,
  timedOut: false,
  outputTail: '',
};
const changes: Verdict = {
  decision: 'request_changes',
  summary: 'needs work',
  findings: [{ severity: 'major', file: 'src/a.ts', detail: 'handle the empty case' }],
};
const HEAD_A = '7368613100000000000000000000000000000000';
const HEAD_B = '7368613200000000000000000000000000000000';

const MALFORMED = [
  'multiple results',
  'claude produced no result',
  'session mismatch',
  'trooper exited 1 without result',
];

const failed = (reason: string): DropResult => ({ status: 'failed', reason, gates: [] });
const item = (h: Harness) => workItem(h.db, 1);

type DropRow = {
  id: string;
  role: string;
  state: string;
  fingerprint: string | null;
  headSha: string | null;
  chargedKey: string | null;
  resultJson: string | null;
};
const drops = (h: Harness, role: string): DropRow[] =>
  h.db
    .prepare(
      `SELECT id, role, state, fingerprint, head_sha AS headSha, charged_key AS chargedKey,
              result_json AS resultJson
       FROM drops WHERE work_item_id = 1 AND role = ? ORDER BY created_at, rowid`,
    )
    .all(role) as DropRow[];

/** Review requests changes on `sha`; the next pass queues the heal. */
async function toHealQueued(h: Harness, sha: string): Promise<void> {
  await toPrOpen(h, sha);
  await h.reconcile();
  await h.finishDrop('review', { status: 'completed', gates: [gateOk], verdict: changes });
  await h.reconcile();
  expect(h.queuedRoles()).toEqual(['heal']);
}

/** The base moves under `sha` and the forge cannot merge it in: the pass queues a resolve. */
async function toResolveQueued(h: Harness, sha: string): Promise<void> {
  await toPrOpen(h, sha);
  h.forge.state.compares.set(`main...${sha}`, {
    aheadBy: 1,
    behindBy: 1,
    baseSha: 'base1',
    mergeBaseSha: 'base0',
  });
  for (let n = 0; n < 5 && !h.queuedRoles().includes('resolve'); n++) await h.reconcile();
  expect(h.queuedRoles()).toEqual(['resolve']);
}

describe('a malformed heal run is retried once on its head', () => {
  for (const reason of MALFORMED) {
    test(`"${reason}": not parked, the drop failed, the same heal enqueued again`, async () => {
      const h = await harness();
      await toHealQueued(h, HEAD_A);
      await h.finishDrop('heal', failed(reason));
      expect(item(h).state).toBe('pr_open');
      const [first] = drops(h, 'heal');
      expect(first?.state).toBe('failed');
      // The drop's stored result keeps its reason, for the drops page.
      expect(JSON.parse(first?.resultJson ?? '{}')).toMatchObject({ reason });
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['heal']);
      const [, retry] = drops(h, 'heal');
      expect(retry?.fingerprint).toBe(first?.fingerprint);
      expect(retry?.headSha).toBe(HEAD_A);
    });
  }

  test('a second malformed run on the same head parks with its reason', async () => {
    const h = await harness();
    await toHealQueued(h, HEAD_A);
    await h.finishDrop('heal', failed('multiple results'));
    await h.reconcile();
    await h.finishDrop('heal', failed('trooper exited 137 without result'));
    expect(item(h)).toMatchObject({
      state: 'parked',
      reason: 'trooper exited 137 without result',
    });
    await h.reconcile();
    expect(h.queuedRoles()).toEqual([]);
  });

  test('the cap is per head: a malformed run on a new head is retried once more', async () => {
    const h = await harness();
    await toHealQueued(h, HEAD_A);
    await h.finishDrop('heal', failed('multiple results'));
    await h.reconcile();
    // The retry pushes head B; its review requests changes again.
    await h.finishDrop('heal', { status: 'completed', headSha: HEAD_B, gates: [gateOk] });
    await h.reconcile();
    await h.finishDrop('review', { status: 'completed', gates: [gateOk], verdict: changes });
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
    await h.finishDrop('heal', failed('multiple results'));
    expect(item(h).state).toBe('pr_open');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
    expect(drops(h, 'heal').at(-1)?.headSha).toBe(HEAD_B);
  });

  test('the retry charges no extra heal budget', async () => {
    const once = await harness();
    await toHealQueued(once, HEAD_A);
    await once.finishDrop('heal', { status: 'completed', headSha: HEAD_B, gates: [gateOk] });

    const retried = await harness();
    await toHealQueued(retried, HEAD_A);
    await retried.finishDrop('heal', failed('multiple results'));
    await retried.reconcile();
    await retried.finishDrop('heal', { status: 'completed', headSha: HEAD_B, gates: [gateOk] });

    expect(getAttempts(retried.db, 1, 'heal').count).toBe(getAttempts(once.db, 1, 'heal').count);
    expect(getAttempts(retried.db, 1, 'heal').count).toBe(1);
  });
});

describe('other heal failures park as today', () => {
  for (const reason of ['gate test failed', 'claude exit 1']) {
    test(`"${reason}" parks`, async () => {
      const h = await harness();
      await toHealQueued(h, HEAD_A);
      await h.finishDrop('heal', failed(reason));
      expect(item(h)).toMatchObject({ state: 'parked', reason });
      expect(drops(h, 'heal')[0]?.state).toBe('failed');
    });
  }

  test('"completed without headSha" parks', async () => {
    const h = await harness();
    await toHealQueued(h, HEAD_A);
    await h.finishDrop('heal', { status: 'completed', gates: [gateOk] });
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'completed without headSha' });
  });

  test('"head moved" is re-decided, not parked', async () => {
    const h = await harness();
    await toHealQueued(h, HEAD_A);
    h.forge.state.setHead(1, HEAD_B);
    await h.finishDrop('heal', failed('head moved: expected a got b'));
    expect(item(h).state).toBe('pr_open');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
  });
});

describe('a malformed resolve run is retried once on its head', () => {
  for (const reason of MALFORMED) {
    test(`"${reason}": not parked, the same resolve enqueued again`, async () => {
      const h = await harness();
      await toResolveQueued(h, HEAD_A);
      await h.finishDrop('resolve', failed(reason));
      expect(item(h).state).toBe('pr_open');
      const [first] = drops(h, 'resolve');
      expect(first?.state).toBe('failed');
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['resolve']);
      expect(drops(h, 'resolve')[1]?.fingerprint).toBe(first?.fingerprint);
    });
  }

  test('a second malformed run parks; the retry charged no resolve budget', async () => {
    const h = await harness();
    await toResolveQueued(h, HEAD_A);
    const before = {
      resolve: getAttempts(h.db, 1, 'resolve').count,
      total: getAttempts(h.db, 1, 'resolve_total').count,
    };
    await h.finishDrop('resolve', failed('claude produced no result'));
    await h.reconcile();
    expect(getAttempts(h.db, 1, 'resolve').count).toBe(before.resolve);
    expect(getAttempts(h.db, 1, 'resolve_total').count).toBe(before.total);
    await h.finishDrop('resolve', failed('claude produced no result'));
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'claude produced no result' });
  });
});

describe('a malformed implement run is retried once', () => {
  test('retried, then parked', async () => {
    const h = await harness();
    await h.reconcile();
    await h.finishDrop('implement', failed('multiple results'));
    expect(item(h).state).not.toBe('parked');
    expect(drops(h, 'implement')[0]?.state).toBe('failed');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['implement']);
    await h.finishDrop('implement', failed('session mismatch'));
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'session mismatch' });
  });

  test('"claude exit 1" parks as today', async () => {
    const h = await harness();
    await h.reconcile();
    await h.finishDrop('implement', failed('claude exit 1'));
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'claude exit 1' });
  });
});
