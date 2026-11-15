import { createVerify, generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  appJwt,
  createGitHubAppBroker,
  GitHubAppError,
  mintRequestBody,
  USE_PERMISSIONS,
  type Use,
} from './github-app.js';

const api = 'https://api.github.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const NOW_MS = 1_790_000_000_123;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const APP_ID = '424242';
const JWT = appJwt(APP_ID, privateKey, NOW_SEC);
// Built at runtime so no token-shaped literal sits in the tracked file.
const TOKEN = ['ghs', 'Q'.repeat(450)].join('_');
const EXPIRES = '2026-11-15T13:00:00Z';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

function broker(secrets?: string[]) {
  return createGitHubAppBroker({
    appId: APP_ID,
    privateKey,
    now: () => NOW_MS,
    onSecret: secrets ? (s) => secrets.push(s) : undefined,
  });
}

/** Asserts an error carries no secret in its message or any serialized property. */
function expectClean(err: unknown) {
  expect(err).toBeInstanceOf(GitHubAppError);
  const e = err as GitHubAppError;
  const text = [
    e.message,
    String(e),
    e.stack ?? '',
    JSON.stringify(e),
    JSON.stringify(Object.getOwnPropertyNames(e).map((k) => [k, (e as never)[k]])),
  ].join('\n');
  for (const secret of [TOKEN, JWT, privateKey, privateKey.split('\n')[1]!]) {
    expect(text.includes(secret)).toBe(false);
  }
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('appJwt', () => {
  test('signs an RS256 JWT with iss, iat = now - 60, exp = now + 540', () => {
    const [head, body, sig] = JWT.split('.');
    expect(decode(head!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(body!)).toEqual({ iss: APP_ID, iat: NOW_SEC - 60, exp: NOW_SEC + 540 });
    const ok = createVerify('RSA-SHA256')
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(sig!, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('mintRequestBody', () => {
  test('narrows to one repository and the given permissions', () => {
    expect(mintRequestBody(7, { contents: 'read' })).toEqual({
      repository_ids: [7],
      permissions: { contents: 'read' },
    });
  });

  test.each([
    [{ administration: 'write' }],
    [{ contents: 'write', workflows: 'write', issues: 'read' }],
    [{}],
  ])('throws for %j', (perms) => {
    expect(() => mintRequestBody(7, perms)).toThrow();
  });

  test('no use asks for administration or workflows', () => {
    for (const perms of Object.values(USE_PERMISSIONS)) {
      expect(Object.keys(perms)).not.toContain('administration');
      expect(Object.keys(perms)).not.toContain('workflows');
      expect(Object.keys(perms).length).toBeGreaterThan(0);
    }
  });

  test('the uses carry the spec table permissions', () => {
    expect(USE_PERMISSIONS).toEqual({
      'server-author': {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        metadata: 'read',
        statuses: 'read',
        checks: 'read',
        actions: 'read',
      },
      'server-reviewer': { pull_requests: 'write' },
      'drop-read-author': { contents: 'read' },
      push: { contents: 'write' },
      'drop-read-reviewer': { contents: 'read' },
    });
  });
});

describe('createGitHubAppBroker', () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });

  describe('mint', () => {
    test.each(Object.keys(USE_PERMISSIONS) as Use[])(
      'sends one repository id and exactly the %s permissions',
      async (use) => {
        let body: unknown;
        nock(api, { reqheaders: { authorization: `Bearer ${JWT}` } })
          .post('/app/installations/99/access_tokens', (b) => {
            body = b;
            return true;
          })
          .reply(201, { token: TOKEN, expires_at: EXPIRES });
        const out = await broker().mint({ installationId: 99, repositoryId: 1234, use });
        expect(body).toEqual({ repository_ids: [1234], permissions: USE_PERMISSIONS[use] });
        expect(out.token).toBe(TOKEN);
        expect(out.expiresAt).toEqual(new Date(EXPIRES));
      },
    );

    test.each([403, 500])('a %i throws a clean typed error', async (status) => {
      nock(api)
        .post('/app/installations/99/access_tokens')
        .reply(status, { message: `nope ${TOKEN} ${JWT}` });
      const err = await caught(broker().mint({ installationId: 99, repositoryId: 1, use: 'push' }));
      expectClean(err);
      expect((err as GitHubAppError).status).toBe(status);
    });

    test('an unknown use throws before any request', async () => {
      const err = await caught(
        broker().mint({ installationId: 99, repositoryId: 1, use: 'nope' as Use }),
      );
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('installationFor', () => {
    test('200 returns the installation id and permissions', async () => {
      nock(api, { reqheaders: { authorization: `Bearer ${JWT}` } })
        .get('/repos/o/r/installation')
        .reply(200, { id: 55, permissions: { contents: 'write', metadata: 'read' } });
      expect(await broker().installationFor('o', 'r')).toEqual({
        installed: true,
        installationId: 55,
        permissions: { contents: 'write', metadata: 'read' },
      });
    });

    test('404 returns not installed', async () => {
      nock(api).get('/repos/o/r/installation').reply(404, { message: 'Not Found' });
      expect(await broker().installationFor('o', 'r')).toEqual({ installed: false });
    });

    test('500 throws a clean typed error with GitHub message', async () => {
      nock(api).get('/repos/o/r/installation').reply(500, { message: 'boom' });
      const err = await caught(broker().installationFor('o', 'r'));
      expectClean(err);
      expect((err as GitHubAppError).status).toBe(500);
      expect((err as GitHubAppError).githubMessage).toBe('boom');
    });
  });

  describe('revoke', () => {
    test.each([204, 401, 404])('%i counts as done', async (status) => {
      nock(api, { reqheaders: { authorization: `Bearer ${TOKEN}` } })
        .delete('/installation/token')
        .reply(status);
      await expect(broker().revoke(TOKEN)).resolves.toBeUndefined();
    });

    test('500 throws a clean typed error', async () => {
      nock(api)
        .delete('/installation/token')
        .reply(500, { message: `bad ${TOKEN}` });
      const err = await caught(broker().revoke(TOKEN));
      expectClean(err);
      expect((err as GitHubAppError).status).toBe(500);
    });
  });

  describe('suspend and unsuspend', () => {
    test('suspend PUTs the suspended flag with the JWT', async () => {
      nock(api, { reqheaders: { authorization: `Bearer ${JWT}` } })
        .put('/app/installations/77/suspended')
        .reply(204);
      await expect(broker().suspend(77)).resolves.toBeUndefined();
    });

    test('unsuspend DELETEs the suspended flag with the JWT', async () => {
      nock(api, { reqheaders: { authorization: `Bearer ${JWT}` } })
        .delete('/app/installations/77/suspended')
        .reply(204);
      await expect(broker().unsuspend(77)).resolves.toBeUndefined();
    });

    test('a 404 on suspend throws a clean typed error', async () => {
      nock(api).put('/app/installations/77/suspended').reply(404, { message: 'Not Found' });
      const err = await caught(broker().suspend(77));
      expectClean(err);
      expect((err as GitHubAppError).status).toBe(404);
    });
  });

  test('onSecret receives the key, every JWT and every minted token', async () => {
    const secrets: string[] = [];
    const b = broker(secrets);
    expect(secrets).toEqual([privateKey]);
    nock(api)
      .post('/app/installations/99/access_tokens')
      .reply(201, { token: TOKEN, expires_at: EXPIRES });
    await b.mint({ installationId: 99, repositoryId: 1, use: 'push' });
    expect(secrets).toEqual([privateKey, JWT, TOKEN]);
  });

  test('apiBase overrides the GitHub host', async () => {
    nock('https://ghe.example').put('/api/v3/app/installations/1/suspended').reply(204);
    await createGitHubAppBroker({
      appId: APP_ID,
      privateKey,
      apiBase: 'https://ghe.example/api/v3',
      now: () => NOW_MS,
    }).suspend(1);
  });
});
