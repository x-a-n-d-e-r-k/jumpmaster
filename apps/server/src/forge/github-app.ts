// GitHub App broker (spec docs/superpowers/specs/2026-11-13-github-app-auth.md, §4.2 and §13 Task 5).
// Holds one app's id and private key and makes the GitHub calls GitHub App mode builds on: signing
// the app JWT, finding a repository's installation, minting installation tokens narrowed to one
// repository and one use's permissions, revoking them, and suspending the installation.
//
// Minted tokens are returned to the caller and never kept here: suspension kills live tokens, so
// none is ever written to the vault, the database or a file. The module does not log, and no error
// it throws carries a token, the JWT or the key.
import { createSign } from 'node:crypto';
import { redactTokenShapes } from '@jumpmaster/protocol';

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** The app's JWT: RS256, issued 60s in the past for clock skew, expiring under GitHub's ten-minute cap. */
export function appJwt(appId: string, pem: string, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: appId, iat: nowSec - 60, exp: nowSec + 540 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem);
  return `${head}.${body}.${b64url(sig)}`;
}

const AUTHOR_SET = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  metadata: 'read',
  statuses: 'read',
  checks: 'read',
  actions: 'read',
} as const;

/** One entry per row of §4.2's table: the permissions each use's token is narrowed to. */
export const USE_PERMISSIONS = {
  'server-author': AUTHOR_SET,
  'server-reviewer': { pull_requests: 'write' },
  'drop-read-author': { contents: 'read' },
  push: { contents: 'write' },
  'drop-read-reviewer': { contents: 'read' },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

export type Use = keyof typeof USE_PERMISSIONS;

const FORBIDDEN = ['administration', 'workflows'];

/** The only way a mint body is built: one repository, an explicit non-empty permission set. */
export function mintRequestBody(
  repositoryId: number,
  permissions: Readonly<Record<string, string>>,
): { repository_ids: [number]; permissions: Record<string, string> } {
  const keys = Object.keys(permissions);
  if (keys.length === 0) throw new Error('a token must be narrowed to at least one permission');
  for (const k of FORBIDDEN)
    if (keys.includes(k)) throw new Error(`a token may not carry the ${k} permission`);
  return { repository_ids: [repositoryId], permissions: { ...permissions } };
}

/** A failed GitHub App call: the HTTP status and GitHub's message, with every secret removed. */
export class GitHubAppError extends Error {
  readonly status: number;
  readonly githubMessage: string;
  constructor(what: string, status: number, githubMessage: string) {
    super(`${what} failed: HTTP ${status}${githubMessage ? ` — ${githubMessage}` : ''}`);
    this.name = 'GitHubAppError';
    this.status = status;
    this.githubMessage = githubMessage;
  }
}

export type Installation =
  | { installed: true; installationId: number; permissions: Record<string, string> }
  | { installed: false };

export interface GitHubAppBroker {
  installationFor(owner: string, repo: string): Promise<Installation>;
  mint(args: {
    installationId: number;
    repositoryId: number;
    use: Use;
  }): Promise<{ token: string; expiresAt: Date }>;
  /**
   * The id GitHub gives `owner/repo`, read under the installation (issue #267): with a token
   * narrowed to that repository by name and to `metadata: read` alone, revoked once read.
   */
  repositoryIdOf(installationId: number, owner: string, repo: string): Promise<number>;
  revoke(token: string): Promise<void>;
  suspend(installationId: number): Promise<void>;
  unsuspend(installationId: number): Promise<void>;
}

export interface GitHubAppBrokerOptions {
  appId: string;
  privateKey: string;
  apiBase?: string;
  /** The clock in milliseconds. */
  now?: () => number;
  /** Told every secret the broker holds or makes (the key, each JWT, each token) before it is used. */
  onSecret?: (s: string) => void;
}

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const PEM_SHAPE = /-----BEGIN [^-]+-----[\s\S]*?(-----END [^-]+-----|$)/g;

export function createGitHubAppBroker(opts: GitHubAppBrokerOptions): GitHubAppBroker {
  const { appId, privateKey } = opts;
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const now = opts.now ?? Date.now;
  const onSecret = opts.onSecret ?? (() => {});
  onSecret(privateKey);

  const jwt = () => {
    const signed = appJwt(appId, privateKey, Math.floor(now() / 1000));
    onSecret(signed);
    return signed;
  };

  /** Removes the given secrets and anything shaped like one from text GitHub sent back. */
  const clean = (text: string, secrets: string[]) => {
    let out = text;
    for (const s of [privateKey, ...secrets]) if (s) out = out.split(s).join('[redacted]');
    // GitHub token shapes come from the protocol's list, so the broker and every other sink agree.
    return redactTokenShapes(out.replace(PEM_SHAPE, '[redacted]'), '[redacted]').replace(
      JWT_SHAPE,
      '[redacted]',
    );
  };

  async function call(
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // A network failure: report the cause's message, not the request (which holds the bearer).
      throw new GitHubAppError(
        `${method} ${path}`,
        0,
        clean(e instanceof Error ? e.message : 'network error', [bearer]),
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  const fail = (what: string, r: { status: number; json: unknown }, secrets: string[]) => {
    const msg = (r.json as { message?: unknown } | undefined)?.message;
    return new GitHubAppError(what, r.status, clean(typeof msg === 'string' ? msg : '', secrets));
  };

  return {
    async installationFor(owner, repo) {
      const bearer = jwt();
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;
      const r = await call('GET', path, bearer);
      if (r.status === 404) return { installed: false };
      if (r.status !== 200) throw fail(`finding the installation on ${owner}/${repo}`, r, [bearer]);
      const j = r.json as { id: number; permissions?: Record<string, string> };
      return { installed: true, installationId: j.id, permissions: { ...j.permissions } };
    },

    async mint({ installationId, repositoryId, use }) {
      if (!Object.hasOwn(USE_PERMISSIONS, use)) throw new Error(`unknown token use ${String(use)}`);
      const body = mintRequestBody(repositoryId, USE_PERMISSIONS[use]);
      const bearer = jwt();
      const r = await call(
        'POST',
        `/app/installations/${installationId}/access_tokens`,
        bearer,
        body,
      );
      const j = r.json as { token?: unknown; expires_at?: unknown } | undefined;
      if (r.status !== 201 || typeof j?.token !== 'string')
        throw fail(`minting a ${use} token`, r, [bearer]);
      onSecret(j.token);
      return { token: j.token, expiresAt: new Date(String(j.expires_at)) };
    },

    async repositoryIdOf(installationId, owner, repo) {
      const bearer = jwt();
      const what = `reading the repository id of ${owner}/${repo}`;
      // Narrowed by name, so the token reaches the named repository or none; it can read metadata only.
      const minted = await call(
        'POST',
        `/app/installations/${installationId}/access_tokens`,
        bearer,
        {
          repositories: [repo],
          permissions: { metadata: 'read' },
        },
      );
      const m = minted.json as { token?: unknown } | undefined;
      if (minted.status !== 201 || typeof m?.token !== 'string') throw fail(what, minted, [bearer]);
      const token = m.token;
      onSecret(token);
      try {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
        const r = await call('GET', path, token);
        const id = (r.json as { id?: unknown } | undefined)?.id;
        if (r.status !== 200 || typeof id !== 'number') throw fail(what, r, [bearer, token]);
        return id;
      } finally {
        // Best effort: an unrevoked metadata token dies within its hour.
        await call('DELETE', '/installation/token', token).catch(() => undefined);
      }
    },

    async revoke(token) {
      const r = await call('DELETE', '/installation/token', token);
      if (r.status === 204 || r.status === 401 || r.status === 404) return;
      throw fail('revoking a token', r, [token]);
    },

    async suspend(installationId) {
      const bearer = jwt();
      const r = await call('PUT', `/app/installations/${installationId}/suspended`, bearer);
      if (r.status !== 204) throw fail(`suspending installation ${installationId}`, r, [bearer]);
    },

    async unsuspend(installationId) {
      const bearer = jwt();
      const r = await call('DELETE', `/app/installations/${installationId}/suspended`, bearer);
      if (r.status !== 204) throw fail(`unsuspending installation ${installationId}`, r, [bearer]);
    },
  };
}
