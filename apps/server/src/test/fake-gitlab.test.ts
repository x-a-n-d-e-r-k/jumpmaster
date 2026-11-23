import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
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

function setup(baseUrl = GITLAB) {
  const gl = fakeGitLab({ baseUrl, project: PROJECT });
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
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
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
        });
        expect((await call('GET', `/projects/${id}/issues`)).status).toBe(200);
      }
      const other = await call('GET', `/projects/${encodeURIComponent('group/other')}`);
      expect(other).toMatchObject({ status: 404, body: { message: '404 Project Not Found' } });
      const otherId = await call('GET', '/projects/999/issues');
      expect(otherId).toMatchObject({ status: 404, body: { message: '404 Project Not Found' } });
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
    expect(q.body).toEqual([{ id: m.id, username: 'maint', name: 'maint', access_level: 40 }]);
    const all = await call('GET', `/projects/${ENCODED}/members/all`);
    expect(all.body.map((x: { username: string }) => x.username).sort()).toEqual(
      ['dev', 'guest', 'maint', 'reporter'].sort(),
    );
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
