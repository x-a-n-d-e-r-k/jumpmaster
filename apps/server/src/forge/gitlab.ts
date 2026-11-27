// GitLabForge (design spec §5.5, spec §9): the GitLab REST v4 client with the issue, label, comment
// and viewer methods of `Forge` (first slice, #676) and the branch, file, directory, compare and
// first-parent methods (second slice, #683), merge requests (third slice, #690), approvals as
// reviews (fourth slice, #696), pipelines and jobs as checks (fifth slice, #697) and the SHA-pinned
// squash merge and rebase as the branch update (sixth slice, #698) and member access levels as
// `isTrusted`, `isMaintainer` and `repoAccess`, the namespace as `ownerType` (#705), and
// protected branches, approval rules and approval settings as `getBranchRules` (#715). `pairFor`
// builds a pair of these from the GitLab tokens a caller passes in (#718), but the live server
// passes none yet, so GitLab zones are still refused with GITLAB_UNSUPPORTED there.
//
// GitLab mapping notes:
// - An issue's `number` is its project-scoped `iid`, and its body is the `description`.
// - `listBlockedBy` is a no-op (no blockers, nothing unreadable) that sends no request: GitLab Free
//   has no "blocked by" links, and the issue-links API's `is_blocked_by` is a paid feature.
// - `addBlockedBy` is refused with GitLabUnsupportedError and sends no request.
// - `updateIssue`'s `stateReason` has no GitLab counterpart and is dropped.
// - `getIssue` never sets `pullRequest`: GitLab numbers issues and merge requests separately.
// - `getIssue`'s `stateReason`: GitLab has no close reason, and the spec is silent, so this mapping
//   is chosen. A plain GitLab close is the counterpart of GitHub's default close (completed), so a
//   closed issue reads as `stateReason: 'completed'` and can be cited as evidence (`verifyCited`).
//   The exception: an issue whose `moved_to_id` is set was closed by GitLab when it was moved, and
//   the work was not done there, so it gets no `stateReason` and `verifyCited` refuses it. An open
//   issue has none. Known limitation: GitLab's REST issue response has no reliable duplicate
//   marker, so an issue closed as a duplicate also reads as completed.
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
//   `state` maps `opened` and `locked` (GitLab carrying out the MR's merge: neither closed nor yet
//   merged) to `open`, and `closed`/`merged` to `closed`; `merged` is true only for `merged`. Any
//   other state throws, rather than reading as closed (which would park or restore the item as
//   abandoned). `headSha` is `sha` (null when absent), `headRef` is `source_branch`, `baseRef` is
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
// - Approvals as reviews (fourth slice, #696). GitLab Free has no review object and no "request
//   changes"; the spec (§5.5, §9) is silent on how reviews map, so this mapping is chosen, and it
//   fails closed. A review is an MR note whose first line is exactly the header
//   `<!-- jm-review: <EVENT> <sha> -->` (EVENT `APPROVE` or `REQUEST_CHANGES`, sha 40 lowercase
//   hex), plus GitLab's approval state:
//   - `createReview` refuses unsent an iid that is not a positive integer, any other event, and a
//     `commitId` that is not 40-hex, so every note it posts has a header `listReviews` accepts.
//     APPROVE is `POST approve` with `sha: commitId`: a 409 (the head moved) rejects with 409 and
//     posts nothing; a 401 (GitLab's answer to any other refusal, "already approved" included)
//     reads `GET approvals` and goes on only when the viewer is in `approved_by` (so a retry after
//     a failed note is safe), else rejects with 401. That 401 also invalidates the token provider
//     in `send` (the token is re-read on the next request); this is accepted. REQUEST_CHANGES, with
//     no GitLab counterpart, is `POST unapprove` (404, no approval to withdraw, is fine). Then one
//     note: the header line, then `body`; its id is returned.
//   - `listReviews` pages the MR notes (system notes skipped) and maps each header note to a review:
//     `id` the note id, `author` `author.username`, `state` APPROVED or CHANGES_REQUESTED,
//     `commitId` from the header, `body` the note without the header line, `submittedAt`
//     `created_at`. It reads `GET approvals` once: an APPROVED note whose author is not in
//     `approved_by` now is DISMISSED (withdrawn, or reset on push). An approver with no review note
//     (a UI approval) is a synthetic APPROVED review with `commitId: ''`, `id: 0`, `body: ''` and
//     `submittedAt` the newest `created_at` of their notes on the MR (else ''). GitLab does not say
//     which commit a UI approval was given on, so `commitId: ''` never approves a head: fail closed.
//     A header in a note counts only as that note author's review; trust is the callers' to decide.
//   - `findReviewByMarker` is the viewer's newest review with a non-zero id whose body's last line
//     (end trimmed) is the marker, as on GitHub; never a synthetic review.
// - Pipelines and jobs as checks (fifth slice, #697):
//   - `checksFor(sha)` pages `GET pipelines?sha=&order_by=id&sort=desc` and, for each pipeline,
//     its current jobs (`GET pipelines/:id/jobs`, retried attempts excluded, so a retried job
//     counts only as its newest attempt). Shadowing: a job name seen in a newer pipeline hides the
//     same name in older pipelines; the jobs left are the effective jobs.
//   - A pipeline with no current jobs (say one that failed on a .gitlab-ci.yml error) counts by its
//     own `status`: `success`/`skipped` add nothing, `failed`/`canceled` make the result `failure`
//     with no named entry in `failed` (there is no job to name), anything else makes it at least
//     `pending`. It adds no job name to `names` and nothing to `queued`, and never makes the
//     result `none`.
//   - The required check and the names (#885): `getBranchRules` maps "Pipelines must succeed" to
//     the one required check `pipeline` (PIPELINE_CHECK), so the operator names no job anywhere.
//     `checksFor` puts `pipeline` in `names` whenever at least one pipeline ran on the commit
//     (jobless ones included), and the result's `state` (every pipeline's jobs, jobless pipelines'
//     own status and the external statuses) says whether it passed. So a green pipeline with jobs
//     of any name satisfies the required check; no pipeline leaves it missing (the flow waits,
//     then parks "no CI result: missing pipeline"); a pending or failed one is named but not
//     `success`. An external status named `pipeline` still counts in `state` and `failed` but
//     never puts the name in `names`: only a GitLab pipeline does. `failed`, `queued` and
//     `rerunFailedChecks` keep naming real jobs and statuses.
//   - Then the commit's external statuses (`GET repository/commits/:sha/statuses`, newest per
//     name). Dedupe: real GitLab lists CI jobs there too, so a status named like an effective job
//     is not counted twice.
//   - States, for jobs and statuses alike: `success`, `skipped`, `manual` with `allow_failure`,
//     and `failed` with `allow_failure` (like GitHub's `neutral`) are done; `failed` is a failure
//     with conclusion `failure`, `canceled` one with conclusion `cancelled`; `created`, `pending`,
//     `waiting_for_resource`, `preparing`, `scheduled`, `running` and `manual` without
//     `allow_failure` are pending, and so is any other or unknown state (`canceling`, say): fail
//     safe, never done.
//   - `queued` is the effective job names in `created`, `pending`, `waiting_for_resource`,
//     `preparing` or `scheduled`, sorted, unique; never an external status, as on GitHub.
//     `state`, `names` and `failed` (sorted, unique) follow GitHubForge.checksFor; the result is
//     `none` only when there is no pipeline and no status. `checkRunId` and `app` are never set.
//   - `checkAnnotations` is a no-op that returns [] and sends no request: GitLab has no check-run
//     annotations (and no failure carries a `checkRunId`, so callers never ask).
//   - `rerunFailedChecks` reads the pipelines and effective jobs as `checksFor` does and retries
//     (`POST pipelines/:id/retry`) once each pipeline owning an effective job named in `names` that
//     is a failure above (so never a shadowed job, nor a failed one with `allow_failure`). It
//     returns their ids, newest first. A refusal (403, 404) or any other error rejects with the
//     status; pipelines retried before it stay retried, as on GitHub.
// - Merges (sixth slice, #698), always SHA-pinned:
//   - `merge(n, { sha, title, message })` is `PUT merge_requests/:iid/merge` with `sha` (refused
//     unsent unless 40 lowercase hex, so no accept goes without it), `squash: true` and
//     `squash_commit_message` set to `title`, a blank line, then `message` (just `title` when
//     `message` is empty). It returns `merged` (`state` is `merged`) and `sha`, the
//     `squash_commit_sha`, else the `merge_commit_sha`, left out when neither is there.
//   - Errors: 409 (the SHA is not the head: it moved) rejects with 409, like GitHub's 409; 405
//     (not mergeable, or not open) and 406 (a conflict) reject with 405, like GitHub's 405; any
//     other error rejects with its status.
//   - `updateBranch(n, expectedHeadSha)` is a rebase: GitLab rewrites the source branch's commits
//     onto the target, where GitHub merges the base in. GitLab's rebase takes no expected head, so
//     (1) it reads the MR and returns `head_moved`, sending no rebase, when `sha` is not
//     `expectedHeadSha`; (2) `PUT merge_requests/:iid/rebase`, where anything but 202 rejects;
//     (3) it reads `GET merge_requests/:iid?include_rebase_in_progress=true` until
//     `rebase_in_progress` is false, at most 30 times with a wait between (1 s by default,
//     `rebasePollDelayMs`), and rejects when the rebase is still running after that; (4) a
//     non-empty `merge_error` is `conflict`, else `updated`.
//   - The race: a push landing between (1) and (2) is not seen; the rebase then rebases that newer
//     head. That is accepted: the flow re-reads the head on its next pass, and the SHA-pinned
//     merge refuses any head it has not seen.
// - Every path segment (branch, file path, ref) is URL-encoded; refs otherwise go in the query.
// - Access (#705; the spec gives no GitLab mapping, so this one is chosen to keep the operator's
//   work lowest). Levels: 10 Guest, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner.
//   - `isTrusted` is Developer or above and `isMaintainer` Maintainer or above, read from
//     `GET members/all` (inherited members included, never `members`), matching the username
//     exactly (`query` only filters). A non-member, or a member whose `state` is present and not
//     `active` (`blocked`, say), is neither.
//   - `repoAccess` reads the project, `GET /user` (the token's user id) and that user's level from
//     `GET members/all/:id` (404: level 0). `pull` and `triage` at Reporter, `push` at Developer,
//     `maintain` at Maintainer, `admin` at Owner. `private` is any visibility but `public`.
//     `scopes` and `tokenExpiresAt` (`expires_at` as GitLab gives it) come from
//     `GET /personal_access_tokens/self`; a 401 or 404 there gives null for both, other errors
//     reject. `grantedPermissions` is never set.
//   - `ownerType` (also in `repoAccess`) is `namespace.kind`: `user` is User, `group` is
//     Organization; any other kind is refused with a GitLabForgeError that does not echo it.
// - Branch rules (#715). The spec (§5.5, §9) asks for "protected branches and approval rules as
//   branch rules" but gives no field mapping, so this one is chosen: it keeps the operator's work
//   lowest where safety allows, and where it does not, an approval requirement counts only when
//   GitLab enforces it.
//   - Entries: `GET protected_branches` (paged). An entry applies on an exact name or through
//     GitLab's `*` glob (any run of characters, `/` included). GitLab applies the most permissive
//     of all matching entries, so they are combined: none matching gives `none`.
//   - The viewer's level is read as `repoAccess` does (`GET /user`, `GET members/all/:id`, 404 is
//     level 0). An entry allows a push when its `access_level` is above 0 and the level is at
//     least that; 0 ("No one") never does, and a user or group entry (no numeric level) is
//     ignored. `viewerCanBypass` is any matching entry allowing the push (`allow_force_push` makes
//     that push a force push too), and `requiresPullRequest` is its negation.
//   - `viewerIsAdmin` is Maintainer (40) or above: a Maintainer can unprotect the branch and edit
//     approval rules, the reach the "bot is admin" guard exists for (`authorMayBeAdmin` allows it).
//   - `requireCodeOwnerReview` is any matching entry's `code_owner_approval_required`.
//   - `requiredApprovals` is the largest `approvals_required` of the `regular` and `any_approver`
//     rules of `GET approval_rules` (paged) that apply: an empty `protected_branches`, or one
//     holding a matching entry's `id`. 0 when none applies. The deprecated project-level
//     `approvals_before_merge` is never counted. Approval rules are a paid feature: on the Free
//     tier (403 or 404 there) GitLab enforces no approvals, so `requiredApprovals` is 0 and the read
//     still succeeds. The two-bot guard waives `approvals < 1` and `stale approvals not
//     dismissed` for such a read (ruling 120): Jumpmaster merges on its reviewer bot's verdict
//     alone, and the doctor's forge.branch-rules warns.
//   - `approvalRules` (GitLab only) says which: `'read'` when `GET approval_rules` answered (with
//     or without rules), `'unavailable'` when it was refused with 403 or 404, so a `requiredApprovals`
//     of 0 there means nothing can be required, not that the rules ask for none. Any other error
//     still throws.
//   - `dismissStaleOnPush` is `reset_approvals_on_push` from `GET approvals` (403 or 404: false).
//   - `requiredChecks` is `['pipeline']` when the project's `only_allow_merge_if_pipeline_succeeds`
//     is set, else [] (the name `checksFor` reports for a pipeline: see the checks notes); `unpinnedChecks` is []; `nonActionsChecks`, `bypass`, `asApp` and
//     `unsupportedRules` are left unset.
//   - A 403 or 404 on `protected_branches`, or a 403 on the member read, gives `unreachable`. Any
//     other error (the project read's included) rejects with a GitLabForgeError, as on GitHub.
// Every other `Forge` method throws GitLabUnsupportedError, naming the method, until a later slice.
//
// Secrets: the token goes only in the PRIVATE-TOKEN header, a redirect is never followed, and no
// error carries the token, a redirect's Location, the request headers, a fetch failure's cause, a
// request body (a commit message, say) or GitLab's response text: only the HTTP status.
import { isGitLabProjectPath, stripTrailingSlashes } from '@jumpmaster/protocol';
import {
  type BlockedByList,
  type BranchRulesRead,
  type BranchUpdate,
  type ChangeDigest,
  type CheckAnnotation,
  type ChecksFacts,
  type ChecksState,
  type CompareFacts,
  type CompareFile,
  digestCompareFiles,
  type FailedCheck,
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

/** A full commit SHA, lowercase. */
const SHA40 = /^[0-9a-f]{40}$/;
/** A review note's first line: exactly `<!-- jm-review: EVENT sha -->`. */
const REVIEW_HEADER = /^<!-- jm-review: (APPROVE|REQUEST_CHANGES) ([0-9a-f]{40}) -->$/;

/** GitHub's `PULLS_FILES_CAP`: a list this long or longer is not trusted to be whole. */
const PULL_FILES_CAP = 3000;

/** How many times `updateBranch` reads an MR whose rebase is in progress, and the default wait
 *  between reads: about half a minute in all, after which it gives up. */
const REBASE_POLL_TRIES = 30;
const REBASE_POLL_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GitLab's member access levels (Guest 10 is never enough for anything here). */
const ACCESS_REPORTER = 20;
const ACCESS_DEVELOPER = 30;
const ACCESS_MAINTAINER = 40;
const ACCESS_OWNER = 50;

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
  moved_to_id?: number | null;
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
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  merge_error?: string | null;
  rebase_in_progress?: boolean;
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
type RawMember = { username?: string; access_level?: unknown; state?: string | null };
type RawProject = {
  default_branch?: unknown;
  visibility?: unknown;
  namespace?: { kind?: unknown } | null;
  only_allow_merge_if_pipeline_succeeds?: unknown;
};
type RawProtectedBranch = {
  id?: unknown;
  name?: unknown;
  push_access_levels?: { access_level?: unknown }[] | null;
  allow_force_push?: unknown;
  code_owner_approval_required?: unknown;
};
type RawApprovalRule = {
  rule_type?: unknown;
  approvals_required?: unknown;
  protected_branches?: { id?: unknown }[] | null;
};
type RawPipeline = { id: number; status: string };
type RawJob = { name: string; status: string; allow_failure?: boolean };
type RawCommitStatus = { name: string; status: string; allow_failure?: boolean };
type RawApprovals = { approved_by?: { user?: RawUser }[] } | null;
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
  /** The wait between reads of a rebase in progress (default 1000 ms); tests pass 0. */
  rebasePollDelayMs?: number;
};

export class GitLabForge implements Forge {
  private readonly api: string;
  private readonly project: string;
  private readonly projectPath: string;
  private readonly provider: TokenProvider;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly rebasePollDelayMs: number;
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
    this.rebasePollDelayMs = opts.rebasePollDelayMs ?? REBASE_POLL_DELAY_MS;
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
    const state = i.state === 'opened' ? 'open' : 'closed';
    // A plain close reads as completed; a moved issue (closed by the move) does not.
    const completed = state === 'closed' && (i.moved_to_id ?? null) === null;
    return {
      body: i.description ?? '',
      state,
      ...(completed ? { stateReason: 'completed' as const } : {}),
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

  async findIssuesByMarker(marker: string, since: string): Promise<{ number: number }[]> {
    const me = await this.viewerLogin();
    const items = await this.list<RawIssue>('searching issues', '/issues', {
      updated_after: since,
    });
    return items
      .filter((i) => i.author?.username === me && (i.description ?? '').trimEnd().endsWith(marker))
      .map((i) => i.iid)
      .sort((a, b) => a - b)
      .map((number) => ({ number }));
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

  /**
   * An MR's `state` as a PR's `state` and `merged`. `locked` (GitLab carrying out the merge) is
   * open and not yet merged. A state GitLab may add later is refused: reading it as closed would
   * park the item or restore it as abandoned.
   */
  private static pullState(mr: RawMergeRequest): Pick<PullFacts, 'state' | 'merged'> {
    switch (mr.state) {
      case 'opened':
      case 'locked':
        return { state: 'open', merged: false };
      case 'closed':
        return { state: 'closed', merged: false };
      case 'merged':
        return { state: 'closed', merged: true };
      default:
        throw new GitLabForgeError(
          `GitLabForge: reading merge request !${mr.iid} failed: unknown merge request state ${JSON.stringify(mr.state)}`,
        );
    }
  }

  private toPullFacts(mr: RawMergeRequest): PullFacts {
    return {
      number: mr.iid,
      title: mr.title,
      ...GitLabForge.pullState(mr),
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

  // --- Approvals as reviews -----------------------------------------------------------------

  /**
   * Review notes (a well-formed header on the first line) as reviews, oldest first, then one
   * synthetic APPROVED review (`commitId: ''`, `id: 0`) per approver with no review note. An
   * APPROVED note whose author no longer approves reads as DISMISSED.
   */
  async listReviews(number: number): Promise<ForgeReview[]> {
    const n = mrIid(number);
    const [notes, approvals] = await Promise.all([
      this.list<RawNote>(`reading notes on merge request ${n}`, `/merge_requests/${n}/notes`),
      this.request<RawApprovals>(
        `reading the approvals of merge request ${n}`,
        'GET',
        `/merge_requests/${n}/approvals`,
      ),
    ]);
    const approvers = approverNames(approvals);
    const reviewed = new Set<string>();
    const newestNote = new Map<string, RawNote>();
    const out: ForgeReview[] = [];
    for (const note of [...notes].sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0))) {
      const author = note.author?.username ?? '';
      const prev = newestNote.get(author);
      if (!prev || newer(note, prev)) newestNote.set(author, note);
      const review = note.system ? null : parseReviewNote(note.body ?? '');
      if (!review) continue;
      reviewed.add(author);
      const approved = review.event === 'APPROVE';
      out.push({
        id: note.id,
        author,
        state: approved ? (approvers.has(author) ? 'APPROVED' : 'DISMISSED') : 'CHANGES_REQUESTED',
        commitId: review.commitId,
        body: review.body,
        submittedAt: note.created_at ?? '',
      });
    }
    for (const user of approvers) {
      if (reviewed.has(user)) continue;
      // GitLab does not say which commit a UI approval was given on: it approves no head.
      out.push({
        id: 0,
        author: user,
        state: 'APPROVED',
        commitId: '',
        body: '',
        submittedAt: newestNote.get(user)?.created_at ?? '',
      });
    }
    return out;
  }

  /**
   * APPROVE approves at `commitId` (409: the head moved, nothing posted; 401: success only when
   * the viewer already approves, so a retry after a failed note is safe). REQUEST_CHANGES
   * withdraws the viewer's approval (404: there was none). Then one note with the review header.
   */
  async createReview(
    number: number,
    input: { event: 'APPROVE' | 'REQUEST_CHANGES'; body: string; commitId: string },
  ): Promise<{ id: number }> {
    const n = mrIid(number);
    const { event, commitId } = input;
    if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES')
      throw new GitLabForgeError('GitLabForge: a review event must be APPROVE or REQUEST_CHANGES');
    if (typeof commitId !== 'string' || !SHA40.test(commitId))
      throw new GitLabForgeError('GitLabForge: a review commitId must be a 40-hex commit SHA');
    const path = `/merge_requests/${n}`;
    if (event === 'APPROVE') {
      try {
        await this.request(`approving merge request ${n}`, 'POST', `${path}/approve`, {
          sha: commitId,
        });
      } catch (err) {
        if ((err as GitLabForgeError).status !== 401) throw err;
        // GitLab answers 401 for "already approved" too (and the 401 invalidated the token
        // provider, which re-reads the token next time): go on only if the viewer approves.
        const [me, approvals] = await Promise.all([
          this.viewerLogin(),
          this.request<RawApprovals>(
            `reading the approvals of merge request ${n}`,
            'GET',
            `${path}/approvals`,
          ),
        ]);
        if (!approverNames(approvals).has(me)) throw err;
      }
    } else {
      try {
        await this.request(
          `withdrawing approval of merge request ${n}`,
          'POST',
          `${path}/unapprove`,
        );
      } catch (err) {
        if ((err as GitLabForgeError).status !== 404) throw err;
      }
    }
    const note = await this.request<{ id: number }>(
      `posting a review on merge request ${n}`,
      'POST',
      `${path}/notes`,
      { body: `${reviewHeader(event, commitId)}\n${input.body}` },
    );
    return { id: note.id };
  }

  /** The viewer's newest review note whose body's last line is `marker`; never a synthetic one. */
  async findReviewByMarker(number: number, marker: string): Promise<{ id: number } | null> {
    mrIid(number);
    const me = await this.viewerLogin();
    const reviews = await this.listReviews(number);
    const hits = reviews.filter(
      (r) => r.author === me && r.id !== 0 && r.body.trimEnd().split('\n').pop() === marker,
    );
    const hit = hits.at(-1);
    return hit ? { id: hit.id } : null;
  }

  // --- Pipelines and jobs as checks ---------------------------------------------------------

  /**
   * The pipelines on `sha`, newest first, with their effective jobs: each pipeline's current
   * (not retried) jobs whose name no newer pipeline's job already took.
   */
  private async pipelineJobs(
    sha: string,
  ): Promise<{ pipeline: RawPipeline; jobs: RawJob[]; jobless: boolean }[]> {
    const pipelines = await this.list<RawPipeline>('listing pipelines', '/pipelines', {
      sha,
      order_by: 'id',
      sort: 'desc',
    });
    const seen = new Set<string>();
    const out: { pipeline: RawPipeline; jobs: RawJob[]; jobless: boolean }[] = [];
    for (const pipeline of pipelines) {
      const current = await this.list<RawJob>(
        `listing the jobs of pipeline ${pipeline.id}`,
        `/pipelines/${positiveId(pipeline.id)}/jobs`,
      );
      const jobs = current.filter((j) => !seen.has(j.name));
      for (const j of jobs) seen.add(j.name);
      out.push({ pipeline, jobs, jobless: current.length === 0 });
    }
    return out;
  }

  async checksFor(sha: string): Promise<ChecksFacts> {
    const [pipelines, statuses] = await Promise.all([
      this.pipelineJobs(sha),
      this.list<RawCommitStatus>(
        'listing commit statuses',
        `/repository/commits/${encodeURIComponent(sha)}/statuses`,
      ),
    ]);
    const jobs = pipelines.flatMap((p) => p.jobs);
    const jobNames = new Set(jobs.map((j) => j.name));
    // Real GitLab lists CI jobs among a commit's statuses too: a job's name is counted once.
    const external = statuses.filter((s) => !jobNames.has(s.name));
    // The required check `pipeline` (Pipelines must succeed, `getBranchRules`) is named once any
    // pipeline runs on `sha`; `state` says whether it passed. An external status never names it.
    const names = [
      ...new Set([
        ...(pipelines.length > 0 ? [PIPELINE_CHECK] : []),
        ...jobs.map((j) => j.name),
        ...external.map((s) => s.name).filter((n) => n !== PIPELINE_CHECK),
      ]),
    ];
    const failures: FailedCheck[] = [];
    let failed = false;
    let pending = false;
    for (const { pipeline, jobless } of pipelines) {
      if (!jobless) continue;
      // No job to name (say a .gitlab-ci.yml error): the pipeline's own status counts.
      const outcome = pipelineOutcome(pipeline.status);
      if (outcome === 'failure') failed = true;
      else if (outcome === 'pending') pending = true;
    }
    for (const c of [...jobs, ...external]) {
      const outcome = checkOutcome(c.status, c.allow_failure === true);
      if (outcome === 'pending') pending = true;
      else if (outcome !== 'done') failures.push({ name: c.name, conclusion: outcome.conclusion });
    }
    const state: ChecksState =
      failed || failures.length > 0
        ? 'failure'
        : pending
          ? 'pending'
          : pipelines.length === 0 && statuses.length === 0
            ? 'none'
            : 'success';
    const queued = [
      ...new Set(jobs.filter((j) => NOT_STARTED.has(j.status)).map((j) => j.name)),
    ].sort();
    const facts = { state, names, failed: uniqueFailures(failures) };
    return queued.length > 0 ? { ...facts, queued } : facts;
  }

  /** GitLab has no check-run annotations: none, and no request. */
  async checkAnnotations(_checkRunId: number): Promise<CheckAnnotation[]> {
    return [];
  }

  /**
   * Retries (`POST pipelines/:id/retry`) each pipeline on `headSha` that owns an effective job
   * named in `names` that failed (not allowed to) or was canceled; once each, newest first.
   * `running` is always false.
   */
  async rerunFailedChecks(
    _prNumber: number,
    headSha: string,
    names: string[],
  ): Promise<{ runIds: number[]; running: boolean }> {
    const wanted = new Set(names);
    const runIds = (await this.pipelineJobs(headSha))
      .filter(({ jobs }) =>
        jobs.some((j) => {
          if (!wanted.has(j.name)) return false;
          const outcome = checkOutcome(j.status, j.allow_failure === true);
          return outcome !== 'done' && outcome !== 'pending';
        }),
      )
      .map(({ pipeline }) => pipeline.id);
    for (const id of runIds)
      await this.request(`retrying pipeline ${id}`, 'POST', `/pipelines/${positiveId(id)}/retry`);
    // It retries single jobs, never a pipeline still running as GitHub refuses: never waits.
    return { runIds, running: false };
  }

  // --- Blocked-by: a no-op and a refusal -----------------------------------------------------

  /** GitLab Free has no "blocked by" links: none, nothing unreadable, and no request. */
  async listBlockedBy(_number: number): Promise<BlockedByList> {
    return { blockers: [], unreadable: 0 };
  }

  async addBlockedBy(_issue: number, _blocker: number): Promise<void> {
    throw new GitLabUnsupportedError('addBlockedBy');
  }

  // --- Access --------------------------------------------------------------------------------

  /** Developer (30) or above, read from `members/all` (inherited members too). */
  async isTrusted(login: string): Promise<boolean> {
    return (await this.memberLevel(login)) >= ACCESS_DEVELOPER;
  }

  /** Maintainer (40) or above, read as `isTrusted`. */
  async isMaintainer(login: string): Promise<boolean> {
    return (await this.memberLevel(login)) >= ACCESS_MAINTAINER;
  }

  /**
   * `login`'s effective access level: 0 unless a member of `members/all` has exactly that username
   * (`query` only filters, by substring) and an `active` state, or none at all.
   */
  private async memberLevel(login: string): Promise<number> {
    const members = await this.list<RawMember>('listing members', '/members/all', {
      query: login,
    });
    const m = members.find((x) => x?.username === login);
    if (!m) return 0;
    if (m.state !== undefined && m.state !== null && m.state !== 'active') return 0;
    return typeof m.access_level === 'number' ? m.access_level : 0;
  }

  private async readProject(): Promise<RawProject> {
    const p = await this.request<RawProject | null>('reading the project', 'GET', '');
    if (!p || typeof p !== 'object')
      throw new GitLabForgeError('GitLabForge: reading the project failed: not an object');
    return p;
  }

  /** The project's "Pipelines must succeed": a project setting, not a branch rule (#936). */
  async pipelinesMustSucceed(): Promise<boolean> {
    const project = await this.readProject();
    return project.only_allow_merge_if_pipeline_succeeds === true;
  }

  // --- Branch rules, merge and rebase ---------------------------------------------------------

  /**
   * The protected-branch entries matching `branch` (exact or `*` glob), combined most permissively
   * as GitLab applies them, with the approval rules and settings that govern it; see the header.
   */
  async getBranchRules(branch: string): Promise<BranchRulesRead> {
    let entries: RawProtectedBranch[];
    try {
      entries = await this.list<RawProtectedBranch>(
        'listing protected branches',
        '/protected_branches',
      );
    } catch (err) {
      if (isRefusal(err)) return { kind: 'unreachable' };
      throw err;
    }
    const matching = entries.filter(
      (e) => typeof e?.name === 'string' && matchesProtectedPattern(e.name, branch),
    );
    if (matching.length === 0) return { kind: 'none' };

    const level = await this.viewerLevel();
    if (level === null) return { kind: 'unreachable' };
    const canPush = matching.some((e) =>
      (e.push_access_levels ?? []).some(
        (a) => typeof a?.access_level === 'number' && a.access_level > 0 && level >= a.access_level,
      ),
    );

    let rules: RawApprovalRule[] = [];
    let approvalRules: 'read' | 'unavailable' = 'read';
    try {
      rules = await this.list<RawApprovalRule>('listing approval rules', '/approval_rules');
    } catch (err) {
      // The Free tier: GitLab enforces no approvals.
      if (!isRefusal(err)) throw err;
      approvalRules = 'unavailable';
    }
    const ids = new Set<unknown>(matching.map((e) => e.id).filter((id) => typeof id === 'number'));
    let requiredApprovals = 0;
    for (const r of rules) {
      if (r?.rule_type !== 'regular' && r?.rule_type !== 'any_approver') continue;
      const scoped = r.protected_branches ?? [];
      if (scoped.length > 0 && !scoped.some((b) => ids.has(b?.id))) continue;
      if (typeof r.approvals_required === 'number' && r.approvals_required > requiredApprovals)
        requiredApprovals = r.approvals_required;
    }

    let dismissStaleOnPush = false;
    try {
      const a = await this.request<{ reset_approvals_on_push?: unknown } | null>(
        'reading the approval settings',
        'GET',
        '/approvals',
      );
      dismissStaleOnPush = a?.reset_approvals_on_push === true;
    } catch (err) {
      if (!isRefusal(err)) throw err;
    }

    const project = await this.readProject();
    return {
      kind: 'ok',
      rules: {
        requiredApprovals,
        dismissStaleOnPush,
        requiredChecks:
          project.only_allow_merge_if_pipeline_succeeds === true ? [PIPELINE_CHECK] : [],
        unpinnedChecks: [],
        viewerCanBypass: canPush,
        viewerIsAdmin: level >= ACCESS_MAINTAINER,
        requiresPullRequest: !canPush,
        requireCodeOwnerReview: matching.some((e) => e.code_owner_approval_required === true),
        approvalRules,
      },
    };
  }

  /**
   * The token's user's access level, as `repoAccess` reads it: `GET /user`, then
   * `GET members/all/:id` (404: level 0). A 403 on the member read gives null.
   */
  private async viewerLevel(): Promise<number | null> {
    const { json: me } = await this.send('reading the user', 'GET', `${this.api}/user`);
    const id = (me as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
      throw new GitLabForgeError('GitLabForge: the user has no id');
    try {
      const m = await this.request<RawMember | null>(
        'reading the user’s access level',
        'GET',
        `/members/all/${id}`,
      );
      return typeof m?.access_level === 'number' ? m.access_level : 0;
    } catch (err) {
      const status = (err as GitLabForgeError).status;
      if (status === 404) return 0;
      if (status === 403) return null;
      throw err;
    }
  }

  /**
   * Squash-merges MR `number`, pinned to `input.sha` (refused unsent unless 40-hex). 409 (the head
   * moved) rejects with 409; 405 and 406 (not mergeable, a conflict) reject with 405.
   */
  async merge(
    number: number,
    input: { sha: string; method: 'squash'; title: string; message: string },
  ): Promise<{ merged: boolean; sha?: string }> {
    const n = mrIid(number);
    if (!SHA40.test(input.sha))
      throw new GitLabForgeError('GitLabForge: a merge needs a full 40-hex head SHA');
    let mr: RawMergeRequest;
    try {
      mr = await this.request<RawMergeRequest>(
        `merging merge request ${n}`,
        'PUT',
        `/merge_requests/${n}/merge`,
        {
          sha: input.sha,
          squash: true,
          squash_commit_message:
            input.message === '' ? input.title : `${input.title}\n\n${input.message}`,
        },
      );
    } catch (err) {
      const status = (err as GitLabForgeError).status;
      if (status === 406)
        throw new GitLabForgeError(
          `GitLabForge: merging merge request ${n} failed: HTTP 406 (not mergeable)`,
          405,
        );
      throw err;
    }
    const sha = mr?.squash_commit_sha || mr?.merge_commit_sha;
    return sha ? { merged: mr.state === 'merged', sha } : { merged: mr?.state === 'merged' };
  }

  /**
   * Rebases MR `prNumber`'s source branch onto its target, when its head is still
   * `expectedHeadSha`; see the header for the race this leaves.
   */
  async updateBranch(prNumber: number, expectedHeadSha: string): Promise<BranchUpdate> {
    const n = mrIid(prNumber);
    const mr = await this.request<RawMergeRequest>(
      `reading merge request ${n}`,
      'GET',
      `/merge_requests/${n}`,
    );
    if (mr?.sha !== expectedHeadSha) return { kind: 'head_moved' };
    const { status } = await this.send(
      `rebasing merge request ${n}`,
      'PUT',
      `${this.project}/merge_requests/${n}/rebase`,
      {},
    );
    if (status !== 202)
      throw new GitLabForgeError(
        `GitLabForge: rebasing merge request ${n} failed: HTTP ${status}, not 202`,
        status,
      );
    for (let attempt = 0; attempt < REBASE_POLL_TRIES; attempt++) {
      if (attempt > 0) await sleep(this.rebasePollDelayMs);
      const now = await this.request<RawMergeRequest>(
        `reading merge request ${n}`,
        'GET',
        `/merge_requests/${n}?include_rebase_in_progress=true`,
      );
      if (now?.rebase_in_progress === true) continue;
      return typeof now?.merge_error === 'string' && now.merge_error !== ''
        ? { kind: 'conflict' }
        : { kind: 'updated' };
    }
    throw new GitLabForgeError(
      `GitLabForge: rebasing merge request ${n} failed: still in progress after ${REBASE_POLL_TRIES} reads`,
    );
  }
  /**
   * The project (visibility, default branch, namespace), the token's user and its member access
   * level (a 404 is level 0), and the token's own scopes and expiry (a 401 or 404 there gives
   * null for both: not every token can read itself).
   */
  async repoAccess(): Promise<RepoAccess> {
    const project = await this.readProject();
    const ownerType = namespaceOwnerType(project);
    const { json: me } = await this.send('reading the user', 'GET', `${this.api}/user`);
    const id = (me as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
      throw new GitLabForgeError('GitLabForge: the user has no id');
    let level = 0;
    try {
      const m = await this.request<RawMember | null>(
        'reading the user’s access level',
        'GET',
        `/members/all/${id}`,
      );
      if (typeof m?.access_level === 'number') level = m.access_level;
    } catch (err) {
      if ((err as GitLabForgeError).status !== 404) throw err;
    }
    let scopes: string[] | null = null;
    let tokenExpiresAt: string | null = null;
    try {
      const { json } = await this.send(
        'reading the token',
        'GET',
        `${this.api}/personal_access_tokens/self`,
      );
      const t = json as { scopes?: unknown; expires_at?: unknown } | null;
      if (Array.isArray(t?.scopes) && t.scopes.every((x) => typeof x === 'string'))
        scopes = t.scopes as string[];
      if (typeof t?.expires_at === 'string') tokenExpiresAt = t.expires_at;
    } catch (err) {
      const status = (err as GitLabForgeError).status;
      if (status !== 401 && status !== 404) throw err;
    }
    return {
      private: project.visibility !== 'public',
      defaultBranch: typeof project.default_branch === 'string' ? project.default_branch : '',
      permissions: {
        admin: level >= ACCESS_OWNER,
        maintain: level >= ACCESS_MAINTAINER,
        push: level >= ACCESS_DEVELOPER,
        triage: level >= ACCESS_REPORTER,
        pull: level >= ACCESS_REPORTER,
      },
      scopes,
      tokenExpiresAt,
      ownerType,
    };
  }

  /** The project's `namespace.kind`: `user` is a User, `group` an Organization. */
  async ownerType(): Promise<'User' | 'Organization'> {
    return namespaceOwnerType(await this.readProject());
  }

  // --- Later slices --------------------------------------------------------------------------

  async probeReads(_sha: string): Promise<ReadProbe[]> {
    throw new GitLabUnsupportedError('probeReads');
  }
  async probeAdministration(): Promise<ReadProbe> {
    throw new GitLabUnsupportedError('probeAdministration');
  }
}

/** A refusal GitLab gives a token that may not read something (or a tier without it): 403 or 404. */
function isRefusal(err: unknown): boolean {
  const status = err instanceof GitLabForgeError ? err.status : 0;
  return status === 403 || status === 404;
}

/** Whether `branch` matches protected-branch `pattern`: exact, or GitLab's `*` glob, which matches
 *  any run of characters, `/` included. */
function matchesProtectedPattern(pattern: string, branch: string): boolean {
  if (!pattern.includes('*')) return pattern === branch;
  const re = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`, 's').test(branch);
}

/** The owner type of a project's `namespace.kind`; any other kind is refused without echoing it. */
function namespaceOwnerType(p: RawProject): 'User' | 'Organization' {
  const kind = p.namespace?.kind;
  if (kind === 'user') return 'User';
  if (kind === 'group') return 'Organization';
  throw new GitLabForgeError('GitLabForge: the project namespace kind is neither user nor group');
}

/**
 * The required check name standing for GitLab's "Pipelines must succeed": `getBranchRules` requires
 * it, and `checksFor` names it whenever a pipeline ran on the commit.
 */
export const PIPELINE_CHECK = 'pipeline';

/** A pipeline id GitLab gave, as a path segment; anything but a positive integer is refused. */
function positiveId(id: unknown): string {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    throw new GitLabForgeError('GitLabForge: a pipeline id is not a positive integer');
  return String(id);
}

/** Job states that mean "not started yet": no runner has picked the job up. */
const NOT_STARTED = new Set([
  'created',
  'pending',
  'waiting_for_resource',
  'preparing',
  'scheduled',
]);

/**
 * A job's or commit status's state as a check: done, a failure (with GitHub's conclusion), or
 * pending. An unknown state (`canceling`, say) is pending: never done.
 */
function checkOutcome(
  status: string,
  allowFailure: boolean,
): 'done' | 'pending' | { conclusion: string } {
  if (status === 'success' || status === 'skipped') return 'done';
  if (status === 'manual') return allowFailure ? 'done' : 'pending';
  if (status === 'failed') return allowFailure ? 'done' : { conclusion: 'failure' };
  if (status === 'canceled') return { conclusion: 'cancelled' };
  return 'pending';
}

/** Failures sorted by name then conclusion, without duplicates (as GitHubForge's `uniqueFailures`). */
function uniqueFailures(failures: FailedCheck[]): FailedCheck[] {
  const byKey = new Map(failures.map((f) => [JSON.stringify([f.name, f.conclusion]), f]));
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byKey.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.conclusion, b.conclusion));
}

/** A pipeline with no jobs, by its own status: success or skipped is done, failed or canceled
 *  a failure, anything else pending. */
function pipelineOutcome(status: string): 'done' | 'failure' | 'pending' {
  if (status === 'success' || status === 'skipped') return 'done';
  if (status === 'failed' || status === 'canceled') return 'failure';
  return 'pending';
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

const reviewHeader = (event: 'APPROVE' | 'REQUEST_CHANGES', commitId: string) =>
  `<!-- jm-review: ${event} ${commitId} -->`;

/** A note's review header and the body after it, or null when its first line is not a header. */
function parseReviewNote(
  body: string,
): { event: 'APPROVE' | 'REQUEST_CHANGES'; commitId: string; body: string } | null {
  const nl = body.indexOf('\n');
  const first = nl === -1 ? body : body.slice(0, nl);
  const m = REVIEW_HEADER.exec(first);
  if (!m) return null;
  return {
    event: m[1] as 'APPROVE' | 'REQUEST_CHANGES',
    commitId: m[2] as string,
    body: nl === -1 ? '' : body.slice(nl + 1),
  };
}

/** The usernames in an approvals response's `approved_by`. */
function approverNames(a: RawApprovals): Set<string> {
  const names = new Set<string>();
  for (const e of Array.isArray(a?.approved_by) ? a.approved_by : []) {
    const u = e?.user?.username;
    if (typeof u === 'string' && u !== '') names.add(u);
  }
  return names;
}
