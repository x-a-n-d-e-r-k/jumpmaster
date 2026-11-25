import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { verifyCited } from '../crew/trail.js';
import { branchProtectionProblems } from '../flow/guards.js';
import { ACCESS, type FakeGitLab, fakeGitLab, type GitLabJobStatus } from '../test/fake-gitlab.js';
import { makeZone } from '../test/fixtures.js';
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
    expect(closed).toEqual({
      body: '',
      state: 'closed',
      stateReason: 'completed',
      labels: [],
      author: 'agent',
    });
    expect(closed).not.toHaveProperty('pullRequest');
    expect(await forge.getIssue(99)).toBeNull();
  });

  test('getIssue: a closed issue reads as completed, an open or moved one has no stateReason', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 1, title: 'open' });
    gl.seedIssue({ iid: 2, title: 'closed', state: 'closed' });
    gl.seedIssue({ iid: 3, title: 'moved', state: 'closed', movedToId: 4242 });
    expect(gl.issue(2)?.moved_to_id).toBeNull();
    expect(gl.issue(3)?.moved_to_id).toBe(4242);
    expect(await forge.getIssue(1)).not.toHaveProperty('stateReason');
    expect(await forge.getIssue(2)).toMatchObject({ state: 'closed', stateReason: 'completed' });
    const moved = await forge.getIssue(3);
    expect(moved).toMatchObject({ state: 'closed' });
    expect(moved).not.toHaveProperty('stateReason');
  });

  test('verifyCited with a GitLabForge pair: a cited closed issue is evidence, open and moved ones are not', async () => {
    const { gl, forge } = setup();
    gl.seedIssue({ iid: 1, title: 'this one' });
    gl.seedIssue({ iid: 2, title: 'done', state: 'closed' });
    gl.seedIssue({ iid: 3, title: 'open' });
    gl.seedIssue({ iid: 4, title: 'moved', state: 'closed', movedToId: 9001 });
    const pair = { author: forge, reviewer: null };
    expect(await verifyCited(pair, 1, { pulls: [], issues: [2] })).toEqual({ ok: true });
    expect(await verifyCited(pair, 1, { pulls: [], issues: [3] })).toEqual({
      ok: false,
      why: '#3 is not closed',
    });
    expect(await verifyCited(pair, 1, { pulls: [], issues: [4] })).toEqual({
      ok: false,
      why: '#4 was not closed as completed',
    });
    expect(await verifyCited(pair, 1, { pulls: [], issues: [99] })).toEqual({
      ok: false,
      why: '#99 not found',
    });
    expect(await verifyCited(pair, 1, { pulls: [], issues: [1] })).toEqual({
      ok: false,
      why: '#1 is this issue',
    });
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

  test('findIssueByMarker finds this viewer’s issue updated exactly at since', async () => {
    const { gl, forge } = setup();
    const since = '2024-01-01T00:00:00.000Z';
    gl.seedIssue({
      iid: 1,
      title: 'before',
      description: `x\n${MARK}`,
      author: 'agent',
      createdAt: '2023-12-31T23:59:59.999Z',
      updatedAt: '2023-12-31T23:59:59.999Z',
    });
    expect(await forge.findIssueByMarker(MARK, since)).toBeNull();
    gl.seedIssue({
      iid: 2,
      title: 'boundary',
      description: `x\n${MARK}`,
      author: 'agent',
      createdAt: since,
      updatedAt: since,
    });
    expect(await forge.findIssueByMarker(MARK, since)).toEqual({ number: 2 });
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
    const err = await forge.probeAdministration().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabUnsupportedError);
    expect((err as Error).message).toContain('probeAdministration');
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

  test('a pipeline id that is not a positive integer is refused before its jobs are read', async () => {
    const { forge, calls } = stubbed((url) =>
      new URL(url).pathname.endsWith('/pipelines')
        ? { body: JSON.stringify([{ id: '1/../2', sha: 'abc', status: 'failed' }]) }
        : { body: '[]' },
    );
    await expect(forge.checksFor('abc')).rejects.toThrow(/not a positive integer/);
    expect(calls.some((c) => c.url.includes('/jobs'))).toBe(false);
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

const MRS = `${API}/merge_requests`;
const MR_URL = (n: number) => `${GITLAB}/${PROJECT.path}/-/merge_requests/${n}`;

/**
 * trunk: base {a, gone, old}. agent/one: base → a modified, b added, gone deleted, old renamed.
 * release: base. agent/two: base → a modified, b added (no rename).
 */
function mrRepo(gl: FakeGitLab) {
  const base = gl.seedCommit({
    branch: 'trunk',
    files: { a: '1\n', gone: 'x\n', old: 'same\n' },
    message: 'base',
  });
  gl.seedBranch('agent/one', base);
  const head = gl.seedCommit({
    branch: 'agent/one',
    files: { a: '2\n', b: 'new\n', renamed: 'same\n' },
    message: 'work',
  });
  gl.seedBranch('release', base);
  gl.seedBranch('agent/two', base);
  const two = gl.seedCommit({
    branch: 'agent/two',
    files: { a: '2\n', b: 'new\n', gone: 'x\n', old: 'same\n' },
    message: 'two',
  });
  return { base, head, two };
}

/** Mark stored MR `iid` as coming from a fork. */
function fork(gl: FakeGitLab, iid: number) {
  const mr = gl.mergeRequest(iid);
  if (!mr) throw new Error(`no MR ${iid}`);
  mr.source_project_id = 999;
}

/** A forge whose every request gets `reply`'s JSON; the calls are recorded. */
function jsonForge(reply: (url: URL, method: string) => { status?: number; body: unknown }) {
  const calls: { url: URL; method: string }[] = [];
  const stub = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    const r = reply(url, method);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { forge: new GitLabForge(GITLAB, PROJECT.path, AGENT, { fetch: stub }), calls };
}

const NEW = { title: 'Agent work', body: 'Closes #1' };

describe('merge requests: findOrCreatePullRequest', () => {
  test('creates an MR, then reuses it whatever the target, with no second POST', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    const made = await forge.findOrCreatePullRequest({ head: 'agent/one', base: 'trunk', ...NEW });
    expect(made).toEqual({ number: 1, url: MR_URL(1), created: true });
    expect(gl.mergeRequest(1)).toMatchObject({
      source_branch: 'agent/one',
      target_branch: 'trunk',
      title: 'Agent work',
      description: 'Closes #1',
      author: { username: 'agent' },
    });
    expect(gl.requests[0]).toMatchObject({
      method: 'GET',
      path: MRS,
      query: { state: 'opened', source_branch: 'agent/one' },
    });

    gl.requests.length = 0;
    const again = await forge.findOrCreatePullRequest({ head: 'agent/one', base: 'trunk', ...NEW });
    expect(again).toEqual({ number: 1, url: MR_URL(1), created: false });
    const other = await forge.findOrCreatePullRequest({
      head: 'agent/one',
      base: 'release',
      ...NEW,
    });
    expect(other).toEqual({ number: 1, url: MR_URL(1), created: false });
    expect(gl.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(gl.mergeRequests).toHaveLength(1);
  });

  test('a 409 race returns the MR that appeared, with no second POST', async () => {
    let gl: FakeGitLab | undefined;
    const fetch = hookedFetch(
      (m, u) => m === 'GET' && u.pathname === MRS,
      () =>
        gl?.seedMergeRequest({
          sourceBranch: 'agent/one',
          targetBranch: 'trunk',
          title: 'raced',
          author: 'other',
        }),
    );
    const s = setup({ fetch });
    gl = s.gl;
    mrRepo(gl);
    const got = await s.forge.findOrCreatePullRequest({
      head: 'agent/one',
      base: 'trunk',
      ...NEW,
    });
    expect(got).toEqual({ number: 1, url: MR_URL(1), created: false });
    expect(gl.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(
      gl.mergeRequests.filter((m) => m.state === 'opened' && m.source_branch === 'agent/one'),
    ).toHaveLength(1);
  });

  test('a 409 whose re-read finds nothing throws a GitLabForgeError', async () => {
    const { forge, calls } = jsonForge((_u, m) =>
      m === 'POST' ? { status: 409, body: { message: ['exists'] } } : { body: [] },
    );
    const err = (await forge
      .findOrCreatePullRequest({ head: 'agent/one', base: 'trunk', ...NEW })
      .catch((e: unknown) => e)) as GitLabForgeError;
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect(err.status).toBe(409);
    expect(err.message).not.toContain(AGENT);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
  });

  test('a fork MR for the branch is not reused: a new same-project MR is created', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'release', title: 'fork' });
    fork(gl, 1);
    const made = await forge.findOrCreatePullRequest({ head: 'agent/one', base: 'trunk', ...NEW });
    expect(made).toEqual({ number: 2, url: MR_URL(2), created: true });
  });

  test('branch names go URL-encoded in the query, never in the path', async () => {
    const { forge, calls } = jsonForge(() => ({ body: [] }));
    await forge.findOpenPullByHead('agent/a b&c=d');
    const url = calls[0]?.url;
    expect(url?.pathname).toBe(MRS);
    expect(url?.search).toContain('source_branch=agent%2Fa+b%26c%3Dd');
    expect(url?.searchParams.get('source_branch')).toBe('agent/a b&c=d');
  });
});

describe('merge requests: getPull', () => {
  test('open, closed and merged MRs map to PullFacts', async () => {
    const { gl, forge } = setup();
    const { head, two } = mrRepo(gl);
    gl.seedMergeRequest({
      sourceBranch: 'agent/one',
      targetBranch: 'trunk',
      title: 'One',
      description: null,
      labels: ['jm:hold', 'agent'],
      author: 'other',
    });
    gl.seedMergeRequest({
      sourceBranch: 'agent/two',
      targetBranch: 'release',
      title: 'Two',
      description: 'body two',
    });
    gl.seedMergeRequest({ sourceBranch: 'agent/two', targetBranch: 'trunk', title: 'Three' });
    gl.closeMergeRequest(2);
    gl.markMergeRequestMerged(3);

    expect(await forge.getPull(1)).toEqual({
      number: 1,
      title: 'One',
      state: 'open',
      merged: false,
      headSha: head,
      headRef: 'agent/one',
      headRepo: PROJECT.path,
      baseRef: 'trunk',
      author: 'other',
      body: '',
      labels: ['agent', 'jm:hold'],
    });
    expect(await forge.getPull(2)).toMatchObject({
      number: 2,
      title: 'Two',
      state: 'closed',
      merged: false,
      headSha: two,
      baseRef: 'release',
      body: 'body two',
      author: 'root',
    });
    expect(await forge.getPull(3)).toMatchObject({ state: 'closed', merged: true });
    expect(await forge.getPull(99)).toBeNull();
    expect(gl.requests.map((r) => r.path)).toEqual([1, 2, 3, 99].map((n) => `${MRS}/${n}`));
  });

  test('a locked MR (merge in progress) is open and unmerged, with its refs and head', async () => {
    const { gl, forge } = setup();
    const { head } = mrRepo(gl);
    gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'trunk', title: 'One' });
    gl.lockMergeRequest(1);
    expect(await forge.getPull(1)).toMatchObject({
      number: 1,
      state: 'open',
      merged: false,
      headSha: head,
      headRef: 'agent/one',
      baseRef: 'trunk',
    });
  });

  test('an MR state the adapter does not know is refused, not read as closed', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'trunk', title: 'One' });
    (gl.mergeRequest(1) as unknown as { state: string }).state = 'reopened-ish';
    const err = await forge.getPull(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect((err as Error).message).toContain('unknown merge request state');
  });

  test('a fork MR is returned with headRepo null; a missing sha gives headSha null', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'trunk', title: 'f' });
    fork(gl, 1);
    expect(await forge.getPull(1)).toMatchObject({ number: 1, headRepo: null });
    gl.closeMergeRequest(1);
    (gl.mergeRequest(1) as unknown as { sha: string | null }).sha = null;
    expect(await forge.getPull(1)).toMatchObject({ headSha: null });
  });

  test('a number that is not a positive integer is refused unsent, without "issue"', async () => {
    const { gl, forge } = setup();
    for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const p of [forge.getPull(n), forge.listPullFiles(n)]) {
        const err = (await p.catch((e: unknown) => e)) as Error;
        expect(err).toBeInstanceOf(GitLabForgeError);
        expect(err.message).toContain('merge request');
        expect(err.message).not.toMatch(/issue/i);
      }
    }
    expect(gl.requests).toEqual([]);
  });

  test('an error other than 404 is a GitLabForgeError with the status and no token', async () => {
    const { forge } = jsonForge(() => ({ status: 500, body: { message: 'boom' } }));
    const err = (await forge.getPull(1).catch((e: unknown) => e)) as GitLabForgeError;
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain(AGENT);
    expect(JSON.stringify(err)).not.toContain(AGENT);
  });
});

describe('merge requests: findOpenPullByHead and listOpenAgentPulls', () => {
  test('findOpenPullByHead: the open MR, and null for closed, none, or a fork', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'trunk', title: 'open' });
    gl.seedMergeRequest({ sourceBranch: 'agent/two', targetBranch: 'trunk', title: 'shut' });
    gl.closeMergeRequest(2);
    gl.seedBranch('agent/fork', gl.branchSha('agent/two') as string);
    gl.seedMergeRequest({ sourceBranch: 'agent/fork', targetBranch: 'trunk', title: 'fork' });
    fork(gl, 3);

    expect(await forge.findOpenPullByHead('agent/one')).toMatchObject({
      number: 1,
      state: 'open',
      headRef: 'agent/one',
      headRepo: PROJECT.path,
    });
    expect(await forge.findOpenPullByHead('agent/two')).toBeNull();
    expect(await forge.findOpenPullByHead('agent/none')).toBeNull();
    expect(await forge.findOpenPullByHead('agent/fork')).toBeNull();
    expect(gl.requests[0]?.query).toMatchObject({ state: 'opened', source_branch: 'agent/one' });
  });

  test('listOpenAgentPulls filters by prefix across pages and leaves out forks', async () => {
    const { gl, forge } = setup();
    const { base } = mrRepo(gl);
    for (let i = 0; i < 110; i++) {
      gl.seedBranch(`agent/n${i}`, gl.branchSha('agent/two') as string);
      gl.seedMergeRequest({ sourceBranch: `agent/n${i}`, targetBranch: 'trunk', title: `n${i}` });
    }
    for (let i = 0; i < 5; i++) {
      gl.seedBranch(`human/h${i}`, gl.branchSha('agent/two') as string);
      gl.seedMergeRequest({ sourceBranch: `human/h${i}`, targetBranch: 'trunk', title: `h${i}` });
    }
    gl.seedBranch('agent/forked', base);
    gl.seedCommit({ branch: 'agent/forked', files: { z: '1' }, message: 'z' });
    const forked = gl.seedMergeRequest({
      sourceBranch: 'agent/forked',
      targetBranch: 'trunk',
      title: 'fork',
    });
    fork(gl, forked.iid);
    const shut = gl.seedMergeRequest({
      sourceBranch: 'agent/one',
      targetBranch: 'trunk',
      title: 'shut',
    });
    gl.closeMergeRequest(shut.iid);

    const pulls = await forge.listOpenAgentPulls('agent/');
    expect(pulls).toHaveLength(110);
    expect(pulls.every((p) => p.headRef.startsWith('agent/n') && p.state === 'open')).toBe(true);
    expect(pulls.every((p) => p.headRepo === PROJECT.path)).toBe(true);
    const pages = gl.requests.filter((r) => r.path === MRS);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.query).toMatchObject({ state: 'opened', per_page: '100', page: '1' });
    expect(pages[1]?.query).toMatchObject({ page: '2' });
  });
});

describe('merge requests: listPullFiles', () => {
  test('maps added, modified, deleted and renamed files, complete when changes_count agrees', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'trunk', title: 'one' });
    expect(await forge.listPullFiles(1)).toEqual({
      files: [
        { path: 'a' },
        { path: 'b' },
        { path: 'gone' },
        { path: 'renamed', previousPath: 'old' },
      ],
      complete: true,
    });
    expect(gl.requests.map((r) => r.path).sort()).toEqual([`${MRS}/1`, `${MRS}/1/diffs`]);
  });

  test('pages more than 100 files', async () => {
    const { gl, forge } = setup();
    const base = gl.seedCommit({ branch: 'trunk', files: { a: '1' }, message: 'base' });
    gl.seedBranch('agent/big', base);
    const files: Record<string, string> = { a: '1' };
    for (let i = 0; i < 150; i++) files[`f${String(i).padStart(3, '0')}`] = `${i}\n`;
    gl.seedCommit({ branch: 'agent/big', files, message: 'big' });
    gl.seedMergeRequest({ sourceBranch: 'agent/big', targetBranch: 'trunk', title: 'big' });
    const got = await forge.listPullFiles(1);
    expect(got.files).toHaveLength(150);
    expect(got.complete).toBe(true);
    expect(gl.requests.filter((r) => r.path === `${MRS}/1/diffs`)).toHaveLength(2);
  });

  test('an overflowing, mismatched, missing or odd changes_count is incomplete', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    const mr = gl.seedMergeRequest({
      sourceBranch: 'agent/one',
      targetBranch: 'trunk',
      title: 'one',
    });
    for (const count of ['1000+', '4+', '3', '5', '', ' 4', '4.0', '0x4', null]) {
      mr.changes_count = count;
      const got = await forge.listPullFiles(1);
      expect(got.files).toHaveLength(4);
      expect(got.complete, `changes_count ${String(count)}`).toBe(false);
    }
    mr.changes_count = '4';
    expect((await forge.listPullFiles(1)).complete).toBe(true);
  });

  test('3000 or more files is incomplete even when changes_count agrees', async () => {
    // One long page (no x-next-page), so the count is whatever the stub lists.
    const forgeFor = (n: number) =>
      jsonForge((u) =>
        u.pathname.endsWith('/diffs')
          ? {
              body: Array.from({ length: n }, (_, i) => ({
                old_path: `f${i}`,
                new_path: `f${i}`,
              })),
            }
          : { body: { iid: 1, changes_count: String(n) } },
      ).forge;
    expect((await forgeFor(2999).listPullFiles(1)).complete).toBe(true);
    expect((await forgeFor(3000).listPullFiles(1)).complete).toBe(false);
  });

  test('a missing MR is a GitLabForgeError with status 404', async () => {
    const { forge } = setup();
    const err = (await forge.listPullFiles(42).catch((e: unknown) => e)) as GitLabForgeError;
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect(err.status).toBe(404);
  });
});

describe('merge requests: changeDigest', () => {
  test('stable for the same change, different when a patch changes, merge-base compare', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    const one = await forge.changeDigest('trunk', 'agent/two');
    expect(one.complete).toBe(true);
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/);
    // trunk moving on (a file agent/two doesn't touch) leaves the change from the merge base alone.
    gl.seedCommit({
      branch: 'trunk',
      files: { a: '1\n', gone: 'x\n', old: 'same\n', t: 'trunk\n' },
      message: 'trunk moves',
    });
    expect(await forge.changeDigest('trunk', 'agent/two')).toEqual(one);
    gl.seedCommit({
      branch: 'agent/two',
      files: { a: '3\n', b: 'new\n', gone: 'x\n', old: 'same\n' },
      message: 'edit',
    });
    const edited = await forge.changeDigest('trunk', 'agent/two');
    expect(edited.complete).toBe(true);
    expect(edited.digest).not.toBe(one.digest);
    const compares = gl.requests.filter((r) => r.path === `${API}/repository/compare`);
    expect(compares[0]?.query).toEqual({ from: 'trunk', to: 'agent/two' });
  });

  test('a pure rename (an empty diff) is incomplete', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    expect(await forge.changeDigest('trunk', 'agent/one')).toEqual({ digest: '', complete: false });
  });

  const diff = (o: Record<string, unknown> = {}) => ({
    old_path: 'a',
    new_path: 'a',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: '@@ -1 +1 @@\n-1\n+2\n',
    ...o,
  });
  const digestOf = async (diffs: unknown[], extra: Record<string, unknown> = {}) => {
    const { forge, calls } = jsonForge(() => ({
      body: { commits: [], diffs, compare_timeout: false, ...extra },
    }));
    const got = await forge.changeDigest('trunk', 'agent/x');
    expect(calls.map((c) => c.url.pathname)).toEqual([`${API}/repository/compare`]);
    expect(calls[0]?.url.searchParams.has('straight')).toBe(false);
    return got;
  };

  test('path, status, previous path and patch each change the digest', async () => {
    const plain = await digestOf([diff(), diff({ old_path: 'b', new_path: 'b' })]);
    expect(plain.complete).toBe(true);
    expect(await digestOf([diff({ old_path: 'b', new_path: 'b' }), diff()])).toEqual(plain);
    const variants = [
      [diff({ old_path: 'c', new_path: 'c' }), diff({ old_path: 'b', new_path: 'b' })],
      [diff({ new_file: true }), diff({ old_path: 'b', new_path: 'b' })],
      [diff({ deleted_file: true }), diff({ old_path: 'b', new_path: 'b' })],
      [diff({ renamed_file: true, old_path: 'z' }), diff({ old_path: 'b', new_path: 'b' })],
      [diff({ diff: '@@ -1 +1 @@\n-1\n+3\n' }), diff({ old_path: 'b', new_path: 'b' })],
    ];
    const digests = new Set([plain.digest]);
    for (const v of variants) {
      const d = await digestOf(v);
      expect(d.complete).toBe(true);
      digests.add(d.digest);
    }
    expect(digests.size).toBe(variants.length + 1);
  });

  test('a timed-out compare, or an empty, too_large or collapsed diff, is incomplete', async () => {
    const incomplete = { digest: '', complete: false };
    expect(await digestOf([diff()], { compare_timeout: true })).toEqual(incomplete);
    expect(await digestOf([diff(), diff({ new_path: 'b', diff: '' })])).toEqual(incomplete);
    expect(await digestOf([diff({ diff: null })])).toEqual(incomplete);
    expect(await digestOf([diff({ too_large: true })])).toEqual(incomplete);
    expect(await digestOf([diff({ collapsed: true })])).toEqual(incomplete);
    expect(await digestOf([diff()], { diffs: undefined })).toEqual(incomplete);
  });
});

describe('merge requests: secrets', () => {
  test('no recorded request carries the token, and a thrown error does not either', async () => {
    const { gl, forge } = setup();
    mrRepo(gl);
    await forge.findOrCreatePullRequest({ head: 'agent/one', base: 'trunk', ...NEW });
    await forge.getPull(1);
    await forge.findOpenPullByHead('agent/one');
    await forge.listOpenAgentPulls('agent/');
    await forge.listPullFiles(1);
    await forge.changeDigest('trunk', 'agent/two');
    expect(gl.requests.length).toBeGreaterThan(6);
    for (const r of gl.requests) {
      expect(r.path).not.toContain(AGENT);
      expect(JSON.stringify(r.query)).not.toContain(AGENT);
      expect(JSON.stringify(r.body ?? null)).not.toContain(AGENT);
    }
    const wrong = new GitLabForge(GITLAB, PROJECT.path, WRONG);
    const errors = await Promise.all([
      wrong.getPull(1).catch((e: unknown) => e),
      wrong.findOpenPullByHead('agent/one').catch((e: unknown) => e),
      wrong.listOpenAgentPulls('agent/').catch((e: unknown) => e),
      wrong.listPullFiles(1).catch((e: unknown) => e),
      wrong.changeDigest('trunk', 'agent/two').catch((e: unknown) => e),
      wrong
        .findOrCreatePullRequest({ head: 'agent/one', base: 'trunk', ...NEW })
        .catch((e: unknown) => e),
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(GitLabForgeError);
      expect((e as GitLabForgeError).status).toBe(401);
      expect((e as Error).message).not.toContain(AGENT);
      expect((e as Error).message).not.toContain(WRONG);
    }
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

// --- Approvals as reviews -------------------------------------------------------------------

const MARKER = '<!-- jm:op:review:7:k -->';
const header = (event: string, sha: string) => `<!-- jm-review: ${event} ${sha} -->`;
const NOTES = (n: number) => `${MRS}/${n}/notes`;

/** An open MR 1 from agent/one (authored by `author`, default root), and its head SHA. */
function reviewRepo(gl: FakeGitLab, author = 'root') {
  const { head, base } = mrRepo(gl);
  gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'trunk', title: 'w', author });
  return { head, base };
}

/** A forge acting as `other` (a developer in `setup`). */
const otherForge = () => new GitLabForge(GITLAB, PROJECT.path, OTHER);
const mrNotes = (gl: FakeGitLab) => gl.notes.filter((n) => n.noteable_type === 'MergeRequest');

describe('reviews: createReview', () => {
  test('APPROVE on the head approves at that SHA, posts one header note and returns its id', async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    const r = await forge.createReview(1, {
      event: 'APPROVE',
      body: `LGTM\n\n${MARKER}`,
      commitId: head,
    });
    expect(gl.approvals(1)).toEqual([{ username: 'agent', sha: head }]);
    const approve = gl.requests.find((q) => q.path === `${MRS}/1/approve`);
    expect(approve?.body).toEqual({ sha: head });
    const notes = mrNotes(gl);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe(`${header('APPROVE', head)}\nLGTM\n\n${MARKER}`);
    expect(notes[0]?.author.username).toBe('agent');
    expect(r).toEqual({ id: notes[0]?.id });
  });

  test('APPROVE against a moved head rejects with 409 and posts no note', async () => {
    const { gl, forge } = setup();
    const { base } = reviewRepo(gl);
    const err = await forge
      .createReview(1, { event: 'APPROVE', body: 'secret body', commitId: base })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect((err as GitLabForgeError).status).toBe(409);
    expect((err as Error).message).not.toContain('secret body');
    expect(gl.approvals(1)).toEqual([]);
    expect(mrNotes(gl)).toEqual([]);
    expect(gl.requests.some((q) => q.method === 'POST' && q.path === NOTES(1))).toBe(false);
  });

  test('a retried APPROVE after the approval landed posts the note and does not throw', async () => {
    const { gl } = setup();
    const { head } = reviewRepo(gl);
    let failed = false;
    // The first note POST fails at the network, after the approval landed.
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!failed && init?.method === 'POST' && String(input).endsWith('/notes')) {
        failed = true;
        throw new Error('connection reset');
      }
      return fetch(input, init);
    }) as typeof fetch;
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, { fetch: flaky });
    const input = { event: 'APPROVE' as const, body: `ok\n${MARKER}`, commitId: head };
    await expect(forge.createReview(1, input)).rejects.toBeInstanceOf(GitLabForgeError);
    expect(gl.approvals(1)).toEqual([{ username: 'agent', sha: head }]);
    expect(mrNotes(gl)).toEqual([]);
    const r = await forge.createReview(1, input);
    const notes = mrNotes(gl);
    expect(notes).toHaveLength(1);
    expect(r).toEqual({ id: notes[0]?.id });
    expect(gl.approvals(1)).toEqual([{ username: 'agent', sha: head }]);
  });

  test("an APPROVE refused for another reason (the MR's author) rejects with 401 and posts no note", async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl, 'agent');
    const err = await forge
      .createReview(1, { event: 'APPROVE', body: 'b', commitId: head })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect((err as GitLabForgeError).status).toBe(401);
    expect(gl.approvals(1)).toEqual([]);
    expect(mrNotes(gl)).toEqual([]);
  });

  test("REQUEST_CHANGES withdraws the viewer's approval, and works with none", async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    await otherForge().createReview(1, { event: 'APPROVE', body: 'other ok', commitId: head });
    await forge.createReview(1, { event: 'APPROVE', body: 'ok', commitId: head });
    expect(gl.approvals(1).map((a) => a.username)).toEqual(['other', 'agent']);

    const r = await forge.createReview(1, { event: 'REQUEST_CHANGES', body: 'no', commitId: head });
    expect(gl.approvals(1).map((a) => a.username)).toEqual(['other']);
    const last = mrNotes(gl).find((n) => n.id === r.id);
    expect(last?.body).toBe(`${header('REQUEST_CHANGES', head)}\nno`);

    // No approval left to withdraw: unapprove answers 404, and the note still goes.
    const again = await forge.createReview(1, {
      event: 'REQUEST_CHANGES',
      body: 'still no',
      commitId: head,
    });
    expect(mrNotes(gl).some((n) => n.id === again.id)).toBe(true);
    expect(gl.approvals(1).map((a) => a.username)).toEqual(['other']);
  });

  test('a malformed commitId, an unknown event or a bad iid is refused unsent', async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    gl.requests.length = 0;
    const bad: [number, { event: string; body: string; commitId: string }][] = [
      [1, { event: 'APPROVE', body: 'b', commitId: head.slice(0, 39) }],
      [1, { event: 'APPROVE', body: 'b', commitId: head.toUpperCase() }],
      [1, { event: 'APPROVE', body: 'b', commitId: `${head} ` }],
      [1, { event: 'APPROVE', body: 'b', commitId: '' }],
      [1, { event: 'COMMENT', body: 'b', commitId: head }],
      [1, { event: 'approve', body: 'b', commitId: head }],
      [0, { event: 'APPROVE', body: 'b', commitId: head }],
      [-1, { event: 'APPROVE', body: 'b', commitId: head }],
      [1.5, { event: 'APPROVE', body: 'b', commitId: head }],
      [Number.NaN, { event: 'REQUEST_CHANGES', body: 'b', commitId: head }],
    ];
    for (const [n, input] of bad) {
      const err = await forge
        .createReview(n, input as Parameters<GitLabForge['createReview']>[1])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitLabForgeError);
    }
    expect(gl.requests).toEqual([]);
  });
});

describe('reviews: listReviews', () => {
  test('maps header notes to APPROVED and CHANGES_REQUESTED, skipping the rest', async () => {
    const { gl, forge } = setup();
    const { head, base } = reviewRepo(gl);
    const at = (s: number) => `2026-11-0${s}T10:00:00.000Z`;
    const changes = gl.seedNote({
      mergeRequestIid: 1,
      author: 'other',
      body: `${header('REQUEST_CHANGES', base)}\nfix it\nplease`,
      createdAt: at(1),
    });
    gl.seedNote({ mergeRequestIid: 1, author: 'other', body: 'plain comment', createdAt: at(2) });
    for (const body of [
      `${header('COMMENT', head)}\nx`,
      `${header('APPROVE', head.slice(1))}\nx`,
      `${header('APPROVE', head.toUpperCase())}\nx`,
      ` ${header('APPROVE', head)}\nx`,
      `${header('APPROVE', head)} trailing\nx`,
      `<!-- jm-review: APPROVE  ${head} -->\nx`,
      `text first\n${header('APPROVE', head)}`,
    ])
      gl.seedNote({ mergeRequestIid: 1, author: 'agent', body, createdAt: at(3) });
    gl.seedNote({
      mergeRequestIid: 1,
      author: 'agent',
      body: header('APPROVE', head),
      system: true,
      createdAt: at(3),
    });
    await forge.createReview(1, { event: 'APPROVE', body: 'looks good', commitId: head });
    const approveNote = mrNotes(gl).at(-1);

    const reviews = await forge.listReviews(1);
    expect(reviews).toEqual([
      {
        id: changes.id,
        author: 'other',
        state: 'CHANGES_REQUESTED',
        commitId: base,
        body: 'fix it\nplease',
        submittedAt: at(1),
      },
      {
        id: approveNote?.id,
        author: 'agent',
        state: 'APPROVED',
        commitId: head,
        body: 'looks good',
        submittedAt: approveNote?.created_at,
      },
    ]);
  });

  test('pages past 100 notes', async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    for (let i = 0; i < 120; i++)
      gl.seedNote({
        mergeRequestIid: 1,
        author: 'other',
        body: `${header('REQUEST_CHANGES', head)}\n${i}`,
      });
    expect(await forge.listReviews(1)).toHaveLength(120);
  });

  test('after a push resets approvals, an earlier APPROVED review reads as DISMISSED', async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    await forge.createReview(1, { event: 'APPROVE', body: 'ok', commitId: head });
    expect((await forge.listReviews(1)).map((r) => r.state)).toEqual(['APPROVED']);
    gl.seedCommit({ branch: 'agent/one', files: { a: '3\n' }, message: 'push' });
    const [r] = await forge.listReviews(1);
    expect(r).toMatchObject({ author: 'agent', state: 'DISMISSED', commitId: head, body: 'ok' });
  });

  test('a UI approval with no note reads as APPROVED with no commitId, id 0 and no body', async () => {
    const { gl, forge } = setup();
    reviewRepo(gl);
    const sha = gl.mergeRequest(1)?.sha ?? '';
    // `other` approves in the UI: an approve with no review note.
    await fetch(`${GITLAB}${MRS}/1/approve`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': OTHER, 'content-type': 'application/json' },
      body: JSON.stringify({ sha }),
    });
    expect(await forge.listReviews(1)).toEqual([
      { id: 0, author: 'other', state: 'APPROVED', commitId: '', body: '', submittedAt: '' },
    ]);
    // With a plain note by them, submittedAt is that note's time.
    const note = gl.seedNote({
      mergeRequestIid: 1,
      author: 'other',
      body: 'hi',
      createdAt: '2026-11-05T00:00:00.000Z',
    });
    gl.seedNote({
      mergeRequestIid: 1,
      author: 'other',
      body: 'older',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    expect(await forge.listReviews(1)).toEqual([
      {
        id: 0,
        author: 'other',
        state: 'APPROVED',
        commitId: '',
        body: '',
        submittedAt: note.created_at,
      },
    ]);
  });

  test("a header in another user's note is that user's review", async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    gl.seedNote({ mergeRequestIid: 1, author: 'mallory', body: `${header('APPROVE', head)}\nok` });
    const [r] = await forge.listReviews(1);
    expect(r).toMatchObject({ author: 'mallory', commitId: head, state: 'DISMISSED' });
  });

  test('a bad iid is refused unsent', async () => {
    const { gl, forge } = setup();
    await expect(forge.listReviews(0)).rejects.toBeInstanceOf(GitLabForgeError);
    await expect(forge.findReviewByMarker(-2, MARKER)).rejects.toBeInstanceOf(GitLabForgeError);
    expect(gl.requests).toEqual([]);
  });

  test('a malformed approvals response or a note with no author fails closed', async () => {
    const sha = 'a'.repeat(40);
    const notes = [
      { id: 5, body: `${header('APPROVE', sha)}\nok`, author: { username: 'agent' } },
      { id: 6, body: `${header('REQUEST_CHANGES', sha)}\nno`, created_at: '2026-11-01T00:00:00Z' },
    ];
    for (const approvals of [
      null,
      {},
      { approved_by: { length: 1 } },
      {
        approved_by: [
          null,
          {},
          { user: null },
          { user: {} },
          { user: { username: '' } },
          { user: { username: 5 } },
        ],
      },
    ]) {
      const { forge } = jsonForge((url) => ({
        body: url.pathname.endsWith('/approvals') ? approvals : notes,
      }));
      expect(await forge.listReviews(1)).toEqual([
        { id: 5, author: 'agent', state: 'DISMISSED', commitId: sha, body: 'ok', submittedAt: '' },
        {
          id: 6,
          author: '',
          state: 'CHANGES_REQUESTED',
          commitId: sha,
          body: 'no',
          submittedAt: '2026-11-01T00:00:00Z',
        },
      ]);
    }
  });
});

describe('reviews: findReviewByMarker', () => {
  test("finds the viewer's review by its last line, ignoring another user's", async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    const theirs = gl.seedNote({
      mergeRequestIid: 1,
      author: 'other',
      body: `${header('APPROVE', head)}\nok\n${MARKER}`,
    });
    expect(await forge.findReviewByMarker(1, MARKER)).toBeNull();
    const mine = gl.seedNote({
      mergeRequestIid: 1,
      author: 'agent',
      body: `${header('REQUEST_CHANGES', head)}\nno\n\n${MARKER}\n  \n`,
    });
    expect(await forge.findReviewByMarker(1, MARKER)).toEqual({ id: mine.id });
    expect(theirs.id).not.toBe(mine.id);
    // A marker that is not the last line does not count.
    gl.seedNote({
      mergeRequestIid: 1,
      author: 'agent',
      body: `${header('REQUEST_CHANGES', head)}\n<!-- jm:op:other -->\nmore`,
    });
    expect(await forge.findReviewByMarker(1, '<!-- jm:op:other -->')).toBeNull();
  });

  test('never returns a synthetic (id 0) review, and is null when nothing matches', async () => {
    const { gl, forge } = setup();
    reviewRepo(gl);
    const sha = gl.mergeRequest(1)?.sha ?? '';
    await fetch(`${GITLAB}${MRS}/1/approve`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': AGENT, 'content-type': 'application/json' },
      body: JSON.stringify({ sha }),
    });
    expect((await forge.listReviews(1)).map((r) => r.id)).toEqual([0]);
    expect(await forge.findReviewByMarker(1, '')).toBeNull();
    expect(await forge.findReviewByMarker(1, MARKER)).toBeNull();
  });

  test('a note posted by createReview is found with the outbox marker (round trip)', async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    expect(await forge.findReviewByMarker(1, MARKER)).toBeNull();
    const r = await forge.createReview(1, {
      event: 'APPROVE',
      body: `All checks pass.\n\n${MARKER}`,
      commitId: head,
    });
    expect(await forge.findReviewByMarker(1, MARKER)).toEqual(r);
  });

  test("returns the viewer's newest review when several carry the marker", async () => {
    const { gl, forge } = setup();
    const { head } = reviewRepo(gl);
    const newest = gl.seedNote({
      mergeRequestIid: 1,
      author: 'agent',
      body: `${header('APPROVE', head)}\nsecond\n${MARKER}`,
      createdAt: '2026-11-05T00:00:00.000Z',
    });
    gl.seedNote({
      mergeRequestIid: 1,
      author: 'agent',
      body: `${header('REQUEST_CHANGES', head)}\nfirst\n${MARKER}`,
      createdAt: '2026-11-02T00:00:00.000Z',
    });
    expect(await forge.findReviewByMarker(1, MARKER)).toEqual({ id: newest.id });
  });
});

describe('reviews: secrets', () => {
  test('no recorded request carries the token, and a thrown error does not either', async () => {
    const { gl, forge } = setup();
    const { head, base } = reviewRepo(gl);
    await forge.createReview(1, { event: 'APPROVE', body: 'b', commitId: head });
    await forge.createReview(1, { event: 'REQUEST_CHANGES', body: 'b', commitId: head });
    await forge.listReviews(1);
    await forge.findReviewByMarker(1, MARKER);
    const moved = await forge
      .createReview(1, { event: 'APPROVE', body: 'hidden body', commitId: base })
      .catch((e: unknown) => e);
    for (const r of gl.requests) {
      expect(r.path).not.toContain(AGENT);
      expect(JSON.stringify(r.query)).not.toContain(AGENT);
      expect(JSON.stringify(r.body ?? null)).not.toContain(AGENT);
    }
    const wrong = new GitLabForge(GITLAB, PROJECT.path, WRONG);
    const errors = await Promise.all([
      wrong.listReviews(1).catch((e: unknown) => e),
      wrong.findReviewByMarker(1, MARKER).catch((e: unknown) => e),
      wrong
        .createReview(1, { event: 'APPROVE', body: 'hidden body', commitId: head })
        .catch((e: unknown) => e),
      wrong
        .createReview(1, { event: 'REQUEST_CHANGES', body: 'hidden body', commitId: head })
        .catch((e: unknown) => e),
    ]);
    for (const e of [moved, ...errors]) {
      expect(e).toBeInstanceOf(GitLabForgeError);
      expect((e as Error).message).not.toContain(AGENT);
      expect((e as Error).message).not.toContain(WRONG);
      expect((e as Error).message).not.toContain('hidden body');
      expect((e as Error).message).not.toMatch(/SHA does not match|Unauthorized/);
    }
    for (const e of errors) expect((e as GitLabForgeError).status).toBe(401);
  });
});

const PIPELINES = `${API}/pipelines`;

function checksRepo(gl: FakeGitLab): string {
  return gl.seedCommit({ branch: 'trunk', files: { a: '1' }, message: 'a' });
}

describe('checks: checksFor', () => {
  test('no pipeline and no status gives none', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    expect(await forge.checksFor(sha)).toEqual({ state: 'none', names: [], failed: [] });
    expect(gl.requests.find((r) => r.path === PIPELINES)?.query).toMatchObject({
      sha,
      order_by: 'id',
      sort: 'desc',
    });
  });

  test('an all-success pipeline gives success with every job name', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({
      sha,
      jobs: [
        { name: 'build', status: 'success' },
        { name: 'lint', status: 'success' },
        { name: 'deploy', status: 'skipped' },
        { name: 'optional', status: 'manual', allowFailure: true },
      ],
    });
    const c = await forge.checksFor(sha);
    expect(c).toEqual({ state: 'success', names: c.names, failed: [] });
    expect([...c.names].sort()).toEqual(['build', 'deploy', 'lint', 'optional']);
  });

  test('a failed job fails with conclusion failure, a canceled one cancelled, no checkRunId', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({
      sha,
      jobs: [
        { name: 'test', status: 'failed' },
        { name: 'e2e', status: 'canceled' },
        { name: 'build', status: 'success' },
      ],
    });
    const c = await forge.checksFor(sha);
    expect(c.state).toBe('failure');
    expect(c.failed).toEqual([
      { name: 'e2e', conclusion: 'cancelled' },
      { name: 'test', conclusion: 'failure' },
    ]);
    expect(c.queued).toBeUndefined();
  });

  test('a failed job with allow_failure does not fail the result', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({
      sha,
      jobs: [
        { name: 'flaky', status: 'failed', allowFailure: true },
        { name: 'build', status: 'success' },
      ],
    });
    expect(await forge.checksFor(sha)).toMatchObject({ state: 'success', failed: [] });
  });

  test('pending, created and running jobs give pending; only created and pending are queued', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({
      sha,
      jobs: [
        { name: 'zeta', status: 'pending' },
        { name: 'alpha', status: 'created' },
        { name: 'run', status: 'running' },
        { name: 'gate', status: 'manual' },
      ],
    });
    const c = await forge.checksFor(sha);
    expect(c.state).toBe('pending');
    expect(c.queued).toEqual(['alpha', 'zeta']);
    expect(c.failed).toEqual([]);
  });

  test('an unknown job state is pending, never success', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    const { jobs } = gl.seedPipeline({ sha, jobs: [{ name: 'test', status: 'success' }] });
    gl.setJobStatus(jobs[0]?.id as number, 'canceling' as GitLabJobStatus);
    const c = await forge.checksFor(sha);
    expect(c.state).toBe('pending');
    expect(c.queued).toBeUndefined();
  });

  test('a pending external status gives pending but is never queued', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedCommitStatus({ sha, name: 'external/ci', status: 'pending' });
    const c = await forge.checksFor(sha);
    expect(c).toEqual({ state: 'pending', names: ['external/ci'], failed: [] });
  });

  test('a retried job counts only as its newest attempt', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    const { pipeline } = gl.seedPipeline({ sha, jobs: [{ name: 'test', status: 'failed' }] });
    expect((await forge.checksFor(sha)).state).toBe('failure');
    await forge.rerunFailedChecks(1, sha, ['test']);
    const c = await forge.checksFor(sha);
    expect(c).toEqual({ state: 'pending', names: ['test'], failed: [], queued: ['test'] });
    // The current attempt, read as the API lists it (the retried one is excluded).
    const latest = (await fetch(`${GITLAB}${PIPELINES}/${pipeline.id}/jobs`, {
      headers: { 'PRIVATE-TOKEN': AGENT },
    }).then((r) => r.json())) as { id: number }[];
    gl.setJobStatus(latest[0]?.id as number, 'success');
    expect(await forge.checksFor(sha)).toEqual({ state: 'success', names: ['test'], failed: [] });
  });

  test("a newer pipeline's job shadows the older pipeline's job of the same name", async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({
      sha,
      jobs: [
        { name: 'test', status: 'failed' },
        { name: 'old-only', status: 'success' },
      ],
    });
    gl.seedPipeline({ sha, jobs: [{ name: 'test', status: 'success' }] });
    const c = await forge.checksFor(sha);
    expect(c.state).toBe('success');
    expect([...c.names].sort()).toEqual(['old-only', 'test']);
  });

  test('a failed external status fails the result; one named like a job is not counted twice', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({ sha, jobs: [{ name: 'build', status: 'success' }] });
    gl.seedCommitStatus({ sha, name: 'build', status: 'failed' });
    gl.seedCommitStatus({ sha, name: 'external/scan', status: 'failed' });
    gl.seedCommitStatus({ sha, name: 'external/ok', status: 'success' });
    const c = await forge.checksFor(sha);
    expect(c.state).toBe('failure');
    expect(c.failed).toEqual([{ name: 'external/scan', conclusion: 'failure' }]);
    expect([...c.names].sort()).toEqual(['build', 'external/ok', 'external/scan']);
  });

  test.each([
    ['failed', 'failure'],
    ['canceled', 'failure'],
    ['created', 'pending'],
    ['running', 'pending'],
    ['success', 'success'],
    ['skipped', 'success'],
  ] as const)('a pipeline with no jobs and status %s gives %s', async (status, state) => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({ sha, jobs: [], status });
    expect(await forge.checksFor(sha)).toEqual({ state, names: [], failed: [] });
  });

  test('waiting_for_resource, preparing and scheduled jobs are pending and queued', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    const { jobs } = gl.seedPipeline({
      sha,
      jobs: [
        { name: 'wait', status: 'success' },
        { name: 'prep', status: 'success' },
        { name: 'later', status: 'success' },
      ],
    });
    const states = ['waiting_for_resource', 'preparing', 'scheduled'];
    jobs.forEach((j, i) => gl.setJobStatus(j.id, states[i] as GitLabJobStatus));
    const c = await forge.checksFor(sha);
    expect(c.state).toBe('pending');
    expect(c.queued).toEqual(['later', 'prep', 'wait']);
  });

  test('a failed job-less pipeline fails the result even when another pipeline succeeds', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({ sha, jobs: [{ name: 'build', status: 'success' }] });
    gl.seedPipeline({ sha, jobs: [], status: 'failed' });
    expect(await forge.checksFor(sha)).toEqual({ state: 'failure', names: ['build'], failed: [] });
  });

  test('pages through more than 100 jobs', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({
      sha,
      jobs: Array.from({ length: 130 }, (_, i) => ({ name: `j${i}`, status: 'success' as const })),
    });
    const c = await forge.checksFor(sha);
    expect(c.names).toHaveLength(130);
    expect(gl.requests.filter((r) => r.path.endsWith('/jobs'))).toHaveLength(2);
  });
});

describe('checks: checkAnnotations', () => {
  test('returns [] and sends no request', async () => {
    const { gl, forge } = setup();
    expect(await forge.checkAnnotations(123)).toEqual([]);
    expect(gl.requests).toEqual([]);
  });
});

describe('checks: rerunFailedChecks', () => {
  const retries = (gl: FakeGitLab) =>
    gl.requests.filter((r) => r.method === 'POST').map((r) => r.path);

  test('retries only pipelines with an effective failed job named in names, once each, newest first', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    const a = gl.seedPipeline({
      sha,
      jobs: [
        { name: 'test', status: 'failed' },
        { name: 'lint', status: 'failed' },
      ],
    }).pipeline;
    const b = gl.seedPipeline({ sha, jobs: [{ name: 'e2e', status: 'canceled' }] }).pipeline;
    gl.seedPipeline({ sha, jobs: [{ name: 'other', status: 'failed' }] });
    const { runIds, running } = await forge.rerunFailedChecks(1, sha, ['test', 'lint', 'e2e']);
    expect(runIds).toEqual([b.id, a.id]);
    expect(running).toBe(false);
    expect(retries(gl)).toEqual([`${PIPELINES}/${b.id}/retry`, `${PIPELINES}/${a.id}/retry`]);
  });

  test('does not retry an older pipeline whose failed job is shadowed', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({ sha, jobs: [{ name: 'test', status: 'failed' }] });
    gl.seedPipeline({ sha, jobs: [{ name: 'test', status: 'success' }] });
    expect(await forge.rerunFailedChecks(1, sha, ['test'])).toEqual({ runIds: [], running: false });
    expect(retries(gl)).toEqual([]);
  });

  test('does not retry a pipeline whose only named failure has allow_failure', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({ sha, jobs: [{ name: 'flaky', status: 'failed', allowFailure: true }] });
    expect(await forge.rerunFailedChecks(1, sha, ['flaky'])).toEqual({
      runIds: [],
      running: false,
    });
    expect(retries(gl)).toEqual([]);
  });

  test('with no match sends no retry and returns []', async () => {
    const { gl, forge } = setup();
    const sha = checksRepo(gl);
    gl.seedPipeline({ sha, jobs: [{ name: 'test', status: 'failed' }] });
    expect(await forge.rerunFailedChecks(1, sha, ['nope'])).toEqual({ runIds: [], running: false });
    expect(retries(gl)).toEqual([]);
  });

  test('a reporter-level token is refused with a 403 that carries no token', async () => {
    const { gl } = setup();
    const REPORTER = glpat('R');
    gl.addUser({ username: 'reader', token: REPORTER, accessLevel: ACCESS.reporter });
    const sha = checksRepo(gl);
    gl.seedPipeline({ sha, jobs: [{ name: 'test', status: 'failed' }] });
    const forge = new GitLabForge(GITLAB, PROJECT.path, REPORTER);
    const err = await forge.rerunFailedChecks(1, sha, ['test']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect((err as GitLabForgeError).status).toBe(403);
    expect((err as Error).message).not.toContain(REPORTER);
    expect((err as Error).message).not.toMatch(/Forbidden|privileges/);
  });
});

/** MR 1 from agent/one into trunk (on mrRepo), and the SHAs. */
function mergeRepo(gl: FakeGitLab) {
  const shas = mrRepo(gl);
  gl.seedMergeRequest({ sourceBranch: 'agent/one', targetBranch: 'trunk', title: 'w' });
  return shas;
}

/** Move trunk on by one commit with the snapshot `files` (a conflict with agent/one when `a`
 *  is not '1\n'), and return its SHA. */
function moveTrunk(gl: FakeGitLab, files: Record<string, string>) {
  return gl.seedCommit({ branch: 'trunk', files, message: 'trunk moves' });
}

const SQUASH = { method: 'squash' as const, title: 'Feat: thing (#1)', message: 'Body line.' };
const statusOf = (e: unknown) => (e as GitLabForgeError).status;

describe('merges: merge', () => {
  test('merge on the head squashes into one new commit with title, blank line, message', async () => {
    const { gl, forge } = setup();
    const { base, head } = mergeRepo(gl);
    const out = await forge.merge(1, { sha: head, ...SQUASH });
    const trunk = gl.branchSha('trunk') as string;
    expect(out).toEqual({ merged: true, sha: trunk });
    const commit = gl.commit(trunk);
    expect(commit?.parent_ids).toEqual([base]);
    expect(commit?.message).toBe('Feat: thing (#1)\n\nBody line.');
    expect(gl.fileAt('trunk', 'b')).toBe('new\n');
    const accept = gl.requests.find((r) => r.method === 'PUT' && r.path === `${MRS}/1/merge`);
    expect(accept?.body).toMatchObject({ sha: head, squash: true });
  });

  test('an empty message squashes with just the title', async () => {
    const { gl, forge } = setup();
    const { head } = mergeRepo(gl);
    await forge.merge(1, { sha: head, ...SQUASH, message: '' });
    expect(gl.commit(gl.branchSha('trunk') as string)?.message).toBe('Feat: thing (#1)');
  });

  test('a stale SHA rejects with 409 and leaves the target unmoved', async () => {
    const { gl, forge } = setup();
    const { base } = mergeRepo(gl);
    const err = await forge.merge(1, { sha: base, ...SQUASH }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect(statusOf(err)).toBe(409);
    expect(gl.branchSha('trunk')).toBe(base);
    expect(gl.mergeRequest(1)?.state).toBe('opened');
    expect((err as Error).message).not.toContain(SQUASH.title);
    expect((err as Error).message).not.toContain(SQUASH.message);
    expect((err as Error).message).not.toContain('SHA does not match');
  });

  test('a non-mergeable MR rejects with 405', async () => {
    const { gl, forge } = setup();
    const { base, head } = mergeRepo(gl);
    gl.setMergeable(1, false);
    const err = await forge.merge(1, { sha: head, ...SQUASH }).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(405);
    expect(gl.branchSha('trunk')).toBe(base);
  });

  test("a conflicting MR (GitLab 406) rejects with 405, without GitLab's text", async () => {
    const { gl, forge } = setup();
    const { head } = mergeRepo(gl);
    const moved = moveTrunk(gl, { a: '3\n', gone: 'x\n', old: 'same\n' });
    const err = await forge.merge(1, { sha: head, ...SQUASH }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect(statusOf(err)).toBe(405);
    expect((err as Error).message).not.toContain('cannot be merged');
    expect(gl.branchSha('trunk')).toBe(moved);
  });

  test('a bad iid or a SHA that is not 40-hex is refused unsent', async () => {
    const { gl, forge } = setup();
    const { head } = mergeRepo(gl);
    for (const n of [0, -1, 1.5, Number.NaN])
      await expect(forge.merge(n, { sha: head, ...SQUASH })).rejects.toBeInstanceOf(
        GitLabForgeError,
      );
    for (const sha of ['', 'abc', head.toUpperCase(), `${head}0`])
      await expect(forge.merge(1, { sha, ...SQUASH })).rejects.toBeInstanceOf(GitLabForgeError);
    expect(gl.requests).toEqual([]);
  });
});

const REBASE = `${MRS}/1/rebase`;

describe('merges: updateBranch', () => {
  test('a stale expected SHA gives head_moved and sends no rebase', async () => {
    const { gl, forge } = setup();
    const { base, head } = mergeRepo(gl);
    expect(await forge.updateBranch(1, base)).toEqual({ kind: 'head_moved' });
    expect(gl.requests.some((r) => r.path === REBASE)).toBe(false);
    expect(gl.branchSha('agent/one')).toBe(head);
  });

  test('behind the target: updated, and the source sits on the target head', async () => {
    const { gl, forge } = setup();
    const { head } = mergeRepo(gl);
    const moved = moveTrunk(gl, { a: '1\n', gone: 'x\n', old: 'same\n', c: 'c\n' });
    expect(await forge.updateBranch(1, head)).toEqual({ kind: 'updated' });
    const now = gl.branchSha('agent/one') as string;
    expect(now).not.toBe(head);
    expect(gl.commit(now)?.parent_ids).toEqual([moved]);
    expect(gl.fileAt('agent/one', 'c')).toBe('c\n');
    expect(gl.fileAt('agent/one', 'b')).toBe('new\n');
    expect(gl.requests.filter((r) => r.method === 'PUT' && r.path === REBASE)).toHaveLength(1);
    expect(
      gl.requests.some(
        (r) => r.path === `${MRS}/1` && r.query.include_rebase_in_progress === 'true',
      ),
    ).toBe(true);
  });

  test('a conflicting rebase gives conflict and leaves the source unchanged', async () => {
    const { gl, forge } = setup();
    const { head } = mergeRepo(gl);
    moveTrunk(gl, { a: '3\n', gone: 'x\n', old: 'same\n' });
    expect(await forge.updateBranch(1, head)).toEqual({ kind: 'conflict' });
    expect(gl.branchSha('agent/one')).toBe(head);
  });

  test('a rebase that never finishes rejects after the bounded reads', async () => {
    const { gl } = setup();
    const { head } = mergeRepo(gl);
    moveTrunk(gl, { a: '1\n', gone: 'x\n', old: 'same\n', c: 'c\n' });
    const stuck = hookedFetch(
      (method, url) => method === 'PUT' && url.pathname === REBASE,
      () => {
        const mr = gl.mergeRequest(1);
        if (mr) mr.rebase_in_progress = true;
      },
    );
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, {
      fetch: stuck,
      rebasePollDelayMs: 0,
    });
    const err = await forge.updateBranch(1, head).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect((err as Error).message).toContain('still in progress');
    const polls = gl.requests.filter((r) => r.query.include_rebase_in_progress === 'true');
    expect(polls).toHaveLength(30);
  });

  test('a rebase answered with anything but 202 rejects with its status', async () => {
    const { gl } = setup();
    const { head } = mergeRepo(gl);
    const real = fetch;
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        init?.method === 'PUT' && new URL(String(input)).pathname === REBASE
          ? new Response('{}', { status: 200 })
          : real(input, init)) as typeof fetch,
      rebasePollDelayMs: 0,
    });
    const err = await forge.updateBranch(1, head).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(200);
  });

  test('a bad iid is refused unsent', async () => {
    const { gl, forge } = setup();
    const { head } = mergeRepo(gl);
    for (const n of [0, -2, 2.5])
      await expect(forge.updateBranch(n, head)).rejects.toBeInstanceOf(GitLabForgeError);
    expect(gl.requests).toEqual([]);
  });
});

describe('merges: secrets', () => {
  test('no recorded request or thrown error carries the token', async () => {
    const { gl, forge } = setup();
    const { base, head } = mergeRepo(gl);
    await forge.updateBranch(1, head);
    const now = gl.branchSha('agent/one') as string;
    await forge.merge(1, { sha: base, ...SQUASH }).catch(() => undefined);
    await forge.merge(1, { sha: now, ...SQUASH });
    for (const r of gl.requests) {
      expect(r.path).not.toContain(AGENT);
      expect(JSON.stringify(r.query)).not.toContain(AGENT);
      expect(JSON.stringify(r.body ?? null)).not.toContain(AGENT);
    }
    const wrong = new GitLabForge(GITLAB, PROJECT.path, WRONG);
    const errors = await Promise.all([
      wrong.merge(1, { sha: now, ...SQUASH }).catch((e: unknown) => e),
      wrong.updateBranch(1, now).catch((e: unknown) => e),
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(GitLabForgeError);
      expect(statusOf(e)).toBe(401);
      for (const s of [AGENT, WRONG, SQUASH.title, SQUASH.message])
        expect((e as Error).message).not.toContain(s);
    }
  });
});

describe('access', () => {
  const LEVELS = [ACCESS.guest, ACCESS.reporter, ACCESS.developer, ACCESS.maintainer, ACCESS.owner];

  test('isTrusted and isMaintainer at each access level read /members/all', async () => {
    const { gl, forge } = setup();
    for (const level of LEVELS) gl.seedMember({ username: `m${level}`, accessLevel: level });
    for (const level of LEVELS) {
      expect(await forge.isTrusted(`m${level}`)).toBe(level >= ACCESS.developer);
      expect(await forge.isMaintainer(`m${level}`)).toBe(level >= ACCESS.maintainer);
    }
    expect(gl.requests.length).toBe(LEVELS.length * 2);
    for (const r of gl.requests) {
      expect(r).toMatchObject({ method: 'GET', path: `${API}/members/all` });
      expect(r.query.query).toMatch(/^m\d0$/);
    }
  });

  test('a non-member, a blocked member and a substring match are neither trusted nor maintainers', async () => {
    const { gl, forge } = setup();
    gl.seedMember({ username: 'blocked', accessLevel: ACCESS.owner, state: 'blocked' });
    gl.seedMember({ username: 'devops', accessLevel: ACCESS.owner });
    gl.seedMember({ username: 'zed', name: 'dev lead', accessLevel: ACCESS.owner });
    gl.seedMember({ username: 'dev', accessLevel: ACCESS.guest });
    for (const login of ['stranger', 'blocked', 'dev', 'devop', 'lead']) {
      expect(await forge.isTrusted(login)).toBe(false);
      expect(await forge.isMaintainer(login)).toBe(false);
    }
    expect(await forge.isMaintainer('devops')).toBe(true);
    expect(await forge.isTrusted('zed')).toBe(true);
    for (const r of gl.requests) expect(r.path).toBe(`${API}/members/all`);
  });

  test('repoAccess: a Developer on a private project in a group', async () => {
    const gl = fakeGitLab({ baseUrl: GITLAB, project: { ...PROJECT, namespaceKind: 'group' } });
    fakes.push(gl);
    gl.addUser({
      username: 'agent',
      token: AGENT,
      accessLevel: ACCESS.developer,
      scopes: ['api', 'read_user'],
      expiresAt: '2027-03-01',
    });
    const access = await new GitLabForge(GITLAB, PROJECT.path, AGENT).repoAccess();
    expect(access).toEqual({
      private: true,
      defaultBranch: 'trunk',
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
      scopes: ['api', 'read_user'],
      tokenExpiresAt: '2027-03-01',
      ownerType: 'Organization',
    });
    expect('grantedPermissions' in access).toBe(false);
    const paths = gl.requests.map((r) => r.path);
    expect(paths).toContain(API);
    expect(paths).toContain('/api/v4/user');
    expect(paths).toContain('/api/v4/personal_access_tokens/self');
    expect(paths.some((p) => /^\/members\/all\/\d+$/.test(p.slice(API.length)))).toBe(true);
  });

  test('repoAccess: an Owner on a public personal project', async () => {
    const gl = fakeGitLab({ baseUrl: GITLAB, project: { ...PROJECT, visibility: 'public' } });
    fakes.push(gl);
    gl.addUser({
      username: 'agent',
      token: AGENT,
      accessLevel: ACCESS.owner,
      scopes: ['read_api'],
      expiresAt: '2026-12-31',
    });
    const access = await new GitLabForge(GITLAB, PROJECT.path, AGENT).repoAccess();
    expect(access).toEqual({
      private: false,
      defaultBranch: 'trunk',
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      scopes: ['read_api'],
      tokenExpiresAt: '2026-12-31',
      ownerType: 'User',
    });
  });

  test('repoAccess: a Maintainer, a Reporter, a Guest and a non-member', async () => {
    for (const [level, want] of [
      [ACCESS.maintainer, [false, true, true, true, true]],
      [ACCESS.reporter, [false, false, false, true, true]],
      [ACCESS.guest, [false, false, false, false, false]],
      [undefined, [false, false, false, false, false]],
    ] as const) {
      const gl = fakeGitLab({ baseUrl: GITLAB, project: { ...PROJECT, visibility: 'internal' } });
      fakes.push(gl);
      gl.addUser({ username: 'agent', token: AGENT, accessLevel: level });
      const { permissions, private: priv } = await new GitLabForge(
        GITLAB,
        PROJECT.path,
        AGENT,
      ).repoAccess();
      const [admin, maintain, push, triage, pull] = want;
      expect(permissions).toEqual({ admin, maintain, push, triage, pull });
      expect(priv).toBe(true);
      gl.stop();
      nock.cleanAll();
    }
  });

  /** A fetch answering the access reads, with `tokenStatus` from /personal_access_tokens/self. */
  function accessFetch(tokenStatus: number, kind = 'user') {
    const calls: string[] = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const stub = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === `/api/v4/projects/${ENCODED}`)
        return json(200, {
          id: 77,
          default_branch: 'trunk',
          visibility: 'private',
          namespace: { kind },
        });
      if (url.pathname === '/api/v4/user') return json(200, { id: 5, username: 'agent' });
      if (url.pathname === `/api/v4/projects/${ENCODED}/members/all/5`)
        return json(200, { id: 5, username: 'agent', access_level: 30, state: 'active' });
      if (url.pathname === '/api/v4/personal_access_tokens/self')
        return tokenStatus === 200
          ? json(200, { scopes: ['api'], expires_at: null })
          : json(tokenStatus, { message: `${tokenStatus} ${AGENT}` });
      return json(404, { message: '404 Not Found' });
    }) as typeof fetch;
    return { forge: new GitLabForge(GITLAB, PROJECT.path, AGENT, { fetch: stub }), calls };
  }

  for (const status of [401, 404])
    test(`repoAccess: a ${status} from /personal_access_tokens/self gives null scopes and expiry`, async () => {
      const { forge, calls } = accessFetch(status);
      const access = await forge.repoAccess();
      expect(access.scopes).toBeNull();
      expect(access.tokenExpiresAt).toBeNull();
      expect(access.permissions.push).toBe(true);
      expect(calls).toContain('/api/v4/personal_access_tokens/self');
    });

  test('repoAccess: a 500 from /personal_access_tokens/self rejects without the token', async () => {
    const { forge } = accessFetch(500);
    const err = (await forge.repoAccess().catch((e: unknown) => e)) as GitLabForgeError;
    expect(err).toBeInstanceOf(GitLabForgeError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain(AGENT);
  });

  test('ownerType maps user and group', async () => {
    for (const [kind, want] of [
      ['user', 'User'],
      ['group', 'Organization'],
    ] as const) {
      const gl = fakeGitLab({ baseUrl: GITLAB, project: { ...PROJECT, namespaceKind: kind } });
      fakes.push(gl);
      gl.addUser({ username: 'agent', token: AGENT, accessLevel: ACCESS.developer });
      expect(await new GitLabForge(GITLAB, PROJECT.path, AGENT).ownerType()).toBe(want);
      expect(gl.requests).toMatchObject([{ method: 'GET', path: API }]);
      gl.stop();
      nock.cleanAll();
    }
  });

  test('an unknown namespace kind rejects ownerType and repoAccess without echoing it', async () => {
    const KIND = 'mystery-kind-zz';
    const gl = fakeGitLab({ baseUrl: GITLAB, project: { ...PROJECT, namespaceKind: KIND } });
    fakes.push(gl);
    gl.addUser({ username: 'agent', token: AGENT, accessLevel: ACCESS.owner });
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT);
    for (const p of [forge.ownerType(), forge.repoAccess()]) {
      const err = (await p.catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(GitLabForgeError);
      expect(err.message).not.toContain(KIND);
      expect(err.message).not.toContain(AGENT);
    }
  });

  test('the token appears in no error from the access methods', async () => {
    const { gl } = setup();
    gl.seedMember({ username: 'm', accessLevel: ACCESS.owner });
    const wrong = new GitLabForge(GITLAB, PROJECT.path, WRONG);
    const errs = await Promise.all([
      wrong.isTrusted('m').catch((e: unknown) => e),
      wrong.isMaintainer('m').catch((e: unknown) => e),
      wrong.repoAccess().catch((e: unknown) => e),
      wrong.ownerType().catch((e: unknown) => e),
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(GitLabForgeError);
      expect((e as Error).message).not.toContain(WRONG);
      expect(String((e as Error).stack)).not.toContain(WRONG);
    }
  });
});

describe('branch rules: getBranchRules', () => {
  /** A fake project with the token's user `agent` at `level` (none: not a member). */
  function rulesSetup(
    o: {
      level?: number;
      visibility?: 'private' | 'public';
      pipeline?: boolean;
      fetch?: typeof fetch;
    } = {},
  ) {
    const gl = fakeGitLab({
      baseUrl: GITLAB,
      project: {
        ...PROJECT,
        visibility: o.visibility ?? 'private',
        onlyAllowMergeIfPipelineSucceeds: o.pipeline ?? false,
      },
    });
    fakes.push(gl);
    gl.addUser({
      username: 'agent',
      token: AGENT,
      accessLevel: 'level' in o ? o.level : ACCESS.developer,
    });
    gl.addUser({ username: 'other', token: OTHER, accessLevel: ACCESS.developer });
    const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT, { fetch: o.fetch });
    return { gl, forge };
  }

  /** A fetch that answers from `override` where it returns a reply, else from the fake. */
  function overrideFetch(
    override: (path: string) => { status: number; body: unknown } | undefined,
  ): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const r = override(url.pathname);
      if (!r) return fetch(input, init);
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  const BASE_RULES = {
    requiredApprovals: 0,
    dismissStaleOnPush: true,
    requiredChecks: [],
    unpinnedChecks: [],
    viewerCanBypass: false,
    viewerIsAdmin: false,
    requiresPullRequest: true,
    requireCodeOwnerReview: false,
    approvalRules: 'read',
  };

  test('an unprotected branch reads none', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'release/*' });
    expect(await forge.getBranchRules('trunk')).toEqual({ kind: 'none' });
  });

  test('an exact protected branch reads ok with the expected fields', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [ACCESS.maintainer] });
    const read = await forge.getBranchRules('trunk');
    expect(read).toEqual({ kind: 'ok', rules: BASE_RULES });
    if (read.kind !== 'ok') throw new Error('not ok');
    for (const k of ['nonActionsChecks', 'bypass', 'asApp', 'unsupportedRules'])
      expect(k in read.rules).toBe(false);
  });

  test('a branch matched only by a wildcard uses that entry', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk' });
    gl.protectBranch({
      name: 'release/*',
      pushAccessLevels: [ACCESS.developer],
      codeOwnerApprovalRequired: true,
    });
    expect(await forge.getBranchRules('release/v1/hotfix')).toEqual({
      kind: 'ok',
      rules: {
        ...BASE_RULES,
        requiresPullRequest: false,
        viewerCanBypass: true,
        requireCodeOwnerReview: true,
      },
    });
  });

  test('entries combine: main (push 0) and * (push Developers) let a Developer push', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.protectBranch({ name: '*', pushAccessLevels: [ACCESS.developer] });
    const read = await forge.getBranchRules('trunk');
    expect(read).toMatchObject({
      kind: 'ok',
      rules: { viewerCanBypass: true, requiresPullRequest: false, viewerIsAdmin: false },
    });
  });

  test('a Developer on a Maintainers-push branch must use a merge request', async () => {
    const { gl, forge } = rulesSetup({ level: ACCESS.developer });
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [ACCESS.maintainer] });
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { requiresPullRequest: true, viewerCanBypass: false, viewerIsAdmin: false },
    });
  });

  test('a Maintainer on a Maintainers-push branch can bypass and is an admin', async () => {
    for (const level of [ACCESS.maintainer, ACCESS.owner]) {
      const { gl, forge } = rulesSetup({ level });
      gl.protectBranch({ name: 'trunk', pushAccessLevels: [ACCESS.maintainer] });
      expect(await forge.getBranchRules('trunk')).toMatchObject({
        kind: 'ok',
        rules: { requiresPullRequest: false, viewerCanBypass: true, viewerIsAdmin: true },
      });
      gl.stop();
      nock.cleanAll();
    }
  });

  test('push 0 is never push access, even for a non-member at level 0', async () => {
    const { gl, forge } = rulesSetup({ level: undefined, visibility: 'public' });
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { requiresPullRequest: true, viewerCanBypass: false, viewerIsAdmin: false },
    });
    expect(gl.requests.some((r) => /\/members\/all\/\d+$/.test(r.path))).toBe(true);
  });

  test('a user or group push entry (no numeric access_level) is ignored', async () => {
    const { forge } = rulesSetup({
      fetch: overrideFetch((p) =>
        p === `${API}/protected_branches`
          ? {
              status: 200,
              body: [
                {
                  id: 1,
                  name: 'trunk',
                  push_access_levels: [{ user_id: 5 }, { group_id: 9, access_level: null }],
                  allow_force_push: true,
                  code_owner_approval_required: false,
                },
              ],
            }
          : undefined,
      ),
    });
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { requiresPullRequest: true, viewerCanBypass: false },
    });
  });

  test('a matching entry and an applicable rule past the first page are used', async () => {
    const { gl, forge } = rulesSetup();
    for (let i = 0; i < 120; i++) gl.protectBranch({ name: `other-${i}` });
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    for (let i = 0; i < 120; i++)
      gl.seedApprovalRule({ name: `r${i}`, approvalsRequired: 5, protectedBranches: ['other-0'] });
    gl.seedApprovalRule({ name: 'late', approvalsRequired: 2, protectedBranches: ['trunk'] });
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { requiredApprovals: 2, requiresPullRequest: true },
    });
    const pages = gl.requests.filter((r) => r.path === `${API}/protected_branches`);
    expect(pages.map((r) => r.query.page)).toEqual(['1', '2']);
  });

  test('requiredApprovals is the maximum over applicable regular and any_approver rules', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.protectBranch({ name: 'tr*', pushAccessLevels: [0] });
    gl.protectBranch({ name: 'elsewhere' });
    gl.seedApprovalRule({ name: 'all', approvalsRequired: 1, ruleType: 'any_approver' });
    gl.seedApprovalRule({ name: 'glob', approvalsRequired: 2, protectedBranches: ['tr*'] });
    gl.seedApprovalRule({ name: 'far', approvalsRequired: 4, protectedBranches: ['elsewhere'] });
    gl.seedApprovalRule({ name: 'report', approvalsRequired: 5, ruleType: 'report_approver' });
    gl.seedApprovalRule({ name: 'owners', approvalsRequired: 6, ruleType: 'code_owner' });
    gl.setApprovalSettings({ approvals_before_merge: 3 });
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { requiredApprovals: 2 },
    });
  });

  test('approvals_before_merge with no approval rule gives requiredApprovals 0', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.setApprovalSettings({ approvals_before_merge: 2 });
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { requiredApprovals: 0 },
    });
  });

  test('the Free tier (403 on approval_rules) gives requiredApprovals 0 and still reads', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.seedApprovalRule({ name: 'all', approvalsRequired: 2 });
    gl.setApprovalSettings({ approvals_before_merge: 2 });
    gl.setTier('free');
    expect(await forge.getBranchRules('trunk')).toEqual({
      kind: 'ok',
      rules: { ...BASE_RULES, approvalRules: 'unavailable' },
    });
  });

  test('premium with no approval rules reads approvalRules read and requiredApprovals 0', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.setTier('premium');
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { approvalRules: 'read', requiredApprovals: 0 },
    });
  });

  test('premium with a rule requiring 1 reads approvalRules read and requiredApprovals 1', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.seedApprovalRule({ name: 'review', approvalsRequired: 1, protectedBranches: ['trunk'] });
    gl.setTier('premium');
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { approvalRules: 'read', requiredApprovals: 1 },
    });
  });

  test('free reads approvalRules unavailable and requiredApprovals 0', async () => {
    const { gl, forge } = rulesSetup();
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.seedApprovalRule({ name: 'review', approvalsRequired: 1, protectedBranches: ['trunk'] });
    gl.setTier('free');
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { approvalRules: 'unavailable', requiredApprovals: 0 },
    });
  });

  test('a 404 on approval_rules gives requiredApprovals 0 and still reads', async () => {
    const { gl, forge } = rulesSetup({
      fetch: overrideFetch((p) =>
        p === `${API}/approval_rules` ? { status: 404, body: { message: '404' } } : undefined,
      ),
    });
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    gl.seedApprovalRule({ name: 'all', approvalsRequired: 2 });
    expect(await forge.getBranchRules('trunk')).toMatchObject({
      kind: 'ok',
      rules: { requiredApprovals: 0, approvalRules: 'unavailable' },
    });
  });

  for (const status of [403, 404])
    test(`a ${status} on GET approvals gives dismissStaleOnPush false and still reads`, async () => {
      const { gl, forge } = rulesSetup({
        fetch: overrideFetch((p) =>
          p === `${API}/approvals` ? { status, body: { message: `${status}` } } : undefined,
        ),
      });
      gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
      gl.seedApprovalRule({ name: 'all', approvalsRequired: 1 });
      expect(await forge.getBranchRules('trunk')).toMatchObject({
        kind: 'ok',
        rules: { requiredApprovals: 1, dismissStaleOnPush: false },
      });
    });

  test('dismissStaleOnPush follows reset_approvals_on_push', async () => {
    for (const reset of [true, false]) {
      const { gl, forge } = rulesSetup();
      gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
      gl.setApprovalSettings({ reset_approvals_on_push: reset });
      expect(await forge.getBranchRules('trunk')).toMatchObject({
        kind: 'ok',
        rules: { dismissStaleOnPush: reset },
      });
      gl.stop();
      nock.cleanAll();
    }
  });

  test('requireCodeOwnerReview follows code_owner_approval_required', async () => {
    for (const required of [true, false]) {
      const { gl, forge } = rulesSetup();
      gl.protectBranch({
        name: 'trunk',
        pushAccessLevels: [0],
        codeOwnerApprovalRequired: required,
      });
      expect(await forge.getBranchRules('trunk')).toMatchObject({
        kind: 'ok',
        rules: { requireCodeOwnerReview: required },
      });
      gl.stop();
      nock.cleanAll();
    }
  });

  test('requiredChecks is pipeline only with only_allow_merge_if_pipeline_succeeds', async () => {
    for (const pipeline of [true, false]) {
      const { gl, forge } = rulesSetup({ pipeline });
      gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
      expect(await forge.getBranchRules('trunk')).toMatchObject({
        kind: 'ok',
        rules: { requiredChecks: pipeline ? ['pipeline'] : [], unpinnedChecks: [] },
      });
      gl.stop();
      nock.cleanAll();
    }
  });

  for (const status of [403, 404])
    test(`a ${status} on protected_branches reads unreachable`, async () => {
      const { forge } = rulesSetup({
        fetch: overrideFetch((p) =>
          p === `${API}/protected_branches`
            ? { status, body: { message: `${status}` } }
            : undefined,
        ),
      });
      expect(await forge.getBranchRules('trunk')).toEqual({ kind: 'unreachable' });
    });

  test('a 403 on the member read reads unreachable', async () => {
    const { gl, forge } = rulesSetup({
      fetch: overrideFetch((p) =>
        /\/members\/all\/\d+$/.test(p) ? { status: 403, body: { message: '403' } } : undefined,
      ),
    });
    gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
    expect(await forge.getBranchRules('trunk')).toEqual({ kind: 'unreachable' });
  });

  for (const path of ['/protected_branches', '/approval_rules', '/approvals', '', '/members/all/'])
    test(`a 500 on ${path || 'the project read'} rejects with only the status`, async () => {
      const { gl, forge } = rulesSetup({
        fetch: overrideFetch((p) =>
          (path.endsWith('/') ? p.startsWith(`${API}${path}`) : p === `${API}${path}`)
            ? { status: 500, body: { message: `boom-body ${AGENT}` } }
            : undefined,
        ),
      });
      gl.protectBranch({ name: 'trunk', pushAccessLevels: [0] });
      const err = (await forge.getBranchRules('trunk').catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(GitLabForgeError);
      expect((err as GitLabForgeError).status).toBe(500);
      expect(err.message).not.toContain(AGENT);
      expect(err.message).not.toContain('boom-body');
      expect(String(err.stack)).not.toContain(AGENT);
    });

  describe('branchProtectionProblems on GitLab reads', () => {
    async function twoBotReads(o: { tier: 'free' | 'premium'; pipeline?: boolean }) {
      const { gl } = rulesSetup({ pipeline: o.pipeline });
      gl.protectBranch({
        name: 'trunk',
        pushAccessLevels: [0],
        mergeAccessLevels: [ACCESS.developer],
      });
      gl.seedApprovalRule({ name: 'review', approvalsRequired: 1, protectedBranches: ['trunk'] });
      gl.setApprovalSettings({ reset_approvals_on_push: true });
      gl.setTier(o.tier);
      const author = await new GitLabForge(GITLAB, PROJECT.path, AGENT).getBranchRules('trunk');
      const reviewer = await new GitLabForge(GITLAB, PROJECT.path, OTHER).getBranchRules('trunk');
      return { author, reviewer };
    }

    test('a correctly protected Premium branch has no problems', async () => {
      const rules = await twoBotReads({ tier: 'premium' });
      expect(branchProtectionProblems(rules, makeZone({ ciRequired: false }))).toEqual([]);
    });

    test('with a required pipeline, a CI-required zone has no problems', async () => {
      const rules = await twoBotReads({ tier: 'premium', pipeline: true });
      expect(branchProtectionProblems(rules, makeZone({ ciRequired: true }))).toEqual([]);
    });

    test('on the Free tier the same set-up waives the approval checks (ruling 120)', async () => {
      const rules = await twoBotReads({ tier: 'free' });
      expect(branchProtectionProblems(rules, makeZone({ ciRequired: false }))).toEqual([]);
    });
  });
});
