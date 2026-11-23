import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ACCESS, type FakeGitLab, fakeGitLab } from '../test/fake-gitlab.js';
import type { TokenProvider } from './github.js';
import { GitLabForge, GitLabUnsupportedError } from './gitlab.js';

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

function setup() {
  const gl = fakeGitLab({ baseUrl: GITLAB, project: PROJECT });
  fakes.push(gl);
  gl.addUser({ username: 'agent', token: AGENT, accessLevel: ACCESS.developer });
  gl.addUser({ username: 'other', token: OTHER, accessLevel: ACCESS.developer });
  const forge = new GitLabForge(GITLAB, PROJECT.path, AGENT);
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

  test('accepts a trailing slash on the base URL', async () => {
    const { gl } = setup();
    const forge = new GitLabForge(`${GITLAB}/`, PROJECT.path, AGENT);
    expect(await forge.getDefaultBranch()).toBe('trunk');
    expect(gl.requests[0]?.path).toBe(API);
  });
});
