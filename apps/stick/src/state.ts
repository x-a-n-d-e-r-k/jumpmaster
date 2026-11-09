import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ImagePolicySchema, readSecret, type StickInfo } from '@jumpmaster/protocol';
import { allowedImages } from './runner.js';

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

const DIGEST_REF = /@sha256:[0-9a-f]{64}$/;

/**
 * What this stick advertises. No capability yet: `egress-v1` arrives with egress enforcement and
 * `image-verify-v1` with image verification, each only once the stick really does it. The policy
 * is `JM_IMAGE_POLICY` (unset: `allowlist`); the pins are the digest refs it allows.
 */
export function stickInfo(env: NodeJS.ProcessEnv, version: string): StickInfo {
  const policy = ImagePolicySchema.safeParse(env.JM_IMAGE_POLICY || 'allowlist');
  if (!policy.success)
    throw new Error(`JM_IMAGE_POLICY must be allowlist or signed, not ${env.JM_IMAGE_POLICY}`);
  return {
    capabilities: [],
    imagePolicy: policy.data,
    version,
    pinnedImages: [...allowedImages(env)].filter((i) => DIGEST_REF.test(i)).sort(),
  };
}

/** This stick's version, from its package.json (next to dist/ in the image and the repository). */
export function stickVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
