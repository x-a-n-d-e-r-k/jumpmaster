// A recording fake GitLab (REST API v4) built on nock, for the `GitLabForge` tests (issue #668).
// It answers `${baseUrl}/api/v4/...` from in-memory state for one project, and never lets a
// request through to the network: any route it doesn't know answers 404. Every request is
// recorded without its token. Later slices add the endpoints they need here.
import { createHash } from 'node:crypto';
import nock from 'nock';
import { gitBlobSha } from '../forge/github.js';

/** GitLab's access levels. */
export const ACCESS = {
  guest: 10,
  reporter: 20,
  developer: 30,
  maintainer: 40,
  owner: 50,
} as const;

export type FakeGitLabProject = {
  id: number;
  /** `group/sub/project`. */
  path: string;
  defaultBranch?: string;
  visibility?: 'private' | 'internal' | 'public';
};

export type RecordedRequest = {
  method: string;
  /** The URL path as sent, `/api/v4/...` (with the project path still encoded). */
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** The caller's username, `null` with no token, `"<unknown>"` when the token matched no user. */
  user: string | null;
};

/** A commit in the fake's in-memory repository: a full file snapshot, path → UTF-8 content. */
export type FakeCommit = {
  id: string;
  parent_ids: string[];
  message: string;
  files: Record<string, string>;
};
export type GitLabCommit = {
  id: string;
  short_id: string;
  parent_ids: string[];
  message: string;
  title: string;
};
export type GitLabDiff = {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
};

export type GitLabUser = { id: number; username: string; name: string };
export type GitLabIssue = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  labels: string[];
  author: GitLabUser;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};
export type GitLabDiffRefs = { base_sha: string; start_sha: string; head_sha: string };
export type GitLabMergeRequest = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged';
  source_branch: string;
  target_branch: string;
  /** The source branch's head, kept current while the MR is open. */
  sha: string;
  source_project_id: number;
  target_project_id: number;
  author: GitLabUser;
  labels: string[];
  web_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  diff_refs: GitLabDiffRefs;
  /** GitLab's `changes_count` (a string, `"1000+"` when the diff overflows). The single-MR read
   *  reports the count of its diff files unless a test sets this; `null` leaves it out. */
  changes_count?: string | null;
};
export type GitLabLabel = { id: number; name: string; color: string; description: string | null };
export type GitLabNote = {
  id: number;
  body: string;
  author: GitLabUser;
  created_at: string;
  updated_at: string;
  system: boolean;
  noteable_type: 'Issue' | 'MergeRequest';
  noteable_iid: number;
};

export type GitLabPipelineStatus =
  | 'created'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual';
export type GitLabPipeline = {
  id: number;
  iid: number;
  project_id: number;
  sha: string;
  ref: string;
  status: GitLabPipelineStatus;
  source: string;
  web_url: string;
  created_at: string;
  updated_at: string;
};
export type GitLabJobStatus = GitLabPipelineStatus;
export type GitLabJob = {
  id: number;
  name: string;
  stage: string;
  status: GitLabJobStatus;
  allow_failure: boolean;
  ref: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  web_url: string;
  pipeline: {
    id: number;
    iid: number;
    project_id: number;
    sha: string;
    ref: string;
    status: GitLabPipelineStatus;
  };
};
export type GitLabCommitStatusState = 'pending' | 'running' | 'success' | 'failed' | 'canceled';
export type GitLabCommitStatus = {
  id: number;
  sha: string;
  ref: string | null;
  status: GitLabCommitStatusState;
  name: string;
  target_url: string | null;
  description: string | null;
  allow_failure: boolean;
  author: GitLabUser;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type User = GitLabUser & { token?: string; accessLevel?: number; scopes: string[] };
type Reply = [number, unknown] | [number, unknown, Record<string, string>];
type Ctx = {
  method: string;
  query: URLSearchParams;
  params: Record<string, unknown>;
  user: User;
  level: number;
};

const API = '/api/v4';
const TOKEN_PARAMS = ['private_token', 'access_token'];
const REDACTED = '[redacted]';

const err = (status: number, message: string): Reply => [status, { message }];
const NOT_FOUND = err(404, '404 Not Found');
const PROJECT_NOT_FOUND = err(404, '404 Project Not Found');
const UNAUTHORIZED = err(401, '401 Unauthorized');
const FORBIDDEN = err(403, '403 Forbidden');
const INSUFFICIENT_SCOPE: Reply = [
  403,
  {
    error: 'insufficient_scope',
    error_description: 'The request requires higher privileges than provided by the access token.',
    scope: 'api',
  },
];

const publicUser = (u: User): GitLabUser => ({ id: u.id, username: u.username, name: u.name });

/** A comma-separated string or an array, as GitLab accepts for label lists. */
function labelList(v: unknown): string[] {
  const parts = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}

/** One page of `items`, with GitLab's pagination headers. */
function paged<T>(items: T[], query: URLSearchParams): Reply {
  const int = (name: string) => {
    const n = Number.parseInt(query.get(name) ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const perPage = Math.min(int('per_page') ?? 20, 100);
  const page = int('page') ?? 1;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return [
    200,
    slice,
    {
      'x-page': String(page),
      'x-per-page': String(perPage),
      'x-total': String(total),
      'x-total-pages': String(totalPages),
      'x-next-page': page < totalPages ? String(page + 1) : '',
      'x-prev-page': page > 1 ? String(Math.min(page - 1, totalPages)) : '',
    },
  ];
}

function parseBody(text: string, contentType: string): unknown {
  if (!text) return undefined;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.includes('x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(text));
  return text;
}

/** `value` with every occurrence of a secret in its strings replaced. */
function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string')
    return secrets.reduce((s, t) => (t ? s.split(t).join(REDACTED) : s), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        TOKEN_PARAMS.includes(k) ? REDACTED : redact(v, secrets),
      ]),
    );
  return value;
}

const SHA = /^[0-9a-f]{40}$/;
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A commit's SHA: sha1 over an unambiguous serialization of its parents, message and files. */
function commitSha(parents: string[], message: string, files: Record<string, string>): string {
  const sorted = Object.keys(files)
    .sort(byPath)
    .map((p) => [p, files[p]]);
  return createHash('sha1')
    .update(JSON.stringify({ parents, message, files: sorted }))
    .digest('hex');
}

/** A file's lines: split on `\n`, one trailing `\n` adds no empty line, empty content has none. */
function lines(content: string): string[] {
  if (content === '') return [];
  return (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
}

/** One whole-file hunk from `before` to `after`. */
function hunk(before: string, after: string): string {
  const a = lines(before);
  const b = lines(after);
  return [
    `@@ -1,${a.length} +1,${b.length} @@\n`,
    ...a.map((l) => `-${l}\n`),
    ...b.map((l) => `+${l}\n`),
  ].join('');
}

/** The diffs from snapshot `from` to snapshot `to`, sorted by `new_path`, renames paired. */
function snapshotDiffs(from: Record<string, string>, to: Record<string, string>): GitLabDiff[] {
  const has = (o: Record<string, string>, p: string) => Object.hasOwn(o, p);
  const gone = Object.keys(from)
    .filter((p) => !has(to, p))
    .sort(byPath);
  const added = Object.keys(to)
    .filter((p) => !has(from, p))
    .sort(byPath);
  const out: GitLabDiff[] = [];
  const paired = new Set<string>();
  for (const old of gone) {
    const match = added.find((p) => !paired.has(p) && to[p] === from[old]);
    if (match !== undefined) {
      paired.add(match);
      paired.add(old);
      out.push({
        old_path: old,
        new_path: match,
        new_file: false,
        renamed_file: true,
        deleted_file: false,
        diff: '',
      });
    }
  }
  const entry = (old_path: string, new_path: string, kind: 'new' | 'deleted' | 'changed') => ({
    old_path,
    new_path,
    new_file: kind === 'new',
    renamed_file: false,
    deleted_file: kind === 'deleted',
    diff: hunk(
      kind === 'new' ? '' : (from[old_path] ?? ''),
      kind === 'deleted' ? '' : (to[new_path] ?? ''),
    ),
  });
  for (const p of gone) if (!paired.has(p)) out.push(entry(p, p, 'deleted'));
  for (const p of added) if (!paired.has(p)) out.push(entry(p, p, 'new'));
  for (const p of Object.keys(to))
    if (has(from, p) && from[p] !== to[p]) out.push(entry(p, p, 'changed'));
  return out.sort((a, b) => byPath(a.new_path, b.new_path) || byPath(a.old_path, b.old_path));
}

/** A URL path segment, decoded; `undefined` when it isn't valid percent-encoding. */
function decodeSegment(s: string | undefined): string | undefined {
  try {
    return decodeURIComponent(s ?? '');
  } catch {
    return undefined;
  }
}

export type GitLabApprovals = {
  approved: boolean;
  approved_by: { user: GitLabUser }[];
  approvals_required: number;
  approvals_left: number;
};

export function fakeGitLab(opts: {
  baseUrl: string;
  project: FakeGitLabProject;
  approvals?: {
    /** Approvals count only while the source branch stays on the head they were given on
     *  (default `true`). */
    resetOnPush?: boolean;
    /** Whether an MR's author may approve it (default `false`, as on GitLab). */
    authorCanApprove?: boolean;
  };
}) {
  const base = new URL(opts.baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, '')}${API}`;
  const project = {
    id: opts.project.id,
    path: opts.project.path,
    defaultBranch: opts.project.defaultBranch ?? 'main',
    visibility: opts.project.visibility ?? 'private',
  };

  const requests: RecordedRequest[] = [];
  /** `METHOD path` of each request to a route the fake doesn't know. */
  const unknown: string[] = [];
  const users: User[] = [];
  const issues: GitLabIssue[] = [];
  const labels: GitLabLabel[] = [];
  const notes: GitLabNote[] = [];
  let nextId = 1000;
  const newId = () => ++nextId;

  // A clock that never repeats, so every write strictly bumps `updated_at`.
  let lastMs = 0;
  const now = () => {
    lastMs = Math.max(Date.now(), lastMs + 1);
    return new Date(lastMs).toISOString();
  };

  function ensureUser(username: string): User {
    const found = users.find((u) => u.username === username);
    if (found) return found;
    const u: User = { id: newId(), username, name: username, scopes: [] };
    users.push(u);
    return u;
  }

  function ensureLabel(name: string): GitLabLabel {
    const found = labels.find((l) => l.name === name);
    if (found) return found;
    const l: GitLabLabel = { id: newId(), name, color: '#6699cc', description: null };
    labels.push(l);
    return l;
  }

  function addIssue(i: {
    iid?: number;
    title: string;
    description?: string | null;
    state?: 'opened' | 'closed';
    labels?: string[];
    author?: string;
    createdAt?: string;
    updatedAt?: string;
  }): GitLabIssue {
    const createdAt = i.createdAt ?? now();
    const state = i.state ?? 'opened';
    const issue: GitLabIssue = {
      id: newId(),
      iid: i.iid ?? Math.max(0, ...issues.map((x) => x.iid)) + 1,
      project_id: project.id,
      title: i.title,
      description: i.description ?? null,
      state,
      labels: labelList(i.labels ?? []),
      author: publicUser(ensureUser(i.author ?? 'root')),
      created_at: createdAt,
      updated_at: i.updatedAt ?? createdAt,
      closed_at: state === 'closed' ? (i.updatedAt ?? createdAt) : null,
    };
    for (const l of issue.labels) ensureLabel(l);
    issues.push(issue);
    return issue;
  }

  function addNote(n: {
    issueIid?: number;
    mergeRequestIid?: number;
    body: string;
    author?: string;
    system?: boolean;
    createdAt?: string;
  }): GitLabNote {
    const onIssue = n.issueIid !== undefined;
    const iid = n.issueIid ?? n.mergeRequestIid;
    if (iid === undefined) throw new Error('seedNote needs issueIid or mergeRequestIid');
    const at = n.createdAt ?? now();
    const note: GitLabNote = {
      id: newId(),
      body: n.body,
      author: publicUser(ensureUser(n.author ?? 'root')),
      created_at: at,
      updated_at: at,
      system: n.system ?? false,
      noteable_type: onIssue ? 'Issue' : 'MergeRequest',
      noteable_iid: iid,
    };
    notes.push(note);
    return note;
  }

  const member = (u: User) =>
    u.accessLevel !== undefined && u.accessLevel > 0
      ? { id: u.id, username: u.username, name: u.name, access_level: u.accessLevel }
      : undefined;
  const members = () => users.flatMap((u) => member(u) ?? []);

  /** Issues newest first, as GitLab orders them by default. */
  const byNewest = <T extends { created_at: string; id: number }>(a: T, b: T) =>
    b.created_at.localeCompare(a.created_at) || b.id - a.id;

  // --- Project routes -----------------------------------------------------------------------

  type Handler = (c: Ctx, m: string[]) => Reply;
  type ProjectRoute = { method: string; path: RegExp; write: boolean; handle: Handler };
  const routes: ProjectRoute[] = [];
  const route = (method: string, path: RegExp, handle: Handler) =>
    routes.push({ method, path, write: method !== 'GET', handle });

  const findIssue = (iid: string | undefined) => issues.find((i) => String(i.iid) === iid);
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

  route('GET', /^$/, () => [
    200,
    {
      id: project.id,
      path_with_namespace: project.path,
      default_branch: project.defaultBranch,
      visibility: project.visibility,
    },
  ]);

  route('GET', /^\/members\/all$/, (c) => {
    const q = c.query.get('query')?.toLowerCase();
    const list = members().filter(
      (m) => !q || m.username.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
    return paged(list, c.query);
  });
  route('GET', /^\/members\/all\/(\d+)$/, (_c, m) => {
    const found = members().find((x) => String(x.id) === m[1]);
    return found ? [200, found] : err(404, '404 Not found');
  });

  route('GET', /^\/issues$/, (c) => {
    const state = c.query.get('state') ?? 'all';
    const wanted = labelList(c.query.get('labels') ?? '');
    const after = c.query.get('updated_after');
    const afterMs = after ? Date.parse(after) : undefined;
    const list = issues
      .filter((i) => state === 'all' || i.state === state)
      .filter((i) => wanted.every((l) => i.labels.includes(l)))
      .filter((i) => afterMs === undefined || Date.parse(i.updated_at) > afterMs)
      .sort(byNewest);
    return paged(list, c.query);
  });
  route('GET', /^\/issues\/(\d+)$/, (_c, m) => {
    const issue = findIssue(m[1]);
    return issue ? [200, issue] : err(404, '404 Issue Not Found');
  });
  route('POST', /^\/issues$/, (c) => {
    if (c.level < ACCESS.guest) return FORBIDDEN;
    const title = str(c.params.title);
    if (!title) return [400, { error: 'title is missing' }];
    const issue = addIssue({
      title,
      description: str(c.params.description) ?? null,
      labels: labelList(c.params.labels),
      author: c.user.username,
    });
    return [201, issue];
  });
  route('PUT', /^\/issues\/(\d+)$/, (c, m) => {
    const issue = findIssue(m[1]);
    if (!issue) return err(404, '404 Issue Not Found');
    const isAuthor = issue.author.username === c.user.username;
    if (c.level < ACCESS.reporter && !(isAuthor && c.level >= ACCESS.guest)) return FORBIDDEN;
    const p = c.params;
    if (p.title !== undefined) issue.title = String(p.title);
    if (p.description !== undefined) issue.description = str(p.description) ?? null;
    if (p.labels !== undefined) issue.labels = labelList(p.labels);
    for (const l of labelList(p.add_labels)) if (!issue.labels.includes(l)) issue.labels.push(l);
    const remove = labelList(p.remove_labels);
    issue.labels = issue.labels.filter((l) => !remove.includes(l));
    for (const l of issue.labels) ensureLabel(l);
    const at = now();
    if (p.state_event === 'close' && issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closed_at = at;
    } else if (p.state_event === 'reopen' && issue.state !== 'opened') {
      issue.state = 'opened';
      issue.closed_at = null;
    }
    issue.updated_at = at;
    return [200, issue];
  });

  route('GET', /^\/labels$/, (c) => paged([...labels], c.query));
  route('POST', /^\/labels$/, (c) => {
    if (c.level < ACCESS.reporter) return FORBIDDEN;
    const name = str(c.params.name)?.trim();
    const color = str(c.params.color);
    if (!name) return [400, { error: 'name is missing' }];
    if (!color) return [400, { error: 'color is missing' }];
    if (labels.some((l) => l.name === name)) return err(409, 'Label already exists');
    const label: GitLabLabel = {
      id: newId(),
      name,
      color,
      description: str(c.params.description) ?? null,
    };
    labels.push(label);
    return [201, label];
  });

  const notesOf = (type: GitLabNote['noteable_type'], iid: string | undefined) =>
    notes.filter((n) => n.noteable_type === type && String(n.noteable_iid) === iid).sort(byNewest);
  route('GET', /^\/issues\/(\d+)\/notes$/, (c, m) => {
    if (!findIssue(m[1])) return err(404, '404 Issue Not Found');
    return paged(notesOf('Issue', m[1]), c.query);
  });
  route('POST', /^\/issues\/(\d+)\/notes$/, (c, m) => {
    const issue = findIssue(m[1]);
    if (!issue) return err(404, '404 Issue Not Found');
    if (c.level < ACCESS.guest) return FORBIDDEN;
    const body = str(c.params.body);
    if (!body) return [400, { error: 'body is missing' }];
    const note = addNote({ issueIid: issue.iid, body, author: c.user.username });
    issue.updated_at = note.created_at;
    return [201, note];
  });
  route('GET', /^\/merge_requests\/(\d+)\/notes$/, (c, m) =>
    paged(notesOf('MergeRequest', m[1]), c.query),
  );

  // --- Repository -----------------------------------------------------------------------------

  const commits = new Map<string, FakeCommit>();
  /** Branch name → commit SHA. */
  const branches = new Map<string, string>();

  function makeCommit(parents: string[], message: string, files: Record<string, string>): string {
    const id = commitSha(parents, message, files);
    if (!commits.has(id))
      commits.set(id, { id, parent_ids: [...parents], message, files: { ...files } });
    return id;
  }
  branches.set(project.defaultBranch, makeCommit([], 'Initial commit', {}));

  /** The commit SHA a ref (a full SHA or a branch name) names. */
  const resolve = (ref: string | undefined | null): string | undefined => {
    if (ref === undefined || ref === null) return undefined;
    if (SHA.test(ref) && commits.has(ref)) return ref;
    return branches.get(ref);
  };
  const commitOf = (sha: string) => commits.get(sha) as FakeCommit;

  /** Every commit reachable from `sha` (itself included). */
  function reachable(sha: string | undefined): Set<string> {
    const seen = new Set<string>();
    const stack = sha ? [sha] : [];
    while (stack.length) {
      const c = stack.pop() as string;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...commitOf(c).parent_ids);
    }
    return seen;
  }

  /** The nearest common ancestor of `a` and `b`, found breadth-first from `b`. */
  function mergeBase(a: string, b: string): string | undefined {
    const ofA = reachable(a);
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length) {
      const c = queue.shift() as string;
      if (seen.has(c)) continue;
      seen.add(c);
      if (ofA.has(c)) return c;
      queue.push(...commitOf(c).parent_ids);
    }
    return undefined;
  }

  const commitJson = (sha: string): GitLabCommit => {
    const c = commitOf(sha);
    return {
      id: c.id,
      short_id: c.id.slice(0, 8),
      parent_ids: [...c.parent_ids],
      message: c.message,
      title: c.message.split('\n')[0] ?? '',
    };
  };

  /** The newest first-parent ancestor of `sha` (itself included) that changed `path`. */
  function lastCommitFor(sha: string, path: string): string {
    let c = commitOf(sha);
    for (;;) {
      const parent = c.parent_ids[0];
      const before = parent ? commitOf(parent).files : {};
      if (
        before[path] !== c.files[path] ||
        Object.hasOwn(before, path) !== Object.hasOwn(c.files, path)
      )
        return c.id;
      if (!parent) return c.id;
      c = commitOf(parent);
    }
  }

  /** Commits reachable from `to` and not from `base`, oldest first (topological, ties by SHA). */
  function commitsBetween(base: string | undefined, to: string): string[] {
    const exclude = reachable(base);
    const set = [...reachable(to)].filter((c) => !exclude.has(c));
    const inSet = new Set(set);
    const done = new Set<string>();
    const out: string[] = [];
    while (out.length < set.length) {
      const ready = set
        .filter((c) => !done.has(c))
        .filter((c) => commitOf(c).parent_ids.every((p) => !inSet.has(p) || done.has(p)))
        .sort(byPath);
      const next = ready[0] as string;
      done.add(next);
      out.push(next);
    }
    return out;
  }

  const branchJson = (name: string) => {
    const { id, parent_ids, message, title } = commitJson(branches.get(name) as string);
    return {
      name,
      commit: { id, parent_ids, message, title },
      protected: false,
      default: name === project.defaultBranch,
    };
  };

  route('GET', /^\/repository\/branches\/([^/]+)$/, (_c, m) => {
    const name = decodeSegment(m[1]);
    if (name === undefined || !branches.has(name)) return err(404, '404 Branch Not Found');
    return [200, branchJson(name)];
  });
  route('POST', /^\/repository\/branches$/, (c) => {
    if (c.level < ACCESS.developer) return FORBIDDEN;
    const name = str(c.params.branch);
    const ref = str(c.params.ref);
    if (!name) return [400, { error: 'branch is missing' }];
    if (!ref) return [400, { error: 'ref is missing' }];
    if (branches.has(name)) return err(400, 'Branch already exists');
    const sha = resolve(ref);
    if (!sha) return err(400, 'Invalid reference name');
    branches.set(name, sha);
    return [201, branchJson(name)];
  });

  /** The file at `ref`, or the reply that says why there isn't one. */
  const fileLookup = (
    c: Ctx,
    seg: string | undefined,
  ): { reply: Reply } | { path: string; ref: string; sha: string; content: string } => {
    const path = decodeSegment(seg);
    const ref = c.query.get('ref');
    if (!ref) return { reply: [400, { error: 'ref is missing' }] };
    const sha = resolve(ref);
    if (path === undefined || !sha) return { reply: err(404, '404 File Not Found') };
    const files = commitOf(sha).files;
    if (!Object.hasOwn(files, path)) return { reply: err(404, '404 File Not Found') };
    return { path, ref, sha, content: files[path] as string };
  };
  route('GET', /^\/repository\/files\/([^/]+)$/, (c, m) => {
    const f = fileLookup(c, m[1]);
    if ('reply' in f) return f.reply;
    const bytes = Buffer.from(f.content, 'utf8');
    return [
      200,
      {
        file_path: f.path,
        file_name: f.path.split('/').pop(),
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
        ref: f.ref,
        blob_id: gitBlobSha(f.content),
        commit_id: f.sha,
        last_commit_id: lastCommitFor(f.sha, f.path),
      },
    ];
  });
  route('GET', /^\/repository\/files\/([^/]+)\/raw$/, (c, m) => {
    const f = fileLookup(c, m[1]);
    if ('reply' in f) return f.reply;
    return [200, f.content, { 'content-type': 'text/plain; charset=utf-8' }];
  });
  const writeFile =
    (create: boolean): Handler =>
    (c, m) => {
      if (c.level < ACCESS.developer) return FORBIDDEN;
      const path = decodeSegment(m[1]);
      if (!path) return err(400, 'file_path is invalid');
      const branch = str(c.params.branch);
      const message = str(c.params.commit_message);
      const raw = str(c.params.content);
      if (!branch) return [400, { error: 'branch is missing' }];
      if (!message) return [400, { error: 'commit_message is missing' }];
      if (raw === undefined) return [400, { error: 'content is missing' }];
      const head = branches.get(branch);
      if (!head) return err(400, 'You can only create or edit files when you are on a branch');
      const files = commitOf(head).files;
      const exists = Object.hasOwn(files, path);
      if (create && exists) return err(400, 'A file with this name already exists');
      if (!create && !exists) return err(400, "A file with this name doesn't exist");
      const last = str(c.params.last_commit_id);
      if (!create && last !== undefined && last !== lastCommitFor(head, path))
        return err(
          400,
          'You are attempting to update a file that has changed since you started editing it.',
        );
      const content =
        str(c.params.encoding) === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw;
      branches.set(branch, makeCommit([head], message, { ...files, [path]: content }));
      return [create ? 201 : 200, { file_path: path, branch }];
    };
  route('POST', /^\/repository\/files\/([^/]+)$/, writeFile(true));
  route('PUT', /^\/repository\/files\/([^/]+)$/, writeFile(false));

  /** `GET repository/tree`: the entries directly under `path` at `ref` (the default branch when
   *  absent), trees first then blobs, each by name. A missing ref or path is 404; like GitLab, a
   *  path that names a file lists nothing. */
  route('GET', /^\/repository\/tree$/, (c) => {
    const sha = resolve(c.query.get('ref') ?? project.defaultBranch);
    if (!sha) return err(404, '404 Tree Not Found');
    const dir = (c.query.get('path') ?? '').replace(/^\/+|\/+$/g, '');
    const files = commitOf(sha).files;
    if (dir !== '' && Object.hasOwn(files, dir)) return paged([], c.query);
    const prefix = dir === '' ? '' : `${dir}/`;
    const trees = new Set<string>();
    const blobs: string[] = [];
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) blobs.push(rest);
      else trees.add(rest.slice(0, slash));
    }
    if (dir !== '' && trees.size === 0 && blobs.length === 0) return err(404, '404 Tree Not Found');
    const treeId = (path: string) =>
      createHash('sha1')
        .update(JSON.stringify({ tree: sha, path }))
        .digest('hex');
    const entries = [
      ...[...trees].sort(byPath).map((name) => ({
        id: treeId(prefix + name),
        name,
        type: 'tree',
        path: prefix + name,
        mode: '040000',
      })),
      ...blobs.sort(byPath).map((name) => ({
        id: gitBlobSha(files[prefix + name] as string),
        name,
        type: 'blob',
        path: prefix + name,
        mode: '100644',
      })),
    ];
    return paged(entries, c.query);
  });

  route('GET', /^\/repository\/commits\/([^/]+)$/, (_c, m) => {
    const sha = resolve(decodeSegment(m[1]));
    return sha ? [200, commitJson(sha)] : err(404, '404 Commit Not Found');
  });

  route('GET', /^\/repository\/merge_base$/, (c) => {
    const refs = c.query.getAll('refs[]');
    if (refs.length !== 2) return err(400, 'Provide exactly two refs');
    const [a, b] = refs.map(resolve);
    if (!a || !b) return err(400, `Could not find ref ${refs[a ? 1 : 0]}`);
    const base = mergeBase(a, b);
    return base ? [200, commitJson(base)] : err(404, '404 Merge Base Not Found');
  });

  route('GET', /^\/repository\/compare$/, (c) => {
    const fromRef = c.query.get('from') ?? '';
    const toRef = c.query.get('to') ?? '';
    const from = resolve(fromRef);
    const to = resolve(toRef);
    if (!from || !to) return NOT_FOUND;
    const straight = c.query.get('straight') === 'true';
    const base = straight ? from : mergeBase(from, to);
    const list = commitsBetween(base, to).map(commitJson);
    return [
      200,
      {
        commit: list[list.length - 1] ?? null,
        commits: list,
        diffs: snapshotDiffs(base ? commitOf(base).files : {}, commitOf(to).files),
        compare_timeout: false,
        compare_same_ref: fromRef === toRef,
      },
    ];
  });

  // --- Merge requests -------------------------------------------------------------------------

  /** Merge requests, numbered apart from issues as on GitLab. Open ones track their branches;
   *  a closed or merged one keeps the `sha` and `diff_refs` it had when it stopped. */
  const mergeRequests: GitLabMergeRequest[] = [];
  const webRoot = opts.baseUrl.replace(/\/+$/, '');

  /** The diff refs of `source` into `target` now, or `undefined` if either branch is gone. */
  function diffRefs(source: string, target: string): GitLabDiffRefs | undefined {
    const head = branches.get(source);
    const start = branches.get(target);
    if (!head || !start) return undefined;
    return { base_sha: mergeBase(start, head) ?? start, start_sha: start, head_sha: head };
  }
  /** `mr` with `sha` and `diff_refs` brought up to date when it is open. */
  function refreshed(mr: GitLabMergeRequest): GitLabMergeRequest {
    if (mr.state === 'opened') {
      const refs = diffRefs(mr.source_branch, mr.target_branch);
      if (refs) {
        mr.diff_refs = refs;
        mr.sha = refs.head_sha;
      }
    }
    return mr;
  }
  const findMr = (iid: string | number | undefined) => {
    const mr = mergeRequests.find((x) => String(x.iid) === String(iid));
    return mr && refreshed(mr);
  };
  const openDuplicate = (source: string, target: string) =>
    mergeRequests.find(
      (x) => x.state === 'opened' && x.source_branch === source && x.target_branch === target,
    );

  function addMergeRequest(m: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string | null;
    labels?: string[];
    author?: string;
    iid?: number;
    createdAt?: string;
  }): GitLabMergeRequest {
    const refs = diffRefs(m.sourceBranch, m.targetBranch);
    if (!refs) throw new Error(`unknown branch ${m.sourceBranch} or ${m.targetBranch}`);
    const at = m.createdAt ?? now();
    const iid = m.iid ?? Math.max(0, ...mergeRequests.map((x) => x.iid)) + 1;
    const mr: GitLabMergeRequest = {
      id: newId(),
      iid,
      project_id: project.id,
      title: m.title,
      description: m.description ?? null,
      state: 'opened',
      source_branch: m.sourceBranch,
      target_branch: m.targetBranch,
      sha: refs.head_sha,
      source_project_id: project.id,
      target_project_id: project.id,
      author: publicUser(ensureUser(m.author ?? 'root')),
      labels: labelList(m.labels ?? []).sort(byPath),
      web_url: `${webRoot}/${project.path}/-/merge_requests/${iid}`,
      created_at: at,
      updated_at: at,
      merged_at: null,
      closed_at: null,
      diff_refs: refs,
    };
    for (const l of mr.labels) ensureLabel(l);
    mergeRequests.push(mr);
    return mr;
  }

  /** Stop the open MR `iid` as merged or closed, freezing its `sha` and `diff_refs`. */
  function finish(iid: number, state: 'merged' | 'closed', at?: string): GitLabMergeRequest {
    const mr = findMr(iid);
    if (!mr) throw new Error(`unknown merge request ${iid}`);
    const when = at ?? now();
    mr.state = state;
    mr.updated_at = when;
    if (state === 'merged') mr.merged_at = when;
    else mr.closed_at = when;
    return mr;
  }

  route('GET', /^\/merge_requests$/, (c) => {
    const state = c.query.get('state') ?? 'all';
    const source = c.query.get('source_branch');
    const target = c.query.get('target_branch');
    const wanted = labelList(c.query.get('labels') ?? '');
    const list = mergeRequests
      .map(refreshed)
      .filter((x) => state === 'all' || x.state === state)
      .filter((x) => source === null || x.source_branch === source)
      .filter((x) => target === null || x.target_branch === target)
      .filter((x) => wanted.every((l) => x.labels.includes(l)))
      .sort(byNewest);
    return paged(list, c.query);
  });
  /** The files MR `mr` changes, from its merge base to its head. */
  const mrDiffs = (mr: GitLabMergeRequest) =>
    snapshotDiffs(commitOf(mr.diff_refs.base_sha).files, commitOf(mr.diff_refs.head_sha).files);
  route('GET', /^\/merge_requests\/(\d+)$/, (_c, m) => {
    const mr = findMr(m[1]);
    if (!mr) return err(404, '404 Not found');
    const { changes_count, ...rest } = mr;
    if (changes_count === null) return [200, rest];
    return [200, { ...rest, changes_count: changes_count ?? String(mrDiffs(mr).length) }];
  });
  route('POST', /^\/merge_requests$/, (c) => {
    if (c.level < ACCESS.developer) return FORBIDDEN;
    const source = str(c.params.source_branch);
    const target = str(c.params.target_branch);
    const title = str(c.params.title);
    if (!source) return [400, { error: 'source_branch is missing' }];
    if (!target) return [400, { error: 'target_branch is missing' }];
    if (!title) return [400, { error: 'title is missing' }];
    if (!branches.has(source))
      return [400, { message: [`Source branch "${source}" does not exist`] }];
    if (!branches.has(target))
      return [400, { message: [`Target branch "${target}" does not exist`] }];
    if (source === target)
      return [400, { message: ["You can't use same project/branch for source and target"] }];
    const dup = openDuplicate(source, target);
    if (dup)
      return [
        409,
        {
          message: [
            `Another open merge request already exists for this source branch: !${dup.iid}`,
          ],
        },
      ];
    const mr = addMergeRequest({
      sourceBranch: source,
      targetBranch: target,
      title,
      description: str(c.params.description) ?? null,
      labels: labelList(c.params.labels),
      author: c.user.username,
    });
    return [201, mr];
  });
  route('PUT', /^\/merge_requests\/(\d+)$/, (c, m) => {
    const mr = findMr(m[1]);
    if (!mr) return err(404, '404 Not found');
    if (c.level < ACCESS.developer) return FORBIDDEN;
    const p = c.params;
    if (p.state_event === 'reopen' && mr.state === 'closed') {
      const dup = openDuplicate(mr.source_branch, mr.target_branch);
      if (dup)
        return [
          409,
          {
            message: [
              `Another open merge request already exists for this source branch: !${dup.iid}`,
            ],
          },
        ];
    }
    if (p.title !== undefined) mr.title = String(p.title);
    if (p.description !== undefined) mr.description = str(p.description) ?? null;
    if (p.labels !== undefined) mr.labels = labelList(p.labels);
    for (const l of labelList(p.add_labels)) if (!mr.labels.includes(l)) mr.labels.push(l);
    const remove = labelList(p.remove_labels);
    mr.labels = mr.labels.filter((l) => !remove.includes(l)).sort(byPath);
    for (const l of mr.labels) ensureLabel(l);
    const at = now();
    if (p.state_event === 'close' && mr.state === 'opened') {
      mr.state = 'closed';
      mr.closed_at = at;
    } else if (p.state_event === 'reopen' && mr.state === 'closed') {
      mr.state = 'opened';
      mr.closed_at = null;
    }
    mr.updated_at = at;
    return [200, refreshed(mr)];
  });
  // --- Merge request notes and approvals ---------------------------------------------------

  route('POST', /^\/merge_requests\/(\d+)\/notes$/, (c, m) => {
    const mr = findMr(m[1]);
    if (!mr) return err(404, '404 Not found');
    if (c.level < ACCESS.reporter) return FORBIDDEN;
    const body = str(c.params.body);
    if (!body) return [400, { error: 'body is missing' }];
    const note = addNote({ mergeRequestIid: mr.iid, body, author: c.user.username });
    mr.updated_at = note.created_at;
    return [201, note];
  });

  const resetOnPush = opts.approvals?.resetOnPush ?? true;
  const authorCanApprove = opts.approvals?.authorCanApprove ?? false;
  type Approval = { username: string; sha: string };
  /** MR iid → its approvals, oldest first, each with the head SHA it was given on. */
  const approvalsByMr = new Map<number, Approval[]>();
  const approvalsRequired = new Map<number, number>();

  /** The approvals that count on `mr` now. With `resetOnPush`, ones given on a head the source
   *  branch has since left are dropped. */
  function currentApprovals(mr: GitLabMergeRequest): Approval[] {
    const sha = refreshed(mr).sha;
    const list = (approvalsByMr.get(mr.iid) ?? []).filter((a) => !resetOnPush || a.sha === sha);
    approvalsByMr.set(mr.iid, list);
    return list;
  }
  const approvalsJson = (mr: GitLabMergeRequest): GitLabApprovals => {
    const list = currentApprovals(mr);
    const required = approvalsRequired.get(mr.iid) ?? 0;
    return {
      approved: list.length > 0,
      approved_by: list.map((a) => ({ user: publicUser(ensureUser(a.username)) })),
      approvals_required: required,
      approvals_left: Math.max(0, required - list.length),
    };
  };

  route('GET', /^\/merge_requests\/(\d+)\/approvals$/, (_c, m) => {
    const mr = findMr(m[1]);
    return mr ? [200, approvalsJson(mr)] : err(404, '404 Not found');
  });
  /** GitLab answers 409 for a `sha` that isn't the head, and 401 for any other refusal. */
  route('POST', /^\/merge_requests\/(\d+)\/approve$/, (c, m) => {
    const mr = findMr(m[1]);
    if (!mr) return err(404, '404 Not found');
    const sha = str(c.params.sha);
    if (sha !== undefined && sha !== mr.sha)
      return err(409, 'SHA does not match HEAD of source branch');
    const list = currentApprovals(mr);
    const refused =
      list.some((a) => a.username === c.user.username) ||
      c.level < ACCESS.developer ||
      mr.state !== 'opened' ||
      (!authorCanApprove && mr.author.username === c.user.username);
    if (refused) return UNAUTHORIZED;
    list.push({ username: c.user.username, sha: mr.sha });
    return [201, approvalsJson(mr)];
  });
  route('POST', /^\/merge_requests\/(\d+)\/unapprove$/, (c, m) => {
    const mr = findMr(m[1]);
    if (!mr) return err(404, '404 Not found');
    const list = currentApprovals(mr);
    const at = list.findIndex((a) => a.username === c.user.username);
    if (at === -1) return NOT_FOUND;
    list.splice(at, 1);
    return [201, approvalsJson(mr)];
  });

  route('GET', /^\/merge_requests\/(\d+)\/diffs$/, (c, m) => {
    const mr = findMr(m[1]);
    if (!mr) return err(404, '404 Not found');
    return paged(mrDiffs(mr), c.query);
  });

  // --- Pipelines, jobs and commit statuses ----------------------------------------------------

  /** Pipelines in creation order. Each holds its jobs, retried ones included. */
  const pipelines: GitLabPipeline[] = [];
  type StoredJob = Omit<GitLabJob, 'pipeline'> & { pipelineId: number; retried: boolean };
  const jobs: StoredJob[] = [];
  const commitStatuses: GitLabCommitStatus[] = [];

  const findPipeline = (id: string | number | undefined) =>
    pipelines.find((p) => String(p.id) === String(id));
  const findJob = (id: string | number | undefined) =>
    jobs.find((j) => String(j.id) === String(id));
  const pipelineOf = (j: StoredJob) => findPipeline(j.pipelineId) as GitLabPipeline;
  const jobsOf = (pipelineId: number, includeRetried = false) =>
    jobs.filter((j) => j.pipelineId === pipelineId && (includeRetried || !j.retried));

  const jobJson = (j: StoredJob): GitLabJob => {
    const { pipelineId: _p, retried: _r, ...rest } = j;
    const p = pipelineOf(j);
    return {
      ...rest,
      pipeline: {
        id: p.id,
        iid: p.iid,
        project_id: p.project_id,
        sha: p.sha,
        ref: p.ref,
        status: p.status,
      },
    };
  };

  /** A pipeline's status from its current jobs, roughly as GitLab composes it. */
  function composite(list: StoredJob[]): GitLabPipelineStatus {
    const has = (s: GitLabJobStatus) => list.some((j) => j.status === s);
    if (list.length === 0) return 'created';
    if (has('running')) return 'running';
    if (has('pending')) return 'pending';
    if (has('created')) return 'created';
    if (list.some((j) => j.status === 'failed' && !j.allow_failure)) return 'failed';
    if (has('canceled')) return 'canceled';
    if (has('manual')) return 'manual';
    if (list.every((j) => j.status === 'skipped')) return 'skipped';
    return 'success';
  }
  function recompute(p: GitLabPipeline) {
    p.status = composite(jobsOf(p.id));
    p.updated_at = now();
  }

  /** Set a job's status, with `started_at` and `finished_at` to match. */
  function moveJob(j: StoredJob, status: GitLabJobStatus, at = now()) {
    j.status = status;
    if (status === 'running') {
      j.started_at = at;
      j.finished_at = null;
    } else if (status === 'success' || status === 'failed' || status === 'canceled') {
      j.started_at ??= at;
      j.finished_at = at;
    } else {
      j.started_at = null;
      j.finished_at = null;
    }
  }

  function addJob(
    p: GitLabPipeline,
    j: { name: string; stage?: string; status?: GitLabJobStatus; allowFailure?: boolean },
  ): StoredJob {
    const id = newId();
    const at = now();
    const job: StoredJob = {
      id,
      name: j.name,
      stage: j.stage ?? 'test',
      status: 'created',
      allow_failure: j.allowFailure ?? false,
      ref: p.ref,
      created_at: at,
      started_at: null,
      finished_at: null,
      web_url: `${webRoot}/${project.path}/-/jobs/${id}`,
      pipelineId: p.id,
      retried: false,
    };
    moveJob(job, j.status ?? 'pending', at);
    jobs.push(job);
    return job;
  }

  /** Retry `old`: it becomes retried and a new pending job takes its place. */
  function retryJob(old: StoredJob): StoredJob {
    old.retried = true;
    return addJob(pipelineOf(old), {
      name: old.name,
      stage: old.stage,
      allowFailure: old.allow_failure,
      status: 'pending',
    });
  }

  /** The commit SHA a seeded pipeline or status is for; throws on an unknown ref. */
  const knownSha = (ref: string) => {
    const sha = resolve(ref);
    if (!sha) throw new Error(`unknown commit or branch ${ref}`);
    return sha;
  };

  function addPipeline(s: {
    sha: string;
    ref?: string;
    status?: GitLabPipelineStatus;
    source?: string;
    createdAt?: string;
    jobs?: { name: string; stage?: string; status?: GitLabJobStatus; allowFailure?: boolean }[];
  }): { pipeline: GitLabPipeline; jobs: GitLabJob[] } {
    const sha = knownSha(s.sha);
    const at = s.createdAt ?? now();
    const id = newId();
    const pipeline: GitLabPipeline = {
      id,
      iid: Math.max(0, ...pipelines.map((p) => p.iid)) + 1,
      project_id: project.id,
      sha,
      ref: s.ref ?? (branches.has(s.sha) ? s.sha : project.defaultBranch),
      status: 'created',
      source: s.source ?? 'push',
      web_url: `${webRoot}/${project.path}/-/pipelines/${id}`,
      created_at: at,
      updated_at: at,
    };
    pipelines.push(pipeline);
    const added = (s.jobs ?? []).map((j) => addJob(pipeline, j));
    pipeline.status = s.status ?? composite(added);
    return { pipeline, jobs: added.map(jobJson) };
  }

  const PIPELINE_ORDER: Record<string, (a: GitLabPipeline, b: GitLabPipeline) => number> = {
    id: (a, b) => a.id - b.id,
    status: (a, b) => byPath(a.status, b.status) || a.id - b.id,
    ref: (a, b) => byPath(a.ref, b.ref) || a.id - b.id,
    updated_at: (a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id,
  };
  route('GET', /^\/pipelines$/, (c) => {
    const q = (k: string) => c.query.get(k);
    const order = PIPELINE_ORDER[q('order_by') ?? 'id'];
    if (!order) return [400, { error: 'order_by does not have a valid value' }];
    const desc = (q('sort') ?? 'desc') !== 'asc';
    const list = pipelines
      .filter((p) => q('sha') === null || p.sha === q('sha'))
      .filter((p) => q('ref') === null || p.ref === q('ref'))
      .filter((p) => q('status') === null || p.status === q('status'))
      .sort((a, b) => (desc ? -order(a, b) : order(a, b)));
    return paged(list, c.query);
  });
  route('GET', /^\/pipelines\/(\d+)$/, (_c, m) => {
    const p = findPipeline(m[1]);
    return p ? [200, p] : err(404, '404 Not found');
  });
  route('GET', /^\/pipelines\/(\d+)\/jobs$/, (c, m) => {
    const p = findPipeline(m[1]);
    if (!p) return err(404, '404 Not found');
    const scopes = [...c.query.getAll('scope[]'), ...c.query.getAll('scope')];
    const list = jobsOf(p.id, c.query.get('include_retried') === 'true')
      .filter((j) => scopes.length === 0 || scopes.includes(j.status))
      .map(jobJson);
    return paged(list, c.query);
  });
  route('GET', /^\/jobs\/(\d+)$/, (_c, m) => {
    const j = findJob(m[1]);
    return j ? [200, jobJson(j)] : err(404, '404 Not found');
  });
  const RETRYABLE: GitLabJobStatus[] = ['success', 'failed', 'canceled'];
  route('POST', /^\/jobs\/(\d+)\/retry$/, (c, m) => {
    const j = findJob(m[1]);
    if (!j) return err(404, '404 Not found');
    if (c.level < ACCESS.developer) return FORBIDDEN;
    if (j.retried || !RETRYABLE.includes(j.status))
      return err(403, '403 Forbidden - Job is not retryable');
    const fresh = retryJob(j);
    recompute(pipelineOf(j));
    return [201, jobJson(fresh)];
  });
  route('POST', /^\/pipelines\/(\d+)\/retry$/, (c, m) => {
    const p = findPipeline(m[1]);
    if (!p) return err(404, '404 Not found');
    if (c.level < ACCESS.developer) return FORBIDDEN;
    const failed = jobsOf(p.id).filter((j) => j.status === 'failed' || j.status === 'canceled');
    for (const j of failed) retryJob(j);
    if (failed.length > 0) recompute(p);
    return [201, p];
  });

  function addCommitStatus(s: {
    sha: string;
    name: string;
    status: GitLabCommitStatusState;
    allowFailure?: boolean;
    targetUrl?: string | null;
    description?: string | null;
    ref?: string | null;
    author?: string;
  }): GitLabCommitStatus {
    const at = now();
    const done = s.status === 'success' || s.status === 'failed' || s.status === 'canceled';
    const status: GitLabCommitStatus = {
      id: newId(),
      sha: knownSha(s.sha),
      ref: s.ref ?? null,
      status: s.status,
      name: s.name,
      target_url: s.targetUrl ?? null,
      description: s.description ?? null,
      allow_failure: s.allowFailure ?? false,
      author: publicUser(ensureUser(s.author ?? 'root')),
      created_at: at,
      started_at: s.status === 'pending' ? null : at,
      finished_at: done ? at : null,
    };
    commitStatuses.push(status);
    return status;
  }

  /** `GET repository/commits/:sha/statuses`: the external statuses on a commit, oldest first.
   *  Without `all=true` only the newest status of each name is listed, as on GitLab. */
  route('GET', /^\/repository\/commits\/([^/]+)\/statuses$/, (c, m) => {
    const sha = resolve(decodeSegment(m[1]));
    if (!sha) return err(404, '404 Commit Not Found');
    const ref = c.query.get('ref');
    const name = c.query.get('name');
    let list = commitStatuses
      .filter((s) => s.sha === sha)
      .filter((s) => ref === null || s.ref === ref)
      .filter((s) => name === null || s.name === name);
    if (c.query.get('all') !== 'true') {
      const newest = new Map<string, GitLabCommitStatus>();
      for (const s of list) newest.set(s.name, s);
      list = [...newest.values()].sort((a, b) => a.id - b.id);
    }
    return paged(list, c.query);
  });

  // --- Dispatch -----------------------------------------------------------------------------

  /** The project route for `rest` (the path after `/projects/:id`), if the fake knows it. */
  const matchProjectRoute = (method: string, rest: string) => {
    for (const r of routes) {
      const m = r.path.exec(rest);
      if (m && r.method === method) return { r, m: [...m] };
    }
    return undefined;
  };

  async function handle(req: Request): Promise<Reply> {
    const url = new URL(req.url);
    const text = await req.text();
    const token = req.headers.get('private-token');
    const user = token === null ? undefined : users.find((u) => u.token && u.token === token);
    const query = new URLSearchParams(url.searchParams);
    const queryToken = TOKEN_PARAMS.map((k) => query.get(k)).filter((v): v is string => !!v);
    for (const k of TOKEN_PARAMS) query.delete(k);
    const body = parseBody(text, req.headers.get('content-type') ?? '');
    const secrets = [
      ...(token ? [token] : []),
      ...queryToken,
      ...users.flatMap((u) => (u.token ? [u.token] : [])),
    ];
    requests.push({
      method: req.method,
      path: redact(url.pathname, secrets) as string,
      query: redact(Object.fromEntries(query), secrets) as Record<string, string>,
      body: redact(body, secrets),
      user: token === null ? null : (user?.username ?? '<unknown>'),
    });

    const rel = url.pathname.slice(prefix.length);
    const seg = /^\/projects\/([^/]+)(\/.*)?$/.exec(rel);
    const projectRoute = seg ? matchProjectRoute(req.method, seg[2] ?? '') : undefined;
    const known = (req.method === 'GET' && rel === '/user') || projectRoute !== undefined;
    if (!known) {
      unknown.push(`${req.method} ${redact(url.pathname, secrets)}`);
      return NOT_FOUND;
    }

    if (!user) return UNAUTHORIZED;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const scopes = user.scopes;
    const readScopes = rel === '/user' ? ['read_api', 'read_user'] : ['read_api'];
    if (!scopes.includes('api') && (write || !readScopes.some((s) => scopes.includes(s))))
      return INSUFFICIENT_SCOPE;

    if (rel === '/user') return [200, publicUser(user)];
    if (!seg || !projectRoute) return NOT_FOUND;

    let id: string;
    try {
      id = decodeURIComponent(seg[1] ?? '');
    } catch {
      return PROJECT_NOT_FOUND;
    }
    if (id !== String(project.id) && id !== project.path) return PROJECT_NOT_FOUND;
    const level = user.accessLevel ?? 0;
    if (level < ACCESS.guest && project.visibility === 'private') return PROJECT_NOT_FOUND;

    const params: Record<string, unknown> = {
      ...Object.fromEntries(query),
      ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
    };
    return projectRoute.r.handle(
      { method: req.method, query, params, user, level },
      projectRoute.m,
    );
  }

  const scope = nock(base.origin).persist();
  const interceptors = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => {
    const i = scope.intercept((p: string) => p === prefix || p.startsWith(`${prefix}/`), m);
    i.reply(async (req: Request) => handle(req));
    return i;
  });

  return {
    baseUrl: opts.baseUrl,
    project,
    /** Every request the fake answered, in order, with no token value in it. */
    requests,
    /** `METHOD path` of each request to a route the fake doesn't know (each answered 404). */
    unknown,
    /** Register a user and the token that authenticates as them. With an `accessLevel` the user is a project member. */
    addUser(u: {
      username: string;
      token: string;
      accessLevel?: number;
      scopes?: string[];
      name?: string;
    }): GitLabUser {
      const user = ensureUser(u.username);
      user.token = u.token;
      user.accessLevel = u.accessLevel;
      user.scopes = u.scopes ?? ['api'];
      if (u.name) user.name = u.name;
      return publicUser(user);
    },
    /** A project member with no token. */
    seedMember(m: { username: string; accessLevel: number; name?: string }) {
      const user = ensureUser(m.username);
      user.accessLevel = m.accessLevel;
      if (m.name) user.name = m.name;
      return { id: user.id, username: user.username, name: user.name, access_level: m.accessLevel };
    },
    seedIssue: addIssue,
    seedLabel(l: { name: string; color?: string; description?: string }): GitLabLabel {
      if (labels.some((x) => x.name === l.name)) throw new Error(`label ${l.name} already seeded`);
      const label: GitLabLabel = {
        id: newId(),
        name: l.name,
        color: l.color ?? '#6699cc',
        description: l.description ?? null,
      };
      labels.push(label);
      return label;
    },
    seedNote: addNote,
    /** Make a commit with the full file snapshot `files`, and return its SHA. With `branch` the
     *  branch moves to it, and `parent` defaults to the branch's head; `parents` makes a merge. */
    seedCommit(c: {
      branch?: string;
      parent?: string;
      /** Every parent, first parent first (a merge commit); overrides `parent`. */
      parents?: string[];
      files: Record<string, string>;
      message: string;
    }): string {
      let parents: string[];
      const known = (ref: string) => {
        const sha = resolve(ref);
        if (!sha) throw new Error(`unknown parent ${ref}`);
        return sha;
      };
      if (c.parents !== undefined) parents = c.parents.map(known);
      else if (c.parent !== undefined) parents = [known(c.parent)];
      else {
        const head = c.branch === undefined ? undefined : branches.get(c.branch);
        parents = head ? [head] : [];
      }
      const sha = makeCommit(parents, c.message, c.files);
      if (c.branch !== undefined) branches.set(c.branch, sha);
      return sha;
    },
    /** Point branch `name` at commit `sha`. */
    seedBranch(name: string, sha: string) {
      if (!commits.has(sha)) throw new Error(`unknown commit ${sha}`);
      branches.set(name, sha);
    },
    /** The commit branch `name` points at. */
    branchSha: (name: string) => branches.get(name),
    /** The content of `path` at `ref` (a SHA or a branch name). */
    fileAt(ref: string, path: string): string | undefined {
      const sha = resolve(ref);
      if (!sha) return undefined;
      const files = commitOf(sha).files;
      return Object.hasOwn(files, path) ? files[path] : undefined;
    },
    /** A stored commit. */
    commit: (sha: string) => commits.get(sha),
    /** Open a merge request from `sourceBranch` into `targetBranch` (both must exist). */
    seedMergeRequest: addMergeRequest,
    /** Mark open merge request `iid` merged, at `mergedAt` (now by default). */
    markMergeRequestMerged: (iid: number, o: { mergedAt?: string } = {}) =>
      finish(iid, 'merged', o.mergedAt),
    /** Mark open merge request `iid` closed, at `closedAt` (now by default). */
    closeMergeRequest: (iid: number, o: { closedAt?: string } = {}) =>
      finish(iid, 'closed', o.closedAt),
    /** The stored merge request, as the fake holds it now. */
    mergeRequest: (iid: number) => findMr(iid),
    /** Set how many approvals merge request `iid` requires (0 by default). */
    setApprovalsRequired(iid: number, n: number) {
      if (!findMr(iid)) throw new Error(`unknown merge request ${iid}`);
      approvalsRequired.set(iid, n);
    },
    /** The approvals merge request `iid` holds now, oldest first, with the head SHA each was
     *  given on. */
    approvals(iid: number): { username: string; sha: string }[] {
      const mr = findMr(iid);
      return mr ? currentApprovals(mr).map((a) => ({ ...a })) : [];
    },
    mergeRequests,
    /** The stored issue, as the fake holds it now. */
    issue: (iid: number) => issues.find((i) => i.iid === iid),
    issues,
    labels,
    notes,
    /** Create a pipeline for `sha` (a SHA or a branch), with its jobs in order. Its status is
     *  `status`, or else composed from the jobs'. */
    seedPipeline: addPipeline,
    /** Move job `id` to `status` and recompute its pipeline's status. */
    setJobStatus(id: number, status: GitLabJobStatus): GitLabJob {
      const j = findJob(id);
      if (!j) throw new Error(`unknown job ${id}`);
      moveJob(j, status);
      recompute(pipelineOf(j));
      return jobJson(j);
    },
    /** Set pipeline `id`'s status directly, leaving its jobs as they are. */
    setPipelineStatus(id: number, status: GitLabPipelineStatus): GitLabPipeline {
      const p = findPipeline(id);
      if (!p) throw new Error(`unknown pipeline ${id}`);
      p.status = status;
      p.updated_at = now();
      return p;
    },
    /** Add an external commit status on `sha` (a SHA or a branch). */
    seedCommitStatus: addCommitStatus,
    /** The stored pipeline, as the fake holds it now. */
    pipeline: (id: number) => findPipeline(id),
    /** The stored job, retried or not, as the API shows it. */
    job: (id: number) => {
      const j = findJob(id);
      return j && { ...jobJson(j), retried: j.retried };
    },
    pipelines,
    commitStatuses,
    /** Remove the fake's interceptors. */
    stop() {
      for (const i of interceptors) nock.removeInterceptor(i);
    },
  };
}

export type FakeGitLab = ReturnType<typeof fakeGitLab>;
