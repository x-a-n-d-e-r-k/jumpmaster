import { containsSecret, isGitLabProjectPath, isRepoFullName } from '@jumpmaster/protocol';

/**
 * What the wizard's project step and `ctl zones add` read from the operator (issue #724): a
 * GitHub repository, a GitLab project on an instance, or why the input is refused.
 */
export type ProjectRef =
  | { forge: 'github'; repo: string }
  | { forge: 'gitlab'; baseUrl: string; repo: string }
  | { error: string };

/** The GitHub hosts a GitHub URL may name; any other `*.github.com` host is refused. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/** Every refusal, a fixed string: none ever echoes the input or any part of it. */
const ERRORS = {
  empty: 'enter a project: owner/name, a github.com URL or a GitLab project URL',
  secret: 'the project looks like it contains a token: enter owner/name or a project URL',
  unreadable: 'enter owner/name, a github.com URL or a GitLab project URL',
  scheme: 'a project URL must use https',
  credentials: 'a project URL must not carry a username or password',
  githubPort: 'a github.com URL must not name a port other than 443',
  githubHost: 'only github.com is supported as a GitHub host',
  githubPath: 'a github.com URL must name an owner and a repository',
  githubRepo: 'the repository must be owner/name with a valid GitHub owner and repository name',
  gitlabPath:
    'a GitLab project URL must name a project path: a group and a project, of letters, digits, _, - and .',
} as const;

const fail = (error: string): ProjectRef => ({ error });

/**
 * Reads the project step's input as one of:
 *
 * - bare `owner/name` (no scheme): a GitHub repository, unchanged;
 * - `https://github.com/<owner>/<name>[.git][/...]` (or `www.github.com`, port 443 at most): a
 *   GitHub repository, its later segments, query and fragment ignored;
 * - any other `https://<host>[:port]/<group>/.../<project>`: a GitLab project on the instance at
 *   the URL's origin, with a trailing slash, everything from a `/-/` segment on and a trailing
 *   `.git` dropped from the path, and the query and fragment ignored.
 *
 * Where the spec is silent, any host outside github.com and `*.github.com` is taken to be a GitLab
 * instance: github.com is the only GitHub host Jumpmaster supports, so no other host can be a
 * GitHub one. Hosts under `github.com` other than `www` (`gist.`, `api.`) are refused, not read as
 * GitLab.
 *
 * Token-shaped input is refused before anything else is read. No error text echoes the input or
 * any part of it. Every accepted result passes the zone schema as `forge`, `gitlab.baseUrl` and
 * `repo`. Pure: no network, filesystem or logging.
 */
export function parseProjectRef(input: string): ProjectRef {
  if (typeof input !== 'string') return fail(ERRORS.unreadable);
  if (containsSecret(input, [])) return fail(ERRORS.secret);
  const text = input.trim();
  if (text === '') return fail(ERRORS.empty);

  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
    return isRepoFullName(text) ? { forge: 'github', repo: text } : fail(ERRORS.githubRepo);
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(ERRORS.unreadable);
  }
  if (url.protocol !== 'https:') return fail(ERRORS.scheme);
  if (url.username !== '' || url.password !== '') return fail(ERRORS.credentials);
  if (url.hostname === '') return fail(ERRORS.unreadable);

  const host = url.hostname.toLowerCase();
  if (GITHUB_HOSTS.has(host)) {
    // `URL` drops the default port, so a port left here is a non-default one.
    if (url.port !== '') return fail(ERRORS.githubPort);
    return githubRef(url.pathname);
  }
  if (host.endsWith('.github.com')) return fail(ERRORS.githubHost);
  return gitlabRef(url.origin, url.pathname);
}

function githubRef(pathname: string): ProjectRef {
  const [owner = '', rawName = ''] = pathname.slice(1).split('/');
  if (owner === '' || rawName === '') return fail(ERRORS.githubPath);
  const name = rawName.endsWith('.git') ? rawName.slice(0, -'.git'.length) : rawName;
  const repo = `${owner}/${name}`;
  return isRepoFullName(repo) ? { forge: 'github', repo } : fail(ERRORS.githubRepo);
}

function gitlabRef(baseUrl: string, pathname: string): ProjectRef {
  let path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const dash = `${path}/`.indexOf('/-/');
  if (dash !== -1) path = path.slice(0, dash);
  if (path.endsWith('.git')) path = path.slice(0, -'.git'.length);
  const repo = path.startsWith('/') ? path.slice(1) : path;
  return isGitLabProjectPath(repo) ? { forge: 'gitlab', baseUrl, repo } : fail(ERRORS.gitlabPath);
}
