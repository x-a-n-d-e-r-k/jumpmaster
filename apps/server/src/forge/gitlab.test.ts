import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ACCESS, type FakeGitLab, fakeGitLab } from '../test/fake-gitlab.js';
import { gitBlobSha, type TokenProvider } from './github.js';
import { GitLabForge, GitLabForgeError, GitLabUnsupportedError } from './gitlab.js';

const GITLAB = 'https://gitlab.example.com';
const PROJECT = { id: 77, path: 'group/sub/project', defaultBranch: 'trunk' };
const ENCODED = encodeURIComponent(PROJECT.path);
const API = `/api/v4/projects/${ENCODED}`;

// Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
const AGENT = glpat('A');
const OTHER = glpat('O');
const WRONG = glpat('W');

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
    for (const gl of fakes) expect(gl.unknown).toEqual([]);
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

function setup(opts: { fetch?: typeof fetch } = {}) {
  const gl = fakeGitLab({ baseUrl: GITLAB, project: PROJECT });
  fakes.push(gl);
  gl.addUser({ username: 'agent', token: AGENT, accessLevel: ACCESS.developer });
  gl.addUser({ username: 'other', token: OTHER, accessLevel: ACCESS.developer });
  const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, opts);
  return { gl, forge };
}

describe('reads', () => {
  test('getDefaultBranch', async () => {
    const { gl, forge } = setup();
    expect(await forge.getDefaultBranch()).toBe('trunk');
    expect(gl.requests).toMatchObject([{ method: 'GET', path: API, user: 'agent' }]);
  });

  test('listOpenIssues pages through more than 100 issues, open only, with and without a label', async () => {
    const { gl, forge } = setup();
    for (let i = 1; i <= 130; i++)
      gl.seedIssue({
        title: `t${i}`,
        description: i === 1 ? null : `body ${i}`,
        labels: i % 2 === 0 ? ['jm:ready'] : [],
        author: 'other',
      });
    gl.seedIssue({ title: 'shut', state: 'closed', labels: ['jm:ready'] });

    const all = await forge.listOpenIssues();
    expect(all).toHaveLength(130);
    expect(all.map((i) => i.title)).not.toContain('shut');
    const first = all.find((i) => i.number === 1);
    expect(first).toEqual({
      number: 1,
      title: 't1',
      body: '',
      author: 'other',
      authorType: '',
      labels: [],
      createdAt: expect.any(String),
    });
    expect(first).not.toHaveProperty('blockedBy');
    const pages = gl.requests.filter((r) => r.path === `${API}/issues`);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.query).toMatchObject({ state: 'opened', per_page: '100' });
    expect(pages[1]?.query).toMatchObject({ page: '2' });

    gl.requests.length = 0;
    const labelled = await forge.listOpenIssues('jm:ready');
    expect(labelled).toHaveLength(65);
    expect(labelled.every((i) => i.labels.includes('jm:ready'))).toBe(true);
    expect(gl.requests[0]?.query).toMatchObject({ labels: 'jm:ready', state: 'opened' });
  });

  test('listReadyIssues lists open issues with the label', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ title: 'ready', labels: ['ready'] });
    gl.seedIssue({ title: 'not' });
    gl.seedIssue({ title: 'closed', labels: ['ready'], state: 'closed' });
    expect((await forge.listReadyIssues('ready')).map((i) => i.title)).toEqual(['ready']);
  });

  test('getIssue: open, closed, and missing', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 5, title: 'a', description: 'hello', labels: ['x', 'y'], author: 'other' });
    gl.seedIssue({ iid: 6, title: 'b', state: 'closed', author: 'agent' });
    expect(await forge.getIssue(5)).toEqual({
      body: 'hello',
      state: 'open',
      labels: ['x', 'y'],
      author: 'other',
    });
    const closed = await forge.getIssue(6);
    expect(closed).toEqual({ body: '', state: 'closed', labels: [], author: 'agent' });
    expect(closed).not.toHaveProperty('pullRequest');
    expect(await forge.getIssue(99)).toBeNull();
  });

  test('getIssueState and getIssueLabels, and the throw for a missing issue', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 1, title: 'a', labels: ['l1'] });
    gl.seedIssue({ iid: 2, title: 'b', state: 'closed' });
    expect(await forge.getIssueState(1)).toBe('open');
    expect(await forge.getIssueState(2)).toBe('closed');
    expect(await forge.getIssueLabels(1)).toEqual(['l1']);
    await expect(forge.getIssueState(3)).rejects.toMatchObject({ status: 404 });
    await expect(forge.getIssueLabels(3)).rejects.toMatchObject({ status: 404 });
  });

  test('listLabels pages through every label', async () => {
    const { gl, forge } = setup();
    for (let i = 0; i < 105; i++) gl.seedLabel({ name: `l${i}` });
    const names = await forge.listLabels();
    expect(names).toHaveLength(105);
    expect(names).toContain('l104');
    expect(gl.requests.filter((r) => r.path === `${API}/labels`)).toHaveLength(2);
  });

  test('viewerLogin is read once and cached', async () => {
    const { gl, forge } = setup();
    expect(await forge.viewerLogin()).toBe('agent');
    expect(await forge.viewerLogin()).toBe('agent');
    expect(gl.requests.filter((r) => r.path === '/api/v4/user')).toHaveLength(1);
  });
});

describe('writes', () => {
  test('createIssue with labels', async () => {
    const { gl, forge } = setup();
    const { number } = await forge.createIssue({ title: 'T', body: 'B', labels: ['a', 'b'] });
    expect(gl.issue(number)).toMatchObject({
      title: 'T',
      description: 'B',
      labels: ['a', 'b'],
      author: { username: 'agent' },
    });
    expect(gl.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `${API}/issues`,
      body: { title: 'T', description: 'B', labels: 'a,b' },
    });
  });

  test('updateIssue closes, reopens and edits title and body; stateReason is dropped', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 3, title: 'old', description: 'old body' });
    await forge.updateIssue(3, { state: 'closed', stateReason: 'completed' });
    expect(gl.issue(3)?.state).toBe('closed');
    expect(gl.requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: `${API}/issues/3`,
      body: { state_event: 'close' },
    });
    expect(JSON.stringify(gl.requests.at(-1)?.body)).not.toContain('completed');

    await forge.updateIssue(3, { state: 'open' });
    expect(gl.issue(3)?.state).toBe('opened');
    expect(gl.requests.at(-1)?.body).toEqual({ state_event: 'reopen' });

    await forge.updateIssue(3, { title: 'new', body: 'new body' });
    expect(gl.issue(3)).toMatchObject({ title: 'new', description: 'new body', state: 'opened' });
    expect(gl.requests.at(-1)?.body).toEqual({ title: 'new', description: 'new body' });
  });

  test('updateIssue with nothing GitLab can apply sends no request', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 3, title: 'old', description: 'old body' });
    await forge.updateIssue(3, {});
    await forge.updateIssue(3, { stateReason: 'completed' });
    expect(gl.requests).toEqual([]);
    expect(gl.issue(3)).toMatchObject({ title: 'old', description: 'old body', state: 'opened' });
  });

  test('setLabels adds and removes in one request', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 4, title: 'x', labels: ['keep', 'drop'] });
    await forge.setLabels(4, { add: ['new1', 'new2'], remove: ['drop'] });
    expect(gl.issue(4)?.labels).toEqual(['keep', 'new1', 'new2']);
    expect(gl.requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: `${API}/issues/4`,
      body: { add_labels: 'new1,new2', remove_labels: 'drop' },
    });
    const before = gl.requests.length;
    await forge.setLabels(4, { add: [], remove: [] });
    expect(gl.requests).toHaveLength(before);
  });

  test('createIssueComment', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 8, title: 'x' });
    const { id } = await forge.createIssueComment(8, 'hi there');
    expect(gl.notes.find((n) => n.id === id)).toMatchObject({
      body: 'hi there',
      noteable_iid: 8,
      author: { username: 'agent' },
    });
    expect(gl.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `${API}/issues/8/notes`,
      body: { body: 'hi there' },
    });
  });

  test('createLabel: new, with a # added, and existing gives created false', async () => {
    const { gl, forge } = setup();
    expect(await forge.createLabel('jm:ready', '0e8a16', 'Ready')).toEqual({ created: true });
    expect(gl.labels.find((l) => l.name === 'jm:ready')).toMatchObject({
      color: '#0e8a16',
      description: 'Ready',
    });
    expect(await forge.createLabel('jm:x', '#123456', '')).toEqual({ created: true });
    expect(gl.labels.find((l) => l.name === 'jm:x')?.color).toBe('#123456');
    expect(await forge.createLabel('jm:ready', '0e8a16', 'Ready')).toEqual({ created: false });
    expect(gl.labels.filter((l) => l.name === 'jm:ready')).toHaveLength(1);
  });
});

describe('markers', () => {
  const MARK = '<!-- jm:op:abc -->';

  test('findIssueByMarker finds this viewer’s issue, ignoring others’ and older ones', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({
      iid: 1,
      title: 'old',
      description: `x\n${MARK}`,
      author: 'agent',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    gl.seedIssue({ iid: 2, title: 'theirs', description: `x\n${MARK}`, author: 'other' });
    gl.seedIssue({ iid: 3, title: 'no marker', description: 'x', author: 'agent' });
    const since = '2024-01-01T00:00:00.000Z';
    expect(await forge.findIssueByMarker(MARK, since)).toBeNull();
    gl.seedIssue({ iid: 4, title: 'mine', description: `body\n${MARK}\n`, author: 'agent' });
    expect(await forge.findIssueByMarker(MARK, since)).toEqual({ number: 4 });
    const listed = gl.requests.filter((r) => r.path === `${API}/issues`);
    expect(listed.at(-1)?.query).toMatchObject({ updated_after: since });
  });

  test('findIssueByMarker pages', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 1, title: 'mine', description: MARK, author: 'agent' });
    for (let i = 0; i < 110; i++) gl.seedIssue({ title: `n${i}`, author: 'other' });
    expect(await forge.findIssueByMarker(MARK, '2000-01-01T00:00:00Z')).toEqual({ number: 1 });
  });

  test('findIssueCommentByMarker returns the newest matching note by the viewer', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 9, title: 'x' });
    const older = gl.seedNote({ issueIid: 9, body: `a\n${MARK}`, author: 'agent' });
    const newer = gl.seedNote({ issueIid: 9, body: `b\n${MARK}\n`, author: 'agent' });
    gl.seedNote({ issueIid: 9, body: `c\n${MARK}`, author: 'other' });
    gl.seedNote({ issueIid: 9, body: `d\n${MARK}`, author: 'agent', system: true });
    gl.seedNote({ issueIid: 9, body: 'no marker', author: 'agent' });
    expect(older.id).toBeLessThan(newer.id);
    expect(await forge.findIssueCommentByMarker(9, MARK)).toEqual({ id: newer.id });
    expect(await forge.findIssueCommentByMarker(9, '<!-- none -->')).toBeNull();
  });

  test('findIssueCommentByMarker ignores system and other users’ notes', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 9, title: 'x' });
    gl.seedNote({ issueIid: 9, body: MARK, author: 'other' });
    gl.seedNote({ issueIid: 9, body: MARK, author: 'agent', system: true });
    expect(await forge.findIssueCommentByMarker(9, MARK)).toBeNull();
  });
});

describe('no-op and refusals', () => {
  test('listBlockedBy is empty and sends no request', async () => {
    const { gl, forge } = setup();
    expect(await forge.listBlockedBy(1)).toEqual({ blockers: [], unreadable: 0 });
    expect(gl.requests).toEqual([]);
  });

  test('addBlockedBy throws GitLabUnsupportedError and sends no request', async () => {
    const { gl, forge } = setup();
    const err = await forge.addBlockedBy(1, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabUnsupportedError);
    expect((err as Error).message).toContain('addBlockedBy');
    expect(gl.requests).toEqual([]);
  });

  test('a later-slice method throws GitLabUnsupportedError and sends no request', async () => {
    const { gl, forge } = setup();
    const err = await forge
      .merge(1, { sha: 'abc', method: 'squash', title: 't', message: 'm' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabUnsupportedError);
    expect((err as Error).message).toContain('merge');
    await expect(forge.getPull(1)).rejects.toBeInstanceOf(GitLabUnsupportedError);
    await expect(forge.repoAccess()).rejects.toBeInstanceOf(GitLabUnsupportedError);
    expect(gl.requests).toEqual([]);
  });
});

/** A fetch that runs `after` once the first request matching `when` has been answered. */
function hookedFetch(when: (method: string, url: URL) => boolean, after: () => void): typeof fetch {
  let fired = false;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (!fired && when(init?.method ?? 'GET', new URL(String(input)))) {
      fired = true;
      after();
    }
    return res;
  }) as typeof fetch;
}

const FILES = `${API}/repository/files/`;

describe('repository: branches', () => {
  test('branchSha returns the head of an existing branch and null for a missing one', async () => {
    const { gl, forge } = setup();
    const head = gl.seedCommit({ branch: 'trunk', files: { a: '1' }, message: 'a' });
    gl.seedBranch('feat/x y', head);
    expect(await forge.branchSha('trunk')).toBe(head);
    expect(await forge.branchSha('feat/x y')).toBe(head);
    expect(await forge.branchSha('nope')).toBeNull();
    expect(gl.requests.map((r) => r.path)).toEqual([
      `${API}/repository/branches/trunk`,
      `${API}/repository/branches/${encodeURIComponent('feat/x y')}`,
      `${API}/repository/branches/nope`,
    ]);
  });

  test('createBranch: new, idempotent on the same SHA, throws on another SHA', async () => {
    const { gl, forge } = setup();
    const one = gl.seedCommit({ branch: 'trunk', files: { a: '1' }, message: 'one' });
    const two = gl.seedCommit({ branch: 'trunk', files: { a: '2' }, message: 'two' });
    await forge.createBranch('agent/issue-1', one);
    expect(gl.branchSha('agent/issue-1')).toBe(one);
    expect(gl.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `${API}/repository/branches`,
      body: { branch: 'agent/issue-1', ref: one },
    });
    await forge.createBranch('agent/issue-1', one);
    expect(gl.branchSha('agent/issue-1')).toBe(one);
    expect(gl.commit(one)?.parent_ids).toHaveLength(1);
    expect(gl.branchSha('trunk')).toBe(two);
    await expect(forge.createBranch('agent/issue-1', two)).rejects.toThrow(
      /already exists on another commit/,
    );
    expect(gl.branchSha('agent/issue-1')).toBe(one);
  });
});

describe('repository: putFile', () => {
  test('creates a new file and returns the new head', async () => {
    const { gl, forge } = setup();
    const before = gl.branchSha('trunk') as string;
    const { commitSha } = await forge.putFile({
      branch: 'trunk',
      path: 'docs/new file.md',
      content: 'héllo\n',
      message: 'add',
      expectBlobSha: null,
    });
    expect(commitSha).toBe(gl.branchSha('trunk'));
    expect(gl.commit(commitSha)?.parent_ids).toEqual([before]);
    expect(gl.fileAt('trunk', 'docs/new file.md')).toBe('héllo\n');
    const post = gl.requests.find((r) => r.method === 'POST');
    expect(post).toMatchObject({
      path: `${FILES}${encodeURIComponent('docs/new file.md')}`,
      body: {
        branch: 'trunk',
        commit_message: 'add',
        encoding: 'base64',
        content: Buffer.from('héllo\n').toString('base64'),
      },
    });
  });

  test('updates with the right expectBlobSha; the SHA is the branch head', async () => {
    const { gl, forge } = setup();
    gl.seedCommit({ branch: 'trunk', files: { 'a.txt': 'old' }, message: 'seed' });
    const { commitSha } = await forge.putFile({
      branch: 'trunk',
      path: 'a.txt',
      content: 'new',
      message: 'edit',
      expectBlobSha: gitBlobSha('old'),
    });
    expect(commitSha).toBe(await forge.branchSha('trunk'));
    expect(gl.fileAt('trunk', 'a.txt')).toBe('new');
    const put = gl.requests.find((r) => r.method === 'PUT');
    expect((put?.body as { last_commit_id?: string }).last_commit_id).toMatch(/^[0-9a-f]{40}$/);
  });

  test('a wrong expectBlobSha is refused without a PUT', async () => {
    const { gl, forge } = setup();
    const head = gl.seedCommit({ branch: 'trunk', files: { 'a.txt': 'old' }, message: 'seed' });
    await expect(
      forge.putFile({
        branch: 'trunk',
        path: 'a.txt',
        content: 'new',
        message: 'edit',
        expectBlobSha: gitBlobSha('something else'),
      }),
    ).rejects.toThrow(/changed/);
    expect(gl.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(gl.branchSha('trunk')).toBe(head);
  });

  test('a file changed between the read and the write is refused by last_commit_id', async () => {
    let gl: FakeGitLab | undefined;
    const fetch = hookedFetch(
      (m, u) => m === 'GET' && u.pathname.startsWith(FILES),
      () => gl?.seedCommit({ branch: 'trunk', files: { 'a.txt': 'theirs' }, message: 'race' }),
    );
    const s = setup({ fetch });
    gl = s.gl;
    gl.seedCommit({ branch: 'trunk', files: { 'a.txt': 'old' }, message: 'seed' });
    const err = (await s.forge
      .putFile({
        branch: 'trunk',
        path: 'a.txt',
        content: 'mine',
        message: 'edit',
        expectBlobSha: gitBlobSha('old'),
      })
      .catch((e: unknown) => e)) as GitLabForgeError;
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect(err.status).toBe(400);
    expect(gl.fileAt('trunk', 'a.txt')).toBe('theirs');
  });

  test('a push between the write and the head read makes putFile throw', async () => {
    let gl: FakeGitLab | undefined;
    const fetch = hookedFetch(
      (m, u) => m === 'PUT' && u.pathname.startsWith(FILES),
      () => gl?.seedCommit({ branch: 'trunk', files: { 'a.txt': 'new', b: '1' }, message: 'push' }),
    );
    const s = setup({ fetch });
    gl = s.gl;
    gl.seedCommit({ branch: 'trunk', files: { 'a.txt': 'old' }, message: 'seed' });
    await expect(
      s.forge.putFile({
        branch: 'trunk',
        path: 'a.txt',
        content: 'new',
        message: 'edit',
        expectBlobSha: gitBlobSha('old'),
      }),
    ).rejects.toThrow(/another push/);
  });

  test('a push before a create also makes putFile throw', async () => {
    let gl: FakeGitLab | undefined;
    const fetch = hookedFetch(
      (m, u) => m === 'GET' && u.pathname.includes('/repository/branches/'),
      () => gl?.seedCommit({ branch: 'trunk', files: { b: '1' }, message: 'push' }),
    );
    const s = setup({ fetch });
    gl = s.gl;
    await expect(
      s.forge.putFile({
        branch: 'trunk',
        path: 'a.txt',
        content: 'new',
        message: 'add',
        expectBlobSha: null,
      }),
    ).rejects.toThrow(/another push/);
  });

  test('a missing branch or a missing file to update throws', async () => {
    const { forge } = setup();
    const o = { path: 'a.txt', content: 'x', message: 'm' };
    await expect(forge.putFile({ ...o, branch: 'nope', expectBlobSha: null })).rejects.toThrow(
      /branch/,
    );
    await expect(
      forge.putFile({ ...o, branch: 'trunk', expectBlobSha: gitBlobSha('x') }),
    ).rejects.toThrow(/changed/);
  });
});

describe('repository: getFileAt and listDir', () => {
  function seed(gl: FakeGitLab) {
    return gl.seedCommit({
      branch: 'trunk',
      files: {
        'README.md': 'readme\n',
        'src/a.ts': 'a',
        'src/lib/c.ts': 'c',
        'dir with space/#hash file.txt': 'odd ✓',
      },
      message: 'tree',
    });
  }

  test("getFileAt: a file's text at a ref, null for a missing file and a directory", async () => {
    const { gl, forge } = setup();
    const sha = seed(gl);
    gl.seedCommit({ branch: 'trunk', files: { 'README.md': 'later' }, message: 'later' });
    expect(await forge.getFileAt(sha, 'README.md')).toBe('readme\n');
    expect(await forge.getFileAt('trunk', 'README.md')).toBe('later');
    expect(await forge.getFileAt(sha, 'nope.md')).toBeNull();
    expect(await forge.getFileAt(sha, 'src')).toBeNull();
    expect(await forge.getFileAt(sha, 'dir with space/#hash file.txt')).toBe('odd ✓');
    expect(gl.requests.at(-1)).toMatchObject({
      path: `${FILES}${encodeURIComponent('dir with space/#hash file.txt')}`,
      query: { ref: sha },
    });
  });

  test('listDir: names at the root and in a subdirectory, null for a file and a missing path', async () => {
    const { gl, forge } = setup();
    const sha = seed(gl);
    expect(await forge.listDir(sha, '')).toEqual(['dir with space', 'src', 'README.md']);
    expect(await forge.listDir('trunk', 'src')).toEqual(['lib', 'a.ts']);
    expect(await forge.listDir(sha, 'dir with space')).toEqual(['#hash file.txt']);
    expect(await forge.listDir(sha, 'src/a.ts')).toBeNull();
    expect(await forge.listDir(sha, 'nope')).toBeNull();
    expect(await forge.listDir('no-such-ref', 'src')).toBeNull();
    expect(gl.requests[1]).toMatchObject({
      method: 'GET',
      path: `${API}/repository/tree`,
      query: { path: 'src', ref: 'trunk' },
    });
    expect(gl.requests[0]?.query).not.toHaveProperty('path');
  });

  test('listDir: a directory spanning two pages returns every entry', async () => {
    const { gl, forge } = setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i++) files[`big/f${String(i).padStart(3, '0')}`] = String(i);
    gl.seedCommit({ branch: 'trunk', files, message: 'big' });
    const names = await forge.listDir('trunk', 'big');
    expect(names).toHaveLength(150);
    expect(names?.[149]).toBe('f149');
    expect(gl.requests.map((r) => r.query.page)).toEqual(['1', '2']);
  });
});

/** trunk: r - m1 - m2 - M(m2, s2) - h ; side: m1 - s1 - s2 ; feature: m1 - f1 - f2 */
function history(gl: FakeGitLab) {
  const r = gl.seedCommit({ branch: 'trunk', files: { a: '0' }, message: 'r' });
  const m1 = gl.seedCommit({ branch: 'trunk', files: { a: '1' }, message: 'm1' });
  gl.seedBranch('feature', m1);
  const f1 = gl.seedCommit({ branch: 'feature', files: { a: '1', f: '1' }, message: 'f1' });
  const f2 = gl.seedCommit({ branch: 'feature', files: { a: '1', f: '2' }, message: 'f2' });
  const m2 = gl.seedCommit({ branch: 'trunk', files: { a: '2' }, message: 'm2' });
  const s1 = gl.seedCommit({ parent: m1, files: { a: '1', s: '1' }, message: 's1' });
  const s2 = gl.seedCommit({ parent: s1, files: { a: '1', s: '2' }, message: 's2' });
  const merge = gl.seedCommit({
    branch: 'trunk',
    parents: [m2, s2],
    files: { a: '2', s: '2' },
    message: 'Merge side',
  });
  const h = gl.seedCommit({ branch: 'trunk', files: { a: '3', s: '2' }, message: 'h' });
  return { r, m1, f1, f2, m2, s1, s2, merge, h };
}

describe('repository: compare and firstParentCommits', () => {
  test('compare: a branch ahead 2 and behind 1 of the base', async () => {
    const { gl, forge } = setup();
    const r = gl.seedCommit({ branch: 'trunk', files: { a: '0' }, message: 'r' });
    gl.seedBranch('feature', r);
    gl.seedCommit({ branch: 'feature', files: { a: '0', f: '1' }, message: 'f1' });
    gl.seedCommit({ branch: 'feature', files: { a: '0', f: '2' }, message: 'f2' });
    const main = gl.seedCommit({ branch: 'trunk', files: { a: '1' }, message: 'm' });
    expect(await forge.compare('trunk', 'feature')).toEqual({
      aheadBy: 2,
      behindBy: 1,
      baseSha: main,
      mergeBaseSha: r,
    });
    expect(await forge.compare(main, 'trunk')).toEqual({
      aheadBy: 0,
      behindBy: 0,
      baseSha: main,
      mergeBaseSha: main,
    });
  });

  test('compare on a history with a merge', async () => {
    const { gl, forge } = setup();
    const c = history(gl);
    expect(await forge.compare('feature', 'trunk')).toEqual({
      aheadBy: 5,
      behindBy: 2,
      baseSha: c.f2,
      mergeBaseSha: c.m1,
    });
  });

  test("firstParentCommits: oldest first, skipping a merge's second parent, cut at max", async () => {
    const { gl, forge } = setup();
    const c = history(gl);
    const all = await forge.firstParentCommits(c.m1, c.h, 10);
    expect(all).toEqual({
      commits: [
        { sha: c.m2, message: 'm2' },
        { sha: c.merge, message: 'Merge side' },
        { sha: c.h, message: 'h' },
      ],
      complete: true,
    });
    expect(await forge.firstParentCommits(c.m1, c.h, 2)).toEqual({
      commits: all.commits.slice(0, 2),
      complete: true,
    });
    expect(await forge.firstParentCommits(c.s1, c.h, 10)).toEqual({ commits: [], complete: false });
  });

  test('firstParentCommits: base equal to head, an unknown base, and a non-ancestor base', async () => {
    const { gl, forge } = setup();
    const c = history(gl);
    const before = gl.requests.length;
    expect(await forge.firstParentCommits(c.h, c.h, 10)).toEqual({ commits: [], complete: true });
    expect(gl.requests.length).toBe(before);
    expect(await forge.firstParentCommits('0'.repeat(40), c.h, 10)).toEqual({
      commits: [],
      complete: false,
    });
    expect(await forge.firstParentCommits(c.f2, c.h, 10)).toEqual({
      commits: [],
      complete: false,
    });
  });
});

describe('repository: secrets', () => {
  test('no recorded request carries the token, and a thrown error does not either', async () => {
    const { gl, forge } = setup();
    const c = history(gl);
    await forge.branchSha('trunk');
    await forge.createBranch('agent/x', c.h);
    await forge.putFile({
      branch: 'agent/x',
      path: 'n.txt',
      content: 'n',
      message: 'n',
      expectBlobSha: null,
    });
    await forge.getFileAt('trunk', 'a');
    await forge.listDir('trunk', '');
    await forge.compare('feature', 'trunk');
    await forge.firstParentCommits(c.m1, c.h, 5);
    for (const r of gl.requests) {
      expect(r.path).not.toContain(AGENT);
      expect(JSON.stringify(r.query)).not.toContain(AGENT);
    }
    const errors = await Promise.all([
      forge.createBranch('agent/x', c.m1).catch((e: unknown) => e),
      new GitLabForge(GITLAB, PROJECT.path, WRONG).branchSha('trunk').catch((e: unknown) => e),
      new GitLabForge(GITLAB, PROJECT.path, WRONG).compare('a', 'b').catch((e: unknown) => e),
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(GitLabForgeError);
      expect((e as Error).message).not.toContain(AGENT);
      expect((e as Error).message).not.toContain(WRONG);
    }
  });
});

describe('secrets', () => {
  test('a 401 throws without the token', async () => {
    const { gl } = setup();
    const forge = new GitLabForge(GITLAB, PROJECT.path, WRONG);
    const err = (await forge.getDefaultBranch().catch((e: unknown) => e)) as Error & {
      status?: number;
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(WRONG);
    expect(JSON.stringify(err)).not.toContain(WRONG);
    expect(String(err.stack)).not.toContain(WRONG);
    expect(gl.requests[0]?.user).toBe('<unknown>');
  });

  test('a redirect is not followed, and the error names neither the token nor Location', async () => {
    const LOCATION = 'https://evil.example.net/steal?x=1';
    const calls: { url: string; init: RequestInit }[] = [];
    const stub = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response('', { status: 302, headers: { location: LOCATION } });
    }) as typeof fetch;
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, { fetch: stub });
    const err = (await forge.getDefaultBranch().catch((e: unknown) => e)) as Error & {
      status?: number;
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.url).toBe(`${GITLAB}/api/v4/projects/${ENCODED}`);
    for (const s of [AGENT, LOCATION, 'evil.example.net', 'PRIVATE-TOKEN', 'private-token']) {
      expect(err.message).not.toContain(s);
      expect(String(err.stack)).not.toContain(s);
    }
  });

  test('a network failure does not echo the cause', async () => {
    const stub = (async () => {
      throw new Error(`boom ${AGENT}`);
    }) as typeof fetch;
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, { fetch: stub });
    const err = (await forge.viewerLogin().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(AGENT);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  test('a TokenProvider is asked before every request, and its token is used', async () => {
    const { gl } = setup();
    gl.seedIssue({ iid: 1, title: 'x' });
    const provider = { token: vi.fn(async () => AGENT), invalidate: vi.fn() };
    const forge = new GitLabForge(GITLAB, PROJECT.path, provider);
    await forge.getDefaultBranch();
    await forge.getIssue(1);
    await forge.viewerLogin();
    expect(provider.token).toHaveBeenCalledTimes(3);
    expect(gl.requests.map((r) => r.user)).toEqual(['agent', 'agent', 'agent']);
    expect(provider.invalidate).not.toHaveBeenCalled();
  });

  test('a TokenProvider is invalidated once on a 401', async () => {
    const { gl } = setup();
    const provider: TokenProvider & { invalidate: ReturnType<typeof vi.fn> } = {
      token: vi.fn(async () => WRONG),
      invalidate: vi.fn(),
    };
    const forge = new GitLabForge(GITLAB, PROJECT.path, provider);
    await expect(forge.getDefaultBranch()).rejects.toMatchObject({ status: 401 });
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(gl.requests).toHaveLength(1);
  });

  test('a provider that throws is reported without its message', async () => {
    const provider = {
      token: async () => {
        throw new Error(`no ${AGENT}`);
      },
    };
    const forge = new GitLabForge(GITLAB, PROJECT.path, provider);
    const err = (await forge.getDefaultBranch().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(AGENT);
  });
});

describe('edges, through an injected fetch', () => {
  type Reply = { status?: number; body?: string; headers?: Record<string, string> };
  const stubbed = (replies: Reply[] | ((url: string) => Reply), opts = {}) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stub = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const r = typeof replies === 'function' ? replies(String(url)) : replies.shift();
      if (!r) throw new Error('no more replies');
      return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers });
    }) as typeof fetch;
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, { fetch: stub, ...opts });
    return { forge, calls };
  };
  const issue = (n: number) => ({
    iid: n,
    title: `t${n}`,
    description: '',
    state: 'opened',
    created_at: '2026-01-01T00:00:00Z',
  });

  test('requestTimeoutMs passes an abort signal; without it there is none', async () => {
    const reply = () => ({ body: JSON.stringify({ default_branch: 'main' }) });
    const timed = stubbed(reply, { requestTimeoutMs: 5000 });
    await timed.forge.getDefaultBranch();
    expect(timed.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    const untimed = stubbed(reply);
    await untimed.forge.getDefaultBranch();
    expect(untimed.calls[0]?.init.signal).toBeUndefined();
  });

  test('a request that outlives requestTimeoutMs fails without the token', async () => {
    const stub = ((_url: string | URL | Request, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, {
      fetch: stub,
      requestTimeoutMs: 10,
    });
    const err = (await forge.getDefaultBranch().catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/network error/);
    expect(err.message).not.toContain(AGENT);
  });

  test('a response that is not JSON is an error', async () => {
    const { forge } = stubbed([{ body: '<html>' }]);
    await expect(forge.getDefaultBranch()).rejects.toThrow(/not JSON/);
  });

  test('a list response that is not an array is an error', async () => {
    const { forge } = stubbed([{ body: '{}' }]);
    await expect(forge.listLabels()).rejects.toThrow(/not a list/);
  });

  test('a non-numeric or non-increasing x-next-page ends the list', async () => {
    for (const next of ['abc', '1', '-2']) {
      const { forge, calls } = stubbed([
        { body: JSON.stringify([issue(1)]), headers: { 'x-next-page': next } },
      ]);
      expect(await forge.listOpenIssues()).toHaveLength(1);
      expect(calls).toHaveLength(1);
    }
  });

  test('a list that never ends stops at the page cap', async () => {
    const { forge, calls } = stubbed((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return { body: '[]', headers: { 'x-next-page': String(page + 1) } };
    });
    await expect(forge.listLabels()).rejects.toThrow(/more than 1000 pages/);
    expect(calls).toHaveLength(1000);
  });

  test('a project with no default branch is an error', async () => {
    const { forge } = stubbed([{ body: '{}' }, { body: JSON.stringify({ default_branch: '' }) }]);
    await expect(forge.getDefaultBranch()).rejects.toThrow(/no default branch/);
    await expect(forge.getDefaultBranch()).rejects.toThrow(/no default branch/);
  });

  test('a user with no username is an error, and a failed viewerLogin is not cached', async () => {
    const { forge, calls } = stubbed([
      { body: '{}' },
      { status: 500 },
      { body: JSON.stringify({ username: 'agent' }) },
    ]);
    await expect(forge.viewerLogin()).rejects.toThrow(/no username/);
    await expect(forge.viewerLogin()).rejects.toThrow(/HTTP 500/);
    expect(await forge.viewerLogin()).toBe('agent');
    expect(await forge.viewerLogin()).toBe('agent');
    expect(calls).toHaveLength(3);
  });

  test('an issue number that is not a positive integer is refused with no request', async () => {
    const { forge, calls } = stubbed([]);
    for (const n of [0, -1, 1.5, Number.NaN])
      await expect(forge.getIssue(n)).rejects.toThrow(/positive integer/);
    expect(calls).toEqual([]);
  });

  test('the newest note wins by created_at, then by the higher id', async () => {
    const note = (id: number, created_at: string) => ({
      id,
      body: 'x <!-- m -->',
      system: false,
      author: { username: 'agent' },
      created_at,
    });
    const user = { body: JSON.stringify({ username: 'agent' }) };
    const byTime = stubbed([
      user,
      {
        body: JSON.stringify([note(9, '2026-01-01T00:00:00Z'), note(2, '2026-02-01T00:00:00Z')]),
      },
    ]);
    expect(await byTime.forge.findIssueCommentByMarker(1, '<!-- m -->')).toEqual({ id: 2 });
    const byId = stubbed([
      user,
      {
        body: JSON.stringify([note(2, '2026-01-01T00:00:00Z'), note(9, '2026-01-01T00:00:00Z')]),
      },
    ]);
    expect(await byId.forge.findIssueCommentByMarker(1, '<!-- m -->')).toEqual({ id: 9 });
  });
});

describe('constructor', () => {
  const refused = (base: string, path: string, secret: string) => {
    let err: unknown;
    try {
      new GitLabForge(base, path, AGENT);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(secret);
    expect((err as Error).message).not.toContain(AGENT);
  };

  test('refuses a base URL that is not an https origin', () => {
    refused('http://gitlab.insecure.example', PROJECT.path, 'gitlab.insecure.example');
    refused('https://gitlab.example.com/sub', PROJECT.path, 'gitlab.example.com');
    refused('https://user:pw@gitlab.example.com', PROJECT.path, 'gitlab.example.com');
  });

  test('refuses a malformed project path', () => {
    refused(GITLAB, 'justone', 'justone');
    refused(GITLAB, 'group//project', 'group//project');
    refused(GITLAB, 'group/../etc', 'group/../etc');
    refused(GITLAB, '/group/project', '/group/project');
    refused(GITLAB, 'group/pro ject', 'pro ject');
  });

  test('refuses a token passed as the path', () => {
    refused(GITLAB, OTHER, OTHER);
    refused(GITLAB, `group/${OTHER}`, OTHER);
  });

  test('refuses the path shapes the zone config refuses', () => {
    refused(GITLAB, 'group/project.git', 'project.git');
    refused(GITLAB, 'group/project.atom', 'project.atom');
    refused(GITLAB, '_acme/app', '_acme');
    refused(GITLAB, 'acme/app-', 'app-');
  });

  test('accepts a path whose segment merely starts like a token prefix', () => {
    expect(() => new GitLabForge(GITLAB, 'global-infra/app', AGENT)).not.toThrow();
    expect(() => new GitLabForge(GITLAB, 'acme/glue-service', AGENT)).not.toThrow();
    expect(() => new GitLabForge(GITLAB, 'glue-team/svc', AGENT)).not.toThrow();
    expect(() => new GitLabForge(GITLAB, 'acme/glass-ui', AGENT)).not.toThrow();
  });

  test('accepts a trailing slash on the base URL', async () => {
    const { gl } = setup();
    const forge = new GitLabForge(`${GITLAB}/`, PROJECT.path, AGENT);
    expect(await forge.getDefaultBranch()).toBe('trunk');
    expect(gl.requests[0]?.path).toBe(API);
  });
});
