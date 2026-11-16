import { describe, expect, test } from 'vitest';
import type { AppEntryRead, AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import {
  type AppInstallation,
  appInstallationsOf,
  suspendAll,
  unsuspendAll,
} from './app-suspension.js';
import { type GitHubAppBroker, GitHubAppError } from './github-app.js';

const present: AppEntryRead = {
  source: 'vault',
  fingerprint: 'fp',
  entry: { appId: '1', slug: 's', clientId: 'c', pem: 'PEM', importedAt: '2026-11-01' },
};
const missing: AppEntryRead = { source: 'missing' };
const apps = (o: Record<string, Partial<Record<AppRole, AppEntryRead>>>): ResolvedApps =>
  new Map(
    Object.entries(o).map(([k, v]) => [
      k,
      { author: v.author ?? missing, reviewer: v.reviewer ?? missing },
    ]),
  );

const zone = (
  repo: string,
  installations: { author?: number; reviewer?: number } | undefined,
  identity: 'starter' | 'two-bot' = 'two-bot',
) => ({
  repo,
  identity,
  ...(installations ? { githubApp: { repositoryId: 1, installations } } : {}),
});

describe('appInstallationsOf', () => {
  test('lists each recorded app installation once, across zones and roles', () => {
    const list = appInstallationsOf(
      [
        zone('Octo/a', { author: 10, reviewer: 20 }),
        zone('octo/b', { author: 10, reviewer: 20 }),
        zone('other/c', { author: 30 }),
      ],
      apps({ octo: { author: present, reviewer: present }, other: { author: present } }),
    );
    expect(list).toEqual([
      { owner: 'octo', role: 'author', installationId: 10 },
      { owner: 'octo', role: 'reviewer', installationId: 20 },
      { owner: 'other', role: 'author', installationId: 30 },
    ]);
  });

  test('excludes starter zones, app-less roles and zones without recorded installations', () => {
    const list = appInstallationsOf(
      [
        zone('octo/a', { author: 10, reviewer: 20 }, 'starter'),
        zone('pat/b', { author: 40, reviewer: 41 }),
        zone('octo/c', undefined),
        zone('half/d', { author: 50, reviewer: 51 }),
      ],
      apps({ octo: { author: present }, half: { reviewer: present } }),
    );
    expect(list).toEqual([{ owner: 'half', role: 'reviewer', installationId: 51 }]);
  });

  test('an undecryptable entry still lists (its broker is missing, reported as failed)', () => {
    const list = appInstallationsOf(
      [zone('octo/a', { author: 10 })],
      apps({ octo: { author: { source: 'missing', undecryptable: true } } }),
    );
    expect(list).toEqual([{ owner: 'octo', role: 'author', installationId: 10 }]);
  });
});

function broker(calls: string[], behave: (id: number) => Promise<void>): GitHubAppBroker {
  const no = () => Promise.reject(new Error('unused'));
  return {
    installationFor: no,
    mint: no,
    revoke: no,
    suspend: (id) => {
      calls.push(`suspend ${id}`);
      return behave(id);
    },
    unsuspend: (id) => {
      calls.push(`unsuspend ${id}`);
      return behave(id);
    },
  };
}

const LIST: AppInstallation[] = [
  { owner: 'a', role: 'author', installationId: 1 },
  { owner: 'b', role: 'author', installationId: 2 },
  { owner: 'c', role: 'reviewer', installationId: 3 },
];

describe('suspendAll / unsuspendAll', () => {
  test('all succeed: one call each', async () => {
    const calls: string[] = [];
    const b = broker(calls, async () => {});
    expect(await suspendAll(LIST, () => b)).toEqual({ ok: 3, failed: [] });
    expect(await unsuspendAll(LIST, () => b)).toEqual({ ok: 3, failed: [] });
    expect(calls).toEqual([
      'suspend 1',
      'suspend 2',
      'suspend 3',
      'unsuspend 1',
      'unsuspend 2',
      'unsuspend 3',
    ]);
  });

  test('a 500 and a network error fail only their own installation, without GitHub text', async () => {
    const calls: string[] = [];
    const b = broker(calls, async (id) => {
      if (id === 1) throw new GitHubAppError('suspending', 500, 'secret-ish message');
      if (id === 3) throw new GitHubAppError('suspending', 0, 'ECONNREFUSED');
    });
    const r = await suspendAll(LIST, () => b);
    expect(r).toEqual({
      ok: 1,
      failed: [
        { owner: 'a', role: 'author', installationId: 1, status: 500 },
        { owner: 'c', role: 'reviewer', installationId: 3, status: 0 },
      ],
    });
    expect(JSON.stringify(r)).not.toContain('message');
    expect(calls).toHaveLength(3);
  });

  test('a missing broker fails with status 0', async () => {
    const calls: string[] = [];
    const b = broker(calls, async () => {});
    const r = await unsuspendAll(LIST, (owner) => (owner === 'b' ? undefined : b));
    expect(r).toEqual({
      ok: 2,
      failed: [{ owner: 'b', role: 'author', installationId: 2, status: 0 }],
    });
  });

  test('a call that never answers fails with status 0 after the deadline', async () => {
    const calls: string[] = [];
    const b = broker(calls, (id) => (id === 2 ? new Promise<void>(() => {}) : Promise.resolve()));
    const started = Date.now();
    const r = await suspendAll(LIST, () => b, { timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toEqual({
      ok: 2,
      failed: [{ owner: 'b', role: 'author', installationId: 2, status: 0 }],
    });
  });

  test('a broker that throws synchronously, or a non-GitHub error, is status 0', async () => {
    const r = await suspendAll(LIST.slice(0, 1), () => {
      throw new Error('boom');
    });
    expect(r).toEqual({
      ok: 0,
      failed: [{ owner: 'a', role: 'author', installationId: 1, status: 0 }],
    });
  });
});
