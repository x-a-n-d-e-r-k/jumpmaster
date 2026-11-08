import { describe, expect, test } from 'vitest';
import {
  applyGateAllowance,
  applyPendingRulings,
  type Briefing,
  listBriefings,
  listRulings,
  raiseBriefing,
  ruleBriefing,
} from './briefings.js';
import { openDb } from './db/open.js';
import {
  getGateAllowance,
  getGatePark,
  getWorkItem,
  recordGatePark,
  setWorkItemState,
} from './db/repo.js';
import { decide } from './flow/decide.js';
import { reconcileZone } from './flow/reconcile.js';
import { buildSnapshot, gateDigest, zonePass } from './flow/snapshot.js';
import { promptVersions } from './payloads.js';
import { syncParked } from './sync.js';
import { usageCfg, type ZoneWorld, zoneWorld } from './test/fixtures.js';
import { plus, t0 } from './test/helpers.js';

const MIN = 60_000;
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NEXT = 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432';
const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts });

/** The PR on `sha` changes the `test` gate script. */
function gateChange(w: ZoneWorld, sha: string, head = pkg({ test: 'vitest --bail' })): void {
  w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
  w.f.state.files.set('base0:package.json', pkg({ test: 'vitest' }));
  w.f.state.files.set(`${sha}:package.json`, head);
  w.f.state.checks.set(sha, { state: 'success', names: ['ci'] });
}

function gateWorld(head?: string): { w: ZoneWorld; id: number } {
  const w = zoneWorld();
  const id = w.prItem(1, HEAD);
  gateChange(w, HEAD, head);
  return { w, id };
}

const reconcile = async (w: ZoneWorld, now: Date) =>
  reconcileZone(
    w.db,
    w.forges,
    w.zone,
    await zonePass(w.forges, w.zone, 'main'),
    promptVersions(),
    usageCfg,
    [],
    now,
  );
const sync = async (w: ZoneWorld, now: Date) =>
  syncParked(w.db, w.forges, w.zone, await zonePass(w.forges, w.zone, 'main'), now);
const decideNow = async (w: ZoneWorld, id: number, now: Date) => {
  const item = getWorkItem(w.db, id);
  if (!item) throw new Error('no item');
  const pass = await zonePass(w.forges, w.zone, 'main');
  return decide(await buildSnapshot(w.db, w.forges, w.zone, item, pass, now));
};
const stateOf = (w: ZoneWorld, id: number) => getWorkItem(w.db, id)?.state;
const deps = (w: ZoneWorld) => ({ forges: () => w.forges, zone: () => w.zone });

function parkedBriefing(w: ZoneWorld): Briefing {
  const b = listBriefings(w.db, { zoneId: 'main', state: 'open' }).find((x) => x.kind === 'parked');
  if (!b) throw new Error('no parked briefing');
  return b;
}

/** Parks the item on its gate change (pass 1) and raises its briefing (pass 2). */
async function parkAndBrief(w: ZoneWorld, id: number): Promise<Briefing> {
  await reconcile(w, t0);
  expect(stateOf(w, id)).toBe('parked');
  await reconcile(w, plus(t0, MIN));
  return parkedBriefing(w);
}

async function allow(w: ZoneWorld, b: Briefing, at: Date): Promise<void> {
  const r = ruleBriefing(w.db, b.id, 'allow', '', at);
  expect(r.ok).toBe(true);
}

describe('allow a gate change by Command ruling', () => {
  test('a fully read gate park is briefed with an allow option bound to the head', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    expect(b.why).toMatch(/^gate script changed: test/);
    // Every change in full, old → new, so Command sees what it allows.
    expect(b.why).toContain('test: "vitest" → "vitest --bail"');
    expect(b.decision).toContain('Read the PR diff at a1b2c3d on the forge before ruling.');
    expect(b.options).toEqual([
      { id: 'retry', label: 'Retry', effect: 'retry_item' },
      { id: 'leave', label: 'Leave parked', effect: 'none' },
      {
        id: 'allow',
        label: 'Allow these gate changes for a1b2c3d',
        effect: 'allow_gate_change',
        sha: HEAD,
        mergeBase: 'base0',
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  test('a change list too long for the briefing is shown cut, with no allow option', async () => {
    const { w, id } = gateWorld(pkg({ test: `vitest ${'x'.repeat(9000)}` }));
    const b = await parkAndBrief(w, id);
    expect(b.why.length).toBeLessThanOrEqual(8200);
    expect(b.why).toContain('too long to review here');
    expect(b.options.map((o) => o.effect)).toEqual(['retry_item', 'none']);
  });

  test('a truncated park reason offers no allow option', async () => {
    const { w, id } = gateWorld();
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`script-number-${i}`, `vitest ${i}`]),
    );
    const test = Object.keys(many)
      .map((n) => `npm run ${n}`)
      .join(' && ');
    gateChange(w, HEAD, pkg({ test, ...many }));
    const b = await parkAndBrief(w, id);
    expect(b.why).toMatch(/\(\+\d+ more\)/);
    expect(b.options.map((o) => o.effect)).toEqual(['retry_item', 'none']);
  });

  test('a park not fully read offers no allow option', async () => {
    // A dependency added with no lockfile anywhere: `lockfile not found`.
    const { w, id } = gateWorld(
      JSON.stringify({ name: 'x', scripts: { test: 'vitest' }, dependencies: { x: '^1' } }),
    );
    const b = await parkAndBrief(w, id);
    expect(b.why).toContain('(not fully read: merge it by hand)');
    expect(b.options.map((o) => o.effect)).toEqual(['retry_item', 'none']);
  });

  test('a protected path park offers no allow option', async () => {
    const { w, id } = gateWorld();
    w.f.state.pullFiles.set(1, {
      files: [{ path: 'package.json' }, { path: '.github/workflows/ci.yml' }],
      complete: true,
    });
    const b = await parkAndBrief(w, id);
    expect(b.why).toBe('protected path: .github/workflows/ci.yml');
    expect(b.options.map((o) => o.effect)).toEqual(['retry_item', 'none']);
  });

  test('allowing the current head un-parks the item; the next pass enqueues review', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    await reconcile(w, plus(t0, 3 * MIN));
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ applyError: null });
    expect(getGateAllowance(w.db, id, HEAD)).toMatchObject({ headSha: HEAD });
    await sync(w, plus(t0, 4 * MIN));
    expect(stateOf(w, id)).toBe('pr_open');
    expect(await decideNow(w, id, plus(t0, 5 * MIN))).toMatchObject({
      kind: 'enqueue',
      role: 'review',
    });
  });

  test('a head that moved before the ruling applied allows nothing', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    w.f.state.setHead(1, NEXT);
    gateChange(w, NEXT);
    await reconcile(w, plus(t0, 3 * MIN));
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ applyError: 'head moved' });
    expect(getGateAllowance(w.db, id, HEAD)).toBeUndefined();
    expect(getGateAllowance(w.db, id, NEXT)).toBeUndefined();
    await sync(w, plus(t0, 4 * MIN));
    await sync(w, plus(t0, 2 * 60 * MIN));
    expect(stateOf(w, id)).toBe('parked');
  });

  test("an allowance for an old head doesn't lift the park of a new head", async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    await reconcile(w, plus(t0, 3 * MIN));
    expect(getGateAllowance(w.db, id, HEAD)).toBeDefined();
    w.f.state.setHead(1, NEXT);
    gateChange(w, NEXT);
    await sync(w, plus(t0, 4 * MIN));
    expect(stateOf(w, id)).toBe('parked');
    expect(await decideNow(w, id, plus(t0, 5 * MIN))).toMatchObject({
      kind: 'park',
      reason: expect.stringMatching(/^gate script changed: test/),
    });
  });

  test('an allowance re-decides a parked item once, not every pass', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    await reconcile(w, plus(t0, 3 * MIN));
    // The head moves after the allowance: the re-decide still parks.
    w.f.state.setHead(1, NEXT);
    gateChange(w, NEXT);
    const redecides = () => w.f.author.calls.filter((c) => c.method === 'listPullFiles').length;
    const before = redecides();
    await sync(w, plus(t0, 4 * MIN));
    expect(redecides()).toBe(before + 1);
    await sync(w, plus(t0, 5 * MIN));
    await sync(w, plus(t0, 6 * MIN));
    expect(redecides()).toBe(before + 1);
    expect(stateOf(w, id)).toBe('parked');
  });

  test('a new push after the item went on parks it again', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    await reconcile(w, plus(t0, 3 * MIN));
    await sync(w, plus(t0, 4 * MIN));
    expect(stateOf(w, id)).toBe('pr_open');
    w.f.state.setHead(1, NEXT);
    gateChange(w, NEXT);
    expect(await decideNow(w, id, plus(t0, 5 * MIN))).toMatchObject({ kind: 'park' });
  });

  test('the allowance survives a restart; applying it twice records one row', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    expect(await applyPendingRulings(w.db, deps(w), 'main', plus(t0, 3 * MIN))).toBe(1);
    expect(await applyPendingRulings(w.db, deps(w), 'main', plus(t0, 4 * MIN))).toBe(0);
    const ruling = { ...b, id: listRulings(w.db, 'main')[0]?.id ?? 0 };
    const option = b.options.find((o) => o.id === 'allow');
    if (!option) throw new Error('no allow option');
    expect(await applyGateAllowance(w.db, deps(w), 'main', ruling, option, plus(t0, 5 * MIN))).toBe(
      true,
    );
    const count = () =>
      (w.db.prepare('SELECT COUNT(*) AS n FROM gate_allowances').get() as { n: number }).n;
    expect(count()).toBe(1);
    expect(getGateAllowance(w.db, id, HEAD)?.ruledAt).toBe(plus(t0, 3 * MIN).toISOString());

    const file = w.db.name;
    w.db.close();
    const db = openDb(file);
    expect(getGateAllowance(db, id, HEAD)).toMatchObject({ headSha: HEAD });
    db.close();
  });

  test('a briefing out of date with what the item is parked on allows nothing', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    // Re-judged on the same head with another change list (e.g. a guard upgrade).
    const park = getGatePark(w.db, id);
    if (!park) throw new Error('no gate park');
    recordGatePark(
      w.db,
      { ...park, details: { scripts: ['test: "vitest" → "evil"'], tools: [] } },
      plus(t0, 2 * MIN),
    );
    await reconcile(w, plus(t0, 3 * MIN));
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ applyError: 'briefing out of date' });
    expect(getGateAllowance(w.db, id, HEAD)).toBeUndefined();
  });

  test('the allowance records the merge base and digest of the changes Command read', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    await reconcile(w, plus(t0, 3 * MIN));
    const park = getGatePark(w.db, id);
    expect(getGateAllowance(w.db, id, HEAD)).toMatchObject({
      mergeBaseSha: 'base0',
      digest: park && gateDigest(park.details),
    });
  });

  test('an item that left parked before the ruling applied is left alone', async () => {
    const { w, id } = gateWorld();
    const b = await parkAndBrief(w, id);
    await allow(w, b, plus(t0, 2 * MIN));
    setWorkItemState(w.db, id, 'done', 'merged', plus(t0, 2 * MIN));
    expect(await applyPendingRulings(w.db, deps(w), 'main', plus(t0, 3 * MIN))).toBe(1);
    expect(getGateAllowance(w.db, id, HEAD)).toBeUndefined();
  });

  test('a crew briefing can never carry allow_gate_change', () => {
    const { w } = gateWorld();
    expect(() =>
      raiseBriefing(
        w.db,
        {
          zoneId: 'main',
          kind: 'crew',
          subject: 'crew:x',
          decision: 'd',
          why: 'w',
          options: [{ id: 'a', label: 'Allow', effect: 'allow_gate_change', sha: HEAD }],
          source: 'crew',
        },
        t0,
      ),
    ).toThrow(/effect none/);
  });

  test('allow_gate_change applies only from a server parked briefing with a head', async () => {
    const { w, id } = gateWorld();
    await reconcile(w, t0);
    for (const [n, b] of [
      // A server briefing of another kind on the item's subject.
      { kind: 'promote' as const, sha: HEAD },
      // A parked briefing whose option names no head.
      { kind: 'parked' as const },
    ].entries()) {
      const bid = raiseBriefing(
        w.db,
        {
          zoneId: 'main',
          kind: b.kind,
          subject: `item:${id}`,
          decision: 'd',
          why: 'w',
          options: [
            {
              id: 'allow',
              label: 'Allow',
              effect: 'allow_gate_change',
              ...('sha' in b ? { sha: b.sha } : {}),
            },
          ],
          source: 'server',
        },
        plus(t0, n * MIN),
      );
      expect(ruleBriefing(w.db, bid, 'allow', '', plus(t0, n * MIN)).ok).toBe(true);
    }
    await applyPendingRulings(w.db, deps(w), 'main', plus(t0, 5 * MIN));
    expect(listRulings(w.db, 'main').map((r) => r.applyError)).toEqual([
      'allow_gate_change needs a server parked briefing with a head',
      'allow_gate_change needs a server parked briefing with a head',
    ]);
    expect(getGateAllowance(w.db, id, HEAD)).toBeUndefined();
  });
});
