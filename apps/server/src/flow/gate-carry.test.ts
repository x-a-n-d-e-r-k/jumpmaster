import { describe, expect, test } from 'vitest';
import { type Briefing, listBriefings, ruleBriefing } from '../briefings.js';
import { getGateAllowance, getWorkItem, recordGateAllowance } from '../db/repo.js';
import { promptVersions } from '../payloads.js';
import { syncParked } from '../sync.js';
import { usageCfg, type ZoneWorld, zoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { decide } from './decide.js';
import { reconcileZone } from './reconcile.js';
import { buildSnapshot, gateDigest, zonePass } from './snapshot.js';

const MIN = 60_000;
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432';
const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts });
const BASE = pkg({ test: 'vitest' });
const HEAD = pkg({ test: 'vitest --bail' });

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
const snapshotOf = async (w: ZoneWorld, id: number, now: Date) => {
  const item = getWorkItem(w.db, id);
  if (!item) throw new Error('no item');
  const pass = await zonePass(w.forges, w.zone, 'main');
  return buildSnapshot(w.db, w.forges, w.zone, item, pass, now);
};
const stateOf = (w: ZoneWorld, id: number) => getWorkItem(w.db, id)?.state;
const openParked = (w: ZoneWorld): Briefing[] =>
  listBriefings(w.db, { zoneId: 'main', state: 'open' }).filter((x) => x.kind === 'parked');
const rowsFor = (w: ZoneWorld, head: string) =>
  w.db.prepare('SELECT * FROM gate_allowances WHERE head_sha = ?').all(head) as Record<
    string,
    unknown
  >[];

/**
 * Head A changes the `test` gate script, is parked and briefed, and Command allows it; the item is
 * back on pr_open at A. The branch's change digest at A is `d`.
 */
async function allowedAtA(): Promise<{ w: ZoneWorld; id: number; rulingId: number }> {
  const w = zoneWorld();
  const id = w.prItem(1, A);
  w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
  w.f.state.files.set('base0:package.json', BASE);
  w.f.state.files.set(`${A}:package.json`, HEAD);
  w.f.state.checks.set(A, { state: 'success', names: ['ci'] });
  w.f.state.digests.set(`main...${A}`, { digest: 'd', complete: true });
  await reconcile(w, t0);
  expect(stateOf(w, id)).toBe('parked');
  await reconcile(w, plus(t0, MIN));
  const b = openParked(w)[0];
  const option = b?.options.find((o) => o.effect === 'allow_gate_change');
  if (!b || !option) throw new Error('no allow option');
  expect(ruleBriefing(w.db, b.id, option.id, '', plus(t0, 2 * MIN)).ok).toBe(true);
  await reconcile(w, plus(t0, 3 * MIN));
  await sync(w, plus(t0, 4 * MIN));
  expect(stateOf(w, id)).toBe('pr_open');
  const rulingId = getGateAllowance(w.db, id, 1, A)?.rulingId;
  if (rulingId === undefined) throw new Error('no allowance at A');
  return { w, id, rulingId };
}

/** The flow merged main into the branch: head B on the new merge base `base1`. */
function mergedMain(w: ZoneWorld, opts: { mainScript?: string; digest?: string } = {}): void {
  w.f.state.setHead(1, B);
  w.f.state.compares.set(`main...${B}`, {
    aheadBy: 2,
    behindBy: 0,
    baseSha: 'base1',
    mergeBaseSha: 'base1',
  });
  w.f.state.files.set('base1:package.json', pkg({ test: opts.mainScript ?? 'vitest' }));
  w.f.state.files.set(`${B}:package.json`, HEAD);
  w.f.state.checks.set(B, { state: 'success', names: ['ci'] });
  w.f.state.digests.set(`main...${B}`, { digest: opts.digest ?? 'd', complete: true });
}

/** The item parks on B and the next pass briefs it again; nothing is recorded for B. */
async function parksAndBriefs(w: ZoneWorld, id: number): Promise<void> {
  const at = plus(t0, 10 * MIN);
  await reconcile(w, at);
  expect(stateOf(w, id)).toBe('parked');
  expect(getWorkItem(w.db, id)?.reason).toMatch(/^gate script changed: test/);
  await reconcile(w, plus(at, MIN));
  const brief = openParked(w);
  expect(brief).toHaveLength(1);
  expect(brief[0]?.options.find((o) => o.effect === 'allow_gate_change')?.sha).toBe(B);
  expect(rowsFor(w, B)).toEqual([]);
}

describe("carrying Command's gate allowance across a merge of main (issue #422)", () => {
  test('same gate changes and branch change: carried to B, no park, no briefing', async () => {
    const { w, id, rulingId } = await allowedAtA();
    mergedMain(w);
    expect(decide(await snapshotOf(w, id, plus(t0, 10 * MIN)))).toMatchObject({
      kind: 'enqueue',
      role: 'review',
    });
    await reconcile(w, plus(t0, 11 * MIN));
    expect(stateOf(w, id)).toBe('pr_open');
    expect(openParked(w)).toEqual([]);
    expect(getGateAllowance(w.db, id, 1, B)).toMatchObject({
      headSha: B,
      mergeBaseSha: 'base1',
      digest: getGateAllowance(w.db, id, 1, A)?.digest,
      rulingId,
      carriedFromHead: A,
    });
    expect(rowsFor(w, B)).toHaveLength(1);
  });

  test('main changed the gate script itself: the gate digest differs, so it parks', async () => {
    const { w, id } = await allowedAtA();
    mergedMain(w, { mainScript: 'vitest --run' });
    await parksAndBriefs(w, id);
  });

  test('the branch added a commit: the change digest differs, so it parks', async () => {
    const { w, id } = await allowedAtA();
    mergedMain(w, { digest: 'd2' });
    await parksAndBriefs(w, id);
  });

  test.each([A, B])('a changeDigest read that throws for %s carries nothing', async (bad) => {
    const { w, id } = await allowedAtA();
    mergedMain(w);
    const real = w.f.author.changeDigest.bind(w.f.author);
    w.f.author.changeDigest = async (base, head) => {
      if (head === bad) throw new Error('fake network error');
      return real(base, head);
    };
    await parksAndBriefs(w, id);
  });

  test.each([A, B])('an incomplete digest for %s carries nothing', async (cut) => {
    const { w, id } = await allowedAtA();
    mergedMain(w);
    w.f.state.digests.set(`main...${cut}`, { digest: '', complete: false });
    await parksAndBriefs(w, id);
  });

  test('two equal empty digests carry nothing', async () => {
    const { w, id } = await allowedAtA();
    mergedMain(w);
    w.f.state.digests.set(`main...${A}`, { digest: '', complete: true });
    w.f.state.digests.set(`main...${B}`, { digest: '', complete: true });
    await parksAndBriefs(w, id);
  });

  test("an allowance on another PR number doesn't carry", async () => {
    const { w, id } = await allowedAtA();
    w.db.prepare('UPDATE gate_allowances SET pr_number = 7').run();
    mergedMain(w);
    await parksAndBriefs(w, id);
  });

  test('two passes evaluating B at once record one row, and both see it allowed', async () => {
    const { w, id, rulingId } = await allowedAtA();
    mergedMain(w);
    const at = plus(t0, 10 * MIN);
    const [s1, s2] = await Promise.all([snapshotOf(w, id, at), snapshotOf(w, id, at)]);
    expect(s1.commandAllowed).toBe(true);
    expect(s2.commandAllowed).toBe(true);
    expect(rowsFor(w, B)).toHaveLength(1);
    expect(rowsFor(w, B)[0]).toMatchObject({ ruling_id: rulingId, carried_from_head: A });
  });

  test('no allowance on an earlier head: parks and briefs as before', async () => {
    const w = zoneWorld();
    const id = w.prItem(1, B);
    mergedMain(w);
    w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
    await parksAndBriefs(w, id);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM gate_allowances').get()).toEqual({ n: 0 });
  });

  test("a ruling on B itself replaces a carried row and clears what it's carried from", async () => {
    const { w, id, rulingId } = await allowedAtA();
    mergedMain(w);
    await reconcile(w, plus(t0, 10 * MIN));
    const carried = getGateAllowance(w.db, id, 1, B);
    if (!carried) throw new Error('not carried');
    recordGateAllowance(
      w.db,
      { ...carried, digest: gateDigest({ scripts: ['x'], tools: [] }), rulingId: rulingId + 1 },
      plus(t0, 11 * MIN),
    );
    expect(getGateAllowance(w.db, id, 1, B)).toMatchObject({
      rulingId: rulingId + 1,
      carriedFromHead: null,
    });
  });
});
