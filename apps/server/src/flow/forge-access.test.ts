import { describe, expect, test } from 'vitest';
import { getWorkItem } from '../db/repo.js';
import { type Harness, harness, toPrOpen } from '../test/flowHarness.js';

/** CI required, with branch protection requiring a `ci` check, as a real zone would have. */
async function ciZone(): Promise<Harness> {
  const h = await harness({ zone: { ciRequired: true } });
  for (const id of ['author', 'reviewer'] as const) {
    const r = h.forge.state.rules[id];
    if (r.kind === 'ok') r.rules.requiredChecks = ['ci'];
  }
  return h;
}

describe('forge reads a zone does not need, and reads it is denied', () => {
  test('with no CI required and no required checks, checks are never read', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    expect(h.forge.author.calls.some((c) => c.method === 'checksFor')).toBe(false);
    expect(h.queuedRoles()).toContain('review');
  });

  test('a 403 on a needed read parks at once, naming the permission to grant', async () => {
    const h = await ciZone();
    await toPrOpen(h, 'sha1');
    h.forge.author.failNext('checksFor', { status: 403, message: 'Resource not accessible' });
    await h.reconcile();
    expect(getWorkItem(h.db, 1)).toMatchObject({
      state: 'parked',
      reason:
        'forge read denied: checksFor (grant the author token Checks: read and Commit statuses: read)',
    });
  });

  test('a denied read recovers once the token can read', async () => {
    const h = await ciZone();
    await toPrOpen(h, 'sha1');
    h.forge.author.failNext('checksFor', { status: 403 });
    await h.reconcile();
    expect(getWorkItem(h.db, 1)?.state).toBe('parked');
    await h.reconcile();
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
  });

  test('a transient failure still waits instead of parking', async () => {
    const h = await ciZone();
    await toPrOpen(h, 'sha1');
    h.forge.author.failNext('checksFor', '5xx');
    await h.reconcile();
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
  });
});
