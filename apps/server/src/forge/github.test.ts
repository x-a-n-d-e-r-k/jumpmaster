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

  test('trusts write/maintain/admin only; 404 is untrusted, other errors throw', async () => {
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
    await expect(forge.isTrusted('eve')).rejects.toThrow();
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
      await forge.findOrCreatePullRequest({
        head: 'agent/issue-7',
        base: 'main',
        title: 't',
        body: 'b',
      }),
    ).toEqual({ number: 12, url: 'u', created: false });
  });

  test('findOrCreatePullRequest creates a PR when none is open', async () => {
    nock(api)
      .get('/repos/o/r/pulls')
      .query({ head: 'o:agent/issue-8', state: 'open' })
      .reply(200, []);
    nock(api)
      .post('/repos/o/r/pulls', {
        head: 'agent/issue-8',
        base: 'main',
        title: 't',
        body: 'Closes #8',
      })
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

  describe('PR lifecycle reads and writes', () => {
    const pullJson = (n: number, extra: Record<string, unknown> = {}) => ({
      number: n,
      title: `pr${n}`,
      state: 'open',
      merged_at: null,
      user: { login: 'bot' },
      head: { sha: 'h1', ref: 'agent/issue-1', repo: { full_name: 'o/r' } },
      base: { ref: 'main' },
      ...extra,
    });
    const link = (path: string) => ({ Link: `<${api}${path}>; rel="next"` });

    test('viewerLogin is cached per instance', async () => {
      const f = new GitHubForge('o', 'r', 'tok');
      nock(api).get('/user').once().reply(200, { login: 'jm-bot' });
      expect(await f.viewerLogin()).toBe('jm-bot');
      expect(await f.viewerLogin()).toBe('jm-bot');
    });

    test('getPull maps merged, head repo and null headSha', async () => {
      nock(api)
        .get('/repos/o/r/pulls/5')
        .reply(
          200,
          pullJson(5, {
            state: 'closed',
            merged_at: '2026-01-01T00:00:00Z',
            head: { sha: null, ref: 'agent/issue-1', repo: null },
          }),
        );
      nock(api).get('/repos/o/r/pulls/6').reply(404, { message: 'Not Found' });
      expect(await forge.getPull(5)).toEqual({
        number: 5,
        title: 'pr5',
        state: 'closed',
        merged: true,
        headSha: null,
        headRef: 'agent/issue-1',
        headRepo: null,
        baseRef: 'main',
        author: 'bot',
      });
      expect(await forge.getPull(6)).toBeNull();
    });

    test('findOpenPullByHead uses owner:branch and rejects fork heads', async () => {
      nock(api)
        .get('/repos/o/r/pulls')
        .query({ head: 'o:agent/issue-1', state: 'open' })
        .reply(200, [
          pullJson(7, { head: { sha: 'f', ref: 'agent/issue-1', repo: { full_name: 'evil/r' } } }),
          pullJson(8),
        ]);
      nock(api)
        .get('/repos/o/r/pulls')
        .query({ head: 'o:agent/issue-2', state: 'open' })
        .reply(200, []);
      expect((await forge.findOpenPullByHead('agent/issue-1'))?.number).toBe(8);
      expect(await forge.findOpenPullByHead('agent/issue-2')).toBeNull();
    });

    test('listOpenAgentPulls paginates past 100', async () => {
      const mk = (i: number) =>
        pullJson(i, {
          head: {
            sha: 's',
            ref: i <= 120 ? `agent/issue-${i}` : `feat/${i}`,
            repo: { full_name: 'o/r' },
          },
        });
      const page1 = Array.from({ length: 100 }, (_, i) => mk(i + 1));
      const page2 = Array.from({ length: 50 }, (_, i) => mk(i + 101));
      page2.push(
        pullJson(999, { head: { sha: 's', ref: 'agent/fork', repo: { full_name: 'x/r' } } }),
      );
      nock(api)
        .get('/repos/o/r/pulls')
        .query({ state: 'open', per_page: '100' })
        .reply(200, page1, link('/repositories/1/pulls?page=2'));
      nock(api).get('/repositories/1/pulls').query({ page: '2' }).reply(200, page2);
      expect(await forge.listOpenAgentPulls('agent/')).toHaveLength(120);
    });

    test('getIssueState, getIssueLabels, branchSha', async () => {
      nock(api).get('/repos/o/r/issues/3').reply(200, { state: 'closed' });
      nock(api)
        .get('/repos/o/r/issues/3/labels')
        .query(true)
        .reply(200, [{ name: 'a' }, { name: 'b' }]);
      nock(api)
        .get('/repos/o/r/branches/agent%2Fissue-3')
        .reply(200, { commit: { sha: 'abc' } });
      nock(api).get('/repos/o/r/branches/gone').reply(404, { message: 'Not Found' });
      expect(await forge.getIssueState(3)).toBe('closed');
      expect(await forge.getIssueLabels(3)).toEqual(['a', 'b']);
      expect(await forge.branchSha('agent/issue-3')).toBe('abc');
      expect(await forge.branchSha('gone')).toBeNull();
    });

    test('compare maps ahead, behind and merge base', async () => {
      nock(api)
        .get('/repos/o/r/compare/main...agent%2Fissue-3')
        .query(true)
        .reply(200, {
          ahead_by: 2,
          behind_by: 1,
          base_commit: { sha: 'b1' },
          merge_base_commit: { sha: 'mb' },
        });
      expect(await forge.compare('main', 'agent/issue-3')).toEqual({
        aheadBy: 2,
        behindBy: 1,
        baseSha: 'b1',
        mergeBaseSha: 'mb',
      });
    });

    test('listPullFiles paginates and keeps previousPath', async () => {
      const f = (i: number) => ({ filename: `f${i}`, status: 'modified' });
      const page1 = Array.from({ length: 100 }, (_, i) => f(i));
      nock(api)
        .get('/repos/o/r/pulls/5/files')
        .query({ per_page: '100' })
        .reply(200, page1, link('/repositories/1/pulls/5/files?page=2'));
      nock(api)
        .get('/repositories/1/pulls/5/files')
        .query({ page: '2' })
        .reply(200, [{ filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed' }]);
      const res = await forge.listPullFiles(5);
      expect(res.complete).toBe(true);
      expect(res.files).toHaveLength(101);
      expect(res.files[0]).toEqual({ path: 'f0' });
      expect(res.files[100]).toEqual({ path: 'new.ts', previousPath: 'old.ts' });
    });

    describe('checksFor', () => {
      const run = (name: string, status: string, conclusion: string | null) => ({
        name,
        status,
        conclusion,
      });
      const mock = (runs: unknown[], statuses: unknown[]) => {
        nock(api)
          .get('/repos/o/r/commits/sha1/check-runs')
          .query(true)
          .reply(200, { total_count: runs.length, check_runs: runs });
        nock(api)
          .get('/repos/o/r/commits/sha1/status')
          .query(true)
          .reply(200, { state: 'pending', statuses });
      };

      test('combines check runs and statuses', async () => {
        mock([run('build', 'completed', 'success')], [{ context: 'ci/x', state: 'success' }]);
        expect(await forge.checksFor('sha1')).toEqual({
          state: 'success',
          names: ['build', 'ci/x'],
        });
        mock([run('build', 'completed', 'success'), run('slow', 'in_progress', null)], []);
        expect((await forge.checksFor('sha1')).state).toBe('pending');
        mock([run('build', 'queued', null)], [{ context: 'ci/x', state: 'error' }]);
        expect(await forge.checksFor('sha1')).toEqual({
          state: 'failure',
          names: ['build', 'ci/x'],
        });
        mock([run('lint', 'completed', 'timed_out'), run('slow', 'queued', null)], []);
        expect((await forge.checksFor('sha1')).state).toBe('failure');
        mock(
          [run('opt', 'completed', 'skipped'), run('n', 'completed', 'neutral')],
          [{ context: 'ci/y', state: 'pending' }],
        );
        expect((await forge.checksFor('sha1')).state).toBe('pending');
      });

      test('none when both are empty', async () => {
        mock([], []);
        expect(await forge.checksFor('sha1')).toEqual({ state: 'none', names: [] });
      });
    });

    test('getFileAt decodes contents and returns null on 404', async () => {
      nock(api)
        .get('/repos/o/r/contents/a/b.txt')
        .query({ ref: 'main' })
        .reply(200, {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('hi\n').toString('base64'),
        });
      nock(api).get('/repos/o/r/contents/nope').query({ ref: 'main' }).reply(404, { message: 'x' });
      expect(await forge.getFileAt('main', 'a/b.txt')).toBe('hi\n');
      expect(await forge.getFileAt('main', 'nope')).toBeNull();
    });

    describe('reviews', () => {
      const rv = (id: number, login: string, body: string, state = 'APPROVED') => ({
        id,
        user: { login },
        state,
        commit_id: 'c1',
        body,
        submitted_at: '2026-01-01T00:00:00Z',
      });

      test('listReviews paginates past 100', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) => rv(i + 1, 'x', ''));
        nock(api)
          .get('/repos/o/r/pulls/5/reviews')
          .query({ per_page: '100' })
          .reply(200, page1, link('/repositories/1/pulls/5/reviews?page=2'));
        nock(api)
          .get('/repositories/1/pulls/5/reviews')
          .query({ page: '2' })
          .reply(200, [rv(101, 'y', 'b', 'CHANGES_REQUESTED')]);
        const all = await forge.listReviews(5);
        expect(all).toHaveLength(101);
        expect(all[100]).toEqual({
          id: 101,
          author: 'y',
          state: 'CHANGES_REQUESTED',
          commitId: 'c1',
          body: 'b',
          submittedAt: '2026-01-01T00:00:00Z',
        });
      });

      test('findReviewByMarker ignores other authors and non-final markers', async () => {
        const f = new GitHubForge('o', 'r', 'tok');
        nock(api).get('/user').reply(200, { login: 'jm-bot' });
        nock(api)
          .get('/repos/o/r/pulls/5/reviews')
          .query(true)
          .reply(200, [
            rv(1, 'other', 'text\n<!-- jm:op:k1 -->'),
            rv(2, 'jm-bot', '<!-- jm:op:k1 -->\nmore text'),
            rv(3, 'jm-bot', 'text\n<!-- jm:op:k1 -->\n'),
          ]);
        nock(api).get('/repos/o/r/pulls/5/reviews').query(true).reply(200, []);
        expect(await f.findReviewByMarker(5, '<!-- jm:op:k1 -->')).toEqual({ id: 3 });
        expect(await f.findReviewByMarker(5, '<!-- jm:op:k1 -->')).toBeNull();
      });

      test('createReview posts event, body and commit_id', async () => {
        nock(api)
          .post(
            '/repos/o/r/pulls/5/reviews',
            (b) => b.event === 'APPROVE' && b.body === 'ok' && b.commit_id === 'abc',
          )
          .reply(200, { id: 77 });
        expect(
          await forge.createReview(5, { event: 'APPROVE', body: 'ok', commitId: 'abc' }),
        ).toEqual({
          id: 77,
        });
      });
    });

    describe('merge', () => {
      const m = { sha: 'abc', method: 'squash' as const, title: 'T', message: 'Closes #3' };

      test('is pinned to sha and sets title and message', async () => {
        nock(api)
          .put(
            '/repos/o/r/pulls/5/merge',
            (b) =>
              b.sha === 'abc' &&
              b.merge_method === 'squash' &&
              b.commit_title === 'T' &&
              b.commit_message === 'Closes #3',
          )
          .reply(200, { merged: true, sha: 'm1' });
        expect(await forge.merge(5, m)).toEqual({ merged: true, sha: 'm1' });
      });

      test('adapter errors carry status', async () => {
        nock(api).put(/merge/).reply(405, { message: 'Base branch was modified' });
        await expect(forge.merge(5, m)).rejects.toMatchObject({ status: 405 });
      });
    });

    describe('getBranchRules', () => {
      const rulesUrl = '/repos/o/r/rules/branches/main';
      const prRule = (id: number, count = 1, stale = true) => ({
        type: 'pull_request',
        ruleset_id: id,
        parameters: {
          required_approving_review_count: count,
          dismiss_stale_reviews_on_push: stale,
        },
      });
      const checksRule = (id: number, checks: { context: string; integration_id?: number }[]) => ({
        type: 'required_status_checks',
        ruleset_id: id,
        parameters: { required_status_checks: checks },
      });
      const rulesetUrl = (id: number) => `/repos/o/r/rulesets/${id}`;
      const mockRuleset = (id: number, body: Record<string, unknown>) =>
        nock(api).get(rulesetUrl(id)).query({ includes_parents: 'true' }).reply(200, body);
      const mockViewer = (permission: string) => {
        nock(api).get('/user').reply(200, { login: 'jm-bot' });
        nock(api)
          .get('/repos/o/r/collaborators/jm-bot/permission')
          .reply(200, { permission, role_name: permission });
      };
      const fresh = () => new GitHubForge('o', 'r', 'tok');

      test('reads approvals, stale dismissal, checks and bypass', async () => {
        nock(api)
          .get(rulesUrl)
          .query(true)
          .reply(200, [
            prRule(1, 2, true),
            checksRule(1, [{ context: 'build', integration_id: 15368 }]),
            { type: 'deletion', ruleset_id: 1 },
          ]);
        mockRuleset(1, { enforcement: 'active', current_user_can_bypass: 'never' });
        mockViewer('write');
        expect(await fresh().getBranchRules('main')).toEqual({
          kind: 'ok',
          rules: {
            requiredApprovals: 2,
            dismissStaleOnPush: true,
            requiredChecks: ['build'],
            unpinnedChecks: [],
            viewerCanBypass: false,
            viewerIsAdmin: false,
          },
        });
      });

      test('treats a missing current_user_can_bypass as bypass', async () => {
        nock(api)
          .get(rulesUrl)
          .query(true)
          .reply(200, [prRule(1)]);
        mockRuleset(1, { enforcement: 'active' });
        mockViewer('write');
        const res = await fresh().getBranchRules('main');
        expect(res.kind === 'ok' && res.rules.viewerCanBypass).toBe(true);
      });

      test('ignores evaluate and disabled rulesets', async () => {
        nock(api)
          .get(rulesUrl)
          .query(true)
          .reply(200, [prRule(1, 5), prRule(2, 3), prRule(3, 1, false)]);
        mockRuleset(1, { enforcement: 'evaluate', current_user_can_bypass: 'always' });
        mockRuleset(2, { enforcement: 'disabled', current_user_can_bypass: 'always' });
        mockRuleset(3, { enforcement: 'active', current_user_can_bypass: 'never' });
        mockViewer('write');
        const res = await fresh().getBranchRules('main');
        expect(res).toMatchObject({
          kind: 'ok',
          rules: { requiredApprovals: 1, dismissStaleOnPush: false, viewerCanBypass: false },
        });
      });

      test('a 403 secondary rate limit is unavailable, a plain 403 is none', async () => {
        nock(api)
          .get(rulesUrl)
          .query(true)
          .reply(403, { message: 'You have exceeded a secondary rate limit. Please wait.' });
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'unavailable' });
        nock(api)
          .get(rulesUrl)
          .query(true)
          .reply(403, { message: 'Forbidden' }, { 'x-ratelimit-remaining': '0' });
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'unavailable' });
        nock(api).get(rulesUrl).query(true).reply(403, { message: 'Resource not accessible' });
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'none' });
      });

      test('none when no ruleset is active', async () => {
        nock(api)
          .get(rulesUrl)
          .query(true)
          .reply(200, [prRule(1)]);
        mockRuleset(1, { enforcement: 'evaluate' });
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'none' });
        nock(api).get(rulesUrl).query(true).reply(200, []);
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'none' });
      });

      test('flags unpinned checks and an admin bot', async () => {
        nock(api)
          .get(rulesUrl)
          .query(true)
          .reply(200, [
            checksRule(1, [{ context: 'build', integration_id: 1 }, { context: 'lint' }]),
          ]);
        mockRuleset(1, { enforcement: 'active', current_user_can_bypass: 'never' });
        mockViewer('admin');
        expect(await fresh().getBranchRules('main')).toMatchObject({
          kind: 'ok',
          rules: {
            requiredChecks: ['build', 'lint'],
            unpinnedChecks: ['lint'],
            viewerIsAdmin: true,
          },
        });
      });

      test('5xx is unavailable, 403 is none', async () => {
        nock(api).get(rulesUrl).query(true).reply(503, { message: 'down' });
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'unavailable' });
        nock(api).get(rulesUrl).query(true).reply(403, { message: 'nope' });
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'none' });
        nock(api).get(rulesUrl).query(true).reply(404, { message: 'nope' });
        expect(await fresh().getBranchRules('main')).toEqual({ kind: 'none' });
      });
    });
  });
});
