import { Octokit } from '@octokit/rest';

export type ForgeIssue = {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  createdAt: string;
};

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
}

const TRUSTED_ROLES = new Set(['write', 'maintain', 'admin']);
const TRUSTED_PERMISSIONS = new Set(['write', 'admin']);

export class GitHubForge implements Forge {
  private readonly octokit: Octokit;

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
    } catch {
      return false;
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
}
