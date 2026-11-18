import { describe, expect, test } from 'vitest';
import { jmLabelNames, listBacklog, queueIssue, queueOpKey } from './backlog.js';
import { openDb } from './db/open.js';
import { listOutbox, setKilled, setZoneMode } from './db/repo.js';
import { opKeys, opMarker } from './outbox.js';
import { fakeForgePair } from './test/fakes.js';
import { makeZone } from './test/fixtures.js';
import { t0, tmpDbFile } from './test/helpers.js';

const ALL_STATES = ['pending', 'done', 'unknown', 'failed'] as const;

function world(o: { trusted?: string[] } = {}) {
  const db = openDb(tmpDbFile());
  const zone = makeZone({ id: 'main' });
  const f = fakeForgePair({ issues: [], trusted: o.trusted ?? ['human'] });
  const forges = { author: f.author, reviewer: f.reviewer };
  const outbox = () => listOutbox(db, [...ALL_STATES]);
  return { db, zone, f, forges, state: f.state, outbox };
}

describe('backlog', () => {
  test('jmLabelNames names every label Jumpmaster reads or writes on an issue', () => {
    expect(jmLabelNames(makeZone()).sort()).toEqual(
      ['agent-ready', 'agent-retry', 'agent-staged', 'jm-triage', 'jm-triaged'].sort(),
    );
  });

  test('queueOpKey is labels:<zone>:queue:<n>:<epoch ms>', () => {
    expect(queueOpKey('main', 7, t0)).toBe(`labels:main:queue:7:${t0.getTime()}`);
  });

  test('listBacklog lists open issues with no Jumpmaster label and no Jumpmaster body', async () => {
    const { zone, forges, state } = world();
    state.addIssue({ number: 1 });
    state.addIssue({ number: 2, labels: ['drop-ready'] });
    state.addIssue({ number: 3, labels: ['agent-staged'] });
    state.addIssue({
      number: 4,
      body: `Some work\n\n${opMarker(opKeys.issue('main', '1', 'k'))}`,
    });
    state.addIssue({ number: 5, labels: ['bug'] });
    const backlog = await listBacklog(
      forges.author,
      makeZone({ ...zone, readyLabel: 'drop-ready' }),
    );
    expect(backlog.map((i) => i.number)).toEqual([1, 5]);
    expect(backlog[0]).toEqual({
      number: 1,
      title: 'Issue 1',
      author: 'human',
      createdAt: expect.any(String),
      startable: true,
    });
  });

  test("an untrusted author's issue is listed as not startable and queue refuses it", async () => {
    const { db, zone, forges, state, outbox } = world();
    state.addIssue({ number: 6, author: 'stranger', labels: ['bug'] });
    const [row] = await listBacklog(forges.author, zone);
    expect(row).toMatchObject({ number: 6, startable: false });
    expect(row?.reason).toContain('write access');
    const r = await queueIssue(db, forges, zone, 6, t0);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(state.issues.get(6)?.labels).toEqual(['bug']);
    expect(outbox()).toEqual([]);
  });

  test('a trust read failure lists the issue as not startable, as intake does', async () => {
    const { zone, f, forges, state } = world();
    state.addIssue({ number: 1 });
    f.author.failNext('isTrusted', 'throw');
    const [row] = await listBacklog(forges.author, zone);
    expect(row).toMatchObject({ number: 1, startable: false });
  });

  test('queueIssue puts the ready label on through one set_labels op', async () => {
    const { db, zone, forges, state, outbox } = world();
    state.addIssue({ number: 1, labels: ['bug'] });
    const r = await queueIssue(db, forges, zone, 1, t0);
    expect(r).toEqual({ ok: true, opKey: queueOpKey('main', 1, t0) });
    expect(state.issues.get(1)?.labels).toContain(zone.readyLabel);
    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('set_labels');
    expect(rows[0]?.opKey.startsWith('labels:main:queue:1:')).toBe(true);
    expect(JSON.parse(rows[0]?.payloadJson ?? '{}')).toEqual({
      number: 1,
      add: [zone.readyLabel],
      remove: [],
    });
  });

  test('D2 queue refuses in observe mode and under the kill switch with no outbox row', async () => {
    const { db, zone, forges, state, outbox } = world();
    state.addIssue({ number: 1 });
    setZoneMode(db, 'main', 'observe', t0);
    expect(await queueIssue(db, forges, zone, 1, t0)).toMatchObject({ ok: false, status: 409 });
    expect(outbox()).toEqual([]);
    setZoneMode(db, 'main', 'active', t0);
    setKilled(db, true, t0);
    expect(await queueIssue(db, forges, zone, 1, t0)).toMatchObject({ ok: false, status: 409 });
    expect(outbox()).toEqual([]);
    expect(state.issues.get(1)?.labels).toEqual([]);
  });

  test('D2 a forge read failure answers 502 and writes nothing', async () => {
    const { db, zone, f, forges, state, outbox } = world();
    state.addIssue({ number: 1 });
    f.author.failNext('getIssue', 'throw');
    expect(await queueIssue(db, forges, zone, 1, t0)).toMatchObject({ ok: false, status: 502 });
    expect(outbox()).toEqual([]);
    expect(f.author.calls.filter((c) => c.method === 'setLabels')).toEqual([]);
  });

  test('queueIssue answers 404 for an issue that does not exist', async () => {
    const { db, zone, forges, outbox } = world();
    expect(await queueIssue(db, forges, zone, 99, t0)).toMatchObject({ ok: false, status: 404 });
    expect(outbox()).toEqual([]);
  });

  test('queueIssue refuses a closed issue, a pull request number and an issue that already carries a Jumpmaster label', async () => {
    const { db, zone, forges, state, outbox } = world();
    state.addIssue({ number: 1 });
    state.closeIssue(1);
    state.addPull({ number: 2, headRef: 'feature', headSha: 'abc', author: 'human' });
    state.addIssue({ number: 3, labels: [zone.triageLabel] });
    state.addIssue({ number: 4, labels: [zone.readyLabel.toUpperCase()] });
    state.addIssue({ number: 5, body: `x\n${opMarker(opKeys.update(1, 'abcdefabcdef'))}` });
    for (const n of [1, 2, 3, 4, 5]) {
      expect([n, await queueIssue(db, forges, zone, n, t0)]).toEqual([
        n,
        expect.objectContaining({ ok: false, status: 409 }),
      ]);
    }
    expect(outbox()).toEqual([]);
  });

  test('D3 two concurrent queues of one issue both succeed and the issue carries the label once', async () => {
    const { db, zone, forges, state } = world();
    state.addIssue({ number: 1 });
    const [a, b] = await Promise.all([
      queueIssue(db, forges, zone, 1, t0),
      queueIssue(db, forges, zone, 1, t0),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const labels = state.issues.get(1)?.labels ?? [];
    expect(labels.filter((l) => l === zone.readyLabel).length).toBe(1);
  });
});
