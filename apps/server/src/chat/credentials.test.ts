import { describe, expect, test, vi } from 'vitest';
import type { Config, DropZoneConfig } from '../config.js';
import type { AppTokenSource, FreshToken } from '../forge/app-tokens.js';
import { makeZone } from '../test/fixtures.js';
import type { AppEntryRead } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { chatReadCredential } from './credentials.js';

// Built at runtime so no token-shaped literal sits in the tracked file.
const READ_PAT = ['github', 'pat', 'CHATREADCHATREADCHATREAD11'].join('_');
const AUTHOR_PAT = ['github', 'pat', 'CHATAUTHORCHATAUTHORCHAT22'].join('_');
const APP_TOKEN = ['ghs', 'CHATAPPTOKEN'.repeat(4)].join('_');

const configWith = (zone: DropZoneConfig, read: boolean): Config =>
  ({
    listen: { host: '127.0.0.1', port: 7420 },
    dataDir: '/data',
    pollSeconds: 60,
    dropZones: [zone],
    usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
    secrets: {
      claudeToken: 'claude-secret',
      githubAuthorToken: AUTHOR_PAT,
      githubReviewerToken: 'reviewer-pat',
      ...(read ? { githubReadToken: READ_PAT } : {}),
      joinToken: 'join-me',
      operatorToken: 'o'.repeat(32),
    },
  }) as Config;

const reviewerEntry: AppEntryRead = {
  source: 'vault',
  fingerprint: 'fp-r',
  entry: { appId: '43', slug: 'jm-reviewer', clientId: 'c', pem: 'pem', importedAt: '2026-11-01' },
};
const withReviewerApp: ResolvedApps = new Map([
  ['octo', { author: { source: 'missing' }, reviewer: reviewerEntry }],
]);
const noApps: ResolvedApps = new Map();

const appZone = makeZone({
  identity: 'two-bot',
  githubApp: { repositoryId: 6660, installations: { reviewer: 88 } },
});
const patZone = makeZone({ identity: 'two-bot' });

function fakeAppTokens(fail = false) {
  const revoke = vi.fn(async () => {});
  const fresh = vi.fn(async (): Promise<FreshToken> => {
    if (fail) throw new Error('mint refused');
    return { token: APP_TOKEN, expiresAt: new Date(), owner: 'octo', revoke };
  });
  const source: Pick<AppTokenSource, 'fresh'> = { fresh };
  return { source, fresh, revoke };
}

describe('chatReadCredential', () => {
  test('an app-reviewer zone mints a fresh reviewer read token and release revokes it', async () => {
    const apps = fakeAppTokens();
    const cred = await chatReadCredential(
      appZone,
      configWith(appZone, true),
      withReviewerApp,
      apps.source,
    );
    expect(cred?.token).toBe(APP_TOKEN);
    expect(apps.fresh).toHaveBeenCalledWith('main', 'reviewer', 'drop-read-reviewer');
    expect(apps.revoke).not.toHaveBeenCalled();
    await cred?.release();
    expect(apps.revoke).toHaveBeenCalledTimes(1);
  });

  test('a PAT zone uses githubReadToken, and a PAT zone without one gets null, never githubAuthorToken', async () => {
    const apps = fakeAppTokens();
    const withRead = await chatReadCredential(
      patZone,
      configWith(patZone, true),
      noApps,
      apps.source,
    );
    expect(withRead?.token).toBe(READ_PAT);
    await withRead?.release();

    const config = configWith(patZone, false);
    // Non-vacuous: the author token is configured, and still never handed out.
    expect(config.secrets.githubAuthorToken).toBe(AUTHOR_PAT);
    const without = await chatReadCredential(patZone, config, noApps, apps.source);
    expect(without).toBeNull();
    expect(JSON.stringify(without)).not.toContain(AUTHOR_PAT);
    expect(apps.fresh).not.toHaveBeenCalled();
  });

  test('a failed app mint yields null, never a PAT fallback', async () => {
    const apps = fakeAppTokens(true);
    const cred = await chatReadCredential(
      appZone,
      configWith(appZone, true),
      withReviewerApp,
      apps.source,
    );
    expect(apps.fresh).toHaveBeenCalledTimes(1);
    expect(cred).toBeNull();
  });

  test('an app-reviewer zone with no token source gets null, never the read PAT', async () => {
    const cred = await chatReadCredential(appZone, configWith(appZone, true), withReviewerApp);
    expect(cred).toBeNull();
  });

  test('a GitLab zone with githubReadToken set gets null', async () => {
    const apps = fakeAppTokens();
    const gitlabZone: DropZoneConfig = {
      ...patZone,
      repo: 'group/sub/project',
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.com' },
    };
    const cred = await chatReadCredential(
      gitlabZone,
      configWith(gitlabZone, true),
      noApps,
      apps.source,
    );
    expect(cred).toBeNull();
    expect(apps.fresh).not.toHaveBeenCalled();
  });

  test('a GitLab zone whose first path segment has a resolved reviewer App gets null and mints nothing', async () => {
    const apps = fakeAppTokens();
    const gitlabZone: DropZoneConfig = {
      ...appZone,
      repo: 'octo/sub/project',
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.com' },
    };
    const cred = await chatReadCredential(
      gitlabZone,
      configWith(gitlabZone, true),
      withReviewerApp,
      apps.source,
    );
    expect(cred).toBeNull();
    expect(apps.fresh).not.toHaveBeenCalled();
  });
});
