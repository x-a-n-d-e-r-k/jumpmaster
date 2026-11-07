import { expect, test } from 'vitest';
import { harness } from '../test/flowHarness.js';

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
