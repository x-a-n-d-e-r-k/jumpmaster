// A recording fake GitLab (REST API v4) built on nock, for the `GitLabForge` tests (issue #668).
// It answers `${baseUrl}/api/v4/...` from in-memory state for one project, and never lets a
// request through to the network: any route it doesn't know answers 404. Every request is
// recorded without its token. Later slices add the endpoints they need here.
import nock from 'nock';

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
    const write = req.method !== 'GET';
    const scopes = user.scopes;
    if (!scopes.includes('api') && (write || !scopes.includes('read_api')))
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
  const interceptors = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => {
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
