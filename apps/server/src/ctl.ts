import { pathToFileURL } from 'node:url';
import { readSecret } from './secrets.js';

const MODES: Record<string, string> = { pause: 'paused', resume: 'active', observe: 'observe' };

export type CtlRequest = { path: string; body: unknown } | { path: string; method: 'GET' };

/** The control request for a command line, or null when it isn't one. */
export function ctlRequest(args: string[]): CtlRequest | null {
  const [command, zone] = args;
  if (command === 'briefings') return { path: '/api/control/briefings', method: 'GET' };
  if (command === 'rule') {
    const [, briefing, optionId, ...rest] = args;
    if (!briefing || !optionId) return null;
    // `--options <digest>` from `ctl briefings`: required to rule on an assistant briefing.
    const digest = rest[0] === '--options' ? rest[1] : undefined;
    if (rest[0] === '--options' && !digest) return null;
    const note = digest ? rest.slice(2) : rest;
    return {
      path: `/api/control/briefings/${encodeURIComponent(briefing)}/rule`,
      body: {
        optionId,
        ...(digest ? { optionsDigest: digest } : {}),
        ...(note.length > 0 ? { note: note.join(' ') } : {}),
      },
    };
  }
  if (command === 'crew-cycle') {
    if (!zone) return null;
    return { path: `/api/control/zones/${encodeURIComponent(zone)}/crew-cycle`, body: {} };
  }
  if (command === 'kill' || command === 'unkill') {
    return { path: '/api/control/kill', body: { engaged: command === 'kill' } };
  }
  const mode = command === undefined ? undefined : MODES[command];
  if (mode === undefined || !zone) return null;
  return { path: `/api/control/zones/${encodeURIComponent(zone)}`, body: { mode } };
}

/** Runs one control command against the server. Returns the process exit code. */
export async function runCtl(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const request = ctlRequest(args);
  if (!request) {
    err(
      'usage: ctl <pause|resume|observe> <zone> | ctl <kill|unkill> | ctl briefings | ctl rule <briefing> <option> [--options <digest>] [note] | ctl crew-cycle <zone>',
    );
    return 2;
  }
  let token: string | undefined;
  try {
    token = readSecret(env, 'JM_OPERATOR_TOKEN');
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (!token) {
    err('JM_OPERATOR_TOKEN or JM_OPERATOR_TOKEN_FILE is required');
    return 2;
  }
  const base = env.JM_SERVER_URL ?? 'http://127.0.0.1:7420';
  const res = await fetchImpl(
    new URL(request.path, base),
    'method' in request
      ? { method: 'GET', headers: { authorization: `Bearer ${token}` } }
      : {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        },
  );
  out(`${res.status} ${await res.text()}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCtl(process.argv.slice(2));
}
