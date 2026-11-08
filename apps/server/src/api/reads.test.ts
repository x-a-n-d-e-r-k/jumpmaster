import { expect, test } from 'vitest';
import { getPullRequest, listWorkItems, recordGateAllowance } from '../db/repo.js';
import { harness, toPrOpen } from '../test/flowHarness.js';

test.each(['/', '/observations', '/drops/x', '/artifacts/1'])(
  'a foreign Host cannot read %s, which defeats DNS rebinding',
  async (url) => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url, headers: { host: 'evil.test' } });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('Issue 1');
  },
);

test('an allowed Host can read the home page', async () => {
  const h = await harness();
  expect((await h.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
});

test("the home page shows Command's gate change allowance for the item's current head", async () => {
  const h = await harness();
  await toPrOpen(h, 'abcdef1234567890');
  const item = listWorkItems(h.db, h.zone.id)[0];
  if (!item) throw new Error('no item');
  const home = async () => (await h.app.inject({ method: 'GET', url: '/' })).body;
  expect(await home()).not.toContain('allowed by Command');
  const prNumber = getPullRequest(h.db, item.id)?.number ?? 0;
  const allowance = { itemId: item.id, prNumber, headSha: 'abcdef1234567890', rulingId: 1 };
  recordGateAllowance(h.db, { ...allowance, mergeBaseSha: 'mb', digest: 'd' }, h.now());
  expect(await home()).toContain('gate change allowed by Command for abcdef1');
});

test('a stick on another address still reaches its routes, which use their own token', async () => {
  const h = await harness();
  await h.reconcile();
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/sticks/lease',
    headers: { ...h.stickHeaders(), host: 'jumpmaster.lan:7420' },
    payload: { freeSlots: 1 },
  });
  expect(res.statusCode).toBe(200);
});
