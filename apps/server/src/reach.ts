import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The address other machines reach this server at (`server.publicUrl`, issue #139): its rules, the
 * Check that fetches `<publicUrl>/healthz` from this server, and the tailnet guidance. The server
 * never runs `tailscale serve`; it only shows the command.
 */

/** How long the Check waits for `/healthz`. */
export const HEALTHZ_TIMEOUT_MS = 5000;

/** Where the setting is edited: pages and scripts that need it link here. */
export const PUBLIC_URL_PAGE = '/settings/other-machines';
export const PUBLIC_URL_NEEDED = 'Set the address other machines reach this server at';

export const TAILSCALE_GENERAL_NOTE =
  'Put this server behind HTTPS on an address the new machine can reach (a reverse proxy with a certificate, or a VPN such as a tailnet), then set that address here.';

/** Why `raw` can't be `server.publicUrl`, or null when it can: an https origin and nothing more. */
export function publicUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `server.publicUrl must be an absolute URL such as https://jumpmaster.example.ts.net (got ${raw})`;
  }
  if (u.protocol !== 'https:')
    return `server.publicUrl must use https://, not ${u.protocol} (other machines send their tokens to it)`;
  if (u.username !== '' || u.password !== '')
    return 'server.publicUrl must carry no user name or password';
  if (u.pathname !== '/' && u.pathname !== '')
    return `server.publicUrl must have no path (found ${u.pathname}): the server answers at the root`;
  if (u.search !== '' || raw.includes('?'))
    return `server.publicUrl must have no query (found ${u.search || '?'})`;
  if (u.hash !== '' || raw.includes('#')) return 'server.publicUrl must have no fragment';
  return null;
}

/** The configured address as an origin (no trailing slash), or undefined when unset. */
export function publicOrigin(config: { server?: { publicUrl?: string } }): string | undefined {
  const raw = config.server?.publicUrl;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export type ReachResult = { ok: true; message: 'Reachable' } | { ok: false; message: string };

export type ReachDeps = {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);

/** The innermost cause of a fetch failure, with its code when it has one. */
function rootCause(err: unknown): { code?: string; message: string } {
  let e = err as { cause?: unknown; code?: unknown; message?: unknown } | undefined;
  for (let i = 0; i < 5 && e?.cause; i++)
    e = e.cause as { cause?: unknown; code?: unknown; message?: unknown };
  return {
    ...(typeof e?.code === 'string' ? { code: e.code } : {}),
    message: String(e?.message ?? err),
  };
}

/**
 * Fetches `<publicUrl>/healthz` from this server: "Reachable" when it answers `{ ok: true }`, else
 * the exact failure (a DNS failure, a TLS error, a timeout, a status code). Never throws.
 */
export async function checkReach(publicUrl: string, deps: ReachDeps = {}): Promise<ReachResult> {
  const origin = new URL(publicUrl).origin;
  const url = `${origin}/healthz`;
  const timeoutMs = deps.timeoutMs ?? HEALTHZ_TIMEOUT_MS;
  const doFetch = deps.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await doFetch(url, { signal: ctl.signal, redirect: 'manual' });
    if (!res.ok)
      return {
        ok: false,
        message: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from ${url}`,
      };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if ((body as { ok?: unknown } | undefined)?.ok !== true)
      return {
        ok: false,
        message: `${url} answered ${res.status} but not as a Jumpmaster server ({ ok: true } expected)`,
      };
    return { ok: true, message: 'Reachable' };
  } catch (err) {
    if (ctl.signal.aborted)
      return {
        ok: false,
        message: `timeout: ${url} did not answer within ${HEALTHZ_TIMEOUT_MS / 1000} seconds`,
      };
    const c = rootCause(err);
    const tail = c.code ? ` (${c.code})` : '';
    if (c.code && DNS_CODES.has(c.code))
      return {
        ok: false,
        message: `DNS lookup failed for ${new URL(origin).hostname}: ${c.message}${tail}`,
      };
    if (c.code && TLS_CODE.test(c.code))
      return { ok: false, message: `TLS error: ${c.message}${tail}` };
    return { ok: false, message: `connection failed: ${c.message}${tail}` };
  } finally {
    clearTimeout(timer);
  }
}

export type TailscaleGuidance =
  | { present: false; note: string }
  | { present: true; command: string; dnsName?: string; publicUrl?: string };

export type TailscaleDeps = {
  /** The CLI's path on `PATH`, or null when absent. */
  which(cmd: string): string | null;
  /** `tailscale status --json`'s output, or null when it failed. */
  status(): Promise<string | null>;
};

/** The first executable `cmd` on `PATH`, or null. */
export function whichOnPath(cmd: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

export const defaultTailscaleDeps: TailscaleDeps = {
  which: (cmd) => whichOnPath(cmd),
  status: () =>
    new Promise((resolve) => {
      execFile(
        'tailscale',
        ['status', '--json'],
        { timeout: HEALTHZ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout)),
      );
    }),
};

/**
 * The command that exposes this server on the tailnet when the `tailscale` CLI is on `PATH`, with
 * the `ts.net` name from `tailscale status --json` when that answers; else the general note.
 */
export async function tailscaleGuidance(
  port: number,
  deps: TailscaleDeps = defaultTailscaleDeps,
): Promise<TailscaleGuidance> {
  if (!deps.which('tailscale')) return { present: false, note: TAILSCALE_GENERAL_NOTE };
  const command = `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
  let dnsName: string | undefined;
  try {
    const out = await deps.status();
    const name = out ? (JSON.parse(out) as { Self?: { DNSName?: unknown } }).Self?.DNSName : null;
    if (typeof name === 'string' && /^[a-z0-9.-]+$/i.test(name.replace(/\.$/, '')))
      dnsName = name.replace(/\.$/, '');
  } catch {
    dnsName = undefined;
  }
  return dnsName
    ? { present: true, command, dnsName, publicUrl: `https://${dnsName}` }
    : { present: true, command };
}
