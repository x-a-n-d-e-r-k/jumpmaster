import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { appJwt, type Call, parseArgs, runStep } from './github-app.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const TOKEN = 'ghs_' + 'S'.repeat(36);

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());

describe('appJwt', () => {
  test('is an RS256 JWT for the app, backdated 60s, valid under ten minutes', () => {
    const jwt = appJwt('12345', PEM, 1_700_000_000);
    const [h, p, s] = jwt.split('.');
    expect(b64json(h!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(b64json(p!)).toEqual({
      iss: '12345',
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
    });
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('parseArgs', () => {
  test('reads the step, app, key, repository and PR', () => {
    expect(
      parseArgs(['approve', '--app', '7', '--key', 'k.pem', '--repo', 'o/r', '--pr', '3']),
    ).toEqual({
      step: 'approve',
      app: '7',
      key: 'k.pem',
      repo: { owner: 'o', name: 'r' },
      pr: 3,
    });
  });
  test('refuses an unknown step, a missing app or key, and a bad repository', () => {
    expect(() => parseArgs(['delete', '--app', '7', '--key', 'k', '--repo', 'o/r'])).toThrow(
      /step/,
    );
    expect(() => parseArgs(['status', '--key', 'k', '--repo', 'o/r', '--pr', '1'])).toThrow(
      /--app/,
    );
    expect(() => parseArgs(['status', '--app', '7', '--repo', 'o/r', '--pr', '1'])).toThrow(
      /--key/,
    );
    expect(() => parseArgs(['open-pr', '--app', '7', '--key', 'k', '--repo', 'nope'])).toThrow(
      /owner\/name/,
    );
  });
  test('needs --pr for approve, status and merge', () => {
    for (const step of ['approve', 'status', 'merge'])
      expect(() => parseArgs([step, '--app', '7', '--key', 'k', '--repo', 'o/r'])).toThrow(/--pr/);
  });
});

/** A fake GitHub: answers by "METHOD path", records every call. */
function fakeGitHub(routes: Record<string, (body: any) => [number, unknown]>) {
  const calls: { method: string; path: string; auth: string; body: any }[] = [];
  const call: Call = async (method, path, auth, body) => {
    calls.push({ method, path, auth, body });
    const key = `${method} ${path}`;
    const route = routes[key] ?? routes[`${method} ${path.split('?')[0]}`];
    if (!route) return { status: 404, json: { message: 'Not Found' } };
    const [status, json] = route(body);
    return { status, json };
  };
  return { call, calls };
}

const MINT = {
  'GET /repos/o/r/installation': () => [200, { id: 99 }] as [number, unknown],
  'POST /app/installations/99/access_tokens': () =>
    [201, { token: TOKEN, expires_at: 'x' }] as [number, unknown],
};
const args = (step: string, pr?: number) =>
  ({ step, app: '7', key: 'k', repo: { owner: 'o', name: 'r' }, pr }) as any;

describe('runStep', () => {
  test('mints a token narrowed to the one repository with the app JWT, then uses the token', async () => {
    const gh = fakeGitHub({
      ...MINT,
      'POST /repos/o/r/pulls/3/reviews': () => [
        200,
        { id: 1, state: 'APPROVED', user: { login: 'rev[bot]' } },
      ],
    });
    await runStep(args('approve', 3), 'JWT', gh.call);
    expect(gh.calls[0]).toMatchObject({
      method: 'GET',
      path: '/repos/o/r/installation',
      auth: 'Bearer JWT',
    });
    expect(gh.calls[1]).toMatchObject({ auth: 'Bearer JWT', body: { repositories: ['r'] } });
    expect(gh.calls[2]).toMatchObject({ auth: `token ${TOKEN}`, body: { event: 'APPROVE' } });
  });

  test('approve reports the review state and the login it was posted as', async () => {
    const gh = fakeGitHub({
      ...MINT,
      'POST /repos/o/r/pulls/3/reviews': () => [
        200,
        { id: 1, state: 'APPROVED', user: { login: 'rev[bot]' } },
      ],
    });
    const out = await runStep(args('approve', 3), 'JWT', gh.call);
    expect(out).toEqual({
      step: 'approve',
      pr: 3,
      http: 200,
      state: 'APPROVED',
      login: 'rev[bot]',
    });
  });

  test('open-pr branches from the default branch, commits one file and opens a PR', async () => {
    const gh = fakeGitHub({
      ...MINT,
      'GET /repos/o/r': () => [200, { default_branch: 'main' }],
      'GET /repos/o/r/git/ref/heads/main': () => [200, { object: { sha: 'abc' } }],
      'POST /repos/o/r/git/refs': () => [201, {}],
      'PUT /repos/o/r/contents/spike/a.txt': () => [201, {}],
      'POST /repos/o/r/pulls': () => [201, { number: 5, user: { login: 'auth[bot]' } }],
    });
    const out = await runStep(
      { ...args('open-pr'), now: () => 1, file: 'spike/a.txt' },
      'JWT',
      gh.call,
    );
    expect(out).toEqual({ step: 'open-pr', http: 201, pr: 5, login: 'auth[bot]' });
    const ref = gh.calls.find((c) => c.path === '/repos/o/r/git/refs')!;
    expect(ref.body).toEqual({ ref: expect.stringMatching(/^refs\/heads\/spike-/), sha: 'abc' });
  });

  test("merge reports success or GitHub's refusal message", async () => {
    const ok = fakeGitHub({
      ...MINT,
      'PUT /repos/o/r/pulls/3/merge': () => [200, { merged: true, sha: 'def' }],
    });
    expect(await runStep(args('merge', 3), 'JWT', ok.call)).toEqual({
      step: 'merge',
      pr: 3,
      http: 200,
      merged: true,
    });
    const no = fakeGitHub({
      ...MINT,
      'PUT /repos/o/r/pulls/3/merge': () => [
        405,
        { message: 'At least 1 approving review is required' },
      ],
    });
    expect(await runStep(args('merge', 3), 'JWT', no.call)).toEqual({
      step: 'merge',
      pr: 3,
      http: 405,
      merged: false,
      message: 'At least 1 approving review is required',
    });
  });

  test('status reads reviewDecision and mergeStateStatus over GraphQL', async () => {
    const gh = fakeGitHub({
      ...MINT,
      'POST /graphql': () => [
        200,
        {
          data: {
            repository: {
              pullRequest: {
                reviewDecision: 'APPROVED',
                mergeStateStatus: 'CLEAN',
                mergeable: 'MERGEABLE',
              },
            },
          },
        },
      ],
    });
    expect(await runStep(args('status', 3), 'JWT', gh.call)).toEqual({
      step: 'status',
      pr: 3,
      http: 200,
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
    });
  });

  test('bypass lists current_user_can_bypass per ruleset, absent field as null', async () => {
    const gh = fakeGitHub({
      ...MINT,
      'GET /repos/o/r/rulesets': () => [
        200,
        [
          { id: 1, name: 'jumpmaster' },
          { id: 2, name: 'jumpmaster-merge' },
        ],
      ],
      'GET /repos/o/r/rulesets/1': () => [
        200,
        { id: 1, name: 'jumpmaster', current_user_can_bypass: 'never' },
      ],
      'GET /repos/o/r/rulesets/2': () => [200, { id: 2, name: 'jumpmaster-merge' }],
    });
    expect(await runStep(args('bypass'), 'JWT', gh.call)).toEqual({
      step: 'bypass',
      http: 200,
      rulesets: [
        { name: 'jumpmaster', current_user_can_bypass: 'never' },
        { name: 'jumpmaster-merge', current_user_can_bypass: null },
      ],
    });
  });

  test('a failed mint reports the status and message and goes no further', async () => {
    const gh = fakeGitHub({ 'GET /repos/o/r/installation': () => [404, { message: 'Not Found' }] });
    expect(await runStep(args('status', 3), 'JWT', gh.call)).toEqual({
      step: 'mint',
      http: 404,
      message: 'Not Found — is the app installed on o/r?',
    });
    expect(gh.calls).toHaveLength(1);
  });

  test('no outcome ever contains the token, even when GitHub echoes it back', async () => {
    const gh = fakeGitHub({
      ...MINT,
      'PUT /repos/o/r/pulls/3/merge': () => [422, { message: `bad ${TOKEN}` }],
    });
    const out = await runStep(args('merge', 3), 'JWT', gh.call);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).toContain('[redacted]');
  });
});
