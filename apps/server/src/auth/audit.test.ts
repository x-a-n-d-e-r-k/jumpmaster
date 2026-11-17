import { afterEach, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import { recordAudit } from './audit.js';

afterEach(() => serverScrubSet.clear());

const stored = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT target, detail_json AS detail FROM control_audit').all() as {
    target: string | null;
    detail: string;
  }[];

test('configured secrets and token shapes are scrubbed from the target and the detail', () => {
  const db = openDb(tmpDbFile());
  const ghp = `${'ghp_'}${'B'.repeat(36)}`;
  recordAudit(
    db,
    { via: 'token', action: 'x', target: 'configured-secret-1', detail: { note: `t ${ghp}` } },
    t0,
    ['configured-secret-1'],
  );
  expect(stored(db)).toEqual([
    { target: '[REDACTED]', detail: JSON.stringify({ note: 't [REDACTED]' }) },
  ]);
});

test('D5: a value only the scrub set holds is scrubbed from the target and the detail', () => {
  const db = openDb(tmpDbFile());
  const minted = 'minted-only-in-scrub-set-0005';
  serverScrubSet.add(minted);
  recordAudit(
    db,
    { via: 'token', action: 'x', target: `t ${minted}`, detail: { note: minted, n: 1 } },
    t0,
  );
  const rows = stored(db);
  expect(JSON.stringify(rows)).not.toContain(minted);
  expect(rows).toEqual([
    { target: 't [REDACTED]', detail: JSON.stringify({ note: '[REDACTED]', n: 1 }) },
  ]);
});
