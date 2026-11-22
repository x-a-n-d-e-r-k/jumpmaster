// A stick's image download reaches /sticks through the whole app (issue #141).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';

const HOST = '127.0.0.1:7420';
const JOIN = 'join-secret-value-4';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

test('progress a stick reports on its lease shows on /sticks, and goes once it reports none', async () => {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-fetch-'));
  const env = { JM_JOIN_TOKEN: JOIN, JM_OPERATOR_TOKEN: 'o'.repeat(32), JM_DEV_IMAGES: '1' };
  const filePath = join(dir, 'jumpmaster.config.json');
  const store = ConfigStore.open({
    db,
    boot: loadBoot({ ...env, JM_DATA_DIR: dir }, filePath),
    filePath,
    env,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  app = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no forge');
    },
    now: () => t0,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  const proto = { host: HOST, 'x-jumpmaster-protocol': '1' };
  const enrolled = await app.inject({
    method: 'POST',
    url: '/api/sticks/enroll',
    headers: proto,
    payload: { joinToken: JOIN, name: 'vps-1', slots: 1 },
  });
  expect(enrolled.statusCode).toBe(200);
  const { stickToken } = enrolled.json() as { stickToken: string };
  const lease = (imageFetch: unknown) =>
    app?.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: { ...proto, authorization: `Bearer ${stickToken}` },
      payload: { freeSlots: 0, capabilities: [], imageFetch },
    });
  const ref = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
  expect((await lease({ ref, done: 3_000_000, total: 90_000_000 }))?.statusCode).toBe(204);
  const s = operatorSession(db, t0);
  const page = async () =>
    (
      await app?.inject({
        method: 'GET',
        url: '/system/sticks',
        headers: { host: HOST, cookie: s.cookie },
      })
    )?.body ?? '';
  expect(await page()).toContain('fetching jumpmaster-trooper 3/90 MB');
  await lease(null);
  expect(await page()).not.toContain('fetching jumpmaster-trooper');
  // A stick still in its first health check (issue #157) says so the same way.
  const starting = (value: unknown) =>
    app?.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: { ...proto, authorization: `Bearer ${stickToken}` },
      payload: { freeSlots: 0, capabilities: [], starting: value },
    });
  expect((await starting({ image: ref }))?.statusCode).toBe(204);
  expect(await page()).toContain('starting: checking the trooper image jumpmaster-trooper');
  expect(await page()).toContain('<span class="stage">Starting</span>');
  await starting(null);
  expect(await page()).not.toContain('starting: checking');
});
