// GitLabForge (design spec §5.5, spec §9): the GitLab REST v4 client with the issue, label, comment
// and viewer methods of `Forge` (first slice, #676) and the branch, file, directory, compare and
// first-parent methods (second slice, #683). Not wired in: GitLab zones are still refused with
// GITLAB_UNSUPPORTED wherever a forge is built.
//
// GitLab mapping notes:
// - An issue's `number` is its project-scoped `iid`, and its body is the `description`.
// - `listBlockedBy` is a no-op (no blockers, nothing unreadable) that sends no request: GitLab Free
//   has no "blocked by" links, and the issue-links API's `is_blocked_by` is a paid feature.
// - `addBlockedBy` is refused with GitLabUnsupportedError and sends no request.
// - `updateIssue`'s `stateReason` has no GitLab counterpart and is dropped.
// - `getIssue` never sets `pullRequest`: GitLab numbers issues and merge requests separately.
// - `branchSha` is `GET repository/branches/:name` (404 gives null). `createBranch` is
//   `POST repository/branches`; GitLab's 400 for an existing branch is success only when the branch
//   is already on `fromSha`.
// - `putFile` differs from GitHub's one compare-and-swap PUT. A new file (`expectBlobSha` null) is
//   `POST repository/files/:path` after reading the branch head. An update first reads the file at
//   `branch` (`GET repository/files/:path`), refuses it unwritten when its `blob_id` is not
//   `expectBlobSha`, then `PUT`s with that read's `last_commit_id`, which GitLab checks so a change
//   between the read and the write is refused. Content goes base64. The files API does not return
//   the commit it made, so the branch head is read after the write and returned only when its
//   first parent is the head seen before the write; otherwise another push landed in between, and
//   putFile throws (the write may have landed).
// - `getFileAt` decodes `GET repository/files/:path?ref=` (a directory or a missing file is 404,
//   giving null).
// - `listDir` pages `GET repository/tree?path=&ref=`. GitLab answers a path that is a file with an
//   empty list rather than an error; git has no empty directories, so an empty list (like a 404)
//   gives null.
// - `compare` builds GitHub's three-dot compare from `repository/merge_base` (the merge base), two
//   `repository/compare` calls (each lists the commits on its `to` side since the merge base:
//   `aheadBy` and `behindBy`) and `repository/commits/:sha` (the resolved base commit).
// - `firstParentCommits` maps `repository/compare`'s commits (`id`, `message`, `parent_ids`) into
//   `walkFirstParents`; a 404 (unknown base) gives `complete: false`, as does a base that is not a
//   first-parent ancestor of head. GitLab's compare is not capped at 250 commits like GitHub's.
// - Merge requests (third slice, #690) stand in for pull requests. A PR's `number` is the MR's
//   project-scoped `iid` (refused unsent unless a positive integer); `title` is `title`, `body` is
//   `description` (null gives ''), `labels` is the MR's `labels`, `author` is `author.username`.
//   `state` maps `opened` to `open` and `closed`/`merged` to `closed`; `merged` is true only for
//   `merged`. `headSha` is `sha` (null when absent), `headRef` is `source_branch`, `baseRef` is
//   `target_branch`. `headRepo` is this project's path when `source_project_id` equals
//   `target_project_id`, and null for an MR from a fork.
// - An MR is "ours" only when `source_project_id` equals `target_project_id`: like GitHub's match
//   on `head.repo.full_name`, `findOrCreatePullRequest`, `findOpenPullByHead` and
//   `listOpenAgentPulls` ignore fork MRs. `getPull` returns them, with `headRepo` null.
// - `findOrCreatePullRequest` first reads `GET merge_requests?state=opened&source_branch=` and
//   reuses an open same-project MR for the branch, whatever its target (`created: false`), as
//   GitHub's lookup by `head` does. Otherwise it `POST`s `merge_requests` (`created: true`). A 409
//   (another open MR with the same source and target appeared in a race) re-reads by source
//   branch and returns that MR with `created: false`; a re-read that finds nothing throws. `url` is
//   `web_url`.
// - `findOpenPullByHead` is the first open same-project MR from `source_branch=`, or null.
//   `listOpenAgentPulls(prefix)` pages the open MRs and keeps the same-project ones whose source
//   branch starts with `prefix`.
// - `listPullFiles` pages `GET merge_requests/:iid/diffs`: `{ path: new_path }`, plus
//   `previousPath: old_path` for a rename. GitLab cuts an MR's diff short at the instance's diff
//   limits (files, lines or bytes), and then its `changes_count` (a string) reads like "1000+".
//   So it also reads `GET merge_requests/:iid`, and the list is `complete` only when
//   `changes_count` is a plain decimal, equals the number of files paged, and that number is below
//   3000 (GitHub's cap). Anything else, a missing or unparseable `changes_count` included, is
//   incomplete: callers treat that as unknown, so it fails closed.
// - `changeDigest(base, head)` digests `GET repository/compare?from=base&to=head` (not straight:
//   from the merge base, like GitHub's three dots) with `digestCompareFiles`. Each diff maps to
//   `filename` (`new_path`), `status` (`added` for `new_file`, `removed` for `deleted_file`,
//   `renamed` for `renamed_file`, else `modified`), `previous_filename` (`old_path`, renames only)
//   and `patch` (`diff`). An empty, `too_large` or `collapsed` diff is no patch, so the digest is
//   incomplete (conservative: a pure rename is incomplete too); `compare_timeout` is incomplete.
// - Every path segment (branch, file path, ref) is URL-encoded; refs otherwise go in the query.
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
  type CompareFile,
  digestCompareFiles,
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
  walkFirstParents,
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

/** GitHub's `PULLS_FILES_CAP`: a list this long or longer is not trusted to be whole. */
const PULL_FILES_CAP = 3000;

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
type RawMergeRequest = {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  sha?: string | null;
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
  author?: RawUser;
  labels?: string[];
  web_url?: string;
  changes_count?: unknown;
};
type RawDiff = {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string | null;
  too_large?: boolean;
  collapsed?: boolean;
};
type RawCommit = { id: string; parent_ids?: string[]; message?: string };
type RawFile = {
  content: string;
  encoding?: string;
  blob_id: string;
  commit_id: string;
  last_commit_id: string;
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
  private readonly projectPath: string;
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
    this.projectPath = projectPath;
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

  // --- Repository ----------------------------------------------------------------------------

  /** A branch's head commit, or null when GitLab answers 404. */
  private async branchHead(branch: string): Promise<RawCommit | null> {
    try {
      const b = await this.request<{ commit?: RawCommit }>(
        'reading a branch',
        'GET',
        `/repository/branches/${encodeURIComponent(branch)}`,
      );
      if (typeof b?.commit?.id !== 'string')
        throw new GitLabForgeError('GitLabForge: reading a branch failed: no head commit');
      return b.commit;
    } catch (err) {
      if ((err as GitLabForgeError).status === 404) return null;
      throw err;
    }
  }

  async branchSha(branch: string): Promise<string | null> {
    return (await this.branchHead(branch))?.id ?? null;
  }

  /** GitLab answers 400 for a branch that exists: success only when it is on `fromSha`. */
  async createBranch(name: string, fromSha: string): Promise<void> {
    try {
      await this.request('creating a branch', 'POST', '/repository/branches', {
        branch: name,
        ref: fromSha,
      });
    } catch (err) {
      if ((err as GitLabForgeError).status !== 400) throw err;
      if ((await this.branchSha(name)) === fromSha) return;
      throw new GitLabForgeError(`GitLabForge: branch ${name} already exists on another commit`);
    }
  }

  /**
   * Read-then-write: an update reads the file at `branch`, refuses a blob that is not
   * `expectBlobSha`, and PUTs with the read's `last_commit_id`, which GitLab checks. The files API
   * does not return its commit, so the branch head is read after the write and returned only when
   * its first parent is the head seen before it; otherwise another push landed in between.
   */
  async putFile(o: {
    branch: string;
    path: string;
    content: string;
    message: string;
    expectBlobSha: string | null;
  }): Promise<{ commitSha: string }> {
    const filePath = `/repository/files/${encodeURIComponent(o.path)}`;
    const body: Record<string, string> = {
      branch: o.branch,
      commit_message: o.message,
      encoding: 'base64',
      content: Buffer.from(o.content, 'utf8').toString('base64'),
    };
    let before: string;
    if (o.expectBlobSha === null) {
      const head = await this.branchSha(o.branch);
      if (head === null)
        throw new GitLabForgeError(`GitLabForge: branch ${o.branch} not found`, 404);
      before = head;
      await this.request('creating a file', 'POST', filePath, body);
    } else {
      const file = await this.readFile(o.branch, o.path);
      if (file === null || file.blob_id !== o.expectBlobSha)
        throw new GitLabForgeError(`GitLabForge: ${o.path} has changed on ${o.branch}`, 409);
      before = file.commit_id;
      await this.request('updating a file', 'PUT', filePath, {
        ...body,
        last_commit_id: file.last_commit_id,
      });
    }
    const after = await this.branchHead(o.branch);
    if (!after || after.parent_ids?.[0] !== before)
      throw new GitLabForgeError(
        `GitLabForge: the write to ${o.branch} cannot be confirmed: another push landed on it`,
      );
    return { commitSha: after.id };
  }

  /** The file at `ref` (the JSON form, content base64), or null on 404. */
  private async readFile(ref: string, path: string): Promise<RawFile | null> {
    try {
      const f = await this.request<RawFile>(
        'reading a file',
        'GET',
        `/repository/files/${encodeURIComponent(path)}?${new URLSearchParams({ ref })}`,
      );
      if (typeof f?.content !== 'string' || typeof f.commit_id !== 'string')
        throw new GitLabForgeError('GitLabForge: reading a file failed: unexpected response');
      return f;
    } catch (err) {
      if ((err as GitLabForgeError).status === 404) return null;
      throw err;
    }
  }

  /** A directory is a 404 on GitLab's files API, as is a missing file. */
  async getFileAt(ref: string, path: string): Promise<string | null> {
    const f = await this.readFile(ref, path);
    if (f === null) return null;
    return f.encoding === 'base64' ? Buffer.from(f.content, 'base64').toString('utf8') : f.content;
  }

  /** GitLab's tree lists nothing for a file path; git has no empty directories, so empty is null. */
  async listDir(ref: string, path: string): Promise<string[] | null> {
    let entries: { name?: unknown }[];
    try {
      entries = await this.list<{ name?: unknown }>('listing a directory', '/repository/tree', {
        ref,
        path: path === '' ? undefined : path,
      });
    } catch (err) {
      if ((err as GitLabForgeError).status === 404) return null;
      throw err;
    }
    if (entries.length === 0) return null;
    return entries.map((e) => String(e.name ?? ''));
  }

  /** GitLab's compare (from the merge base, like GitHub's three dots), or null on 404. */
  private async compareCommits(from: string, to: string): Promise<RawCommit[] | null> {
    try {
      const c = await this.request<{ commits?: unknown }>(
        'comparing commits',
        'GET',
        `/repository/compare?${new URLSearchParams({ from, to, straight: 'false' })}`,
      );
      if (!Array.isArray(c?.commits))
        throw new GitLabForgeError('GitLabForge: comparing commits failed: no commit list');
      return c.commits as RawCommit[];
    } catch (err) {
      if ((err as GitLabForgeError).status === 404) return null;
      throw err;
    }
  }

  /**
   * GitHub's `base...head` from three GitLab reads: the merge base, the two compares (each lists
   * the commits on its `to` side since the merge base), and the base commit itself.
   */
  async compare(base: string, head: string): Promise<CompareFacts> {
    const q = new URLSearchParams();
    q.append('refs[]', base);
    q.append('refs[]', head);
    const [mb, ahead, behind, baseCommit] = await Promise.all([
      this.request<RawCommit>('reading the merge base', 'GET', `/repository/merge_base?${q}`),
      this.compareCommits(base, head),
      this.compareCommits(head, base),
      this.request<RawCommit>(
        'reading a commit',
        'GET',
        `/repository/commits/${encodeURIComponent(base)}`,
      ),
    ]);
    if (ahead === null || behind === null)
      throw new GitLabForgeError('GitLabForge: comparing commits failed: HTTP 404', 404);
    return {
      aheadBy: ahead.length,
      behindBy: behind.length,
      baseSha: baseCommit.id,
      mergeBaseSha: mb.id,
    };
  }

  async firstParentCommits(
    base: string,
    head: string,
    max: number,
  ): Promise<{ commits: { sha: string; message: string }[]; complete: boolean }> {
    if (base === head) return { commits: [], complete: true };
    // A 404: the base commit is unknown (history rewritten and collected), nothing to walk.
    const listed = await this.compareCommits(base, head);
    if (listed === null) return { commits: [], complete: false };
    return walkFirstParents(
      listed.map((c) => ({
        sha: c.id,
        commit: { message: c.message ?? '' },
        parents: (c.parent_ids ?? []).map((sha) => ({ sha })),
      })),
      base,
      head,
      max,
    );
  }

  // --- Merge requests ------------------------------------------------------------------------

  /** Whether `mr` comes from this project, not a fork. */
  private static ours(mr: RawMergeRequest): boolean {
    return mr.source_project_id !== undefined && mr.source_project_id === mr.target_project_id;
  }

  private toPullFacts(mr: RawMergeRequest): PullFacts {
    return {
      number: mr.iid,
      title: mr.title,
      state: mr.state === 'opened' ? 'open' : 'closed',
      merged: mr.state === 'merged',
      headSha: mr.sha ?? null,
      headRef: mr.source_branch,
      headRepo: GitLabForge.ours(mr) ? this.projectPath : null,
      baseRef: mr.target_branch,
      author: mr.author?.username ?? '',
      body: mr.description ?? '',
      labels: mr.labels ?? [],
    };
  }

  /** The open same-project MRs from `branch` (one page: GitLab allows one per target branch). */
  private async openFrom(branch: string): Promise<RawMergeRequest[]> {
    const q = new URLSearchParams({ state: 'opened', source_branch: branch, per_page: '100' });
    const list = await this.request<unknown>(
      'listing merge requests',
      'GET',
      `/merge_requests?${q}`,
    );
    if (!Array.isArray(list))
      throw new GitLabForgeError(
        'GitLabForge: listing merge requests failed: response is not a list',
      );
    return (list as RawMergeRequest[]).filter((mr) => GitLabForge.ours(mr));
  }

  async findOrCreatePullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string; created: boolean }> {
    const found = (mr: RawMergeRequest) => ({
      number: mr.iid,
      url: mr.web_url ?? '',
      created: false,
    });
    const [existing] = await this.openFrom(input.head);
    if (existing) return found(existing);
    try {
      const mr = await this.request<RawMergeRequest>(
        'creating a merge request',
        'POST',
        '/merge_requests',
        {
          source_branch: input.head,
          target_branch: input.base,
          title: input.title,
          description: input.body,
        },
      );
      return { number: mr.iid, url: mr.web_url ?? '', created: true };
    } catch (err) {
      if ((err as GitLabForgeError).status !== 409) throw err;
      // Another open MR for the same branches appeared since the lookup: return it.
      const [raced] = await this.openFrom(input.head);
      if (raced) return found(raced);
      throw new GitLabForgeError(
        'GitLabForge: creating a merge request failed: HTTP 409, and no open merge request was found',
        409,
      );
    }
  }

  private async readMergeRequest(number: number): Promise<RawMergeRequest | null> {
    const n = mrIid(number);
    try {
      return await this.request<RawMergeRequest>(
        `reading merge request ${n}`,
        'GET',
        `/merge_requests/${n}`,
      );
    } catch (err) {
      if ((err as GitLabForgeError).status === 404) return null;
      throw err;
    }
  }

  async getPull(number: number): Promise<PullFacts | null> {
    const mr = await this.readMergeRequest(number);
    return mr ? this.toPullFacts(mr) : null;
  }

  async findOpenPullByHead(branch: string): Promise<PullFacts | null> {
    const [mr] = await this.openFrom(branch);
    return mr ? this.toPullFacts(mr) : null;
  }

  async listOpenAgentPulls(prefix: string): Promise<PullFacts[]> {
    const all = await this.list<RawMergeRequest>('listing merge requests', '/merge_requests', {
      state: 'opened',
    });
    return all
      .filter((mr) => GitLabForge.ours(mr) && mr.source_branch.startsWith(prefix))
      .map((mr) => this.toPullFacts(mr));
  }

  /** Complete only when the MR's `changes_count` is a plain number equal to the files paged. */
  async listPullFiles(number: number): Promise<PullFiles> {
    const n = mrIid(number);
    const [diffs, mr] = await Promise.all([
      this.list<RawDiff>(`listing the files of merge request ${n}`, `/merge_requests/${n}/diffs`),
      this.request<RawMergeRequest>(`reading merge request ${n}`, 'GET', `/merge_requests/${n}`),
    ]);
    const files = diffs.map((d) => {
      const path = d.new_path ?? '';
      return d.renamed_file && d.old_path !== undefined
        ? { path, previousPath: d.old_path }
        : { path };
    });
    const count = mr?.changes_count;
    const complete =
      typeof count === 'string' &&
      /^\d+$/.test(count) &&
      Number(count) === files.length &&
      files.length < PULL_FILES_CAP;
    return { files, complete };
  }

  /** `base...head` from GitLab's (merge-base) compare; any diff GitLab did not show is incomplete. */
  async changeDigest(base: string, head: string): Promise<ChangeDigest> {
    const c = await this.request<{ diffs?: unknown; compare_timeout?: unknown }>(
      'comparing commits',
      'GET',
      `/repository/compare?${new URLSearchParams({ from: base, to: head })}`,
    );
    if (c?.compare_timeout === true || !Array.isArray(c?.diffs))
      return { digest: '', complete: false };
    return digestCompareFiles((c.diffs as RawDiff[]).map(toCompareFile));
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

/** A merge request's iid as a path segment; anything but a positive integer is refused unsent. */
function mrIid(number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new GitLabForgeError('GitLabForge: a merge request number must be a positive integer');
  return String(number);
}

/** One GitLab diff as GitHub's compare file. A diff GitLab did not show carries no patch. */
function toCompareFile(d: RawDiff): CompareFile {
  const status = d.new_file
    ? 'added'
    : d.deleted_file
      ? 'removed'
      : d.renamed_file
        ? 'renamed'
        : 'modified';
  const shown = typeof d.diff === 'string' && d.diff !== '' && !d.too_large && !d.collapsed;
  return {
    filename: d.new_path ?? '',
    status,
    ...(d.renamed_file && d.old_path !== undefined ? { previous_filename: d.old_path } : {}),
    ...(shown ? { patch: d.diff as string } : {}),
  };
}

/** Whether note `a` is newer than `b`: later `created_at`, then the higher id. */
function newer(a: RawNote, b: RawNote): boolean {
  const ta = Date.parse(a.created_at ?? '');
  const tb = Date.parse(b.created_at ?? '');
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb;
  return a.id > b.id;
}
