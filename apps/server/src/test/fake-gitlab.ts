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

export function fakeGitLab(opts: { baseUrl: string; project: FakeGitLabProject }) {
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
     *  branch moves to it, and `parent` defaults to the branch's head. */
    seedCommit(c: {
      branch?: string;
      parent?: string;
      files: Record<string, string>;
      message: string;
    }): string {
      let parent: string | undefined;
      if (c.parent !== undefined) {
        parent = resolve(c.parent);
        if (!parent) throw new Error(`unknown parent ${c.parent}`);
      } else if (c.branch !== undefined) parent = branches.get(c.branch);
      const sha = makeCommit(parent ? [parent] : [], c.message, c.files);
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
    /** The stored issue, as the fake holds it now. */
    issue: (iid: number) => issues.find((i) => i.iid === iid),
    issues,
    labels,
    notes,
    /** Remove the fake's interceptors. */
    stop() {
      for (const i of interceptors) nock.removeInterceptor(i);
    },
  };
}

export type FakeGitLab = ReturnType<typeof fakeGitLab>;
