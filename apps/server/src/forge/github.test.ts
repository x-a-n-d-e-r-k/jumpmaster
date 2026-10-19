import nock from 'nock';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { GitHubForge } from './github.js';

const api = 'https://api.github.com';
const forge = new GitHubForge('o', 'r', 'tok');

function issue(n: number, extra: Record<string, unknown> = {}) {
  return {
    number: n,
    title: `t${n}`,
    body: `b${n}`,
    user: { login: 'alice' },
    labels: [{ name: 'agent-ready' }, 'plain'],
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('GitHubForge', () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });

  test("uses the repo's default branch", async () => {
    nock(api).get('/repos/o/r').reply(200, { default_branch: 'trunk' });
    expect(await forge.getDefaultBranch()).toBe('trunk');
  });

  test('paginates ready issues and drops pull requests', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    page1[3] = issue(4, { pull_request: { url: 'x' } });
    const page2 = Array.from({ length: 5 }, (_, i) => issue(101 + i));
    nock(api)
      .get('/repos/o/r/issues')
      .query({ labels: 'agent-ready', state: 'open', per_page: '100' })
      .reply(200, page1, { Link: `<${api}/repositories/1/issues?page=2>; rel="next"` });
    nock(api).get('/repositories/1/issues').query({ page: '2' }).reply(200, page2);
    const issues = await forge.listReadyIssues('agent-ready');
    expect(issues.length).toBe(104);
    expect(issues.some((i) => i.number === 4)).toBe(false);
    expect(issues[0]).toEqual({
      number: 1,
      title: 't1',
      body: 'b1',
      author: 'alice',
      labels: ['agent-ready', 'plain'],
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  test('null issue body becomes an empty string', async () => {
    nock(api)
      .get('/repos/o/r/issues')
      .query(true)
      .reply(200, [issue(1, { body: null })]);
    expect((await forge.listReadyIssues('agent-ready'))[0]?.body).toBe('');
  });

  test('trusts write/maintain/admin only and fails closed', async () => {
    nock(api).get('/repos/o/r/collaborators/alice/permission').reply(200, { permission: 'write' });
    nock(api).get('/repos/o/r/collaborators/bob/permission').reply(200, { permission: 'read' });
    nock(api).get('/repos/o/r/collaborators/eve/permission').reply(500);
    nock(api).get('/repos/o/r/collaborators/mal/permission').reply(404);
    nock(api)
      .get('/repos/o/r/collaborators/maint/permission')
      .reply(200, { permission: 'write', role_name: 'maintain' });
    nock(api)
      .get('/repos/o/r/collaborators/trg/permission')
      .reply(200, { permission: 'read', role_name: 'triage' });
    nock(api)
      .get('/repos/o/r/collaborators/adm/permission')
      .reply(200, { permission: 'admin', role_name: 'admin' });
    expect(await forge.isTrusted('alice')).toBe(true);
    expect(await forge.isTrusted('bob')).toBe(false);
    expect(await forge.isTrusted('eve')).toBe(false);
    expect(await forge.isTrusted('mal')).toBe(false);
    expect(await forge.isTrusted('maint')).toBe(true);
    expect(await forge.isTrusted('trg')).toBe(false);
    expect(await forge.isTrusted('adm')).toBe(true);
  });

  test('findOrCreatePullRequest returns an existing PR for the head branch', async () => {
    nock(api)
      .get('/repos/o/r/pulls')
      .query({ head: 'o:agent/issue-7', state: 'open' })
      .reply(200, [{ number: 12, html_url: 'u' }]);
    expect(
      await forge.findOrCreatePullRequest({ head: 'agent/issue-7', base: 'main', title: 't', body: 'b' }),
    ).toEqual({ number: 12, url: 'u', created: false });
  });

  test('findOrCreatePullRequest creates a PR when none is open', async () => {
    nock(api)
      .get('/repos/o/r/pulls')
      .query({ head: 'o:agent/issue-8', state: 'open' })
      .reply(200, []);
    nock(api)
      .post('/repos/o/r/pulls', { head: 'agent/issue-8', base: 'main', title: 't', body: 'Closes #8' })
      .reply(201, { number: 13, html_url: 'v' });
    expect(
      await forge.findOrCreatePullRequest({
        head: 'agent/issue-8',
        base: 'main',
        title: 't',
        body: 'Closes #8',
      }),
    ).toEqual({ number: 13, url: 'v', created: true });
  });
});
