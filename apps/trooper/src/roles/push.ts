import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  type PushGrant,
  type PushPayload,
  type PushResult,
  READY_LINE,
  RESULT_PREFIX,
} from '@jumpmaster/protocol';
import type { commitIfDirty, pushStaged, stageFromAgent } from '../git.js';
import type { TrooperIdentities } from '../privilege.js';
import { redact } from '../redact.js';
import { readGrant, StdinClosedError } from '../stdin.js';

export interface PushDeps {
  /** The rest of stdin after the payload line: the grant arrives here, after the ready line. */
  stdin: Readable;
  emit(line: string): void;
  ids: TrooperIdentities | null;
  /** Kills every agent-uid process. */
  sweep(): void;
  /** How many agent-uid processes are still alive. */
  alive(uid: number): number;
  git: {
    stageFromAgent: typeof stageFromAgent;
    pushStaged: typeof pushStaged;
    commitIfDirty: typeof commitIfDirty;
  };
}

const REASON_MAX = 2000;

/** SIGKILL lands asynchronously: a process the sweep just killed may still be listed briefly. */
export const SURVIVOR_CHECKS = 10;
export const SURVIVOR_POLL_MS = 200;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** True when agent processes are still alive after up to ~2 s of re-checks. */
async function survivors(alive: () => number): Promise<boolean> {
  for (let i = 0; i < SURVIVOR_CHECKS; i++) {
    if (alive() === 0) return false;
    if (i < SURVIVOR_CHECKS - 1) await sleep(SURVIVOR_POLL_MS);
  }
  return true;
}

const basicAuth = (token: string): string =>
  Buffer.from(`x-access-token:${token}`).toString('base64');

const grantSecrets = (g: PushGrant): string[] => [...g.secrets, g.token, basicAuth(g.token)];

/** Redacts every reason, bounds it, and serialises the result line with the same secrets. */
function finish(r: PushResult, secrets: string[], emit: (l: string) => void): PushResult {
  const out: PushResult =
    r.status === 'pushed' ? r : { ...r, reason: redact(r.reason, secrets).slice(0, REASON_MAX) };
  // Redact the serialised line too: JSON escaping could otherwise hide a secret from the reason pass.
  emit(redact(RESULT_PREFIX + JSON.stringify(out), secrets));
  return out;
}

/**
 * The push container's role, token last. The working copy at `<agent home>/repo` is hostile.
 *
 * 1. salvage only: commit what the agent left, as the agent, hardened (best effort);
 * 2. stage the branch into a root-owned bare repo (no token anywhere yet); `nothing` ends here;
 * 3. sweep the agent uid, and refuse (retryable) if any agent process survived;
 * 4. print the ready line; only then read the grant (which carries the token) from stdin;
 * 5. refuse a grant for another branch; push.
 *
 * Every path prints exactly one result line, and removes the staged copy.
 */
export async function runPush(payload: PushPayload, deps: PushDeps): Promise<PushResult> {
  // No secret is known before the grant; redact still strips anything token-shaped.
  let secrets: string[] = [];
  let pushDir: string | null = null;
  const done = (r: PushResult) => finish(r, secrets, deps.emit);
  const fail = (reason: string, retryable: boolean) =>
    done({ status: 'failed', reason, retryable });
  try {
    const agent = deps.ids?.agent ?? null;
    // Without the agent identity there is no uid to sweep: never stage, never ask for a token.
    if (!agent) return fail('push role requires the agent identity', false);
    const repo = join(agent.home, 'repo');

    if (payload.salvage) {
      // Best effort: a commit that fails (a lock the killed agent left, a timeout) must not lose
      // the commits the agent already made; staging takes whatever the branch holds.
      await deps.git
        .commitIfDirty(repo, 'wip: salvage', agent, { hardened: true })
        .catch(() => undefined);
    }

    const staged = await deps.git.stageFromAgent(repo, payload.branch, {
      as: agent,
      sweep: deps.sweep,
    });
    if ('nothing' in staged) return done({ status: 'nothing', reason: staged.nothing });
    pushDir = staged.pushDir;

    deps.sweep();
    if (await survivors(() => deps.alive(agent.uid)))
      return fail('agent process survived the sweep', true);

    deps.emit(READY_LINE);
    let grant: PushGrant;
    try {
      grant = await readGrant(deps.stdin);
    } catch (e) {
      // The stick went away after ready (it stops the container on a refused grant and retries):
      // retryable. A grant that arrived but is malformed or oversized stays final below.
      if (e instanceof StdinClosedError) return fail(e.message, true);
      throw e;
    }
    secrets = grantSecrets(grant);
    if (grant.branch !== payload.branch) {
      return fail(`grant is for another branch than ${payload.branch}`, false);
    }
    // pushStaged removes the staged copy itself; the finally below covers it throwing.
    return done(await deps.git.pushStaged(pushDir, grant));
  } catch (e) {
    // By design every other thrown error (staging, a malformed grant, an unexpected push throw)
    // is final: the server can't tell a transient one from a hostile working copy.
    return fail(e instanceof Error ? e.message : String(e), false);
  } finally {
    if (pushDir) rmSync(pushDir, { recursive: true, force: true });
  }
}
