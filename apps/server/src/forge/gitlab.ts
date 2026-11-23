// GitLabForge, first slice (issue #676; design spec §5.5, spec §9): the GitLab REST v4 client and
// the issue, label, comment and viewer methods of `Forge`. Not wired in: GitLab zones are still
// refused with GITLAB_UNSUPPORTED wherever a forge is built.
//
// GitLab mapping notes:
// - An issue's `number` is its project-scoped `iid`, and its body is the `description`.
// - `listBlockedBy` is a no-op (no blockers, nothing unreadable) that sends no request: GitLab Free
//   has no "blocked by" links, and the issue-links API's `is_blocked_by` is a paid feature.
// - `addBlockedBy` is refused with GitLabUnsupportedError and sends no request.
// - `updateIssue`'s `stateReason` has no GitLab counterpart and is dropped.
// - `getIssue` never sets `pullRequest`: GitLab numbers issues and merge requests separately.
// Every other `Forge` method throws GitLabUnsupportedError, naming the method, until a later slice.
//
// Secrets: the token goes only in the PRIVATE-TOKEN header, a redirect is never followed, and no
// error carries the token, a redirect's Location, the request headers or a fetch failure's cause.
import { isGitLabProjectPath, stripTrailingSlashes } from '@jumpmaster/protocol';
import {
  type BlockedByList,
  type BranchRulesRead,
  type BranchUpdate,
  type ChangeDigest,
  type CheckAnnotation,
  type ChecksFacts,
  type CompareFacts,
  type Forge,
  type ForgeIssue,
  type ForgeReview,
  type IssueFacts,
  type PullFacts,
  type PullFiles,
  type ReadProbe,
  type RepoAccess,
  staticTokenProvider,
  type TokenProvider,
} from './github.js';
import { isHttpsOrigin } from './kind.js';

/** A `Forge` method GitLabForge does not (or cannot) do. The message names only the method. */
export class GitLabUnsupportedError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`GitLabForge: ${method} is not supported on GitLab yet`);
    this.name = 'GitLabUnsupportedError';
    this.method = method;
  }
}

/** A failed GitLab request: `status` is GitLab's HTTP status (0 when none came). */
export class GitLabForgeError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'GitLabForgeError';
    this.status = status;
  }
}

/** The most pages a list follows: 1,000 pages of 100 is far past any project this serves. */
const MAX_PAGES = 1000;

type Query = Record<string, string | undefined>;
type Method = 'GET' | 'POST' | 'PUT';

type RawUser = { username?: string } | null | undefined;
type RawIssue = {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  labels?: string[];
  author?: RawUser;
  created_at: string;
};
type RawNote = {
  id: number;
  body?: string;
  system?: boolean;
  author?: RawUser;
  created_at?: string;
};

export type GitLabForgeOptions = {
  fetch?: typeof fetch;
  /** Aborts a request (and its body read) that has not finished in time. */
  requestTimeoutMs?: number;
};

export class GitLabForge implements Forge {
  private readonly api: string;
  private readonly project: string;
  private readonly provider: TokenProvider;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private viewer: Promise<string> | undefined;

  constructor(
    baseUrl: string,
    projectPath: string,
    token: string | TokenProvider,
    opts: GitLabForgeOptions = {},
  ) {
    // Never echo the values: a token in the wrong slot would land in the message.
    if (!isHttpsOrigin(baseUrl))
      throw new Error('GitLabForge: the base URL is not an https origin');
    if (!isGitLabProjectPath(projectPath))
      throw new Error('GitLabForge: the project path is not a valid group/project path');
    this.api = `${stripTrailingSlashes(baseUrl)}/api/v4`;
    this.project = `${this.api}/projects/${encodeURIComponent(projectPath)}`;
    this.provider = typeof token === 'string' ? staticTokenProvider(token) : token;
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs;
  }

  // --- HTTP ----------------------------------------------------------------------------------

  /** One request. `what` names it in errors; the URL, headers and token never appear there. */
  private async send(
    what: string,
    method: Method,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    let token: string;
    try {
      token = await this.provider.token();
    } catch {
      // The provider's error may quote a token: drop it, and keep no `cause`.
      throw new GitLabForgeError(`GitLabForge: ${what} failed: could not get a token`);
    }
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': token, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const signal = this.timeoutMs === undefined ? undefined : AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // PRIVATE-TOKEN is a custom header that fetch would carry across a cross-origin redirect:
        // the token goes only to the base URL's host, so a redirect is never followed.
        redirect: 'manual',
        ...(signal ? { signal } : {}),
      });
      text = await res.text();
    } catch {
      // The cause may echo the request; it is not reported.
      throw new GitLabForgeError(`GitLabForge: ${what} failed: network error`);
    }
    if (res.status === 401) this.provider.invalidate?.();
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400))
      throw new GitLabForgeError(
        `GitLabForge: ${what} failed: HTTP ${res.status} (redirect not followed)`,
        res.status,
      );
    if (res.status < 200 || res.status >= 300)
      throw new GitLabForgeError(`GitLabForge: ${what} failed: HTTP ${res.status}`, res.status);
    let json: unknown;
    try {
      json = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      throw new GitLabForgeError(`GitLabForge: ${what} failed: response is not JSON`, res.status);
    }
    return { status: res.status, headers: res.headers, json };
  }

  private async request<T>(what: string, method: Method, path: string, body?: unknown) {
    return (await this.send(what, method, `${this.project}${path}`, body)).json as T;
  }

  /** Every page of a project list, 100 a page, following `x-next-page` until it is empty. */
  private async list<T>(what: string, path: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    let page = '1';
    for (let n = 0; n < MAX_PAGES; n++) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, v);
      q.set('per_page', '100');
      q.set('page', page);
      const { headers, json } = await this.send(what, 'GET', `${this.project}${path}?${q}`);
      if (!Array.isArray(json))
        throw new GitLabForgeError(`GitLabForge: ${what} failed: response is not a list`);
      out.push(...(json as T[]));
      const next = headers.get('x-next-page')?.trim() ?? '';
      if (next === '' || !/^\d+$/.test(next) || Number(next) <= Number(page)) return out;
      page = next;
    }
    throw new GitLabForgeError(`GitLabForge: ${what} failed: more than ${MAX_PAGES} pages`);
  }

  // --- Issues --------------------------------------------------------------------------------

  async getDefaultBranch(): Promise<string> {
    const p = await this.request<{ default_branch?: unknown }>('reading the project', 'GET', '');
    if (typeof p?.default_branch !== 'string' || p.default_branch === '')
      throw new GitLabForgeError('GitLabForge: the project has no default branch');
    return p.default_branch;
  }

  async listReadyIssues(label: string): Promise<ForgeIssue[]> {
    return this.listOpenIssues(label);
  }

  async listOpenIssues(label?: string): Promise<ForgeIssue[]> {
    const items = await this.list<RawIssue>('listing issues', '/issues', {
      state: 'opened',
      labels: label,
    });
    return items.map((i) => ({
      number: i.iid,
      title: i.title,
      body: i.description ?? '',
      author: i.author?.username ?? '',
      authorType: '',
      labels: i.labels ?? [],
      createdAt: i.created_at,
    }));
  }

  async getIssue(number: number): Promise<IssueFacts | null> {
    let i: RawIssue;
    try {
      i = await this.request<RawIssue>(`reading issue ${number}`, 'GET', `/issues/${iid(number)}`);
    } catch (err) {
      if ((err as GitLabForgeError).status === 404) return null;
      throw err;
    }
    return {
      body: i.description ?? '',
      state: i.state === 'opened' ? 'open' : 'closed',
      labels: i.labels ?? [],
      ...(i.author?.username ? { author: i.author.username } : {}),
    };
  }

  private async mustGetIssue(number: number): Promise<IssueFacts> {
    const issue = await this.getIssue(number);
    if (!issue) throw new GitLabForgeError(`GitLabForge: issue ${number} not found`, 404);
    return issue;
  }

  async getIssueState(number: number): Promise<'open' | 'closed'> {
    return (await this.mustGetIssue(number)).state;
  }

  async getIssueLabels(number: number): Promise<string[]> {
    return (await this.mustGetIssue(number)).labels;
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number }> {
    const i = await this.request<RawIssue>('creating an issue', 'POST', '/issues', {
      title: input.title,
      description: input.body,
      labels: input.labels.join(','),
    });
    return { number: i.iid };
  }

  async findIssueByMarker(marker: string, since: string): Promise<{ number: number } | null> {
    const me = await this.viewerLogin();
    const items = await this.list<RawIssue>('searching issues', '/issues', {
      updated_after: since,
    });
    const hit = items.find(
      (i) => i.author?.username === me && (i.description ?? '').trimEnd().endsWith(marker),
    );
    return hit ? { number: hit.iid } : null;
  }

  /** `stateReason` has no GitLab counterpart and is dropped; a patch with nothing else sends nothing. */
  async updateIssue(
    number: number,
    patch: { title?: string; body?: string; state?: 'closed' | 'open'; stateReason?: 'completed' },
  ): Promise<void> {
    const body: Record<string, string> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.description = patch.body;
    if (patch.state !== undefined) body.state_event = patch.state === 'closed' ? 'close' : 'reopen';
    // Nothing to change (an empty patch, or only `stateReason`): GitLab would refuse an empty PUT.
    if (Object.keys(body).length === 0) return;
    await this.request(`updating issue ${number}`, 'PUT', `/issues/${iid(number)}`, body);
  }

  async setLabels(number: number, change: { add: string[]; remove: string[] }): Promise<void> {
    if (change.add.length === 0 && change.remove.length === 0) return;
    const body: Record<string, string> = {};
    if (change.add.length > 0) body.add_labels = change.add.join(',');
    if (change.remove.length > 0) body.remove_labels = change.remove.join(',');
    await this.request(`labelling issue ${number}`, 'PUT', `/issues/${iid(number)}`, body);
  }

  async createIssueComment(number: number, body: string): Promise<{ id: number }> {
    const n = await this.request<{ id: number }>(
      `commenting on issue ${number}`,
      'POST',
      `/issues/${iid(number)}/notes`,
      { body },
    );
    return { id: n.id };
  }

  async findIssueCommentByMarker(number: number, marker: string): Promise<{ id: number } | null> {
    const me = await this.viewerLogin();
    const notes = await this.list<RawNote>(
      `reading notes on issue ${number}`,
      `/issues/${iid(number)}/notes`,
    );
    let best: RawNote | undefined;
    for (const n of notes) {
      if (n.system || n.author?.username !== me || !(n.body ?? '').trimEnd().endsWith(marker))
        continue;
      if (!best || newer(n, best)) best = n;
    }
    return best ? { id: best.id } : null;
  }

  /** Cached; a failed read is not, so the next call asks again. */
  viewerLogin(): Promise<string> {
    if (!this.viewer) {
      const p = this.send('reading the user', 'GET', `${this.api}/user`).then(({ json }) => {
        const username = (json as { username?: unknown } | null)?.username;
        if (typeof username !== 'string' || username === '')
          throw new GitLabForgeError('GitLabForge: the user has no username');
        return username;
      });
      p.catch(() => {
        if (this.viewer === p) this.viewer = undefined;
      });
      this.viewer = p;
    }
    return this.viewer;
  }

  // --- Labels --------------------------------------------------------------------------------

  async listLabels(): Promise<string[]> {
    const labels = await this.list<{ name: string }>('listing labels', '/labels');
    return labels.map((l) => l.name);
  }

  async createLabel(
    name: string,
    color: string,
    description: string,
  ): Promise<{ created: boolean }> {
    try {
      await this.request('creating a label', 'POST', '/labels', {
        name,
        color: color.startsWith('#') ? color : `#${color}`,
        ...(description ? { description } : {}),
      });
      return { created: true };
    } catch (err) {
      if ((err as GitLabForgeError).status === 409) return { created: false };
      throw err;
    }
  }

  // --- Blocked-by: a no-op and a refusal -----------------------------------------------------

  /** GitLab Free has no "blocked by" links: none, nothing unreadable, and no request. */
  async listBlockedBy(_number: number): Promise<BlockedByList> {
    return { blockers: [], unreadable: 0 };
  }

  async addBlockedBy(_issue: number, _blocker: number): Promise<void> {
    throw new GitLabUnsupportedError('addBlockedBy');
  }

  // --- Later slices --------------------------------------------------------------------------

  async isTrusted(_login: string): Promise<boolean> {
    throw new GitLabUnsupportedError('isTrusted');
  }
  async isMaintainer(_login: string): Promise<boolean> {
    throw new GitLabUnsupportedError('isMaintainer');
  }
  async findOrCreatePullRequest(_input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string; created: boolean }> {
    throw new GitLabUnsupportedError('findOrCreatePullRequest');
  }
  async createBranch(_name: string, _fromSha: string): Promise<void> {
    throw new GitLabUnsupportedError('createBranch');
  }
  async putFile(_o: {
    branch: string;
    path: string;
    content: string;
    message: string;
    expectBlobSha: string | null;
  }): Promise<{ commitSha: string }> {
    throw new GitLabUnsupportedError('putFile');
  }
  async getPull(_number: number): Promise<PullFacts | null> {
    throw new GitLabUnsupportedError('getPull');
  }
  async findOpenPullByHead(_branch: string): Promise<PullFacts | null> {
    throw new GitLabUnsupportedError('findOpenPullByHead');
  }
  async listOpenAgentPulls(_prefix: string): Promise<PullFacts[]> {
    throw new GitLabUnsupportedError('listOpenAgentPulls');
  }
  async branchSha(_branch: string): Promise<string | null> {
    throw new GitLabUnsupportedError('branchSha');
  }
  async compare(_base: string, _head: string): Promise<CompareFacts> {
    throw new GitLabUnsupportedError('compare');
  }
  async firstParentCommits(
    _base: string,
    _head: string,
    _max: number,
  ): Promise<{ commits: { sha: string; message: string }[]; complete: boolean }> {
    throw new GitLabUnsupportedError('firstParentCommits');
  }
  async listPullFiles(_number: number): Promise<PullFiles> {
    throw new GitLabUnsupportedError('listPullFiles');
  }
  async changeDigest(_base: string, _head: string): Promise<ChangeDigest> {
    throw new GitLabUnsupportedError('changeDigest');
  }
  async checksFor(_sha: string): Promise<ChecksFacts> {
    throw new GitLabUnsupportedError('checksFor');
  }
  async checkAnnotations(_checkRunId: number): Promise<CheckAnnotation[]> {
    throw new GitLabUnsupportedError('checkAnnotations');
  }
  async rerunFailedChecks(
    _prNumber: number,
    _headSha: string,
    _names: string[],
  ): Promise<{ runIds: number[] }> {
    throw new GitLabUnsupportedError('rerunFailedChecks');
  }
  async getBranchRules(_branch: string): Promise<BranchRulesRead> {
    throw new GitLabUnsupportedError('getBranchRules');
  }
  async getFileAt(_ref: string, _path: string): Promise<string | null> {
    throw new GitLabUnsupportedError('getFileAt');
  }
  async listReviews(_number: number): Promise<ForgeReview[]> {
    throw new GitLabUnsupportedError('listReviews');
  }
  async createReview(
    _number: number,
    _input: { event: 'APPROVE' | 'REQUEST_CHANGES'; body: string; commitId: string },
  ): Promise<{ id: number }> {
    throw new GitLabUnsupportedError('createReview');
  }
  async findReviewByMarker(_number: number, _marker: string): Promise<{ id: number } | null> {
    throw new GitLabUnsupportedError('findReviewByMarker');
  }
  async merge(
    _number: number,
    _input: { sha: string; method: 'squash'; title: string; message: string },
  ): Promise<{ merged: boolean; sha?: string }> {
    throw new GitLabUnsupportedError('merge');
  }
  async updateBranch(_prNumber: number, _expectedHeadSha: string): Promise<BranchUpdate> {
    throw new GitLabUnsupportedError('updateBranch');
  }
  async repoAccess(): Promise<RepoAccess> {
    throw new GitLabUnsupportedError('repoAccess');
  }
  async ownerType(): Promise<'User' | 'Organization'> {
    throw new GitLabUnsupportedError('ownerType');
  }
  async listDir(_ref: string, _path: string): Promise<string[] | null> {
    throw new GitLabUnsupportedError('listDir');
  }
  async probeReads(_sha: string): Promise<ReadProbe[]> {
    throw new GitLabUnsupportedError('probeReads');
  }
  async probeAdministration(): Promise<ReadProbe> {
    throw new GitLabUnsupportedError('probeAdministration');
  }
}

/** An issue number as a path segment; anything but a positive integer is refused unsent. */
function iid(number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new GitLabForgeError('GitLabForge: an issue number must be a positive integer');
  return String(number);
}

/** Whether note `a` is newer than `b`: later `created_at`, then the higher id. */
function newer(a: RawNote, b: RawNote): boolean {
  const ta = Date.parse(a.created_at ?? '');
  const tb = Date.parse(b.created_at ?? '');
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb;
  return a.id > b.id;
}
