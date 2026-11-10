import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PRESETS } from '@jumpmaster/protocol';
import type { DoctorCheck } from './doctor/checks.js';
import { EXPIRATION_NOTE, REPOSITORY_ACCESS_NOTE, RESOURCE_OWNER_NOTE } from './github/guidance.js';
import { readSecret, readSecretFile } from './secrets.js';

const MODES: Record<string, string> = { pause: 'paused', resume: 'active', observe: 'observe' };

export type CtlRequest =
  | { path: string; body: unknown; method?: 'PUT' | 'PATCH' }
  | { path: string; method: 'GET' };

/**
 * `ctl config …` verbs that are one request. `set` (a read, then a conditional patch) and
 * `import` (a local file) are built by `runConfig`.
 */
function configRequest(args: string[]): CtlRequest | null {
  const [, verb, ...rest] = args;
  if (verb === 'show' && rest.every((a) => a === '--json'))
    return { path: '/api/control/config', method: 'GET' };
  if (verb === 'revisions' && rest.length === 0)
    return { path: '/api/control/config/revisions', method: 'GET' };
  if (verb === 'export' && rest.length === 0)
    return { path: '/api/control/config/export', method: 'GET' };
  if ((verb === 'reload' || verb === 'adopt') && rest.length === 0)
    return { path: `/api/control/config/${verb}`, body: {} };
  if (verb === 'mode')
    return rest.length === 1 && rest[0] === 'file'
      ? { path: '/api/control/config/mode', body: { mode: 'file' } }
      : null;
  if (verb === 'rollback') {
    const [id, ...note] = rest;
    if (!id || !/^\d+$/.test(id)) return null;
    return {
      path: '/api/control/config/rollback',
      body: { id: Number(id), ...(note.length > 0 ? { note: note.join(' ') } : {}) },
    };
  }
  return null;
}

const REPO_ARG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const EGRESS = ['off', 'monitor', 'enforce'];

/**
 * `ctl zones add <owner/name> [--id <id>] [--preset <p>] [--identity starter] [--egress <mode>]
 * [--resume]`: the same route as the wizard's project step. `--egress` defaults to monitor, the
 * wizard's and the add baseline's, never the schema's off. Gates are detected by the server.
 */
function zonesAddRequest(args: string[]): CtlRequest | null {
  const [, , repo, ...rest] = args;
  if (!repo || !REPO_ARG.test(repo)) return null;
  const zone: Record<string, unknown> = { repo };
  let egress = 'monitor';
  let resume = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--resume') {
      resume = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    i += 1;
    if (flag === '--id') {
      // The schema's zone id rule (`ZONE_ID`), so a typo is a usage error here, not a refusal.
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) return null;
      zone.id = value;
    } else if (flag === '--preset') {
      if (!(PRESETS as readonly string[]).includes(value)) return null;
      zone.preset = value;
    } else if (flag === '--identity') {
      if (value !== 'starter' && value !== 'two-bot') return null;
      zone.identity = value;
    } else if (flag === '--egress') {
      if (!EGRESS.includes(value)) return null;
      egress = value;
    } else return null;
  }
  zone.egress = { mode: egress };
  return { path: '/api/control/zones', body: { zone, ...(resume ? { resume: true } : {}) } };
}

const GITHUB_LOGIN = /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$|^@?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * `ctl github <zone> recommend | pat <author|reviewer|read> | ruleset | codeowners [--reviewer
 * <login>]… | checklist`: one read of the zone's guidance, printed per artifact by `runCtl`.
 */
function githubRequest(args: string[]): CtlRequest | null {
  const [, zone, what, ...rest] = args;
  if (!zone || !what) return null;
  const path = `/api/control/zones/${encodeURIComponent(zone)}/github`;
  if (what === 'recommend' || what === 'ruleset' || what === 'checklist')
    return rest.length === 0 ? { path, method: 'GET' } : null;
  if (what === 'pat')
    return rest.length === 1 && ['author', 'reviewer', 'read'].includes(rest[0] ?? '')
      ? { path, method: 'GET' }
      : null;
  if (what !== 'codeowners') return null;
  const reviewers: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const login = rest[i + 1];
    if (rest[i] !== '--reviewer' || !login || !GITHUB_LOGIN.test(login)) return null;
    reviewers.push(login);
  }
  return reviewers.length === 0
    ? { path, method: 'GET' }
    : { path: `${path}?${new URLSearchParams({ reviewer: reviewers.join(',') })}`, method: 'GET' };
}

type GuidanceView = {
  recommendation: {
    identity: string;
    authorMayBeAdmin: boolean;
    reason: string;
    stop?: string;
    ask?: string;
  };
  pat: Record<string, string>;
  ruleset: { text: string; note?: string };
  codeowners: { text: string };
  checklist: { url: string; items: string[] };
};

/** One artifact of the guidance, as lines: a file alone (for a redirect), or a link and its notes. */
function githubLines(args: string[], g: GuidanceView): string[] {
  const [, , what, role] = args;
  const text = (t: string) => t.replace(/\n$/, '').split('\n');
  if (what === 'ruleset') return text(g.ruleset.text);
  if (what === 'codeowners') return text(g.codeowners.text);
  if (what === 'pat')
    return [
      g.pat[role ?? ''] ?? '',
      `${RESOURCE_OWNER_NOTE}.`,
      `Then ${REPOSITORY_ACCESS_NOTE}.`,
      `Expiry: ${EXPIRATION_NOTE}.`,
    ];
  if (what === 'checklist') return [g.checklist.url, ...g.checklist.items.map((i) => `- ${i}`)];
  const r = g.recommendation;
  return [
    `identity: ${r.identity}`,
    `authorMayBeAdmin: ${r.authorMayBeAdmin}`,
    r.reason,
    ...(r.stop ? [`stop: ${r.stop}`] : []),
    ...(r.ask ? [`first: ${r.ask}`] : []),
  ];
}

/** The control request for a command line, or null when it isn't one. */
export function ctlRequest(args: string[]): CtlRequest | null {
  const [command, zone] = args;
  if (command === 'config') return configRequest(args);
  if (command === 'github') return githubRequest(args);
  if (command === 'detect')
    return args.length === 2 && zone && REPO_ARG.test(zone)
      ? { path: '/api/control/detect', body: { repo: zone } }
      : null;
  if (command === 'zones') return zone === 'add' ? zonesAddRequest(args) : null;
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

const CONFIG_USAGE =
  'ctl config show [--json] | ctl config revisions | ctl config set <path>=<json>… [--note <text>] | ctl config rollback <id> [note] | ctl config import <file> [--dry-run] [--note <text>] | ctl config export | ctl config reload | ctl config adopt | ctl config mode file';
export const SECRETS_USAGE =
  'ctl secrets list | ctl secrets set <name> [--from-file <path>] [--created YYYY-MM-DD] (the value on stdin or in the file, never in argv) | ctl secrets test <name> | ctl secrets remove <name> | ctl secrets reload';

const USAGE = `usage: ctl <pause|resume|observe> <zone> | ctl <kill|unkill> | ctl briefings | ctl rule <briefing> <option> [--options <digest>] [note] | ctl crew-cycle <zone> | ctl doctor [zone] [--json] | ctl doctor <zone> --drop | ctl doctor <zone> --cancel | ctl setup-code | ctl setup reopen | ctl detect <owner/name> | ctl github <zone> recommend | pat <author|reviewer|read> | ruleset | codeowners [--reviewer <login>]… | checklist | ctl zones add <owner/name> [--id <id>] [--preset <p>] [--identity starter] [--egress off|monitor|enforce] [--resume] | ctl passphrase set (the passphrase on stdin) | ${CONFIG_USAGE} | ${SECRETS_USAGE}`;

type Call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<Response>;
type Change = { path: string; from?: unknown; to?: unknown };
type Issue = { path: string; message: string };

const shown = (v: unknown): string => (v === undefined ? '(unset)' : JSON.stringify(v));
const changeLine = (c: Change): string => `${c.path}: ${shown(c.from)} -> ${shown(c.to)}`;
const issueLine = (i: Issue): string => `issue: ${i.path || '(root)'}: ${i.message}`;
/** A value as typed: JSON when it parses, else the text itself (`readyLabel=go`). */
const valueOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sets `value` at `path` in `obj` (null removes, as a merge patch would). */
function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  const [head, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) {
    if (value === null) delete obj[head];
    else obj[head] = value;
    return;
  }
  const next = isObject(obj[head]) ? (obj[head] as Record<string, unknown>) : {};
  obj[head] = next;
  setPath(next, rest, value);
}

/** The applied revision as a line: what changed, and what waits for a restart. */
function appliedLine(body: { revision: number; changed: string[]; restartNeeded: string[] }) {
  const changed = body.changed.length > 0 ? body.changed.join(', ') : 'nothing changed';
  const restart =
    body.restartNeeded.length > 0
      ? `; restart to apply ${body.restartNeeded.join(', ')} (docker compose restart jumpmaster)`
      : '';
  return `revision ${body.revision}: ${changed}${restart}`;
}

/**
 * `ctl config …`. `set` reads the current document and revision, then sends one merge patch
 * conditional on that revision (a zone path `dropZones.<id>.<key>` edits that zone and sends the
 * zone list whole, as a merge patch replaces arrays). `import` reads a local file. `export` writes
 * the JSON alone to stdout, for the host to redirect.
 */
async function runConfig(
  args: string[],
  call: Call,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const [, verb, ...rest] = args;
  const usage = () => {
    err(`usage: ${CONFIG_USAGE}`);
    return 2;
  };
  const fail = async (res: Response) => {
    out(`${res.status} ${await res.text()}`);
    return 1;
  };
  const flag = (name: string): { value?: string; rest: string[] } | null => {
    const i = rest.indexOf(name);
    if (i < 0) return { rest };
    const value = rest[i + 1];
    if (value === undefined) return null;
    return { value, rest: [...rest.slice(0, i), ...rest.slice(i + 2)] };
  };

  if (verb === 'set') {
    const n = flag('--note');
    if (!n) return usage();
    const pairs = n.rest.map((a) => {
      const eq = a.indexOf('=');
      return eq <= 0 ? null : { path: a.slice(0, eq).split('.'), value: valueOf(a.slice(eq + 1)) };
    });
    // A path segment naming the prototype machinery would set a prototype, here or in the patch.
    const bad = (seg: string) =>
      seg === '' || ['__proto__', 'constructor', 'prototype'].includes(seg);
    if (pairs.length === 0 || pairs.some((p) => p === null || p.path.some(bad))) return usage();
    const cur = await call('GET', '/api/control/config');
    if (!cur.ok) return fail(cur);
    const { revision, config } = (await cur.json()) as {
      revision: number;
      config: Record<string, unknown>;
    };
    const patch: Record<string, unknown> = {};
    const zones = Array.isArray(config.dropZones)
      ? (structuredClone(config.dropZones) as Record<string, unknown>[])
      : [];
    let zonesTouched = false;
    for (const p of pairs as { path: string[]; value: unknown }[]) {
      if (p.path[0] === 'dropZones' && p.path.length >= 3) {
        const zone = zones.find((z) => z.id === p.path[1]);
        if (!zone) {
          err(`no zone ${p.path[1]} in the config: ctl config show lists the zones`);
          return 2;
        }
        setPath(zone, p.path.slice(2), p.value);
        zonesTouched = true;
      } else setPath(patch, p.path, p.value);
    }
    if (zonesTouched) patch.dropZones = zones;
    const res = await call('PATCH', '/api/control/config', {
      patch,
      expectRevision: revision,
      ...(n.value !== undefined ? { note: n.value } : {}),
    });
    if (!res.ok) return fail(res);
    out(appliedLine(await res.json()));
    return 0;
  }

  if (verb === 'import') {
    const dry = rest.includes('--dry-run');
    const n = flag('--note');
    if (!n) return usage();
    const words = n.rest.filter((a) => a !== '--dry-run');
    if (words.length !== 1) return usage();
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(words[0] as string, 'utf8')) as unknown;
    } catch (e) {
      err(`cannot read ${words[0]}: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    // A real import is conditional on the revision read just before it, as `set` is.
    let expectRevision: number | undefined;
    if (!dry) {
      const cur = await call('GET', '/api/control/config');
      if (!cur.ok) return fail(cur);
      expectRevision = ((await cur.json()) as { revision: number }).revision;
    }
    const res = await call('POST', '/api/control/config/import', {
      config,
      ...(dry ? { dryRun: true } : { expectRevision }),
      ...(n.value !== undefined ? { note: n.value } : {}),
    });
    if (!res.ok) return fail(res);
    if (dry) {
      const body = (await res.json()) as { changes: Change[]; issues: Issue[] };
      for (const c of body.changes) out(changeLine(c));
      for (const i of body.issues) out(issueLine(i));
      out(
        body.issues.length > 0 ? 'dry run: refused, nothing applied' : 'dry run: nothing applied',
      );
      return body.issues.length > 0 ? 1 : 0;
    }
    out(appliedLine(await res.json()));
    return 0;
  }

  const request = configRequest(args);
  if (!request) return usage();
  let body = request.method === 'GET' ? undefined : request.body;
  if (verb === 'rollback') {
    // Conditional on the revision read just before it: a change made meanwhile is a conflict.
    const cur = await call('GET', '/api/control/config');
    if (!cur.ok) return fail(cur);
    const { revision } = (await cur.json()) as { revision: number };
    body = { ...(body as object), expectRevision: revision };
  }
  const res =
    request.method === 'GET'
      ? await call('GET', request.path)
      : await call('POST', request.path, body);
  if (!res.ok) return fail(res);
  if (verb === 'export') {
    // Exactly the JSON: `out` ends the line the JSON's own trailing newline would.
    out((await res.text()).replace(/\n$/, ''));
    return 0;
  }
  if (verb === 'show') {
    const body = (await res.json()) as {
      mode: string;
      revision: number;
      config: unknown;
      restartPending: string[];
    };
    if (rest.includes('--json')) {
      out(JSON.stringify(body, null, 2));
      return 0;
    }
    const pending =
      body.restartPending.length > 0 ? `, restart pending: ${body.restartPending.join(', ')}` : '';
    out(`config: ${body.mode} mode, revision ${body.revision}${pending}`);
    out(JSON.stringify(body.config, null, 2));
    return 0;
  }
  if (verb === 'revisions') {
    const { revisions } = (await res.json()) as {
      revisions: {
        id: number;
        createdAt: string;
        via: string;
        note: string | null;
        changes: Change[];
      }[];
    };
    for (const r of revisions) {
      out(`#${r.id} ${r.createdAt} ${r.via}${r.note ? ` ${JSON.stringify(r.note)}` : ''}`);
      for (const c of r.changes) out(`    ${changeLine(c)}`);
    }
    return 0;
  }
  out(`${res.status} ${await res.text()}`);
  return 0;
}

/**
 * `ctl secrets`: the credential routes. `set` takes the value from `--from-file` or stdin, never
 * from argv (the shell history and the process list would keep it), and prints no value.
 */
async function runSecrets(
  args: string[],
  call: Call,
  out: (line: string) => void,
  err: (line: string) => void,
  readStdin: () => Promise<string>,
): Promise<number> {
  const [, verb, name, ...rest] = args;
  const at = (n: string) => `/api/control/secrets/${encodeURIComponent(n)}`;
  const show = async (res: Response) => {
    out(`${res.status} ${await res.text()}`);
    return res.ok ? 0 : 1;
  };
  const usage = () => {
    err(SECRETS_USAGE);
    return 2;
  };
  if (verb === 'list' && !name) return show(await call('GET', '/api/control/secrets'));
  if (verb === 'reload' && !name)
    return show(await call('POST', '/api/control/secrets/reload', {}));
  if (!name) return usage();
  if (verb === 'test' && rest.length === 0) return show(await call('POST', `${at(name)}/test`, {}));
  if (verb === 'remove' && rest.length === 0) return show(await call('DELETE', at(name)));
  if (verb !== 'set') return usage();
  let file: string | undefined;
  let created: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const v = rest[i + 1];
    if (flag === '--from-file' && v) file = v;
    else if (flag === '--created' && v && /^\d{4}-\d{2}-\d{2}$/.test(v)) created = v;
    else {
      err(
        `ctl secrets set takes the value from stdin or --from-file, never from argv. ${SECRETS_USAGE}`,
      );
      return 2;
    }
    i++;
  }
  let value: string;
  try {
    value = file
      ? readSecretFile(file, '--from-file')
      : ((await readStdin()).split('\n')[0]?.replace(/\r$/, '') ?? '');
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (!value) {
    err(`ctl secrets set reads the value from stdin or --from-file. ${SECRETS_USAGE}`);
    return 2;
  }
  return show(
    await call('PUT', at(name), { value, ...(created ? { declaredCreatedAt: created } : {}) }),
  );
}

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

/** The operator token from the environment or its file; null (said on `err`) when absent. */
function operatorToken(env: NodeJS.ProcessEnv, err: (line: string) => void): string | null {
  let token: string | undefined;
  try {
    token = readSecret(env, 'JM_OPERATOR_TOKEN');
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!token) {
    err('JM_OPERATOR_TOKEN or JM_OPERATOR_TOKEN_FILE is required');
    return null;
  }
  return token;
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
  if (args[0] === 'config' || args[0] === 'secrets') {
    const token = operatorToken(env, err);
    if (token === null) return 2;
    const base = env.JM_SERVER_URL ?? 'http://127.0.0.1:7420';
    const call: Call = (method, path, body) =>
      fetchImpl(new URL(path, base), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return args[0] === 'secrets'
      ? runSecrets(args, call, out, err, readStdin)
      : runConfig(args, call, out, err);
  }
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
  const token = operatorToken(env, err);
  if (token === null) return 2;
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
  if (args[0] === 'github' && res.ok) {
    for (const line of githubLines(args, JSON.parse(text) as GuidanceView)) out(line);
    return 0;
  }
  if (args[0] === 'zones' && res.ok) {
    // What was written, as `init` says it: the zone, its preset and each gate.
    const added = JSON.parse(text) as {
      zone: string;
      revision: number;
      preset?: string;
      egress?: string;
      gates?: { name: string; run: string }[];
    };
    out(
      `added zone ${added.zone} (revision ${added.revision}), preset ${added.preset ?? '(image)'}, egress ${added.egress ?? 'monitor'}`,
    );
    for (const g of added.gates ?? []) out(`  gate ${g.name}: ${g.run}`);
    return 0;
  }
  out(`${res.status} ${text}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCtl(process.argv.slice(2));
}
