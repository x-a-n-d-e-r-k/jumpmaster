import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@jumpmaster/protocol';
import { StickClient } from './client.js';
import { DockerDriver } from './docker.js';
import { reapOrphans, runDrop } from './runner.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** Where the stick keeps its enrollment (and, in the image, its verify state). */
export const stateDir = (env: NodeJS.ProcessEnv): string =>
  env.JM_STATE_DIR || join(homedir(), '.jumpmaster');

/** The join token, from JM_JOIN_TOKEN or the file named by JM_JOIN_TOKEN_FILE. */
export function joinToken(env: NodeJS.ProcessEnv): string {
  const token = readSecret(env, 'JM_JOIN_TOKEN');
  if (!token) throw new Error('JM_JOIN_TOKEN or JM_JOIN_TOKEN_FILE is required');
  return token;
}

type Enrollment = { stickId: string; stickToken: string };

/** The saved enrollment for this server URL, if any. */
export function loadEnrollment(dir: string, serverUrl: string): Enrollment | undefined {
  const file = join(dir, 'stick.json');
  if (!existsSync(file)) return undefined;
  const saved = JSON.parse(readFileSync(file, 'utf8')) as {
    serverUrl?: string;
    stickId?: string;
    stickToken?: string;
  };
  if (saved.serverUrl === serverUrl && saved.stickId && saved.stickToken)
    return { stickId: saved.stickId, stickToken: saved.stickToken };
  return undefined;
}

export function saveEnrollment(dir: string, data: Enrollment & { serverUrl: string }): void {
  const file = join(dir, 'stick.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function main() {
  const serverUrl = need('JM_SERVER_URL');
  const slots = Number(process.env.JM_SLOTS ?? '1');
  if (!Number.isInteger(slots) || slots < 1) throw new Error('JM_SLOTS must be an integer >= 1');
  const dir = stateDir(process.env);
  const saved = loadEnrollment(dir, serverUrl);
  const token = saved?.stickToken;
  let stickId = saved?.stickId;
  const client = new StickClient(serverUrl, token);
  if (!token || !stickId) {
    const name = process.env.JM_STICK_NAME ?? 'stick';
    const enrolled = await client.enroll(joinToken(process.env), name, slots);
    stickId = enrolled.stickId;
    saveEnrollment(dir, { serverUrl, stickId, stickToken: enrolled.stickToken });
    console.log(`enrolled as ${stickId}`);
  }

  const driver = new DockerDriver();
  // Before leasing: kill troopers a previous run of this stick left behind.
  const reaped = await reapOrphans(driver, stickId);
  if (reaped.length > 0) console.log(`removed ${reaped.length} orphaned trooper container(s)`);
  let running = 0;
  for (;;) {
    if (running >= slots) {
      await sleep(500);
      continue;
    }
    try {
      const drop = await client.lease(slots - running);
      if (!drop) continue;
      running++;
      console.log(`drop ${drop.dropId} (epoch ${drop.epoch}) leased`);
      runDrop(drop, {
        client,
        driver,
        stickId,
        heartbeatMs: 15_000,
        ...(process.env.JM_LOST_SERVER_KILL_BEATS
          ? { lostServerKillBeats: Number(process.env.JM_LOST_SERVER_KILL_BEATS) }
          : {}),
      })
        .catch((e) =>
          console.error(`drop ${drop.dropId} failed: ${e instanceof Error ? e.message : e}`),
        )
        .finally(() => {
          running--;
        });
    } catch (e) {
      console.error(`lease error: ${e instanceof Error ? e.message : e}`);
      await sleep(5000);
    }
  }
}

const isMain = (): boolean => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain())
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
