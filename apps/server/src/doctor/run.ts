import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '@jumpmaster/protocol';
import { secretList } from '../config.js';
import type { Db } from '../db/open.js';
import {
  type DoctorCheck,
  type DoctorDeps,
  type DoctorEnv,
  type DoctorStatus,
  runChecks,
} from './checks.js';

/** A stored doctor run. `checks` are redacted before they are stored or returned. */
export type DoctorRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  checks: DoctorCheck[];
  /** Doctor drops whose results this run reported. */
  dropIds: string[];
};

export class DoctorBusyError extends Error {
  constructor() {
    super('a doctor run is already in progress');
  }
}

/**
 * One run at a time per server: a second request is refused rather than queued. The lock carries
 * its start time and expires, so a run that somehow never finishes can't refuse every later one.
 */
const LOCK_MS = 10 * 60_000;
let running: { since: number } | null = null;

const redactCheck = (c: DoctorCheck, secrets: string[]): DoctorCheck => ({
  ...c,
  summary: redact(c.summary, secrets),
  ...(c.fix !== undefined ? { fix: redact(c.fix, secrets) } : {}),
  ...(c.doc !== undefined ? { doc: redact(c.doc, secrets) } : {}),
});

/**
 * Runs every check (zones in parallel), stores the run (the last 20 are kept), and returns it.
 * Throws `DoctorBusyError` while another run is in progress.
 */
export async function runDoctor(d: DoctorDeps, opts: { zoneId?: string } = {}): Promise<DoctorRun> {
  const now = d.now().getTime();
  if (running !== null && now - running.since < LOCK_MS) throw new DoctorBusyError();
  const mine = { since: now };
  running = mine;
  try {
    const startedAt = d.now().toISOString();
    const { lastInsertRowid } = d.db
      .prepare('INSERT INTO doctor_runs (started_at) VALUES (?)')
      .run(startedAt);
    const id = Number(lastInsertRowid);
    const secrets = secretList(d.config.secrets);
    const checks = (await runChecks(d, opts)).map((c) => redactCheck(c, secrets));
    const dropIds = checks.flatMap((c) => (c.dropId ? [c.dropId] : []));
    const finishedAt = d.now().toISOString();
    d.db
      .prepare(
        'UPDATE doctor_runs SET finished_at = ?, results_json = ?, drop_ids_json = ? WHERE id = ?',
      )
      .run(finishedAt, JSON.stringify(checks), JSON.stringify(dropIds), id);
    return { id, startedAt, finishedAt, checks, dropIds };
  } finally {
    // Only this run's own lock: a newer run that took over an expired lock keeps it.
    if (running === mine) running = null;
  }
}

type Row = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  resultsJson: string;
  dropIdsJson: string;
};

const parse = <T>(json: string, fallback: T): T => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

/** The most recent finished run, or null when the doctor has never finished one. */
export function latestDoctorRun(db: Db): DoctorRun | null {
  const r = db
    .prepare(
      `SELECT id, started_at AS startedAt, finished_at AS finishedAt, results_json AS resultsJson,
         drop_ids_json AS dropIdsJson
       FROM doctor_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get() as Row | undefined;
  if (!r) return null;
  return {
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    checks: parse<DoctorCheck[]>(r.resultsJson, []),
    dropIds: parse<string[]>(r.dropIdsJson, []),
  };
}

export function summarize(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  const out: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) out[c.status]++;
  return out;
}

/** This process, as the doctor sees it. */
export function processEnv(env: NodeJS.ProcessEnv = process.env): DoctorEnv {
  let uidMap: string | null = null;
  try {
    uidMap = readFileSync('/proc/self/uid_map', 'utf8');
  } catch {
    uidMap = null; // not Linux
  }
  const secretFiles = Object.entries(env)
    .filter(([k, v]) => /^JM_[A-Z0-9_]+_FILE$/.test(k) && typeof v === 'string' && v !== '')
    .map(([variable, path]) => {
      let mode: number | null = null;
      try {
        mode = statSync(path as string).mode & 0o777;
      } catch {
        mode = null; // startup already refused an unreadable secret
      }
      return { variable, path: path as string, mode };
    });
  // Every file under the secrets directory (credentials by name, the machine secrets, the vault
  // key), once, beside the *_FILE variables that point elsewhere.
  const dir = env.JM_SECRETS_DIR;
  if (dir) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const path = join(dir, name);
      if (secretFiles.some((f) => f.path === path)) continue;
      try {
        const st = statSync(path);
        if (st.isFile())
          secretFiles.push({ variable: `secrets/${name}`, path, mode: st.mode & 0o777 });
      } catch {
        // gone between the listing and the stat
      }
    }
  }
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    inContainer: env.JM_CONTAINER === '1',
    uidMap,
    secretFiles,
  };
}
