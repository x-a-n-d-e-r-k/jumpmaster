import { pathToFileURL } from 'node:url';
import type { DoctorCheck } from './doctor/checks.js';
import { readSecret } from './secrets.js';

const MODES: Record<string, string> = { pause: 'paused', resume: 'active', observe: 'observe' };

export type CtlRequest =
  | { path: string; body: unknown; method?: 'PUT' }
  | { path: string; method: 'GET' };

/** The control request for a command line, or null when it isn't one. */
export function ctlRequest(args: string[]): CtlRequest | null {
  const [command, zone] = args;
  if (command === 'briefings') return { path: '/api/control/briefings', method: 'GET' };
  // Setup and the passphrase. The passphrase itself comes from stdin, never argv.
  if (command === 'setup-code')
    return args.length === 1 ? { path: '/api/control/setup/code', body: {} } : null;
  if (command === 'setup')
    return args.length === 2 && zone === 'reopen'
      ? { path: '/api/control/setup/reopen', body: {} }
      : null;
  if (command === 'passphrase')
    return args.length === 2 && zone === 'set'
      ? { path: '/api/control/passphrase', method: 'PUT', body: {} }
      : null;
  if (command === 'doctor') {
    const drop = args.includes('--drop');
    const cancel = args.includes('--cancel');
    const words = args.slice(1).filter((a) => a !== '--json' && a !== '--drop' && a !== '--cancel');
    if (words.some((w) => w.startsWith('--')) || words.length > 1) return null;
    const [only] = words;
    // A doctor drop is for one zone, and spends a turn of usage: never all zones at once.
    if (drop && cancel) return null;
    if (cancel)
      return only ? { path: '/api/control/doctor/drop', body: { zone: only, cancel: true } } : null;
    if (drop) return only ? { path: '/api/control/doctor/drop', body: { zone: only } } : null;
    return { path: '/api/control/doctor', body: only ? { zone: only } : {} };
  }
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

const STATUS_WORD: Record<DoctorCheck['status'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
};

/** The doctor's run as lines a person reads: each check, then its fix and doc for any not passing. */
export function formatDoctor(run: {
  id: number;
  finishedAt: string | null;
  checks: DoctorCheck[];
}) {
  const lines = [`Jumpmaster doctor, run ${run.id} (${run.finishedAt ?? 'unfinished'})`, ''];
  const zoneWidth = Math.max(4, ...run.checks.map((c) => (c.zoneId ?? '').length));
  const idWidth = Math.max(...run.checks.map((c) => c.id.length));
  for (const c of run.checks) {
    lines.push(
      `${STATUS_WORD[c.status]}  ${(c.zoneId ?? '').padEnd(zoneWidth)}  ${c.id.padEnd(idWidth)}  ${c.summary}`,
    );
    // Under the summary column: status (4), zone and id, each followed by two spaces.
    const indent = ' '.repeat(4 + 2 + zoneWidth + 2 + idWidth + 2);
    if (c.status !== 'pass' && c.fix)
      for (const [i, l] of c.fix.split('\n').entries())
        lines.push(`${indent}${i === 0 ? 'fix: ' : '     '}${l}`);
    if (c.status !== 'pass' && c.doc) lines.push(`${indent}see: ${c.doc}`);
  }
  const n = (s: DoctorCheck['status']) => run.checks.filter((c) => c.status === s).length;
  lines.push(
    '',
    `${n('pass')} pass, ${n('warn')} warn, ${n('fail')} fail, ${n('skip')} skip${n('fail') > 0 ? ': fix each FAIL, then run the doctor again' : ''}`,
  );
  return lines;
}

const USAGE =
  'usage: ctl <pause|resume|observe> <zone> | ctl <kill|unkill> | ctl briefings | ctl rule <briefing> <option> [--options <digest>] [note] | ctl crew-cycle <zone> | ctl doctor [zone] [--json] | ctl doctor <zone> --drop | ctl doctor <zone> --cancel | ctl setup-code | ctl setup reopen | ctl passphrase set (the passphrase on stdin)';

/** The first line of stdin, without its line ending (`ctl passphrase set`). */
async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(b);
    if (b.includes(10)) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs one control command against the server. Returns the process exit code. */
export async function runCtl(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  readStdin: () => Promise<string> = readStdinLine,
): Promise<number> {
  const request = ctlRequest(args);
  if (!request) {
    err(USAGE);
    return 2;
  }
  let body = request.method === 'GET' ? undefined : request.body;
  if (request.path === '/api/control/passphrase') {
    const line = (await readStdin()).split('\n')[0]?.replace(/\r$/, '') ?? '';
    if (!line) {
      err(
        'ctl passphrase set reads the passphrase from stdin: printf %s "$PASSPHRASE" | jumpmaster ctl passphrase set',
      );
      return 2;
    }
    body = { passphrase: line };
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
    request.method === 'GET'
      ? { method: 'GET', headers: { authorization: `Bearer ${token}` } }
      : {
          method: request.method ?? 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const text = await res.text();
  if (args[0] === 'doctor' && !args.includes('--drop') && !args.includes('--cancel') && res.ok) {
    const { run } = JSON.parse(text) as {
      run: { id: number; finishedAt: string | null; checks: DoctorCheck[] };
    };
    if (args.includes('--json')) out(JSON.stringify({ run }, null, 2));
    else for (const line of formatDoctor(run)) out(line);
    return run.checks.some((c) => c.status === 'fail') ? 1 : 0;
  }
  out(`${res.status} ${text}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCtl(process.argv.slice(2));
}
