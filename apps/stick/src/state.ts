import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ImagePolicy,
  ImagePolicySchema,
  readSecret,
  type StickCapability,
  type StickInfo,
} from '@jumpmaster/protocol';
import { allowedImages } from './runner.js';
import type { ReleaseInfo } from './verify.js';

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
 * The capabilities a stick advertises from what its startup proved: `egress-v1` when the egress
 * check passed, and `image-verify-v1` only under the signed policy (a stick that doesn't verify
 * signatures must never lease a drop from a zone that requires signed images).
 */
export function advertisedCapabilities(o: {
  egress: boolean;
  policy: ImagePolicy;
}): StickCapability[] {
  return [
    ...(o.egress ? (['egress-v1'] as const) : []),
    ...(o.policy === 'signed' ? (['image-verify-v1'] as const) : []),
  ];
}

/**
 * What this stick advertises. `capabilities` are the ones its startup checks proved (`egress-v1`
 * when `egressCapability` passes, `image-verify-v1` when it starts under the signed policy). The
 * policy is `JM_IMAGE_POLICY` (unset: `allowlist`); the pins are the digest refs it allows.
 */
export function stickInfo(
  env: NodeJS.ProcessEnv,
  version: string,
  capabilities: string[] = [],
): StickInfo {
  const policy = ImagePolicySchema.safeParse(env.JM_IMAGE_POLICY || 'allowlist');
  if (!policy.success)
    throw new Error(`JM_IMAGE_POLICY must be allowlist or signed, not ${env.JM_IMAGE_POLICY}`);
  return {
    capabilities: [...capabilities],
    imagePolicy: policy.data,
    version,
    pinnedImages: [...allowedImages(env)].filter((i) => DIGEST_REF.test(i)).sort(),
  };
}

/** Where the stick image's build records its release (see images/stick/Dockerfile). */
export const RELEASE_FILE = new URL('../../../release.json', import.meta.url);

/**
 * The release this stick image was built for: its version and the repository whose release
 * workflow it trusts. Undefined for a build without release arguments (or outside the image).
 */
export function loadRelease(file: URL | string = RELEASE_FILE): ReleaseInfo | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const { version, repository } = (raw ?? {}) as { version?: unknown; repository?: unknown };
  return {
    version: typeof version === 'string' && version !== '' ? version : null,
    repository: typeof repository === 'string' && repository !== '' ? repository : null,
  };
}

/**
 * This stick's version: the release it was built for, else its package.json version marked
 * `-dev` (a build from a checkout is not a release, and must not look like 0.0.0 of one).
 */
export function stickVersion(release: ReleaseInfo | undefined = loadRelease()): string {
  if (release?.version) return release.version;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version !== '' ? `${pkg.version}-dev` : 'unknown';
  } catch {
    return 'unknown';
  }
}
