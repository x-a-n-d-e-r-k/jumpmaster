import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecret } from '@jumpmaster/protocol';

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
