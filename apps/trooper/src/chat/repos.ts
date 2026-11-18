// The chat's clones of the zones' code. Root fetches each zone into a root-owned bare mirror with
// the zone's read token (in git's header for that one process: never in a config file, on the
// volume or in the agent's reach), and the agent updates its working copy from the mirror over
// `file://`, with no token at all. Layout: `<root>/<zoneId>/mirror` (root) and
// `<root>/<zoneId>/work` (the agent's checkout, detached at the default branch).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type ChatZoneFetch, redact, withBasicAuth } from '@jumpmaster/protocol';
import { initBare, mirrorFetch, runGit, trustMirror } from '../git.js';
import type { AgentIdentity } from '../privilege.js';

/** Commits of history each fetch keeps: enough for `git log` and `blame` on recent work. */
export const CHAT_FETCH_DEPTH = 200;
const FETCH_TIMEOUT_MS = 180_000;
const REASON_MAX = 300;

/** A zone id is a directory name here: no separators, no dot-names. */
const ZONE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
/** A branch name that is one refspec side and nothing else. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!\/)[A-Za-z0-9._/-]{1,200}$/;

export type SyncResult = { workDir: string } | { unavailable: string };

const execFileP = promisify(execFile);

/**
 * Root cannot chown here (the service drops CAP_CHOWN) nor enter an agent-owned 0700 directory,
 * so the agent's `work` is made by root with the agent's gid as its group (0770): the agent
 * writes in it, and its git trusts it through the root-written safe.directory list.
 */
async function makeWorkDir(work: string, as: AgentIdentity | null): Promise<void> {
  if (!as) {
    mkdirSync(work, { mode: 0o700 });
    return;
  }
  await execFileP('setpriv', [
    `--regid=${as.gid}`,
    '--clear-groups',
    '--',
    'mkdir',
    '-m',
    '0770',
    '--',
    work,
  ]);
}

/** The agent's checkout: fetched from the mirror over file://, detached at the default branch. */
async function updateWork(
  work: string,
  mirror: string,
  z: ChatZoneFetch,
  as: AgentIdentity | null,
): Promise<void> {
  if (!existsSync(work)) await makeWorkDir(work, as);
  if (as) trustMirror(mirror, [work]);
  const opts = { as, extraConfig: [['protocol.file.allow', 'always']] as [string, string][] };
  if (!existsSync(join(work, '.git'))) {
    await runGit(work, ['init', '-q', '--template='], '', opts);
    await runGit(work, ['remote', 'add', 'origin', `file://${mirror}`], '', opts);
  }
  await runGit(
    work,
    [
      'fetch',
      '-q',
      '--no-tags',
      '--prune',
      '--update-shallow',
      'origin',
      `+refs/heads/${z.defaultBranch}:refs/remotes/origin/${z.defaultBranch}`,
      ...z.extraRefs.map((r) => `+refs/${r}:refs/remotes/origin/${r}`),
    ],
    '',
    opts,
  );
  await runGit(work, ['checkout', '-q', '-f', '--detach', `origin/${z.defaultBranch}`], '', opts);
}

/** A failure in plain words plus git's first line, with the token (in any form) removed. */
function reason(what: string, e: unknown, token: string): string {
  const detail = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
  return redact(`${what}: ${detail}`, withBasicAuth(token)).slice(0, REASON_MAX);
}

/**
 * Brings `<root>/<z.id>` up to date for a turn. Runs as root; `as` is the agent identity the
 * working copy belongs to (null outside the container). `o.url` is a test seam for the remote.
 */
export async function syncZone(
  root: string,
  z: ChatZoneFetch,
  as: AgentIdentity | null,
  o: { url?: string } = {},
): Promise<SyncResult> {
  if (!ZONE_ID.test(z.id)) return { unavailable: 'the zone id cannot name a directory' };
  if (!BRANCH.test(z.defaultBranch)) return { unavailable: 'the default branch name is not valid' };
  if (z.token === null) return { unavailable: 'no read token for this zone' };
  const zoneDir = join(root, z.id);
  const mirror = join(zoneDir, 'mirror');
  const work = join(zoneDir, 'work');
  try {
    if (!existsSync(zoneDir)) mkdirSync(zoneDir, { mode: 0o755 });
    await initBare(mirror);
    await mirrorFetch(
      mirror,
      z.token,
      { owner: z.owner, name: z.name, ...(o.url !== undefined ? { url: o.url } : {}) },
      [z.defaultBranch],
      { extraRefs: z.extraRefs, depth: CHAT_FETCH_DEPTH, timeoutMs: FETCH_TIMEOUT_MS },
    );
  } catch (e) {
    return { unavailable: reason(`fetching ${z.owner}/${z.name} failed`, e, z.token) };
  }
  try {
    await updateWork(work, mirror, z, as);
  } catch (e) {
    return { unavailable: reason('updating the working copy failed', e, z.token) };
  }
  return { workDir: work };
}
