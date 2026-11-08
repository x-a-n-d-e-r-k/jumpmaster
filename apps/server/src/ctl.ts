import { pathToFileURL } from 'node:url';

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

async function main(): Promise<number> {
  const request = ctlRequest(process.argv.slice(2));
  if (!request) {
    console.error(
      'usage: ctl <pause|resume|observe> <zone> | ctl <kill|unkill> | ctl briefings | ctl rule <briefing> <option> [--options <digest>] [note] | ctl crew-cycle <zone>',
    );
    return 2;
  }
  const token = process.env.JM_OPERATOR_TOKEN;
  if (!token) {
    console.error('JM_OPERATOR_TOKEN is required');
    return 2;
  }
  const base = process.env.JM_SERVER_URL ?? 'http://127.0.0.1:7420';
  const res = await fetch(
    new URL(request.path, base),
    'method' in request
      ? { method: 'GET', headers: { authorization: `Bearer ${token}` } }
      : {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        },
  );
  console.log(`${res.status} ${await res.text()}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
