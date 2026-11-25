import nock from 'nock';
import { afterEach, expect, test } from 'vitest';
import { AGENT_FOREGROUND_ENV, CONTAINER_ENV, DROP_PROXY_ENV } from '../vitest.setup.js';

afterEach(() => nock.cleanAll());

test('unit tests run without the trooper container environment', () => {
  for (const name of CONTAINER_ENV) expect(process.env[name], name).toBeUndefined();
});

test("unit tests run without a drop's proxy settings", () => {
  for (const name of DROP_PROXY_ENV) expect(process.env[name], name).toBeUndefined();
});

test("unit tests run without a drop agent's foreground settings", () => {
  for (const name of AGENT_FOREGROUND_ENV) expect(process.env[name], name).toBeUndefined();
});

test('fetch reaches an HTTP mock even when vitest was started behind a proxy', async () => {
  nock('https://api.github.com').get('/hermetic').reply(200, { ok: true });
  const r = await fetch('https://api.github.com/hermetic');
  expect(await r.json()).toEqual({ ok: true });
});
