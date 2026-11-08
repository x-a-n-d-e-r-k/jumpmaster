import { pathToFileURL } from 'node:url';

const MODES: Record<string, string> = { pause: 'paused', resume: 'active', observe: 'observe' };

/** The control request for a command line, or null when it isn't one. */
export function ctlRequest(args: string[]): { path: string; body: unknown } | null {
  const [command, zone] = args;
  if (command === 'rule') {
    const [, briefing, optionId, ...note] = args;
    if (!briefing || !optionId) return null;
    return {
      path: `/api/control/briefings/${encodeURIComponent(briefing)}/rule`,
      body: { optionId, ...(note.length > 0 ? { note: note.join(' ') } : {}) },
    };
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
      'usage: ctl <pause|resume|observe> <zone> | ctl <kill|unkill> | ctl rule <briefing> <option> [note]',
    );
    return 2;
  }
  const token = process.env.JM_OPERATOR_TOKEN;
  if (!token) {
    console.error('JM_OPERATOR_TOKEN is required');
    return 2;
  }
  const base = process.env.JM_SERVER_URL ?? 'http://127.0.0.1:7420';
  const res = await fetch(new URL(request.path, base), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
  });
  console.log(`${res.status} ${await res.text()}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
