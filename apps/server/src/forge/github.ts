import { Octokit } from '@octokit/rest';

export type ForgeIssue = {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  createdAt: string;
};

export type ForgeError = Error & { status?: number };

export type PullFacts = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string | null;
  headRef: string;
  headRepo: string | null;
  baseRef: string;
  author: string;
};

export type ForgeReview = {
  id: number;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  commitId: string;
  body: string;
  submittedAt: string;
};

export type ChecksState = 'success' | 'pending' | 'failure' | 'none';
export type ChecksFacts = { state: ChecksState; names: string[] };

export type CompareFacts = {
  aheadBy: number;
  behindBy: number;
  baseSha: string;
  mergeBaseSha: string;
};

export type PullFiles = { files: { path: string; previousPath?: string }[]; complete: boolean };

export type BranchRules = {
  requiredApprovals: number;
  dismissStaleOnPush: boolean;
  requiredChecks: string[];
  unpinnedChecks: string[];
  viewerCanBypass: boolean;
  viewerIsAdmin: boolean;
};
export type BranchRulesRead =
  | { kind: 'ok'; rules: BranchRules }
  | { kind: 'none' }
  | { kind: 'unavailable' };

export interface Forge {
  getDefaultBranch(): Promise<string>;
  listReadyIssues(label: string): Promise<ForgeIssue[]>;
  isTrusted(login: string): Promise<boolean>;
  findOrCreatePullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string; created: boolean }>;
  viewerLogin(): Promise<string>;
  getPull(number: number): Promise<PullFacts | null>;
  findOpenPullByHead(branch: string): Promise<PullFacts | null>;
  listOpenAgentPulls(prefix: string): Promise<PullFacts[]>;
  getIssueState(number: number): Promise<'open' | 'closed'>;
  getIssueLabels(number: number): Promise<string[]>;
  branchSha(branch: string): Promise<string | null>;
  compare(base: string, head: string): Promise<CompareFacts>;
  listPullFiles(number: number): Promise<PullFiles>;
  checksFor(sha: string): Promise<ChecksFacts>;
  getBranchRules(branch: string): Promise<BranchRulesRead>;
  getFileAt(ref: string, path: string): Promise<string | null>;
  listReviews(number: number): Promise<ForgeReview[]>;
  createReview(
    number: number,
    input: { event: 'APPROVE' | 'REQUEST_CHANGES'; body: string; commitId: string },
  ): Promise<{ id: number }>;
  findReviewByMarker(number: number, marker: string): Promise<{ id: number } | null>;
  merge(
    number: number,
    input: { sha: string; method: 'squash'; title: string; message: string },
  ): Promise<{ merged: boolean; sha?: string }>;
}

const TRUSTED_ROLES = new Set(['write', 'maintain', 'admin']);
const TRUSTED_PERMISSIONS = new Set(['write', 'admin']);

const PULLS_FILES_CAP = 3000;
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

function statusOf(err: unknown): number | undefined {
  return (err as ForgeError | null)?.status;
}

type RawPull = {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  user: { login: string } | null;
  head: { sha: string | null; ref: string; repo: { full_name: string } | null };
  base: { ref: string };
};

function toPullFacts(p: RawPull): PullFacts {
  return {
    number: p.number,
    title: p.title,
    state: p.state === 'open' ? 'open' : 'closed',
    merged: p.merged_at != null,
    headSha: p.head.sha ?? null,
    headRef: p.head.ref,
    headRepo: p.head.repo?.full_name ?? null,
    baseRef: p.base.ref,
    author: p.user?.login ?? '',
  };
}

export class GitHubForge implements Forge {
  private readonly octokit: Octokit;
  private viewer: Promise<string> | undefined;

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    token: string,
  ) {
    this.octokit = new Octokit({ auth: token, baseUrl: 'https://api.github.com' });
  }

  async getDefaultBranch(): Promise<string> {
    const { data } = await this.octokit.rest.repos.get({ owner: this.owner, repo: this.repo });
    return data.default_branch;
  }

  async listReadyIssues(label: string): Promise<ForgeIssue[]> {
    const items = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: 100,
    });
    return items
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        author: i.user?.login ?? '',
        labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
        createdAt: i.created_at,
      }));
  }

  async isTrusted(login: string): Promise<boolean> {
    try {
      const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: this.owner,
        repo: this.repo,
        username: login,
      });
      if (data.role_name) return TRUSTED_ROLES.has(data.role_name);
      return TRUSTED_PERMISSIONS.has(data.permission);
    } catch (err) {
      // Only "not a collaborator" is an answer. Anything else (5xx, a 403 secondary rate limit,
      // the network) is unknown and must not quietly drop a maintainer's review: rethrow.
      if ((err as ForgeError).status === 404) return false;
      throw err;
    }
  }

  async findOrCreatePullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string; created: boolean }> {
    const { data: open } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${input.head}`,
      state: 'open',
    });
    const existing = open[0];
    if (existing) return { number: existing.number, url: existing.html_url, created: false };
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { number: data.number, url: data.html_url, created: true };
  }

  private get slug(): string {
    return `${this.owner}/${this.repo}`;
  }

  viewerLogin(): Promise<string> {
    if (!this.viewer) {
      const p = this.octokit.rest.users.getAuthenticated().then(({ data }) => data.login);
      p.catch(() => {
        if (this.viewer === p) this.viewer = undefined;
      });
      this.viewer = p;
    }
    return this.viewer;
  }

  async getPull(number: number): Promise<PullFacts | null> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: number,
      });
      return toPullFacts(data);
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async findOpenPullByHead(branch: string): Promise<PullFacts | null> {
    const { data } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${branch}`,
      state: 'open',
    });
    const match = data.find((p) => p.head.repo?.full_name === this.slug);
    return match ? toPullFacts(match) : null;
  }

  async listOpenAgentPulls(prefix: string): Promise<PullFacts[]> {
    const pulls = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      per_page: 100,
    });
    return pulls
      .filter((p) => p.head.ref.startsWith(prefix) && p.head.repo?.full_name === this.slug)
      .map(toPullFacts);
  }

  async getIssueState(number: number): Promise<'open' | 'closed'> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });
    return data.state === 'open' ? 'open' : 'closed';
  }

  async getIssueLabels(number: number): Promise<string[]> {
    const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsOnIssue, {
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      per_page: 100,
    });
    return labels.map((l) => l.name);
  }

  async branchSha(branch: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getBranch({
        owner: this.owner,
        repo: this.repo,
        branch,
      });
      return data.commit.sha;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async compare(base: string, head: string): Promise<CompareFacts> {
    const { data } = await this.octokit.rest.repos.compareCommitsWithBasehead({
      owner: this.owner,
      repo: this.repo,
      basehead: `${base}...${head}`,
      per_page: 1,
    });
    return {
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      baseSha: data.base_commit.sha,
      mergeBaseSha: data.merge_base_commit.sha,
    };
  }

  async listPullFiles(number: number): Promise<PullFiles> {
    const raw = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      per_page: 100,
    });
    const files = raw.map((f) =>
      f.previous_filename
        ? { path: f.filename, previousPath: f.previous_filename }
        : { path: f.filename },
    );
    return { files, complete: files.length < PULLS_FILES_CAP };
  }

  async checksFor(sha: string): Promise<ChecksFacts> {
    const runs = await this.octokit.paginate(this.octokit.rest.checks.listForRef, {
      owner: this.owner,
      repo: this.repo,
      ref: sha,
      per_page: 100,
    });
    // The combined-status payload is not a plain list, so page it by hand.
    const statuses: { context: string; state: string }[] = [];
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.rest.repos.getCombinedStatusForRef({
        owner: this.owner,
        repo: this.repo,
        ref: sha,
        per_page: 100,
        page,
      });
      statuses.push(...data.statuses);
      if (data.statuses.length < 100) break;
    }
    const names = [...runs.map((r) => r.name), ...statuses.map((s) => s.context)];
    let failed = false;
    let pending = false;
    for (const r of runs) {
      if (r.status !== 'completed') pending = true;
      else if (r.conclusion && FAILED_CONCLUSIONS.has(r.conclusion)) failed = true;
    }
    for (const s of statuses) {
      if (s.state === 'failure' || s.state === 'error') failed = true;
      else if (s.state === 'pending') pending = true;
    }
    const state: ChecksState = failed
      ? 'failure'
      : pending
        ? 'pending'
        : names.length === 0
          ? 'none'
          : 'success';
    return { state, names };
  }

  async getBranchRules(branch: string): Promise<BranchRulesRead> {
    try {
      const rules = await this.octokit.paginate(
        'GET /repos/{owner}/{repo}/rules/branches/{branch}',
        {
          owner: this.owner,
          repo: this.repo,
          branch,
          per_page: 100,
        },
      );
      const ids = [...new Set(rules.map((r) => r.ruleset_id).filter((id) => id != null))];
      const active = new Set<number>();
      let viewerCanBypass = false;
      for (const id of ids) {
        const { data } = await this.octokit.request(
          'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}',
          {
            owner: this.owner,
            repo: this.repo,
            ruleset_id: id as number,
            includes_parents: true,
          },
        );
        if (data.enforcement !== 'active') continue;
        active.add(id as number);
        if (data.current_user_can_bypass !== 'never') viewerCanBypass = true;
      }
      if (active.size === 0) return { kind: 'none' };

      let requiredApprovals = 0;
      let dismissStaleOnPush = false;
      const requiredChecks: string[] = [];
      const unpinnedChecks: string[] = [];
      for (const rule of rules) {
        if (rule.ruleset_id == null || !active.has(rule.ruleset_id)) continue;
        if (rule.type === 'pull_request') {
          const p = rule.parameters as
            | { required_approving_review_count?: number; dismiss_stale_reviews_on_push?: boolean }
            | undefined;
          requiredApprovals = Math.max(requiredApprovals, p?.required_approving_review_count ?? 0);
          if (p?.dismiss_stale_reviews_on_push) dismissStaleOnPush = true;
        } else if (rule.type === 'required_status_checks') {
          const p = rule.parameters as
            | { required_status_checks?: { context: string; integration_id?: number | null }[] }
            | undefined;
          for (const c of p?.required_status_checks ?? []) {
            if (!requiredChecks.includes(c.context)) requiredChecks.push(c.context);
            if (c.integration_id == null && !unpinnedChecks.includes(c.context)) {
              unpinnedChecks.push(c.context);
            }
          }
        }
      }
      const viewerIsAdmin = await this.viewerIsAdmin();
      return {
        kind: 'ok',
        rules: {
          requiredApprovals,
          dismissStaleOnPush,
          requiredChecks,
          unpinnedChecks,
          viewerCanBypass,
          viewerIsAdmin,
        },
      };
    } catch (err) {
      const status = statusOf(err);
      if (status === 403 || status === 404) return { kind: 'none' };
      if (status !== undefined && status >= 500) return { kind: 'unavailable' };
      throw err;
    }
  }

  private async viewerIsAdmin(): Promise<boolean> {
    const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: this.owner,
      repo: this.repo,
      username: await this.viewerLogin(),
    });
    return (data.role_name ?? data.permission) === 'admin';
  }

  async getFileAt(ref: string, path: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/contents/{+path}', {
        owner: this.owner,
        repo: this.repo,
        path: path.split('/').map(encodeURIComponent).join('/'),
        ref,
      });
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async listReviews(number: number): Promise<ForgeReview[]> {
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      per_page: 100,
    });
    return reviews
      .filter((r) => r.state !== 'PENDING')
      .map((r) => ({
        id: r.id,
        author: r.user?.login ?? '',
        state: r.state as ForgeReview['state'],
        commitId: r.commit_id ?? '',
        body: r.body ?? '',
        submittedAt: r.submitted_at ?? '',
      }));
  }

  async createReview(
    number: number,
    input: { event: 'APPROVE' | 'REQUEST_CHANGES'; body: string; commitId: string },
  ): Promise<{ id: number }> {
    const { data } = await this.octokit.rest.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      event: input.event,
      body: input.body,
      commit_id: input.commitId,
    });
    return { id: data.id };
  }

  async findReviewByMarker(number: number, marker: string): Promise<{ id: number } | null> {
    const me = await this.viewerLogin();
    const reviews = await this.listReviews(number);
    const hit = reviews.find(
      (r) => r.author === me && r.body.trimEnd().split('\n').pop() === marker,
    );
    return hit ? { id: hit.id } : null;
  }

  async merge(
    number: number,
    input: { sha: string; method: 'squash'; title: string; message: string },
  ): Promise<{ merged: boolean; sha?: string }> {
    const { data } = await this.octokit.rest.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      sha: input.sha,
      merge_method: input.method,
      commit_title: input.title,
      commit_message: input.message,
    });
    return data.sha ? { merged: data.merged, sha: data.sha } : { merged: data.merged };
  }
}
