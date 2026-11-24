import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { gitBlobSha } from '../forge/github.js';
import { ACCESS, type FakeGitLab, fakeGitLab } from './fake-gitlab.js';

const GITLAB = 'https://gitlab.com';
const SELF_MANAGED = 'https://git.example.internal';
const PROJECT = { id: 4242, path: 'group/sub/project' };
const ENCODED = encodeURIComponent(PROJECT.path);

// Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
const GUEST = glpat('G');
const REPORTER = glpat('R');
const DEVELOPER = glpat('D');
const WRONG = glpat('W');
const ALL_TOKENS = [GUEST, REPORTER, DEVELOPER, WRONG];

const noMatch: string[] = [];
const onNoMatch = (req: { method?: string; path?: string }) =>
  noMatch.push(`${req.method} ${req.path}`);
let fakes: FakeGitLab[] = [];

beforeAll(() => {
  nock.disableNetConnect();
  nock.emitter.on('no match', onNoMatch);
});
afterEach(() => {
  try {
    expect(noMatch).toEqual([]);
    // No token reaches the request record, from accepted or rejected requests alike.
    for (const gl of fakes) {
      const text = JSON.stringify(gl.requests);
      for (const t of ALL_TOKENS) expect(text).not.toContain(t);
    }
  } finally {
    for (const gl of fakes) gl.stop();
    fakes = [];
    noMatch.length = 0;
    nock.cleanAll();
  }
});
afterAll(() => {
  nock.emitter.removeListener('no match', onNoMatch);
  nock.enableNetConnect();
});

function setup(
  baseUrl = GITLAB,
  approvals?: { resetOnPush?: boolean; authorCanApprove?: boolean },
) {
  const gl = fakeGitLab({ baseUrl, project: PROJECT, approvals });
  fakes.push(gl);
  gl.addUser({ username: 'guest', token: GUEST, accessLevel: ACCESS.guest, scopes: ['api'] });
  gl.addUser({
    username: 'reporter',
    token: REPORTER,
    accessLevel: ACCESS.reporter,
    scopes: ['api'],
  });
  gl.addUser({
    username: 'dev',
    token: DEVELOPER,
    accessLevel: ACCESS.developer,
    scopes: ['api'],
  });
  const call = async (
    method: string,
    path: string,
    opts: { token?: string | null; body?: unknown } = {},
  ) => {
    const token = opts.token === undefined ? DEVELOPER : opts.token;
    const headers: Record<string, string> = {};
    if (token !== null) headers['PRIVATE-TOKEN'] = token;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}/api/v4${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body: body as any, text };
  };
  return { gl, call };
}

describe('project addressing', () => {
  for (const baseUrl of [GITLAB, SELF_MANAGED])
    test(`by numeric id and by encoded path on ${baseUrl}`, async () => {
      const { call } = setup(baseUrl);
      for (const id of [String(PROJECT.id), ENCODED]) {
        const r = await call('GET', `/projects/${id}`);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({
          id: PROJECT.id,
          path_with_namespace: PROJECT.path,
          default_branch: 'main',
          visibility: 'private',
          namespace: { kind: 'user' },
          only_allow_merge_if_pipeline_succeeds: false,
        });
        expect((await call('GET', `/projects/${id}/issues`)).status).toBe(200);
      }
      const other = await call('GET', `/projects/${encodeURIComponent('group/other')}`);
      expect(other).toMatchObject({ status: 404, body: { message: '404 Project Not Found' } });
      const otherId = await call('GET', '/projects/999/issues');
      expect(otherId).toMatchObject({ status: 404, body: { message: '404 Project Not Found' } });
    });

  test('the project read returns only_allow_merge_if_pipeline_succeeds, false by default', async () => {
    const { call } = setup();
    const off = await call('GET', `/projects/${PROJECT.id}`);
    expect(off.body.only_allow_merge_if_pipeline_succeeds).toBe(false);
    const gl = fakeGitLab({
      baseUrl: SELF_MANAGED,
      project: { ...PROJECT, onlyAllowMergeIfPipelineSucceeds: true },
    });
    fakes.push(gl);
    gl.addUser({ username: 'dev', token: DEVELOPER, accessLevel: ACCESS.developer });
    const res = await fetch(`${SELF_MANAGED}/api/v4/projects/${PROJECT.id}`, {
      headers: { 'PRIVATE-TOKEN': DEVELOPER },
    });
    expect(
      ((await res.json()) as Record<string, unknown>).only_allow_merge_if_pipeline_succeeds,
    ).toBe(true);
  });

  test('GET /user answers the caller', async () => {
    const { call } = setup();
    const r = await call('GET', '/user', { token: REPORTER });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'reporter', name: expect.any(String) });
    expect(typeof r.body.id).toBe('number');
  });
});

describe('auth', () => {
  test('a missing token and a wrong token each get 401', async () => {
    const { gl, call } = setup();
    const missing = await call('GET', `/projects/${PROJECT.id}`, { token: null });
    expect(missing).toMatchObject({ status: 401, body: { message: '401 Unauthorized' } });
    const wrong = await call('GET', `/projects/${PROJECT.id}`, { token: WRONG });
    expect(wrong).toMatchObject({ status: 401, body: { message: '401 Unauthorized' } });
    expect(gl.requests.map((r) => r.user)).toEqual([null, '<unknown>']);
    expect(gl.requests[0]).toEqual({
      method: 'GET',
      path: `/api/v4/projects/${PROJECT.id}`,
      query: {},
      body: undefined,
      user: null,
    });
  });

  test('a token passed as a query parameter is not recorded', async () => {
    const { gl } = setup();
    const res = await fetch(
      `${GITLAB}/api/v4/projects/${PROJECT.id}?private_token=${encodeURIComponent(WRONG)}&x=1`,
    );
    expect(res.status).toBe(401);
    expect(gl.requests[0]?.query).toEqual({ x: '1' });
  });

  test('a read-only token cannot write', async () => {
    const { gl, call } = setup();
    const ro = glpat('O');
    gl.addUser({ username: 'ro', token: ro, accessLevel: ACCESS.developer, scopes: ['read_api'] });
    expect((await call('GET', `/projects/${PROJECT.id}/issues`, { token: ro })).status).toBe(200);
    const w = await call('POST', `/projects/${PROJECT.id}/issues`, {
      token: ro,
      body: { title: 'x' },
    });
    expect(w.status).toBe(403);
    expect(JSON.stringify(gl.requests)).not.toContain(ro);
  });
});

describe('permissions', () => {
  test('a Guest can open an issue but not edit another user’s issue or create a label', async () => {
    const { gl, call } = setup();
    const theirs = gl.seedIssue({ title: 'someone else', author: 'dev' });
    const created = await call('POST', `/projects/${PROJECT.id}/issues`, {
      token: GUEST,
      body: { title: 'from a guest', description: 'hi', labels: 'bug' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'from a guest',
      description: 'hi',
      state: 'opened',
      labels: ['bug'],
      author: { username: 'guest' },
    });
    // A guest may edit their own issue.
    const own = await call('PUT', `/projects/${PROJECT.id}/issues/${created.body.iid}`, {
      token: GUEST,
      body: { title: 'renamed' },
    });
    expect(own.status).toBe(200);

    const put = await call('PUT', `/projects/${PROJECT.id}/issues/${theirs.iid}`, {
      token: GUEST,
      body: { title: 'nope' },
    });
    expect(put).toMatchObject({ status: 403, body: { message: '403 Forbidden' } });
    const label = await call('POST', `/projects/${PROJECT.id}/labels`, {
      token: GUEST,
      body: { name: 'guest-label', color: '#ff0000' },
    });
    expect(label).toMatchObject({ status: 403, body: { message: '403 Forbidden' } });
    expect(gl.issue(theirs.iid)?.title).toBe('someone else');

    const okPut = await call('PUT', `/projects/${PROJECT.id}/issues/${theirs.iid}`, {
      token: REPORTER,
      body: { title: 'renamed by reporter' },
    });
    expect(okPut.status).toBe(200);
    expect(okPut.body.title).toBe('renamed by reporter');
    const okLabel = await call('POST', `/projects/${PROJECT.id}/labels`, {
      token: REPORTER,
      body: { name: 'reporter-label', color: '#00ff00' },
    });
    expect(okLabel.status).toBe(201);
    expect(okLabel.body).toMatchObject({ name: 'reporter-label', color: '#00ff00' });
  });

  test('a Guest can post a note', async () => {
    const { gl, call } = setup();
    const issue = gl.seedIssue({ title: 't', author: 'dev' });
    const r = await call('POST', `/projects/${PROJECT.id}/issues/${issue.iid}/notes`, {
      token: GUEST,
      body: { body: 'a comment' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      body: 'a comment',
      author: { username: 'guest' },
      system: false,
    });
  });
});

describe('members', () => {
  test('lookup by id and query by username', async () => {
    const { gl, call } = setup();
    const m = gl.seedMember({ username: 'maint', accessLevel: ACCESS.maintainer });
    const one = await call('GET', `/projects/${ENCODED}/members/all/${m.id}`);
    expect(one).toMatchObject({
      status: 200,
      body: { id: m.id, username: 'maint', access_level: 40 },
    });
    expect((await call('GET', `/projects/${ENCODED}/members/all/987654`)).status).toBe(404);
    const q = await call('GET', `/projects/${ENCODED}/members/all?query=maint`);
    expect(q.status).toBe(200);
    expect(q.body).toEqual([
      { id: m.id, username: 'maint', name: 'maint', access_level: 40, state: 'active' },
    ]);
    const all = await call('GET', `/projects/${ENCODED}/members/all`);
    expect(all.body.map((x: { username: string }) => x.username).sort()).toEqual(
      ['dev', 'guest', 'maint', 'reporter'].sort(),
    );
  });
});

describe('access', () => {
  test('a member state is seedable through seedMember and addUser', async () => {
    const { gl, call } = setup();
    const b = gl.seedMember({
      username: 'blocked',
      accessLevel: ACCESS.developer,
      state: 'blocked',
    });
    const tok = glpat('B');
    gl.addUser({ username: 'away', token: tok, accessLevel: ACCESS.reporter, state: 'awaiting' });
    expect(b.state).toBe('blocked');
    const one = await call('GET', `/projects/${ENCODED}/members/all/${b.id}`);
    expect(one.body).toMatchObject({ username: 'blocked', state: 'blocked' });
    const all = await call('GET', `/projects/${ENCODED}/members/all`);
    const states = Object.fromEntries(
      all.body.map((x: { username: string; state: string }) => [x.username, x.state]),
    );
    expect(states).toMatchObject({ blocked: 'blocked', away: 'awaiting', guest: 'active' });
  });

  test('the project namespace kind is seedable', async () => {
    const gl = fakeGitLab({ baseUrl: GITLAB, project: { ...PROJECT, namespaceKind: 'group' } });
    fakes.push(gl);
    gl.addUser({ username: 'dev', token: DEVELOPER, accessLevel: ACCESS.developer });
    const res = await fetch(`${GITLAB}/api/v4/projects/${PROJECT.id}`, {
      headers: { 'PRIVATE-TOKEN': DEVELOPER },
    });
    expect(((await res.json()) as { namespace: unknown }).namespace).toEqual({ kind: 'group' });
  });

  test('GET /personal_access_tokens/self answers the caller’s scopes and expiry', async () => {
    const { gl, call } = setup();
    const tok = glpat('E');
    gl.addUser({
      username: 'exp',
      token: tok,
      scopes: ['read_user', 'read_api'],
      expiresAt: '2027-01-31',
    });
    const r = await call('GET', '/personal_access_tokens/self', { token: tok });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scopes: ['read_user', 'read_api'], expires_at: '2027-01-31' });
    const dflt = await call('GET', '/personal_access_tokens/self', { token: REPORTER });
    expect(dflt.body).toMatchObject({ scopes: ['api'], expires_at: null });
    expect(JSON.stringify(gl.requests)).not.toContain(tok);
  });

  test('GET /personal_access_tokens/self takes the same scopes as GET /user', async () => {
    const { gl, call } = setup();
    const ru = glpat('U');
    const rr = glpat('Q');
    gl.addUser({ username: 'ru', token: ru, scopes: ['read_user'] });
    gl.addUser({ username: 'rr', token: rr, scopes: ['read_repository'] });
    expect((await call('GET', '/personal_access_tokens/self', { token: ru })).status).toBe(200);
    expect((await call('GET', '/personal_access_tokens/self', { token: rr })).status).toBe(403);
    expect(gl.unknown).toEqual([]);
  });

  test('tokenSelfStatus makes GET /personal_access_tokens/self answer 401 or 404, opt-in', async () => {
    const { gl, call } = setup();
    const t404 = glpat('N');
    const t401 = glpat('M');
    gl.addUser({ username: 'n', token: t404, accessLevel: ACCESS.developer, tokenSelfStatus: 404 });
    gl.addUser({ username: 'm', token: t401, accessLevel: ACCESS.developer, tokenSelfStatus: 401 });
    expect(await call('GET', '/personal_access_tokens/self', { token: t404 })).toMatchObject({
      status: 404,
      body: { message: '404 Not Found' },
    });
    expect(await call('GET', '/personal_access_tokens/self', { token: t401 })).toMatchObject({
      status: 401,
      body: { message: '401 Unauthorized' },
    });
    // GET /user still answers for those users, and the default stays 200.
    expect((await call('GET', '/user', { token: t404 })).status).toBe(200);
    expect((await call('GET', '/personal_access_tokens/self', { token: REPORTER })).status).toBe(
      200,
    );
    expect(gl.unknown).toEqual([]);
    expect(JSON.stringify(gl.requests)).not.toContain(t404);
  });

  test('GET /personal_access_tokens/self answers 401 with no token or an unknown token', async () => {
    const { call } = setup();
    const none = await call('GET', '/personal_access_tokens/self', { token: null });
    expect(none).toMatchObject({ status: 401, body: { message: '401 Unauthorized' } });
    const wrong = await call('GET', '/personal_access_tokens/self', { token: WRONG });
    expect(wrong).toMatchObject({ status: 401, body: { message: '401 Unauthorized' } });
  });
});

describe('issues', () => {
  test('a 45-issue list pages as 20, 20 and 5', async () => {
    const { gl, call } = setup();
    for (let i = 1; i <= 45; i++) gl.seedIssue({ title: `issue ${i}` });
    const seen = new Set<number>();
    const expected = [
      [20, '2'],
      [20, '3'],
      [5, ''],
    ] as const;
    for (const [i, [count, next]] of expected.entries()) {
      const r = await call('GET', `/projects/${PROJECT.id}/issues?per_page=20&page=${i + 1}`);
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(count);
      expect(r.headers.get('x-next-page')).toBe(next);
      expect(r.headers.get('x-total')).toBe('45');
      expect(r.headers.get('x-page')).toBe(String(i + 1));
      expect(r.headers.get('x-per-page')).toBe('20');
      for (const issue of r.body) seen.add(issue.iid);
    }
    expect(seen.size).toBe(45);
  });

  test('per_page defaults to 20 and is clamped at 100', async () => {
    const { gl, call } = setup();
    for (let i = 1; i <= 120; i++) gl.seedIssue({ title: `issue ${i}` });
    const d = await call('GET', `/projects/${PROJECT.id}/issues`);
    expect(d.body).toHaveLength(20);
    expect(d.headers.get('x-per-page')).toBe('20');
    const big = await call('GET', `/projects/${PROJECT.id}/issues?per_page=500`);
    expect(big.body).toHaveLength(100);
    expect(big.headers.get('x-per-page')).toBe('100');
    expect(big.headers.get('x-next-page')).toBe('2');
  });

  test('the labels, state and updated_after filters', async () => {
    const { gl, call } = setup();
    gl.seedIssue({ title: 'a', labels: ['bug', 'p1'], updatedAt: '2026-01-01T00:00:00.000Z' });
    gl.seedIssue({ title: 'b', labels: ['bug'], updatedAt: '2026-02-01T00:00:00.000Z' });
    gl.seedIssue({
      title: 'c',
      labels: ['bug', 'p1'],
      state: 'closed',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    gl.seedIssue({ title: 'd', labels: ['p1'], updatedAt: '2026-04-01T00:00:00.000Z' });
    const titles = async (q: string) =>
      (await call('GET', `/projects/${PROJECT.id}/issues?${q}`)).body
        .map((i: { title: string }) => i.title)
        .sort();
    expect(await titles('labels=bug,p1')).toEqual(['a', 'c']);
    expect(await titles('labels=bug,p1&state=opened')).toEqual(['a']);
    expect(await titles('state=closed')).toEqual(['c']);
    expect(await titles('state=opened')).toEqual(['a', 'b', 'd']);
    expect(await titles('state=all')).toEqual(['a', 'b', 'c', 'd']);
    expect(await titles('updated_after=2026-02-01T00:00:00Z')).toEqual(['c', 'd']);
  });

  test('PUT with state_event=close and add_labels is stored and read back', async () => {
    const { gl, call } = setup();
    const issue = gl.seedIssue({ title: 't', labels: ['bug'], author: 'guest' });
    const before = issue.updated_at;
    const put = await call('PUT', `/projects/${ENCODED}/issues/${issue.iid}`, {
      body: { state_event: 'close', add_labels: 'done,p1' },
    });
    expect(put.status).toBe(200);
    const got = await call('GET', `/projects/${ENCODED}/issues/${issue.iid}`);
    expect(got.body).toMatchObject({
      iid: issue.iid,
      state: 'closed',
      labels: ['bug', 'done', 'p1'],
      author: { username: 'guest' },
    });
    expect(got.body.updated_at > before).toBe(true);

    const more = await call('PUT', `/projects/${ENCODED}/issues/${issue.iid}`, {
      body: { state_event: 'reopen', remove_labels: 'bug', description: 'new' },
    });
    expect(more.body).toMatchObject({
      state: 'opened',
      labels: ['done', 'p1'],
      description: 'new',
    });
    const replaced = await call('PUT', `/projects/${ENCODED}/issues/${issue.iid}`, {
      body: { labels: ['x'] },
    });
    expect(replaced.body.labels).toEqual(['x']);
    expect((await call('GET', `/projects/${ENCODED}/issues/999`)).status).toBe(404);
  });
});

describe('labels', () => {
  test('a second POST with the same name gets 409', async () => {
    const { gl, call } = setup();
    gl.seedLabel({ name: 'seeded' });
    const first = await call('POST', `/projects/${PROJECT.id}/labels`, {
      body: { name: 'ready', color: '#123456' },
    });
    expect(first.status).toBe(201);
    const second = await call('POST', `/projects/${PROJECT.id}/labels`, {
      body: { name: 'ready', color: '#654321' },
    });
    expect(second.status).toBe(409);
    const list = await call('GET', `/projects/${PROJECT.id}/labels`);
    expect(list.body.map((l: { name: string }) => l.name)).toEqual(['seeded', 'ready']);
  });
});

describe('notes', () => {
  test('issue and merge request notes', async () => {
    const { gl, call } = setup();
    const issue = gl.seedIssue({ title: 't' });
    gl.seedNote({ issueIid: issue.iid, body: 'seeded', author: 'reporter' });
    gl.seedNote({ mergeRequestIid: 7, body: 'mr note', system: true });
    await call('POST', `/projects/${PROJECT.id}/issues/${issue.iid}/notes`, {
      body: { body: 'posted' },
    });
    const notes = await call('GET', `/projects/${PROJECT.id}/issues/${issue.iid}/notes`);
    expect(notes.body.map((n: { body: string }) => n.body).sort()).toEqual(['posted', 'seeded']);
    for (const n of notes.body)
      expect(Object.keys(n)).toEqual(
        expect.arrayContaining(['id', 'body', 'author', 'created_at', 'system']),
      );
    const mr = await call('GET', `/projects/${PROJECT.id}/merge_requests/7/notes`);
    expect(mr.body).toMatchObject([{ body: 'mr note', system: true }]);
  });
});

describe('unknown routes', () => {
  test('answer 404, are recorded, and attempt no connection', async () => {
    const { gl, call } = setup();
    const r = await call('GET', `/projects/${PROJECT.id}/repository/branches`);
    expect(r).toMatchObject({ status: 404, body: { message: '404 Not Found' } });
    const r2 = await call('DELETE', '/nothing/here', { token: null });
    expect(r2.status).toBe(404);
    expect(gl.requests.map((x) => `${x.method} ${x.path}`)).toEqual([
      `GET /api/v4/projects/${PROJECT.id}/repository/branches`,
      'DELETE /api/v4/nothing/here',
    ]);
    expect(gl.unknown).toHaveLength(2);
    expect(noMatch).toEqual([]);
  });

  test('HEAD and OPTIONS on an unknown route answer 404 and are recorded', async () => {
    const { gl } = setup();
    for (const method of ['HEAD', 'OPTIONS']) {
      const res = await fetch(`${GITLAB}/api/v4/projects/${PROJECT.id}/repository/files/a`, {
        method,
        headers: { 'PRIVATE-TOKEN': DEVELOPER },
      });
      await res.text();
      expect(res.status).toBe(404);
    }
    expect(gl.requests.map((x) => x.method)).toEqual(['HEAD', 'OPTIONS']);
    expect(gl.unknown).toHaveLength(2);
    expect(noMatch).toEqual([]);
  });

  test('a project id that is not valid URL encoding answers 404 Project Not Found', async () => {
    const { call } = setup();
    const r = await call('GET', '/projects/%E0%A4%A/issues');
    expect(r).toMatchObject({ status: 404, body: { message: '404 Project Not Found' } });
  });

  test('stop() removes the interceptors', async () => {
    const { gl } = setup();
    gl.stop();
    // With the interceptors gone, nock refuses the request (net connect is disabled).
    const res = await fetch(`${GITLAB}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': DEVELOPER } });
    expect(res.status).toBe(501);
    await res.text();
    await new Promise((r) => setImmediate(r));
    expect(gl.requests).toEqual([]);
    expect(noMatch.length).toBeGreaterThan(0);
    noMatch.length = 0;
  });
});

describe('edges beyond the spec', () => {
  test('a non-member gets 404 on a private project', async () => {
    const { gl, call } = setup();
    const outsider = glpat('O');
    gl.addUser({ username: 'outsider', token: outsider, scopes: ['api'] });
    const r = await call('GET', `/projects/${PROJECT.id}`, { token: outsider });
    expect(r).toMatchObject({ status: 404, body: { message: '404 Project Not Found' } });
    const own = await call('GET', '/user', { token: outsider });
    expect(own.status).toBe(200);
    expect(JSON.stringify(gl.requests)).not.toContain(outsider);
  });

  test('a non-member gets 403 creating an issue or a note on a public project', async () => {
    const gl = fakeGitLab({ baseUrl: GITLAB, project: { ...PROJECT, visibility: 'public' } });
    fakes.push(gl);
    const outsider = glpat('P');
    gl.addUser({ username: 'outsider', token: outsider, scopes: ['api'] });
    const issue = gl.seedIssue({ title: 't' });
    const post = (path: string, body: unknown) =>
      fetch(`${GITLAB}/api/v4/projects/${PROJECT.id}${path}`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': outsider, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect(await post('/issues', { title: 'x' })).toEqual({
      status: 403,
      body: { message: '403 Forbidden' },
    });
    expect(await post(`/issues/${issue.iid}/notes`, { body: 'x' })).toEqual({
      status: 403,
      body: { message: '403 Forbidden' },
    });
    expect(JSON.stringify(gl.requests)).not.toContain(outsider);
  });

  test('missing required fields answer 400', async () => {
    const { gl, call } = setup();
    const issue = gl.seedIssue({ title: 't' });
    expect((await call('POST', `/projects/${PROJECT.id}/issues`, { body: {} })).status).toBe(400);
    expect(
      (await call('POST', `/projects/${PROJECT.id}/labels`, { body: { color: '#fff' } })).status,
    ).toBe(400);
    expect(
      (await call('POST', `/projects/${PROJECT.id}/labels`, { body: { name: 'n' } })).status,
    ).toBe(400);
    expect(
      (await call('POST', `/projects/${PROJECT.id}/issues/${issue.iid}/notes`, { body: {} }))
        .status,
    ).toBe(400);
  });

  test('notes on a missing issue answer 404', async () => {
    const { call } = setup();
    const get = await call('GET', `/projects/${PROJECT.id}/issues/999/notes`);
    expect(get).toMatchObject({ status: 404, body: { message: '404 Issue Not Found' } });
    const post = await call('POST', `/projects/${PROJECT.id}/issues/999/notes`, {
      body: { body: 'x' },
    });
    expect(post.status).toBe(404);
  });

  test('token-named keys in a body are redacted in the record', async () => {
    const { gl, call } = setup();
    const other = glpat('X');
    await call('POST', `/projects/${PROJECT.id}/issues`, {
      body: { title: 't', private_token: other, access_token: other },
    });
    expect(gl.requests[0]?.body).toMatchObject({
      private_token: expect.not.stringContaining(other),
    });
    expect(JSON.stringify(gl.requests)).not.toContain(other);
  });

  test('GET /user accepts the read_user scope', async () => {
    const { gl, call } = setup();
    const ru = glpat('U');
    gl.addUser({ username: 'ru', token: ru, accessLevel: ACCESS.developer, scopes: ['read_user'] });
    expect(await call('GET', '/user', { token: ru })).toMatchObject({
      status: 200,
      body: { username: 'ru' },
    });
    expect((await call('GET', `/projects/${PROJECT.id}`, { token: ru })).status).toBe(403);
    expect(JSON.stringify(gl.requests)).not.toContain(ru);
  });
});

describe('repository: branches', () => {
  const P = `/projects/${PROJECT.id}`;

  test('creates a branch from a SHA and from a branch name', async () => {
    const { gl, call } = setup();
    const head = gl.branchSha('main') as string;
    const fromSha = await call('POST', `${P}/repository/branches`, {
      body: { branch: 'a', ref: head },
    });
    expect(fromSha.status).toBe(201);
    expect(fromSha.body.commit.id).toBe(head);
    const fromName = await call('POST', `${P}/repository/branches`, {
      body: { branch: 'b', ref: 'main' },
    });
    expect(fromName.status).toBe(201);
    expect(gl.branchSha('b')).toBe(head);
    const got = await call('GET', `${P}/repository/branches/b`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      name: 'b',
      commit: { id: head, parent_ids: [], message: 'Initial commit', title: 'Initial commit' },
      protected: false,
      default: false,
    });
    expect((await call('GET', `${P}/repository/branches/main`)).body.default).toBe(true);
  });

  test('a branch name with / works only URL-encoded', async () => {
    const { gl, call } = setup();
    const made = await call('POST', `${P}/repository/branches`, {
      body: { branch: 'jm/x', ref: 'main' },
    });
    expect(made.status).toBe(201);
    const got = await call('GET', `${P}/repository/branches/jm%2Fx`);
    expect(got.status).toBe(200);
    expect(got.body.name).toBe('jm/x');
    const raw = await call('GET', `${P}/repository/branches/jm/x`);
    expect(raw.status).toBe(404);
    expect(gl.unknown).toEqual([`GET /api/v4${P}/repository/branches/jm/x`]);
  });

  test('a duplicate name or unknown ref gives 400', async () => {
    const { call } = setup();
    const dup = await call('POST', `${P}/repository/branches`, {
      body: { branch: 'main', ref: 'main' },
    });
    expect(dup).toMatchObject({ status: 400, body: { message: 'Branch already exists' } });
    const bad = await call('POST', `${P}/repository/branches`, {
      body: { branch: 'x', ref: 'nope' },
    });
    expect(bad.status).toBe(400);
  });

  test('a Reporter gets 403 and a read_api token gets insufficient_scope', async () => {
    const { gl, call } = setup();
    const r = await call('POST', `${P}/repository/branches`, {
      token: REPORTER,
      body: { branch: 'x', ref: 'main' },
    });
    expect(r.status).toBe(403);
    const ro = glpat('O');
    gl.addUser({ username: 'ro', token: ro, accessLevel: ACCESS.maintainer, scopes: ['read_api'] });
    const s = await call('POST', `${P}/repository/branches`, {
      token: ro,
      body: { branch: 'x', ref: 'main' },
    });
    expect(s.status).toBe(403);
    expect(s.body.error).toBe('insufficient_scope');
    expect(gl.branchSha('x')).toBeUndefined();
    expect(JSON.stringify(gl.requests)).not.toContain(ro);
    // Reads still work with read_api.
    expect((await call('GET', `${P}/repository/branches/main`, { token: ro })).status).toBe(200);
  });

  test('a missing branch gives 404', async () => {
    const { call } = setup();
    expect((await call('GET', `${P}/repository/branches/nope`)).status).toBe(404);
  });
});

describe('repository: files', () => {
  const P = `/projects/${PROJECT.id}`;

  test('gets a file as base64 and raw, with blob_id from gitBlobSha', async () => {
    const { gl, call } = setup();
    const content = 'héllo\nworld\n';
    const sha = gl.seedCommit({ branch: 'main', files: { 'a.txt': content }, message: 'add a' });
    const got = await call('GET', `${P}/repository/files/a.txt?ref=main`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      file_path: 'a.txt',
      file_name: 'a.txt',
      size: Buffer.byteLength(content),
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
      ref: 'main',
      blob_id: gitBlobSha(content),
      commit_id: sha,
      last_commit_id: sha,
    });
    const raw = await call('GET', `${P}/repository/files/a.txt/raw?ref=${sha}`);
    expect(raw.status).toBe(200);
    expect(raw.text).toBe(content);
    expect((await call('GET', `${P}/repository/files/b.txt?ref=main`)).status).toBe(404);
    expect((await call('GET', `${P}/repository/files/b.txt/raw?ref=main`)).status).toBe(404);
    expect((await call('GET', `${P}/repository/files/a.txt?ref=nope`)).status).toBe(404);
  });

  test('last_commit_id is the newest first-parent commit that changed the file', async () => {
    const { gl, call } = setup();
    const c1 = gl.seedCommit({ branch: 'main', files: { a: '1', b: '1' }, message: 'one' });
    const c2 = gl.seedCommit({ branch: 'main', files: { a: '1', b: '2' }, message: 'two' });
    const got = await call('GET', `${P}/repository/files/a?ref=main`);
    expect(got.body.commit_id).toBe(c2);
    expect(got.body.last_commit_id).toBe(c1);
  });

  test('POST creates a file on a new commit; POST on an existing file gives 400', async () => {
    const { gl, call } = setup();
    const old = gl.branchSha('main') as string;
    const made = await call('POST', `${P}/repository/files/new.txt`, {
      body: { branch: 'main', content: 'x\n', commit_message: 'add new' },
    });
    expect(made).toMatchObject({ status: 201, body: { file_path: 'new.txt', branch: 'main' } });
    const head = gl.branchSha('main') as string;
    expect(head).not.toBe(old);
    expect(gl.commit(head)?.parent_ids).toEqual([old]);
    expect(gl.fileAt('main', 'new.txt')).toBe('x\n');
    const again = await call('POST', `${P}/repository/files/new.txt`, {
      body: { branch: 'main', content: 'y', commit_message: 'again' },
    });
    expect(again.status).toBe(400);
    expect(gl.branchSha('main')).toBe(head);
  });

  test('PUT on a missing file gives 400; a stale last_commit_id gives 400', async () => {
    const { gl, call } = setup();
    const missing = await call('PUT', `${P}/repository/files/none.txt`, {
      body: { branch: 'main', content: 'y', commit_message: 'edit' },
    });
    expect(missing.status).toBe(400);
    const first = gl.seedCommit({ branch: 'main', files: { f: 'a' }, message: 'f1' });
    const second = gl.seedCommit({ branch: 'main', files: { f: 'b' }, message: 'f2' });
    const stale = await call('PUT', `${P}/repository/files/f`, {
      body: { branch: 'main', content: 'c', commit_message: 'edit', last_commit_id: first },
    });
    expect(stale.status).toBe(400);
    expect(gl.branchSha('main')).toBe(second);
    const ok = await call('PUT', `${P}/repository/files/f`, {
      body: { branch: 'main', content: 'c', commit_message: 'edit', last_commit_id: second },
    });
    expect(ok).toMatchObject({ status: 200, body: { file_path: 'f', branch: 'main' } });
    expect(gl.fileAt('main', 'f')).toBe('c');
    expect(gl.commit(gl.branchSha('main') as string)?.parent_ids).toEqual([second]);
  });

  test('a Reporter gets 403 on a file write and nothing changes', async () => {
    const { gl, call } = setup();
    const before = gl.branchSha('main');
    const r = await call('POST', `${P}/repository/files/a`, {
      token: REPORTER,
      body: { branch: 'main', content: 'x', commit_message: 'm' },
    });
    expect(r.status).toBe(403);
    expect(gl.branchSha('main')).toBe(before);
  });

  test('a path with / works only encoded', async () => {
    const { gl, call } = setup();
    const enc = encodeURIComponent('dir/sub/f.md');
    const made = await call('POST', `${P}/repository/files/${enc}`, {
      body: { branch: 'main', content: '# hi\n', commit_message: 'docs' },
    });
    expect(made.status).toBe(201);
    expect(made.body.file_path).toBe('dir/sub/f.md');
    const got = await call('GET', `${P}/repository/files/${enc}?ref=main`);
    expect(got.status).toBe(200);
    expect(got.body.file_name).toBe('f.md');
    const raw = await call('GET', `${P}/repository/files/dir/sub/f.md?ref=main`);
    expect(raw.status).toBe(404);
    expect(gl.unknown).toEqual([`GET /api/v4${P}/repository/files/dir/sub/f.md`]);
  });

  test('no recorded request contains the token after a file write', async () => {
    const { gl, call } = setup();
    await call('POST', `${P}/repository/files/t`, {
      body: { branch: 'main', content: 'x', commit_message: 'm' },
    });
    await call('PUT', `${P}/repository/files/t?private_token=${DEVELOPER}`, {
      token: null,
      body: { branch: 'main', content: 'y', commit_message: 'm2' },
    });
    expect(gl.requests.length).toBe(2);
    expect(gl.requests[0]?.body).toMatchObject({ content: 'x' });
    expect(JSON.stringify(gl.requests)).not.toContain(DEVELOPER);
  });
});

describe('repository: commits and merge base', () => {
  const P = `/projects/${PROJECT.id}`;

  test('GET a commit returns parent_ids and short_id; an unknown SHA gives 404', async () => {
    const { gl, call } = setup();
    const root = gl.branchSha('main') as string;
    const sha = gl.seedCommit({ branch: 'main', files: {}, message: 'Title\n\nBody' });
    const got = await call('GET', `${P}/repository/commits/${sha}`);
    expect(got.body).toEqual({
      id: sha,
      short_id: sha.slice(0, 8),
      parent_ids: [root],
      message: 'Title\n\nBody',
      title: 'Title',
    });
    expect((await call('GET', `${P}/repository/commits/${'0'.repeat(40)}`)).status).toBe(404);
  });

  test('merge base of diverged branches, of an ancestor, and of unrelated roots', async () => {
    const { gl, call } = setup();
    const fork = gl.seedCommit({ branch: 'main', files: { a: '1' }, message: 'fork' });
    gl.seedBranch('feature', fork);
    gl.seedCommit({ branch: 'main', files: { a: '2' }, message: 'main side' });
    gl.seedCommit({ branch: 'feature', files: { a: '1', b: '1' }, message: 'feature side' });
    const mb = (a: string, b: string) =>
      call(
        'GET',
        `${P}/repository/merge_base?refs[]=${encodeURIComponent(a)}&refs[]=${encodeURIComponent(b)}`,
      );
    const diverged = await mb('main', 'feature');
    expect(diverged.status).toBe(200);
    expect(diverged.body.id).toBe(fork);
    expect(diverged.body.parent_ids).toHaveLength(1);
    expect((await mb('feature', fork)).body.id).toBe(fork);
    const lone = gl.seedCommit({ files: { z: '1' }, message: 'other root' });
    expect((await mb('main', lone)).status).toBe(404);
    expect((await mb('main', 'nope')).status).toBe(400);
    expect((await call('GET', `${P}/repository/merge_base?refs[]=main`)).status).toBe(400);
  });
});

describe('repository: compare', () => {
  const P = `/projects/${PROJECT.id}`;
  const cmp = (call: ReturnType<typeof setup>['call'], q: string) =>
    call('GET', `${P}/repository/compare?${q}`);

  function diverged(gl: FakeGitLab) {
    const base = gl.seedCommit({
      branch: 'main',
      files: { 'keep.txt': 'k\n', 'old.txt': 'same\n', 'gone.txt': 'a\nb\n', 'edit.txt': 'one\n' },
      message: 'base',
    });
    gl.seedBranch('feature', base);
    const m1 = gl.seedCommit({
      branch: 'main',
      files: { 'keep.txt': 'k2\n', 'old.txt': 'same\n', 'gone.txt': 'a\nb\n', 'edit.txt': 'one\n' },
      message: 'main change',
    });
    const f1 = gl.seedCommit({
      branch: 'feature',
      files: { 'keep.txt': 'k\n', 'new.txt': 'same\n', 'gone.txt': 'a\nb\n', 'edit.txt': 'two\n' },
      message: 'feature rename + edit',
    });
    const f2 = gl.seedCommit({
      branch: 'feature',
      files: { 'keep.txt': 'k\n', 'new.txt': 'same\n', 'edit.txt': 'two\n', 'added.txt': 'x\ny' },
      message: 'feature delete + add',
    });
    return { base, m1, f1, f2 };
  }

  test('straight=false diffs from the merge base; straight=true from `from`', async () => {
    const { gl, call } = setup();
    const { base, m1, f1, f2 } = diverged(gl);
    for (const q of ['from=main&to=feature', 'from=main&to=feature&straight=false']) {
      const r = await cmp(call, q);
      expect(r.status).toBe(200);
      expect(r.body.commits.map((c: { id: string }) => c.id)).toEqual([f1, f2]);
      expect(r.body.commits[0].parent_ids).toEqual([base]);
      expect(r.body.commits[1].parent_ids).toEqual([f1]);
      expect(r.body.commit.id).toBe(f2);
      expect(r.body.compare_same_ref).toBe(false);
      expect(r.body.compare_timeout).toBe(false);
      expect(r.body.diffs).toEqual([
        {
          old_path: 'added.txt',
          new_path: 'added.txt',
          new_file: true,
          renamed_file: false,
          deleted_file: false,
          diff: '@@ -1,0 +1,2 @@\n+x\n+y\n',
        },
        {
          old_path: 'edit.txt',
          new_path: 'edit.txt',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          diff: '@@ -1,1 +1,1 @@\n-one\n+two\n',
        },
        {
          old_path: 'gone.txt',
          new_path: 'gone.txt',
          new_file: false,
          renamed_file: false,
          deleted_file: true,
          diff: '@@ -1,2 +1,0 @@\n-a\n-b\n',
        },
        {
          old_path: 'old.txt',
          new_path: 'new.txt',
          new_file: false,
          renamed_file: true,
          deleted_file: false,
          diff: '',
        },
      ]);
    }
    const mb = await call('GET', `${P}/repository/merge_base?refs[]=main&refs[]=feature`);
    expect(mb.body.id).toBe(base);

    const straight = await cmp(call, 'from=main&to=feature&straight=true');
    expect(straight.body.commits.map((c: { id: string }) => c.id)).toEqual([f1, f2]);
    const keep = straight.body.diffs.find((d: { new_path: string }) => d.new_path === 'keep.txt');
    expect(keep.diff).toBe('@@ -1,1 +1,1 @@\n-k2\n+k\n');
    expect(m1).toBe(gl.branchSha('main'));
  });

  test('comparing a ref with itself gives compare_same_ref and nothing else', async () => {
    const { gl, call } = setup();
    diverged(gl);
    const r = await cmp(call, 'from=feature&to=feature');
    expect(r.body).toEqual({
      commit: null,
      commits: [],
      diffs: [],
      compare_timeout: false,
      compare_same_ref: true,
    });
  });

  test('unrelated histories diff from the empty tree; an unknown ref gives 404', async () => {
    const { gl, call } = setup();
    const lone = gl.seedCommit({ files: { a: '' }, message: 'other root' });
    gl.seedBranch('other', lone);
    const r = await cmp(call, 'from=main&to=other');
    expect(r.body.commits.map((c: { id: string }) => c.id)).toEqual([lone]);
    expect(r.body.diffs).toEqual([
      {
        old_path: 'a',
        new_path: 'a',
        new_file: true,
        renamed_file: false,
        deleted_file: false,
        diff: '@@ -1,0 +1,0 @@\n',
      },
    ]);
    expect((await cmp(call, 'from=main&to=nope')).status).toBe(404);
    expect((await cmp(call, 'from=nope&to=main')).status).toBe(404);
  });

  test('the same repository gives byte-identical SHAs and diffs across fakes', async () => {
    const one = setup();
    const two = setup(SELF_MANAGED);
    expect(one.gl.branchSha('main')).toBe(two.gl.branchSha('main'));
    expect(one.gl.branchSha('main')).toMatch(/^[0-9a-f]{40}$/);
    const a = diverged(one.gl);
    const b = diverged(two.gl);
    expect(a).toEqual(b);
    const ra = await cmp(one.call, 'from=main&to=feature');
    const rb = await cmp(two.call, 'from=main&to=feature');
    expect(JSON.stringify(ra.body.diffs)).toBe(JSON.stringify(rb.body.diffs));
  });
});

describe('repository: tree', () => {
  const P = `/projects/${PROJECT.id}`;
  const tree = (call: ReturnType<typeof setup>['call'], q: string) =>
    call('GET', `${P}/repository/tree?${q}`);
  const names = (body: { name: string; type: string }[]) => body.map((e) => `${e.type}:${e.name}`);

  function seed(gl: FakeGitLab) {
    return gl.seedCommit({
      branch: 'main',
      files: { 'README.md': 'r', 'src/a.ts': 'a', 'src/b.ts': 'b', 'src/lib/c.ts': 'c', z: 'z' },
      message: 'tree',
    });
  }

  test('lists the root and a subdirectory, trees first, with blob ids and paths', async () => {
    const { gl, call } = setup();
    const sha = seed(gl);
    const root = await tree(call, 'ref=main');
    expect(root.status).toBe(200);
    expect(names(root.body)).toEqual(['tree:src', 'blob:README.md', 'blob:z']);
    const src = await tree(call, `path=src&ref=${sha}`);
    expect(names(src.body)).toEqual(['tree:lib', 'blob:a.ts', 'blob:b.ts']);
    expect(src.body[1]).toMatchObject({
      id: gitBlobSha('a'),
      name: 'a.ts',
      type: 'blob',
      path: 'src/a.ts',
      mode: '100644',
    });
    expect(src.body[0]).toMatchObject({
      name: 'lib',
      type: 'tree',
      path: 'src/lib',
      mode: '040000',
    });
    expect(names((await tree(call, 'path=src/lib/&ref=main')).body)).toEqual(['blob:c.ts']);
    expect(gl.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: `/api/v4${P}/repository/tree`,
      query: { path: 'src/lib/', ref: 'main' },
      user: 'dev',
    });
    expect(gl.unknown).toEqual([]);
  });

  test('pages with page, per_page and x-next-page', async () => {
    const { gl, call } = setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`d/f${i}`] = String(i);
    gl.seedCommit({ branch: 'main', files, message: 'many' });
    const one = await tree(call, 'path=d&ref=main&per_page=2&page=1');
    expect(names(one.body)).toEqual(['blob:f0', 'blob:f1']);
    expect(one.headers.get('x-next-page')).toBe('2');
    const three = await tree(call, 'path=d&ref=main&per_page=2&page=3');
    expect(names(three.body)).toEqual(['blob:f4']);
    expect(three.headers.get('x-next-page')).toBe('');
  });

  test('a missing path or ref gives 404; a file path gives an empty list', async () => {
    const { gl, call } = setup();
    seed(gl);
    expect((await tree(call, 'path=nope&ref=main')).status).toBe(404);
    expect((await tree(call, 'path=src&ref=nope')).status).toBe(404);
    expect((await tree(call, `path=src&ref=${'0'.repeat(40)}`)).status).toBe(404);
    const file = await tree(call, 'path=src/a.ts&ref=main');
    expect(file.status).toBe(200);
    expect(file.body).toEqual([]);
  });

  test('without ref, the default branch is listed', async () => {
    const { gl, call } = setup();
    seed(gl);
    expect(names((await tree(call, 'path=src/lib')).body)).toEqual(['blob:c.ts']);
  });
});

describe('repository: merge commits', () => {
  test('seedCommit with parents makes a merge commit', async () => {
    const { gl } = setup();
    const a = gl.seedCommit({ branch: 'main', files: { a: '1' }, message: 'a' });
    const b = gl.seedCommit({ parent: a, files: { b: '1' }, message: 'b' });
    const m = gl.seedCommit({
      branch: 'main',
      parents: [a, b],
      files: { a: '1', b: '1' },
      message: 'merge',
    });
    expect(gl.commit(m)?.parent_ids).toEqual([a, b]);
    expect(gl.branchSha('main')).toBe(m);
    expect(() => gl.seedCommit({ parents: ['nope'], files: {}, message: 'x' })).toThrow(/unknown/);
  });
});

describe('repository: unknown routes', () => {
  test('GET /repository/archive lands in unknown with a 404', async () => {
    const { gl, call } = setup();
    const r = await call('GET', `/projects/${PROJECT.id}/repository/archive`);
    expect(r.status).toBe(404);
    expect(gl.unknown).toEqual([`GET /api/v4/projects/${PROJECT.id}/repository/archive`]);
  });
});

describe('merge requests', () => {
  const P = `/projects/${PROJECT.id}`;

  /** `main` and `feature` diverged from a common base. */
  function branchesFor(gl: FakeGitLab) {
    const base = gl.seedCommit({
      branch: 'main',
      files: { 'keep.txt': 'k\n', 'old.txt': 'same\n', 'gone.txt': 'a\n', 'edit.txt': 'one\n' },
      message: 'base',
    });
    gl.seedBranch('feature', base);
    gl.seedCommit({
      branch: 'main',
      files: { 'keep.txt': 'k2\n', 'old.txt': 'same\n', 'gone.txt': 'a\n', 'edit.txt': 'one\n' },
      message: 'main moves on',
    });
    const head = gl.seedCommit({
      branch: 'feature',
      files: { 'keep.txt': 'k\n', 'new.txt': 'same\n', 'edit.txt': 'two\n', 'added.txt': 'x\n' },
      message: 'feature work',
    });
    return { base, head };
  }
  const create = (call: ReturnType<typeof setup>['call'], extra: object = {}, token?: string) =>
    call('POST', `${P}/merge_requests`, {
      token,
      body: {
        source_branch: 'feature',
        target_branch: 'main',
        title: 'Add things',
        description: 'Closes #1',
        labels: 'agent,review',
        ...extra,
      },
    });

  test('create, get by iid, and find it filtered by source_branch and state=opened', async () => {
    const { gl, call } = setup();
    const { base, head } = branchesFor(gl);
    const made = await create(call);
    expect(made.status).toBe(201);
    expect(made.body.iid).toBe(1);
    const got = await call('GET', `${P}/merge_requests/1`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      iid: 1,
      title: 'Add things',
      description: 'Closes #1',
      state: 'opened',
      source_branch: 'feature',
      target_branch: 'main',
      sha: head,
      source_project_id: PROJECT.id,
      target_project_id: PROJECT.id,
      author: { username: 'dev' },
      labels: ['agent', 'review'],
      web_url: `${GITLAB}/${PROJECT.path}/-/merge_requests/1`,
      merged_at: null,
      diff_refs: { base_sha: base, start_sha: gl.branchSha('main'), head_sha: head },
    });
    const list = await call(
      'GET',
      `${P}/merge_requests?source_branch=feature&target_branch=main&state=opened`,
    );
    expect(list.body.map((m: { iid: number }) => m.iid)).toEqual([1]);
    expect((await call('GET', `${P}/merge_requests?source_branch=other`)).body).toEqual([]);
    expect((await call('GET', `${P}/merge_requests?state=closed`)).body).toEqual([]);
    expect((await call('GET', `${P}/merge_requests?labels=agent`)).body).toHaveLength(1);
    expect((await call('GET', `${P}/merge_requests?labels=agent,nope`)).body).toEqual([]);
    expect((await call('GET', `${P}/merge_requests/99`)).status).toBe(404);
  });

  test('a duplicate open MR gives 409, a Reporter gets 403, a missing branch is refused', async () => {
    const { gl, call } = setup();
    branchesFor(gl);
    expect((await create(call)).status).toBe(201);
    const dup = await create(call, { title: 'again' });
    expect(dup.status).toBe(409);
    expect((await create(call, {}, REPORTER)).status).toBe(403);
    expect((await create(call, { source_branch: 'nope' })).status).toBe(400);
    expect((await create(call, { target_branch: 'nope' })).status).toBe(400);
    expect((await create(call, { title: '' })).status).toBe(400);
    expect((await create(call, { target_branch: 'feature' })).status).toBe(400);
    const put = await call('PUT', `${P}/merge_requests/1`, {
      token: REPORTER,
      body: { title: 'x' },
    });
    expect(put.status).toBe(403);
    // Once the first is closed, a new MR for the same branches is allowed.
    gl.closeMergeRequest(1);
    expect((await create(call)).body.iid).toBe(2);
  });

  test('pushing to the source branch updates sha and diff_refs.head_sha', async () => {
    const { gl, call } = setup();
    const { base } = branchesFor(gl);
    await create(call);
    const put = await call('PUT', `${P}/repository/files/${encodeURIComponent('added.txt')}`, {
      body: { branch: 'feature', content: 'changed\n', commit_message: 'push' },
    });
    expect(put.status).toBe(200);
    const head = gl.branchSha('feature');
    const got = await call('GET', `${P}/merge_requests/1`);
    expect(got.body.sha).toBe(head);
    expect(got.body.diff_refs).toMatchObject({ base_sha: base, head_sha: head });
    const listed = await call('GET', `${P}/merge_requests`);
    expect(listed.body[0].sha).toBe(head);
  });

  test('PUT add_labels, remove_labels and state_event close; reopen', async () => {
    const { gl, call } = setup();
    branchesFor(gl);
    await create(call);
    const r = await call('PUT', `${P}/merge_requests/1`, {
      body: { add_labels: 'done,agent', remove_labels: 'review', state_event: 'close' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'closed', labels: ['agent', 'done'] });
    expect(r.body.closed_at).toEqual(expect.any(String));
    const closed = await call('GET', `${P}/merge_requests?state=closed`);
    expect(closed.body.map((m: { iid: number }) => m.iid)).toEqual([1]);
    expect((await call('GET', `${P}/merge_requests?state=opened`)).body).toEqual([]);
    const edit = await call('PUT', `${P}/merge_requests/1`, {
      body: { title: 'T2', description: 'D2', labels: 'x', state_event: 'reopen' },
    });
    expect(edit.body).toMatchObject({
      title: 'T2',
      description: 'D2',
      labels: ['x'],
      state: 'opened',
      closed_at: null,
    });
    expect((await call('PUT', `${P}/merge_requests/9`, { body: { title: 'x' } })).status).toBe(404);
  });

  test('diffs show the three-dot change, with an add, an edit, a rename and a delete', async () => {
    const { gl, call } = setup();
    branchesFor(gl);
    await create(call);
    const r = await call('GET', `${P}/merge_requests/1/diffs`);
    expect(r.status).toBe(200);
    // keep.txt changed only on main, so it is not part of the merge request's change.
    expect(
      r.body.map((d: { old_path: string; new_path: string }) => `${d.old_path}>${d.new_path}`),
    ).toEqual(['added.txt>added.txt', 'edit.txt>edit.txt', 'gone.txt>gone.txt', 'old.txt>new.txt']);
    const by = (p: string) => r.body.find((d: { new_path: string }) => d.new_path === p);
    expect(by('added.txt')).toMatchObject({ new_file: true, diff: '@@ -1,0 +1,1 @@\n+x\n' });
    expect(by('edit.txt')).toMatchObject({
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: '@@ -1,1 +1,1 @@\n-one\n+two\n',
    });
    expect(by('gone.txt')).toMatchObject({ deleted_file: true });
    expect(by('new.txt')).toMatchObject({ renamed_file: true, old_path: 'old.txt' });
    for (const d of r.body)
      expect(Object.keys(d).sort()).toEqual(
        ['deleted_file', 'diff', 'new_file', 'new_path', 'old_path', 'renamed_file'].sort(),
      );

    const p1 = await call('GET', `${P}/merge_requests/1/diffs?per_page=3&page=1`);
    const p2 = await call('GET', `${P}/merge_requests/1/diffs?per_page=3&page=2`);
    expect(p1.body).toHaveLength(3);
    expect(p1.headers.get('x-next-page')).toBe('2');
    expect(p2.body).toHaveLength(1);
    expect(p2.headers.get('x-total-pages')).toBe('2');
    expect([...p1.body, ...p2.body]).toEqual(r.body);
    expect((await call('GET', `${P}/merge_requests/5/diffs`)).status).toBe(404);
  });

  test('a single MR reports changes_count as its diff file count, unless a test sets it', async () => {
    const { gl, call } = setup();
    branchesFor(gl);
    await create(call);
    expect((await call('GET', `${P}/merge_requests/1`)).body.changes_count).toBe('4');
    const mr = gl.mergeRequest(1);
    if (!mr) throw new Error('no MR');
    mr.changes_count = '1000+';
    expect((await call('GET', `${P}/merge_requests/1`)).body.changes_count).toBe('1000+');
    mr.changes_count = null;
    expect((await call('GET', `${P}/merge_requests/1`)).body).not.toHaveProperty('changes_count');
  });

  test('MR iid 1 and issue iid 1 coexist', async () => {
    const { gl, call } = setup();
    branchesFor(gl);
    const issue = await call('POST', `${P}/issues`, { body: { title: 'an issue' } });
    const mr = await create(call);
    expect(issue.body.iid).toBe(1);
    expect(mr.body.iid).toBe(1);
    expect((await call('GET', `${P}/issues/1`)).body.title).toBe('an issue');
    expect((await call('GET', `${P}/merge_requests/1`)).body.title).toBe('Add things');
    expect((await create(call, { source_branch: 'main', target_branch: 'feature' })).body.iid).toBe(
      2,
    );
    expect((await call('POST', `${P}/issues`, { body: { title: 'b' } })).body.iid).toBe(2);
  });

  test('a seeded merged MR reads state merged with merged_at set, and keeps its sha', async () => {
    const { gl, call } = setup();
    const { head } = branchesFor(gl);
    const mr = gl.seedMergeRequest({
      sourceBranch: 'feature',
      targetBranch: 'main',
      title: 'Merged one',
      labels: ['agent'],
      author: 'dev',
    });
    gl.markMergeRequestMerged(mr.iid, { mergedAt: '2026-05-01T00:00:00.000Z' });
    gl.seedCommit({ branch: 'feature', files: { z: '1' }, message: 'after merge' });
    const got = await call('GET', `${P}/merge_requests/${mr.iid}`);
    expect(got.body).toMatchObject({
      state: 'merged',
      merged_at: '2026-05-01T00:00:00.000Z',
      sha: head,
      diff_refs: { head_sha: head },
      author: { username: 'dev' },
    });
    expect((await call('GET', `${P}/merge_requests?state=merged`)).body).toHaveLength(1);
    expect((await call('GET', `${P}/merge_requests?state=all`)).body).toHaveLength(1);
    expect((await call('GET', `${P}/merge_requests?state=opened`)).body).toHaveLength(0);
    // A merged MR doesn't block a new one for the same branches, and can't be reopened.
    expect((await create(call)).status).toBe(201);
    const reopen = await call('PUT', `${P}/merge_requests/${mr.iid}`, {
      body: { state_event: 'reopen' },
    });
    expect(reopen.body.state).toBe('merged');
    expect(() =>
      gl.seedMergeRequest({ sourceBranch: 'nope', targetBranch: 'main', title: 'x' }),
    ).toThrow(/unknown branch/);
  });

  test('requests carry no token; unknown MR routes answer 404 and are listed', async () => {
    const { gl, call } = setup();
    branchesFor(gl);
    await create(call);
    await call('GET', `${P}/merge_requests?private_token=${DEVELOPER}`);
    const r = await call('PUT', `${P}/merge_requests/1/cancel_merge_when_pipeline_succeeds`);
    expect(r.status).toBe(404);
    expect((await call('GET', `${P}/merge_requests/1/changes`)).status).toBe(404);
    expect(gl.unknown).toEqual([
      `PUT /api/v4${P}/merge_requests/1/cancel_merge_when_pipeline_succeeds`,
      `GET /api/v4${P}/merge_requests/1/changes`,
    ]);
    expect(gl.requests.length).toBe(4);
    expect(gl.requests[0]?.body).toMatchObject({ source_branch: 'feature' });
    expect(gl.requests[1]?.query).toEqual({});
    expect(JSON.stringify(gl.requests)).not.toContain(DEVELOPER);
  });
});

describe('pipelines and jobs', () => {
  const P = `/projects/${PROJECT.id}`;
  const ids = (list: { id: number }[]) => list.map((x) => x.id);
  const names = (list: { name: string }[]) => list.map((x) => x.name);

  function twoShas(gl: FakeGitLab) {
    const a = gl.seedCommit({ branch: 'main', files: { a: '1' }, message: 'a' });
    const b = gl.seedCommit({ branch: 'feature', parent: a, files: { a: '2' }, message: 'b' });
    return { a, b };
  }

  test('GET pipelines?sha= lists only that SHA, newest first with order_by=id&sort=desc', async () => {
    const { gl, call } = setup();
    const { a, b } = twoShas(gl);
    const first = gl.seedPipeline({ sha: a, ref: 'main', status: 'failed' }).pipeline;
    const other = gl.seedPipeline({ sha: b, ref: 'feature' }).pipeline;
    const second = gl.seedPipeline({ sha: a, ref: 'main', status: 'success' }).pipeline;

    const r = await call('GET', `${P}/pipelines?sha=${a}&order_by=id&sort=desc`);
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([second.id, first.id]);
    expect(r.body[0]).toMatchObject({
      id: second.id,
      iid: 3,
      sha: a,
      ref: 'main',
      status: 'success',
      source: 'push',
      web_url: `${GITLAB}/${PROJECT.path}/-/pipelines/${second.id}`,
    });
    for (const p of r.body)
      for (const k of ['created_at', 'updated_at']) expect(p[k]).toEqual(expect.any(String));
    const asc = await call('GET', `${P}/pipelines?sha=${a}&order_by=id&sort=asc`);
    expect(ids(asc.body)).toEqual([first.id, second.id]);
    expect(ids((await call('GET', `${P}/pipelines?sha=${b}`)).body)).toEqual([other.id]);
    expect(ids((await call('GET', `${P}/pipelines?ref=main&status=failed`)).body)).toEqual([
      first.id,
    ]);
    expect(ids((await call('GET', `${P}/pipelines`)).body)).toEqual([
      second.id,
      other.id,
      first.id,
    ]);
    const p1 = await call('GET', `${P}/pipelines?per_page=2&page=1`);
    expect(p1.body).toHaveLength(2);
    expect(p1.headers.get('x-next-page')).toBe('2');
    expect((await call('GET', `${P}/pipelines/${other.id}`)).body).toMatchObject({
      id: other.id,
      sha: b,
    });
    expect((await call('GET', `${P}/pipelines/999999`)).status).toBe(404);
  });

  test('pipeline jobs filter by scope[] and page over more than one page', async () => {
    const { gl, call } = setup();
    const { a } = twoShas(gl);
    const { pipeline, jobs } = gl.seedPipeline({
      sha: a,
      jobs: [
        { name: 'lint', stage: 'test', status: 'success' },
        { name: 'unit', stage: 'test', status: 'failed' },
        { name: 'e2e', stage: 'test', status: 'failed', allowFailure: true },
        { name: 'build', stage: 'build', status: 'canceled' },
        { name: 'deploy', stage: 'deploy', status: 'manual' },
      ],
    });
    expect(pipeline.status).toBe('failed');
    const all = await call('GET', `${P}/pipelines/${pipeline.id}/jobs`);
    expect(names(all.body)).toEqual(['lint', 'unit', 'e2e', 'build', 'deploy']);
    expect(all.body[1]).toMatchObject({
      id: jobs[1]?.id,
      name: 'unit',
      stage: 'test',
      status: 'failed',
      allow_failure: false,
      web_url: `${GITLAB}/${PROJECT.path}/-/jobs/${jobs[1]?.id}`,
      pipeline: { id: pipeline.id },
    });
    expect(all.body[1].finished_at).toEqual(expect.any(String));
    expect(all.body[4]).toMatchObject({ started_at: null, finished_at: null });
    expect(all.body[2].allow_failure).toBe(true);

    const failed = await call('GET', `${P}/pipelines/${pipeline.id}/jobs?scope[]=failed`);
    expect(names(failed.body)).toEqual(['unit', 'e2e']);
    const two = await call(
      'GET',
      `${P}/pipelines/${pipeline.id}/jobs?scope[]=failed&scope[]=canceled`,
    );
    expect(names(two.body)).toEqual(['unit', 'e2e', 'build']);

    const p1 = await call('GET', `${P}/pipelines/${pipeline.id}/jobs?per_page=2&page=1`);
    const p2 = await call('GET', `${P}/pipelines/${pipeline.id}/jobs?per_page=2&page=2`);
    const p3 = await call('GET', `${P}/pipelines/${pipeline.id}/jobs?per_page=2&page=3`);
    expect(p1.headers.get('x-total-pages')).toBe('3');
    expect(p1.headers.get('x-next-page')).toBe('2');
    expect(p3.headers.get('x-next-page')).toBe('');
    expect([...p1.body, ...p2.body, ...p3.body]).toEqual(all.body);
    expect((await call('GET', `${P}/pipelines/999999/jobs`)).status).toBe(404);
  });

  test('retrying a job adds a pending job of the same name and hides the old one', async () => {
    const { gl, call } = setup();
    const { a } = twoShas(gl);
    const { pipeline, jobs } = gl.seedPipeline({
      sha: a,
      jobs: [
        { name: 'lint', status: 'success' },
        { name: 'unit', status: 'failed' },
      ],
    });
    const old = jobs[1] as { id: number };
    const r = await call('POST', `${P}/jobs/${old.id}/retry`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: 'unit',
      status: 'pending',
      started_at: null,
      finished_at: null,
      pipeline: { id: pipeline.id },
    });
    expect(r.body.id).not.toBe(old.id);

    const list = await call('GET', `${P}/pipelines/${pipeline.id}/jobs`);
    expect(ids(list.body)).not.toContain(old.id);
    expect(names(list.body)).toEqual(['lint', 'unit']);
    const withRetried = await call(
      'GET',
      `${P}/pipelines/${pipeline.id}/jobs?include_retried=true`,
    );
    expect(ids(withRetried.body)).toContain(old.id);
    expect(ids(withRetried.body)).toContain(r.body.id);
    expect((await call('GET', `${P}/pipelines/${pipeline.id}`)).body.status).toBe('pending');

    gl.setJobStatus(r.body.id, 'success');
    expect((await call('GET', `${P}/pipelines/${pipeline.id}`)).body.status).toBe('success');
    expect((await call('GET', `${P}/jobs/${r.body.id}`)).body.status).toBe('success');
    expect((await call('POST', `${P}/jobs/999999/retry`)).status).toBe(404);
  });

  test('a pipeline retry retries the failed and canceled jobs only', async () => {
    const { gl, call } = setup();
    const { a } = twoShas(gl);
    const { pipeline, jobs } = gl.seedPipeline({
      sha: a,
      jobs: [
        { name: 'lint', status: 'success' },
        { name: 'unit', status: 'failed' },
        { name: 'build', status: 'canceled' },
        { name: 'deploy', status: 'manual' },
        { name: 'docs', status: 'skipped' },
      ],
    });
    const r = await call('POST', `${P}/pipelines/${pipeline.id}/retry`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: pipeline.id, status: 'pending' });
    const list = (await call('GET', `${P}/pipelines/${pipeline.id}/jobs`)).body;
    expect(list.map((j: { name: string; status: string }) => `${j.name}:${j.status}`)).toEqual([
      'lint:success',
      'deploy:manual',
      'docs:skipped',
      'unit:pending',
      'build:pending',
    ]);
    const kept = ids(list);
    for (const j of [jobs[0], jobs[3], jobs[4]]) expect(kept).toContain(j?.id);
    for (const j of [jobs[1], jobs[2]]) expect(kept).not.toContain(j?.id);
    const all = (await call('GET', `${P}/pipelines/${pipeline.id}/jobs?include_retried=true`)).body;
    expect(all).toHaveLength(7);
    expect((await call('POST', `${P}/pipelines/999999/retry`)).status).toBe(404);
  });

  test('a Reporter gets 403 on both retries; retrying a running job gives 403', async () => {
    const { gl, call } = setup();
    const { a } = twoShas(gl);
    const { pipeline, jobs } = gl.seedPipeline({
      sha: a,
      jobs: [
        { name: 'unit', status: 'failed' },
        { name: 'slow', status: 'running' },
      ],
    });
    const before = (await call('GET', `${P}/pipelines/${pipeline.id}/jobs?include_retried=true`))
      .body;
    const failed = jobs[0] as { id: number };
    const running = jobs[1] as { id: number };
    expect((await call('POST', `${P}/jobs/${failed.id}/retry`, { token: REPORTER })).status).toBe(
      403,
    );
    expect(
      (await call('POST', `${P}/pipelines/${pipeline.id}/retry`, { token: REPORTER })).status,
    ).toBe(403);
    expect((await call('POST', `${P}/jobs/${running.id}/retry`)).status).toBe(403);
    const after = (await call('GET', `${P}/pipelines/${pipeline.id}/jobs?include_retried=true`))
      .body;
    expect(after).toEqual(before);
    expect((await call('GET', `${P}/pipelines`, { token: REPORTER })).status).toBe(200);
  });

  test('commit statuses for a SHA list with their allow_failure', async () => {
    const { gl, call } = setup();
    const { a, b } = twoShas(gl);
    gl.seedCommitStatus({
      sha: a,
      name: 'security/scan',
      status: 'failed',
      allowFailure: true,
      targetUrl: 'https://scan.example/1',
    });
    gl.seedCommitStatus({ sha: a, name: 'deploy/preview', status: 'success' });
    gl.seedCommitStatus({ sha: b, name: 'other', status: 'pending' });
    const r = await call('GET', `${P}/repository/commits/${a}/statuses`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0]).toMatchObject({
      sha: a,
      name: 'security/scan',
      status: 'failed',
      allow_failure: true,
      target_url: 'https://scan.example/1',
    });
    expect(r.body[1]).toMatchObject({
      name: 'deploy/preview',
      status: 'success',
      allow_failure: false,
      target_url: null,
    });
    // A newer status of the same name replaces the older one unless `all=true`.
    gl.seedCommitStatus({ sha: a, name: 'deploy/preview', status: 'running' });
    const latest = (await call('GET', `${P}/repository/commits/${a}/statuses`)).body;
    expect(latest.map((s: { status: string }) => s.status)).toEqual(['failed', 'running']);
    expect((await call('GET', `${P}/repository/commits/${a}/statuses?all=true`)).body).toHaveLength(
      3,
    );
    expect(
      (await call('GET', `${P}/repository/commits/${a}/statuses?name=security/scan`)).body,
    ).toHaveLength(1);
    expect((await call('GET', `${P}/repository/commits/${'f'.repeat(40)}/statuses`)).status).toBe(
      404,
    );
  });

  test('requests carry no token; unknown pipeline routes answer 404 and are listed', async () => {
    const { gl, call } = setup();
    const { a } = twoShas(gl);
    const { pipeline, jobs } = gl.seedPipeline({ sha: a, jobs: [{ name: 'u', status: 'failed' }] });
    await call('GET', `${P}/pipelines?sha=${a}&private_token=${DEVELOPER}`);
    await call('POST', `${P}/jobs/${jobs[0]?.id}/retry`, { body: { access_token: REPORTER } });
    expect((await call('POST', `${P}/pipelines/${pipeline.id}/cancel`)).status).toBe(404);
    expect((await call('GET', `${P}/jobs/${jobs[0]?.id}/trace`)).status).toBe(404);
    expect(gl.unknown).toEqual([
      `POST /api/v4${P}/pipelines/${pipeline.id}/cancel`,
      `GET /api/v4${P}/jobs/${jobs[0]?.id}/trace`,
    ]);
    expect(gl.requests).toHaveLength(4);
    expect(gl.requests[0]?.query).toEqual({ sha: a });
    const text = JSON.stringify(gl.requests);
    for (const t of ALL_TOKENS) expect(text).not.toContain(t);
  });

  test('setPipelineStatus moves a pipeline; seeding an unknown ref throws', async () => {
    const { gl, call } = setup();
    const { a } = twoShas(gl);
    const { pipeline } = gl.seedPipeline({ sha: a, jobs: [{ name: 'u', status: 'running' }] });
    expect(pipeline.status).toBe('running');
    gl.setPipelineStatus(pipeline.id, 'canceled');
    expect((await call('GET', `${P}/pipelines/${pipeline.id}`)).body.status).toBe('canceled');
    expect(() => gl.seedPipeline({ sha: 'nope' })).toThrow(/unknown/);
    expect(() => gl.seedCommitStatus({ sha: 'nope', name: 'x', status: 'success' })).toThrow(
      /unknown/,
    );
    expect(() => gl.setJobStatus(1, 'success')).toThrow(/unknown job/);
  });
});

describe('merge request notes and approvals', () => {
  const P = `/projects/${PROJECT.id}`;

  /** An open MR `!1` from `feature` into `main`, authored by `author` (root by default). */
  function withMr(gl: FakeGitLab, author = 'root') {
    const base = gl.seedCommit({ branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' });
    gl.seedBranch('feature', base);
    const head = gl.seedCommit({
      branch: 'feature',
      files: { 'a.txt': 'b\n' },
      message: 'feature work',
    });
    const mr = gl.seedMergeRequest({
      sourceBranch: 'feature',
      targetBranch: 'main',
      title: 'Change a',
      author,
    });
    return { base, head, mr };
  }
  const usernames = (body: { approved_by: { user: { username: string } }[] }) =>
    body.approved_by.map((a) => a.user.username);

  test('post an MR note and read it back; guest 403, missing body 400, unknown MR 404', async () => {
    const { gl, call } = setup();
    const { mr } = withMr(gl);
    const before = gl.mergeRequest(1)?.updated_at as string;
    const r = await call('POST', `${P}/merge_requests/1/notes`, {
      body: { body: 'Looks good' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      body: 'Looks good',
      noteable_type: 'MergeRequest',
      noteable_iid: mr.iid,
      system: false,
      author: { username: 'dev' },
    });
    expect((gl.mergeRequest(1)?.updated_at as string) > before).toBe(true);
    const list = await call('GET', `${P}/merge_requests/1/notes`);
    expect(list.body.map((n: { id: number }) => n.id)).toEqual([r.body.id]);

    const asReporter = await call('POST', `${P}/merge_requests/1/notes`, {
      token: REPORTER,
      body: { body: 'reporter comment' },
    });
    expect(asReporter.status).toBe(201);
    expect(
      (
        await call('POST', `${P}/merge_requests/1/notes`, {
          token: GUEST,
          body: { body: 'x' },
        })
      ).status,
    ).toBe(403);
    expect((await call('POST', `${P}/merge_requests/1/notes`, { body: {} })).status).toBe(400);
    expect(
      (await call('POST', `${P}/merge_requests/99/notes`, { body: { body: 'x' } })).status,
    ).toBe(404);
    expect(gl.notes.filter((n) => n.noteable_type === 'MergeRequest')).toHaveLength(2);
  });

  test('approve gives 201 and GET approvals shows the approver', async () => {
    const { gl, call } = setup();
    const { head } = withMr(gl);
    const empty = await call('GET', `${P}/merge_requests/1/approvals`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      approved: false,
      approved_by: [],
      approvals_required: 0,
      approvals_left: 0,
    });
    const r = await call('POST', `${P}/merge_requests/1/approve`, { body: { sha: head } });
    expect(r.status).toBe(201);
    const got = await call('GET', `${P}/merge_requests/1/approvals`);
    expect(r.body).toEqual(got.body);
    expect(got.body.approved).toBe(true);
    expect(got.body.approved_by).toEqual([
      { user: { id: expect.any(Number), username: 'dev', name: 'dev' } },
    ]);
    expect(gl.approvals(1)).toEqual([{ username: 'dev', sha: head }]);
    expect((await call('GET', `${P}/merge_requests/99/approvals`)).status).toBe(404);
  });

  test('approve refusals: again 401, stale sha 409, reporter 401, merged 401, unknown 404', async () => {
    const { gl, call } = setup();
    const { base } = withMr(gl);
    const approve = (body: object = {}, token?: string, iid = 1) =>
      call('POST', `${P}/merge_requests/${iid}/approve`, { token, body });
    expect((await approve({ sha: base })).status).toBe(409);
    expect(gl.approvals(1)).toEqual([]);
    expect((await approve()).status).toBe(201);
    expect((await approve()).status).toBe(401);
    expect((await approve({}, REPORTER)).status).toBe(401);
    expect((await approve({}, GUEST)).status).toBe(401);
    expect((await approve({}, undefined, 99)).status).toBe(404);
    gl.addUser({ username: 'dev2', token: WRONG, accessLevel: ACCESS.developer });
    gl.markMergeRequestMerged(1);
    expect((await approve({}, WRONG)).status).toBe(401);
    expect(usernames((await call('GET', `${P}/merge_requests/1/approvals`)).body)).toEqual(['dev']);
  });

  test('the author cannot approve by default; authorCanApprove allows it', async () => {
    const strict = setup();
    withMr(strict.gl, 'dev');
    expect((await strict.call('POST', `${P}/merge_requests/1/approve`)).status).toBe(401);
    const lax = setup(SELF_MANAGED, { authorCanApprove: true });
    withMr(lax.gl, 'dev');
    expect((await lax.call('POST', `${P}/merge_requests/1/approve`)).status).toBe(201);
    expect(lax.gl.approvals(1).map((a) => a.username)).toEqual(['dev']);
  });

  test('unapprove removes the approval; with none it answers 404', async () => {
    const { gl, call } = setup();
    withMr(gl);
    expect((await call('POST', `${P}/merge_requests/1/unapprove`)).status).toBe(404);
    await call('POST', `${P}/merge_requests/1/approve`);
    await call('POST', `${P}/merge_requests/1/approve`, { token: REPORTER });
    const r = await call('POST', `${P}/merge_requests/1/unapprove`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ approved: false, approved_by: [] });
    expect(gl.approvals(1)).toEqual([]);
    expect((await call('POST', `${P}/merge_requests/1/unapprove`)).status).toBe(404);
    expect((await call('POST', `${P}/merge_requests/99/unapprove`)).status).toBe(404);
  });

  test('moving the source branch clears approvals by default', async () => {
    const { gl, call } = setup();
    withMr(gl);
    await call('POST', `${P}/merge_requests/1/approve`);
    expect(gl.approvals(1)).toHaveLength(1);
    gl.seedCommit({ branch: 'feature', files: { 'a.txt': 'c\n' }, message: 'push' });
    expect(gl.approvals(1)).toEqual([]);
    expect((await call('GET', `${P}/merge_requests/1/approvals`)).body.approved).toBe(false);

    // Approve again on the new head, then move the branch through the file write route.
    expect((await call('POST', `${P}/merge_requests/1/approve`)).status).toBe(201);
    const w = await call('PUT', `${P}/repository/files/a.txt`, {
      body: { branch: 'feature', commit_message: 'edit', content: 'd\n' },
    });
    expect(w.status).toBe(200);
    expect(gl.approvals(1)).toEqual([]);
    expect(usernames((await call('GET', `${P}/merge_requests/1/approvals`)).body)).toEqual([]);
    // And through seedBranch.
    await call('POST', `${P}/merge_requests/1/approve`);
    gl.seedBranch('feature', gl.branchSha('main') as string);
    expect(gl.approvals(1)).toEqual([]);
  });

  test('with resetOnPush: false approvals stay and keep the SHA each was given on', async () => {
    const { gl, call } = setup(GITLAB, { resetOnPush: false });
    const { head } = withMr(gl);
    await call('POST', `${P}/merge_requests/1/approve`);
    const next = gl.seedCommit({ branch: 'feature', files: { 'a.txt': 'c\n' }, message: 'push' });
    await call('POST', `${P}/merge_requests/1/approve`, { token: WRONG }); // unknown token: 401
    gl.addUser({ username: 'dev2', token: WRONG, accessLevel: ACCESS.maintainer });
    expect((await call('POST', `${P}/merge_requests/1/approve`, { token: WRONG })).status).toBe(
      201,
    );
    await call('PUT', `${P}/repository/files/a.txt`, {
      body: { branch: 'feature', commit_message: 'edit', content: 'd\n' },
    });
    expect(gl.approvals(1)).toEqual([
      { username: 'dev', sha: head },
      { username: 'dev2', sha: next },
    ]);
    const got = (await call('GET', `${P}/merge_requests/1/approvals`)).body;
    expect(usernames(got)).toEqual(['dev', 'dev2']);
  });

  test('approvals_required and approvals_left follow setApprovalsRequired', async () => {
    const { gl, call } = setup();
    withMr(gl);
    const get = async () => (await call('GET', `${P}/merge_requests/1/approvals`)).body;
    gl.setApprovalsRequired(1, 2);
    expect(await get()).toMatchObject({
      approvals_required: 2,
      approvals_left: 2,
      approved: false,
    });
    await call('POST', `${P}/merge_requests/1/approve`);
    expect(await get()).toMatchObject({ approvals_required: 2, approvals_left: 1, approved: true });
    gl.addUser({ username: 'dev2', token: WRONG, accessLevel: ACCESS.developer });
    await call('POST', `${P}/merge_requests/1/approve`, { token: WRONG });
    await call('POST', `${P}/merge_requests/1/approve`, { token: WRONG });
    expect(await get()).toMatchObject({ approvals_required: 2, approvals_left: 0 });
    gl.setApprovalsRequired(1, 1);
    expect(await get()).toMatchObject({ approvals_required: 1, approvals_left: 0 });
    expect(() => gl.setApprovalsRequired(99, 1)).toThrow(/unknown merge request/);
  });

  test('requests to the new routes carry no token; unknown routes answer 404 and are listed', async () => {
    const { gl, call } = setup();
    withMr(gl);
    await call('POST', `${P}/merge_requests/1/notes?private_token=${DEVELOPER}`, {
      body: { body: `token ${REPORTER} in a note` },
    });
    await call('POST', `${P}/merge_requests/1/approve`, { body: { access_token: REPORTER } });
    await call('GET', `${P}/merge_requests/1/approvals?access_token=${GUEST}`);
    await call('POST', `${P}/merge_requests/1/unapprove`);
    expect((await call('POST', `${P}/merge_requests/1/reset_approvals`)).status).toBe(404);
    expect(gl.unknown).toEqual([`POST /api/v4${P}/merge_requests/1/reset_approvals`]);
    expect(gl.requests).toHaveLength(5);
    expect(gl.requests.map((r) => `${r.method} ${r.path}`).slice(0, 4)).toEqual([
      `POST /api/v4${P}/merge_requests/1/notes`,
      `POST /api/v4${P}/merge_requests/1/approve`,
      `GET /api/v4${P}/merge_requests/1/approvals`,
      `POST /api/v4${P}/merge_requests/1/unapprove`,
    ]);
    const text = JSON.stringify(gl.requests);
    for (const t of ALL_TOKENS) expect(text).not.toContain(t);
  });
});

describe('merge request accept and rebase', () => {
  const P = `/projects/${PROJECT.id}`;

  /** `feature` (two commits off `base`) and `main` (one commit off `base`) touch different
   *  files; MR `!1` merges `feature` into `main`. With `conflict`, `main` also changes `a`. */
  function diverged(gl: FakeGitLab, o: { conflict?: boolean; deleteB?: boolean } = {}) {
    const base = gl.seedCommit({
      branch: 'main',
      files: { a: 'a\n', b: 'b\n' },
      message: 'base',
    });
    gl.seedBranch('feature', base);
    const f1 = gl.seedCommit({
      branch: 'feature',
      files: o.deleteB ? { a: 'a\n' } : { a: 'A\n', b: 'b\n' },
      message: 'feature one',
    });
    const f2 = gl.seedCommit({
      branch: 'feature',
      files: o.deleteB ? { a: 'a\n', c: 'c\n' } : { a: 'A\n', b: 'b\n', c: 'c\n' },
      message: 'feature two',
    });
    const m1 = gl.seedCommit({
      branch: 'main',
      files: { a: o.conflict ? 'x\n' : 'a\n', b: 'B\n' },
      message: 'main work',
    });
    gl.seedMergeRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'Add c' });
    return { base, f1, f2, m1 };
  }

  test('every MR carries the new fields, defaulted', async () => {
    const { gl, call } = setup();
    diverged(gl);
    const defaults = {
      merge_commit_sha: null,
      squash_commit_sha: null,
      merge_error: null,
      rebase_in_progress: false,
    };
    expect(gl.mergeRequest(1)).toMatchObject(defaults);
    gl.seedBranch('other', gl.branchSha('feature') as string);
    const made = await call('POST', `${P}/merge_requests`, {
      body: { source_branch: 'other', target_branch: 'main', title: 'Other' },
    });
    expect(made.body).toMatchObject(defaults);
    expect((await call('GET', `${P}/merge_requests/2`)).body).toMatchObject(defaults);
  });

  test('a squash accept at the head SHA makes one commit on main and removes the source', async () => {
    const { gl, call } = setup();
    const { f2, m1 } = diverged(gl);
    const r = await call('PUT', `${P}/merge_requests/1/merge`, {
      body: { sha: f2, squash: true, should_remove_source_branch: true },
    });
    expect(r.status).toBe(200);
    const head = gl.branchSha('main') as string;
    expect(head).not.toBe(m1);
    expect(gl.commit(head)).toMatchObject({
      parent_ids: [m1],
      message: 'Add c',
      files: { a: 'A\n', b: 'B\n', c: 'c\n' },
    });
    expect(r.body).toMatchObject({
      state: 'merged',
      squash_commit_sha: head,
      merge_commit_sha: null,
      sha: f2,
    });
    expect(r.body.merged_at).toEqual(expect.any(String));
    expect(gl.branchSha('feature')).toBeUndefined();
    const got = await call('GET', `${P}/merge_requests/1`);
    expect(got.body).toMatchObject({ state: 'merged', sha: f2, squash_commit_sha: head });
    expect(got.body.diff_refs).toMatchObject({ start_sha: m1, head_sha: f2 });
  });

  test('a squash accept takes squash_commit_message and keeps the source branch by default', async () => {
    const { gl, call } = setup();
    const { f2 } = diverged(gl);
    const r = await call('PUT', `${P}/merge_requests/1/merge`, {
      body: { squash: true, squash_commit_message: 'Squashed' },
    });
    expect(r.status).toBe(200);
    expect(gl.commit(gl.branchSha('main') as string)?.message).toBe('Squashed');
    expect(gl.branchSha('feature')).toBe(f2);
  });

  test('a non-squash accept makes a two-parent merge commit and sets merge_commit_sha', async () => {
    const { gl, call } = setup();
    const { f2, m1 } = diverged(gl);
    const r = await call('PUT', `${P}/merge_requests/1/merge`, {
      body: { merge_commit_message: 'Merge it' },
    });
    expect(r.status).toBe(200);
    const head = gl.branchSha('main') as string;
    expect(gl.commit(head)).toMatchObject({
      parent_ids: [m1, f2],
      message: 'Merge it',
      files: { a: 'A\n', b: 'B\n', c: 'c\n' },
    });
    expect(r.body).toMatchObject({
      state: 'merged',
      merge_commit_sha: head,
      squash_commit_sha: null,
    });
    expect(gl.branchSha('feature')).toBe(f2);
  });

  test('a stale SHA gives 409 and changes nothing', async () => {
    const { gl, call } = setup();
    const { f1, f2, m1 } = diverged(gl);
    const before = JSON.stringify(gl.mergeRequest(1));
    const r = await call('PUT', `${P}/merge_requests/1/merge`, {
      body: { sha: f1, squash: true },
    });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ message: 'SHA does not match HEAD of source branch' });
    expect(gl.branchSha('main')).toBe(m1);
    expect(gl.branchSha('feature')).toBe(f2);
    expect(JSON.stringify(gl.mergeRequest(1))).toBe(before);
  });

  test('refusals: 404 unknown, 403 Reporter, 405 closed, 405 not mergeable, 406 conflict', async () => {
    const { gl, call } = setup();
    const { f2, m1 } = diverged(gl);
    const merge = (iid: number, token?: string) =>
      call('PUT', `${P}/merge_requests/${iid}/merge`, { token, body: { squash: true } });
    expect((await merge(99)).status).toBe(404);
    expect((await merge(1, REPORTER)).status).toBe(403);
    gl.setMergeable(1, false);
    expect((await merge(1)).status).toBe(405);
    gl.setMergeable(1, true);
    gl.closeMergeRequest(1);
    expect((await merge(1)).status).toBe(405);
    expect(gl.branchSha('main')).toBe(m1);
    expect(gl.branchSha('feature')).toBe(f2);
    expect(() => gl.setMergeable(99, false)).toThrow(/unknown merge request/);

    const second = setup(SELF_MANAGED);
    const d = diverged(second.gl, { conflict: true });
    const r = await second.call('PUT', `${P}/merge_requests/1/merge`, { body: { squash: true } });
    expect(r.status).toBe(406);
    expect(second.gl.branchSha('main')).toBe(d.m1);
    expect(second.gl.mergeRequest(1)?.state).toBe('opened');
  });

  test('checks run in order: 403 before 405, 405 closed before 409, 409 before 405 and 406', async () => {
    const { gl, call } = setup();
    const { f1 } = diverged(gl, { conflict: true });
    gl.setMergeable(1, false);
    const merge = (body: unknown, token?: string) =>
      call('PUT', `${P}/merge_requests/1/merge`, { token, body });
    expect((await merge({ sha: f1 })).status).toBe(409);
    expect((await merge({})).status).toBe(405);
    gl.setMergeable(1, true);
    expect((await merge({})).status).toBe(406);
    gl.closeMergeRequest(1);
    expect((await merge({ sha: f1 }, REPORTER)).status).toBe(403);
    expect((await merge({ sha: f1 })).status).toBe(405);
  });

  test('a deletion on one side and an edit on the other is a conflict', async () => {
    const { gl, call } = setup();
    diverged(gl, { deleteB: true });
    expect((await call('PUT', `${P}/merge_requests/1/merge`)).status).toBe(406);
  });

  test('a clean rebase replays the source commits onto the target head', async () => {
    const { gl, call } = setup();
    const { f2, m1 } = diverged(gl);
    const r = await call('PUT', `${P}/merge_requests/1/rebase`);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ rebase_in_progress: true });
    const head = gl.branchSha('feature') as string;
    expect(head).not.toBe(f2);
    const top = gl.commit(head);
    expect(top).toMatchObject({ message: 'feature two', files: { a: 'A\n', b: 'B\n', c: 'c\n' } });
    const first = gl.commit(top?.parent_ids[0] as string);
    expect(top?.parent_ids).toHaveLength(1);
    expect(first).toMatchObject({
      message: 'feature one',
      parent_ids: [m1],
      files: { a: 'A\n', b: 'B\n' },
    });
    expect(gl.branchSha('main')).toBe(m1);
    const got = await call('GET', `${P}/merge_requests/1?include_rebase_in_progress=true`);
    expect(got.body).toMatchObject({
      rebase_in_progress: false,
      merge_error: null,
      sha: head,
      diff_refs: { base_sha: m1, start_sha: m1, head_sha: head },
    });
  });

  test('a conflicting rebase leaves the source branch and sets merge_error', async () => {
    const { gl, call } = setup();
    const { f2, m1 } = diverged(gl, { conflict: true });
    const r = await call('PUT', `${P}/merge_requests/1/rebase`);
    expect(r.status).toBe(202);
    expect(gl.branchSha('feature')).toBe(f2);
    expect(gl.branchSha('main')).toBe(m1);
    const got = await call('GET', `${P}/merge_requests/1?include_rebase_in_progress=true`);
    expect(got.body).toMatchObject({ rebase_in_progress: false, sha: f2 });
    expect(got.body.merge_error).toEqual(expect.stringMatching(/\S/));
  });

  test('rebase refusals: 404 unknown, 403 Reporter, 405 not open', async () => {
    const { gl, call } = setup();
    const { f2 } = diverged(gl);
    expect((await call('PUT', `${P}/merge_requests/99/rebase`)).status).toBe(404);
    expect((await call('PUT', `${P}/merge_requests/1/rebase`, { token: REPORTER })).status).toBe(
      403,
    );
    gl.closeMergeRequest(1);
    expect((await call('PUT', `${P}/merge_requests/1/rebase`)).status).toBe(405);
    expect(gl.branchSha('feature')).toBe(f2);
  });

  test('merge and rebase requests are recorded without their token', async () => {
    const { gl, call } = setup();
    diverged(gl);
    await call('PUT', `${P}/merge_requests/1/rebase?private_token=${DEVELOPER}`);
    await call('PUT', `${P}/merge_requests/1/merge?private_token=${DEVELOPER}`, {
      body: { squash: true, private_token: REPORTER },
    });
    expect((await call('PUT', `${P}/merge_requests/1/cancel_merge`)).status).toBe(404);
    expect(gl.unknown).toEqual([`PUT /api/v4${P}/merge_requests/1/cancel_merge`]);
    expect(gl.requests.slice(0, 2)).toMatchObject([
      { method: 'PUT', path: `/api/v4${P}/merge_requests/1/rebase`, user: 'dev', query: {} },
      {
        method: 'PUT',
        path: `/api/v4${P}/merge_requests/1/merge`,
        body: { squash: true, private_token: '[redacted]' },
      },
    ]);
    const text = JSON.stringify(gl.requests);
    for (const t of ALL_TOKENS) expect(text).not.toContain(t);
  });
});

describe('protected branches, approval rules and approval settings', () => {
  const P = `/projects/${PROJECT.id}`;
  const NEW_ROUTES = [
    `${P}/protected_branches`,
    `${P}/protected_branches/main`,
    `${P}/approval_rules`,
    `${P}/approvals`,
  ];

  test('the list and single read, by exact stored name only', async () => {
    const { gl, call } = setup();
    const main = gl.protectBranch({
      name: 'main',
      pushAccessLevels: [ACCESS.maintainer],
      mergeAccessLevels: [ACCESS.developer],
      codeOwnerApprovalRequired: true,
    });
    gl.protectBranch({ name: 'release/*', pushAccessLevels: [0], allowForcePush: true });
    gl.protectBranch({ name: 'jm/x' });

    const list = await call('GET', `${P}/protected_branches`);
    expect(list.status).toBe(200);
    expect(list.headers.get('x-total')).toBe('3');
    expect(list.body.map((b: { name: string }) => b.name)).toEqual(['main', 'release/*', 'jm/x']);
    expect(list.body[0]).toEqual({
      id: main.id,
      name: 'main',
      push_access_levels: [{ access_level: 40, access_level_description: 'Maintainers' }],
      merge_access_levels: [
        { access_level: 30, access_level_description: 'Developers + Maintainers' },
      ],
      allow_force_push: false,
      code_owner_approval_required: true,
    });
    const paged = await call('GET', `${P}/protected_branches?per_page=2&page=2`);
    expect(paged.body.map((b: { name: string }) => b.name)).toEqual(['jm/x']);

    const wildcard = await call('GET', `${P}/protected_branches/release%2F*`);
    expect(wildcard.status).toBe(200);
    expect(wildcard.body).toMatchObject({
      name: 'release/*',
      push_access_levels: [{ access_level: 0, access_level_description: 'No one' }],
      allow_force_push: true,
      code_owner_approval_required: false,
    });
    const slash = await call('GET', `${P}/protected_branches/jm%2Fx`);
    expect(slash).toMatchObject({ status: 200, body: { name: 'jm/x' } });

    expect((await call('GET', `${P}/protected_branches/develop`)).status).toBe(404);
    // A concrete branch that only matches the wildcard does not answer the single read.
    expect((await call('GET', `${P}/protected_branches/release%2F1.0`)).status).toBe(404);
    expect(() => gl.protectBranch({ name: 'main' })).toThrow(/already protected/);
  });

  test('branch JSON reports protected for an exact or wildcard match only', async () => {
    const { gl, call } = setup();
    const head = gl.branchSha('main') as string;
    for (const b of ['release/1.0', 'release', 'feature', 'jm/release/2']) gl.seedBranch(b, head);
    const isProtected = async (name: string) =>
      (await call('GET', `${P}/repository/branches/${encodeURIComponent(name)}`)).body.protected;
    expect(await isProtected('main')).toBe(false);
    gl.protectBranch({ name: 'main' });
    gl.protectBranch({ name: 'release/*' });
    expect(await isProtected('main')).toBe(true);
    expect(await isProtected('release/1.0')).toBe(true);
    expect(await isProtected('release')).toBe(false);
    expect(await isProtected('feature')).toBe(false);
    expect(await isProtected('jm/release/2')).toBe(false);
    gl.protectBranch({ name: '*/release/*' });
    expect(await isProtected('jm/release/2')).toBe(true);
  });

  test('approval rules as seeded; on the Free tier they answer 403, the rest still answer', async () => {
    const { gl, call } = setup();
    const main = gl.protectBranch({ name: 'main' });
    const rule = gl.seedApprovalRule({
      name: 'Reviewers',
      approvalsRequired: 2,
      eligibleApprovers: ['dev', 'reporter'],
      protectedBranches: ['main'],
    });
    gl.seedApprovalRule({ name: 'Any', approvalsRequired: 1, ruleType: 'any_approver' });
    const r = await call('GET', `${P}/approval_rules`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-total')).toBe('2');
    expect(r.body[0]).toEqual({
      id: rule.id,
      name: 'Reviewers',
      rule_type: 'regular',
      approvals_required: 2,
      eligible_approvers: [
        { id: expect.any(Number), username: 'dev', name: 'dev' },
        { id: expect.any(Number), username: 'reporter', name: 'reporter' },
      ],
      protected_branches: [main],
    });
    expect(r.body[1]).toMatchObject({
      name: 'Any',
      rule_type: 'any_approver',
      approvals_required: 1,
      eligible_approvers: [],
      protected_branches: [],
    });
    expect(() =>
      gl.seedApprovalRule({ name: 'x', approvalsRequired: 1, protectedBranches: ['nope'] }),
    ).toThrow(/not protected/);

    gl.setTier('free');
    expect(await call('GET', `${P}/approval_rules`)).toMatchObject({
      status: 403,
      body: { message: '403 Forbidden' },
    });
    expect((await call('GET', `${P}/approvals`)).status).toBe(200);
    expect((await call('GET', `${P}/protected_branches`)).status).toBe(200);
    expect((await call('GET', `${P}/protected_branches/main`)).status).toBe(200);
    gl.setTier('premium');
    expect((await call('GET', `${P}/approval_rules`)).status).toBe(200);
  });

  test('approval settings: defaults follow the constructor options, and a subset is seedable', async () => {
    const { gl, call } = setup();
    expect((await call('GET', `${P}/approvals`)).body).toEqual({
      approvals_before_merge: 0,
      reset_approvals_on_push: true,
      merge_requests_author_approval: false,
      merge_requests_disable_committers_approval: false,
    });
    gl.setApprovalSettings({ approvals_before_merge: 2 });
    gl.setApprovalSettings({ merge_requests_disable_committers_approval: true });
    expect((await call('GET', `${P}/approvals`)).body).toEqual({
      approvals_before_merge: 2,
      reset_approvals_on_push: true,
      merge_requests_author_approval: false,
      merge_requests_disable_committers_approval: true,
    });
    const lax = setup(SELF_MANAGED, { resetOnPush: false, authorCanApprove: true });
    expect((await lax.call('GET', `${P}/approvals`)).body).toMatchObject({
      reset_approvals_on_push: false,
      merge_requests_author_approval: true,
    });
  });

  /** An open MR `!1` from `feature` into `main`, authored by `author`. */
  function withMr(gl: FakeGitLab, author = 'root') {
    const base = gl.seedCommit({ branch: 'main', files: { a: '1' }, message: 'base' });
    gl.seedBranch('feature', base);
    gl.seedCommit({ branch: 'feature', files: { a: '2' }, message: 'work' });
    gl.seedMergeRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'A', author });
  }

  test('reset_approvals_on_push governs the merge request approvals route', async () => {
    const { gl, call } = setup();
    withMr(gl);
    const approvedBy = async () =>
      (await call('GET', `${P}/merge_requests/1/approvals`)).body.approved_by.map(
        (a: { user: { username: string } }) => a.user.username,
      );
    gl.setApprovalSettings({ reset_approvals_on_push: false });
    expect((await call('POST', `${P}/merge_requests/1/approve`)).status).toBe(201);
    gl.seedCommit({ branch: 'feature', files: { a: '3' }, message: 'push' });
    expect(await approvedBy()).toEqual(['dev']);
    gl.setApprovalSettings({ reset_approvals_on_push: true });
    expect(await approvedBy()).toEqual([]);
    expect((await call('GET', `${P}/approvals`)).body.reset_approvals_on_push).toBe(true);
  });

  test('merge_requests_author_approval governs the approve route', async () => {
    const { gl, call } = setup();
    withMr(gl, 'dev');
    gl.setApprovalSettings({ merge_requests_author_approval: false });
    expect((await call('POST', `${P}/merge_requests/1/approve`)).status).toBe(401);
    gl.setApprovalSettings({ merge_requests_author_approval: true });
    expect((await call('POST', `${P}/merge_requests/1/approve`)).status).toBe(201);
    expect(gl.approvals(1).map((a) => a.username)).toEqual(['dev']);

    const strict = setup(SELF_MANAGED, { authorCanApprove: true });
    withMr(strict.gl, 'dev');
    strict.gl.setApprovalSettings({ merge_requests_author_approval: false });
    expect((await strict.call('POST', `${P}/merge_requests/1/approve`)).status).toBe(401);
  });

  test('every new route refuses a missing or wrong token and another project, and is recorded', async () => {
    const { gl, call } = setup();
    gl.protectBranch({ name: 'main' });
    for (const path of NEW_ROUTES) {
      expect(await call('GET', path, { token: null })).toMatchObject({ status: 401 });
      expect(await call('GET', path, { token: WRONG })).toMatchObject({ status: 401 });
      expect((await call('GET', path)).status).toBe(200);
      const other = await call('GET', path.replace(P, '/projects/999'));
      expect(other).toMatchObject({ status: 404, body: { message: '404 Project Not Found' } });
    }
    expect(gl.unknown).toEqual([]);
    expect(gl.requests).toHaveLength(NEW_ROUTES.length * 4);
    expect(gl.requests.slice(0, 3)).toEqual([
      {
        method: 'GET',
        path: `/api/v4${P}/protected_branches`,
        query: {},
        body: undefined,
        user: null,
      },
      {
        method: 'GET',
        path: `/api/v4${P}/protected_branches`,
        query: {},
        body: undefined,
        user: '<unknown>',
      },
      {
        method: 'GET',
        path: `/api/v4${P}/protected_branches`,
        query: {},
        body: undefined,
        user: 'dev',
      },
    ]);
    const text = JSON.stringify(gl.requests);
    for (const t of ALL_TOKENS) expect(text).not.toContain(t);
  });
});
