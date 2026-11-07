import { expect, test } from 'vitest';
import { harness } from '../test/flowHarness.js';

test('a gate secret reaches the lease payload but never the database', async () => {
  const value = 'postgres://local/secret-value';
  const h = await harness({ zoneSecrets: { TEST_DB_URL: value } });
  await h.reconcile();
  const { payload, dropId } = await h.lease();
  expect(payload.gateSecrets).toEqual({ TEST_DB_URL: value });
  const stored = JSON.stringify(h.db.prepare('SELECT * FROM drops WHERE id = ?').get(dropId));
  expect(stored).not.toContain(value);
  const events = JSON.stringify(h.db.prepare('SELECT * FROM drop_events').all());
  expect(events).not.toContain(value);
});
