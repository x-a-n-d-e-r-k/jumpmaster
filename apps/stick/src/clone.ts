import {
  type CloneGrant,
  type ClonePayload,
  ClonePayloadSchema,
  type ClonePlan,
  type CloneResult,
  CloneResultSchema,
  ceilingRefusal,
  gitlabBasicAuth,
  gitlabBasicAuthAs,
  READY_LINE,
  RESULT_PREFIX,
  redact,
  redactTokenShapes,
} from '@jumpmaster/protocol';
import type { CloneClient } from './client.js';
import type { ContainerDriver, ContainerHandle, DropNet } from './driver.js';
import { type EgressSession, egressImage, startEgress, stickCeiling } from './egress.js';
import { dropSubnetPool } from './subnets.js';
import { MIRROR_MOUNT, REMOVE_TIMEOUT_MS } from './volumes.js';

/**
 * Every trooper image from the clone-container release carries it: such an image runs the `clone`
 * role, which fetches a GitLab project into the drop's mirror before the agent starts. The stick
 * reads nothing else from it yet.
 */
export const TROOPER_CLONE_LABEL = 'org.jumpmaster.trooper.clone';
export const TROOPER_CLONE_VERSION = '1';

export const cloneNetwork = (dropId: string, epoch: number) => `jm-clone-${dropId}-${epoch}`;
export const cloneContainer = (dropId: string, epoch: number) =>
  `jumpmaster-clone-${dropId}-${epoch}`;

/** How long a clone container may take to print `READY_LINE`. */
export const CLONE_READY_TIMEOUT_MS = 2 * 60_000;
/** The whole clone, plan to result: past it the container is killed and the clone fails. */
export const CLONE_TIMEOUT_MS = 15 * 60_000;
/** How often `halted()` is asked while a clone runs. */
export const CLONE_HALT_POLL_MS = 1_000;
const STOP_GRACE_MS = 10_000;
const STDERR_LOG_CHARS = 2_000;

export type CloneDeps = {
  client: CloneClient;
  driver: ContainerDriver;
  stickId: string;
  /** `TROOPER_IMAGE`: the stick's own verified trooper image, never a drop's image. */
  image: string;
  /** The egress proxy image; defaults to `JM_EGRESS_IMAGE`. */
  egressImage?: string;
  egressReadyMs?: number;
  /** Defaults to `JM_DROP_SUBNET_POOL`. */
  subnetPool?: string;
  /** The stick's egress ceiling: `undefined` reads it from the environment, `null` means none. */
  ceiling?: string[] | null;
  /**
   * The drop networks in use, shared with the runner and the sweep: the clone network is in it
   * from before it is created until after it is removed.
   */
  active: Set<string>;
  log?: (line: string) => void;
  readyTimeoutMs?: number;
  /** The whole clone; defaults to `CLONE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Aborted by the kill switch or a heartbeat halt: the container is killed at once. */
  signal?: AbortSignal;
  /** Polled every `haltPollMs`; true kills the container at once, as `signal` does. */
  halted?: () => boolean;
  haltPollMs?: number;
};

export type CloneOutcome =
  | { ok: true; bytes: number }
  | { ok: false; reason: string; retryable: boolean }
  | 'stale';

/**
 * What the stick redacts once it holds a clone grant: the token, the grant's secrets, and the
 * base64 basic-auth forms the trooper may send (`oauth2:<token>`, and `<username>:<token>`).
 */
export function cloneGrantSecrets(grant: CloneGrant): string[] {
  return [
    grant.token,
    ...grant.secrets,
    gitlabBasicAuth(grant.token),
    ...(grant.username ? [gitlabBasicAuthAs(grant.username, grant.token)] : []),
  ];
}

type Stop = 'timeout' | 'halted';
const STOP_REASON: Record<Stop, string> = { timeout: 'clone timed out', halted: 'halted' };

/**
 * One drop's clone container, end to end: plan, its own network and proxy under egress, the
 * stick's own trooper image in the `clone` role, ready, grant, result. The grant is written only
 * to the container this call started, and only after it printed `READY_LINE`. The container's
 * output is never returned or posted. Every path removes the container (confirmed), the proxy
 * and the network before this returns; on any outcome but success the mirror volume goes too,
 * once the container is confirmed gone.
 */
export async function runClone(
  drop: { dropId: string; epoch: number; volume: string },
  deps: CloneDeps,
): Promise<CloneOutcome> {
  const { client, driver, active } = deps;
  const { dropId, epoch, volume } = drop;
  const log = deps.log ?? ((line: string) => console.log(line));
  let secrets: string[] = [];
  const scrub = (text: string) => redact(text, secrets);
  // Each string is scrubbed before JSON escaping could hide a secret, and the line again after.
  const say = (what: string, extra: Record<string, unknown> = {}) => {
    const fields = Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v]),
    );
    log(scrub(JSON.stringify({ event: 'clone', dropId, epoch, what, ...fields })));
  };
  const fail = (reason: string, retryable: boolean): CloneOutcome => ({
    ok: false,
    reason: scrub(reason),
    retryable,
  });

  const labels = {
    'jumpmaster.drop': dropId,
    'jumpmaster.epoch': String(epoch),
    'jumpmaster.stick': deps.stickId,
  };
  const name = cloneContainer(dropId, epoch);
  const network = cloneNetwork(dropId, epoch);

  let stopped: Stop | undefined;
  let handle: ContainerHandle | undefined;
  let wake: () => void = () => {};
  const aborted = new Promise<'aborted'>((r) => {
    wake = () => r('aborted');
  });
  const stopFor = (why: Stop) => {
    if (stopped) return;
    stopped = why;
    wake();
    if (handle) {
      handle.endStdin();
      void handle.kill().catch(() => {});
    }
  };
  const onAbort = () => stopFor('halted');
  const timer = setTimeout(() => stopFor('timeout'), deps.timeoutMs ?? CLONE_TIMEOUT_MS);
  deps.signal?.addEventListener('abort', onAbort);
  const poll = deps.halted
    ? setInterval(() => {
        if (deps.halted?.()) stopFor('halted');
      }, deps.haltPollMs ?? CLONE_HALT_POLL_MS)
    : undefined;
  if (deps.signal?.aborted || deps.halted?.()) stopFor('halted');

  let net: DropNet | undefined;
  let session: EgressSession | undefined;
  let netActive = false;
  let outcome: CloneOutcome = fail('clone did not finish', true);
  try {
    outcome = await (async (): Promise<CloneOutcome> => {
      if (stopped) return fail(STOP_REASON[stopped], false);
      let plan: Awaited<ReturnType<CloneClient['clonePlan']>> | 'aborted';
      try {
        plan = await Promise.race([client.clonePlan(dropId, epoch), aborted]);
      } catch (e) {
        say('plan failed', { error: message(e) });
        return fail(`clone plan failed: ${message(e)}`, true);
      }
      if (plan === 'aborted') return fail(STOP_REASON[stopped ?? 'halted'], false);
      if (plan === 'stale') return 'stale';
      if ('refused' in plan) {
        const refused = redactTokenShapes(plan.refused);
        say('plan refused', { refused, retryable: plan.retryable });
        return fail(refused, plan.retryable);
      }
      const ok: ClonePlan = plan;

      // The stick's egress ceiling, as for a push: a host outside it starts nothing.
      let ceiling: string[] | null;
      let outside: string | null;
      try {
        ceiling = stickCeiling(deps.ceiling);
        outside = ceilingRefusal(ok.egress, ceiling);
      } catch (e) {
        ceiling = [];
        outside = message(e);
      }
      if (outside) {
        say('plan refused by the egress ceiling', { reason: outside });
        return fail(outside, false);
      }

      if (ok.egress) {
        // In the active set before it exists, so the sweep never takes it from under the clone.
        active.add(network);
        netActive = true;
        net = await driver.createDropNetwork(
          network,
          labels,
          deps.subnetPool ?? dropSubnetPool(process.env),
        );
        session = await startEgress(
          driver,
          {
            dropId,
            epoch,
            egress: ok.egress,
            net,
            image: deps.egressImage ?? egressImage(process.env),
            labels,
            ...(deps.egressReadyMs !== undefined ? { readyMs: deps.egressReadyMs } : {}),
          },
          ceiling,
        );
      }
      if (stopped) return fail(STOP_REASON[stopped], false);

      const payload: ClonePayload = ClonePayloadSchema.parse({
        protocol: 1,
        role: 'clone',
        dropId,
        epoch,
        ...(net ? { egress: true } : {}),
      });
      handle = await driver.start({
        image: deps.image,
        payload: JSON.stringify(payload),
        name,
        labels,
        ...(net ? { network, egress: net } : {}),
        ...(ok.limits ? { limits: ok.limits } : {}),
        clone: true,
        mirror: { volume, target: MIRROR_MOUNT },
        holdStdin: true,
      });
      if (stopped) {
        handle.endStdin();
        await handle.kill().catch(() => {});
        return fail(STOP_REASON[stopped], false);
      }
      return await drive(handle);
    })();
  } catch (e) {
    say('clone failed', { error: message(e) });
    outcome = fail(`clone failed: ${message(e)}`, true);
  } finally {
    clearTimeout(timer);
    if (poll) clearInterval(poll);
    deps.signal?.removeEventListener('abort', onAbort);
    if (handle) handle.endStdin();
    let gone = true;
    await driver.removeAndWait(name, REMOVE_TIMEOUT_MS).catch((e: unknown) => {
      gone = false;
      say('clone container not removed', { error: message(e) });
    });
    if (session) await session.stop().catch(() => {});
    if (net) {
      await driver.removeServices(network, labels).catch((e: unknown) => {
        say('clone network not removed', { error: message(e) });
      });
    }
    if (netActive) active.delete(network);
    if (!(typeof outcome === 'object' && outcome.ok)) {
      // A container still holding the volume makes the removal fail; the sweep finds it later.
      if (gone) {
        await driver.removeVolume(volume).catch((e: unknown) => {
          say('mirror volume not removed', { volume, error: message(e) });
        });
      } else say('mirror volume kept: the clone container is not confirmed gone', { volume });
    }
  }
  if (typeof outcome === 'object' && !outcome.ok) say('failed', { reason: outcome.reason });
  else if (outcome === 'stale') say('stale');
  else say('cloned', { bytes: outcome.bytes });
  return outcome;

  /** Reads the container through ready, the grant and its result. */
  async function drive(h: ContainerHandle): Promise<CloneOutcome> {
    const it = h.logs()[Symbol.asyncIterator]();
    /** The next line that matters (ready or a result), the end of the logs, a timeout or a stop. */
    const next = async (
      wantReady: boolean,
      deadline: number,
    ): Promise<{ line: string } | 'end' | 'timeout' | 'aborted'> => {
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return 'timeout';
        let t: NodeJS.Timeout | undefined;
        // No deadline after the grant: the overall timeout ends that wait (through `aborted`).
        const r = await Promise.race([
          it.next(),
          aborted,
          ...(Number.isFinite(left)
            ? [
                new Promise<'timeout'>((res) => {
                  t = setTimeout(() => res('timeout'), left);
                }),
              ]
            : []),
        ]);
        clearTimeout(t);
        if (r === 'aborted' || r === 'timeout') return r;
        if (r.done) return 'end';
        if ((wantReady && r.value === READY_LINE) || r.value.startsWith(RESULT_PREFIX)) {
          return { line: r.value };
        }
      }
    };
    const resultOf = (line: string): CloneResult | undefined => {
      try {
        return CloneResultSchema.parse(JSON.parse(line.slice(RESULT_PREFIX.length)));
      } catch {
        return undefined;
      }
    };
    const halt = () => fail(STOP_REASON[stopped ?? 'halted'], false);
    const noResult = async (): Promise<CloneOutcome> => {
      const { exitCode } = await h.wait().catch(() => ({ exitCode: -1 }));
      if (stopped) return halt();
      // The stderr tail is for the stick's log only, redacted; never returned or posted.
      say('no result', { exitCode, stderr: scrub(h.stderrTail()).slice(-STDERR_LOG_CHARS) });
      return fail(`clone container exited without a result (exit ${exitCode})`, true);
    };
    const finish = (line: string): Promise<CloneOutcome> | CloneOutcome => {
      const r = resultOf(line);
      if (!r) return noResult();
      if (r.status === 'cloned') return { ok: true, bytes: r.bytes };
      return fail(r.reason, r.retryable);
    };
    const stop = async () => {
      h.endStdin();
      await h.stop(STOP_GRACE_MS).catch(() => {});
    };

    const first = await next(true, Date.now() + (deps.readyTimeoutMs ?? CLONE_READY_TIMEOUT_MS));
    if (first === 'aborted') return halt();
    if (first === 'timeout') {
      say('not ready in time');
      await stop();
      return fail('clone container was not ready in time', true);
    }
    if (first === 'end') return noResult();
    // A result before ready (an early failure) is the clone's; no grant is asked for.
    if (first.line !== READY_LINE) return finish(first.line);

    let reply: Awaited<ReturnType<CloneClient['cloneGrant']>> | 'aborted';
    try {
      reply = await Promise.race([client.cloneGrant(dropId, epoch), aborted]);
    } catch (e) {
      await stop();
      say('grant failed', { error: message(e) });
      return fail(`clone grant failed: ${message(e)}`, true);
    }
    if (reply === 'aborted' || stopped) return halt();
    if ('stale' in reply) {
      await stop();
      return 'stale';
    }
    if ('refused' in reply) {
      // The grant never reaches this container.
      await stop();
      const refused = redactTokenShapes(reply.refused);
      say('grant refused', { refused, retryable: reply.retryable });
      return fail(refused, reply.retryable);
    }
    secrets = cloneGrantSecrets(reply.grant);
    // Only this call's own container, which has just printed ready, ever gets the grant.
    await h.writeLine(JSON.stringify(reply.grant));
    h.endStdin();

    const last = await next(false, Number.POSITIVE_INFINITY);
    if (last === 'aborted' || last === 'timeout') return halt();
    if (last === 'end') return noResult();
    return finish(last.line);
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
