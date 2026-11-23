import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  type PushGrant,
  type PushPayload,
  type PushResult,
  READY_LINE,
  RESULT_PREFIX,
} from '@jumpmaster/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TrooperIdentities } from '../privilege.js';
import {
  grantSecrets,
  type PushDeps,
  runPush,
  SURVIVOR_CHECKS,
  SURVIVOR_POLL_MS,
  survivors,
} from './push.js';

const B = 'agent/issue-1';
const HEAD = 'a'.repeat(40);
const TOKEN = 'tok-plain-0123456789-not-shaped';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const IDS: TrooperIdentities = {
  agent: { uid: 10001, gid: 10001, home: '/home/agent' },
  gate: { uid: 10002, gid: 10002, home: '/home/gate' },
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), 'pushrole-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
  protocol: 1,
  role: 'push',
  dropId: 7,
  epoch: 1,
  branch: B,
  salvage: false,
  ...over,
});

const grant = (over: Partial<PushGrant> = {}): PushGrant => ({
  token: TOKEN,
  owner: 'o',
  name: 'r',
  branch: B,
  base: 'main',
  lease: '',
  protectedPaths: [],
  secrets: ['zone-secret-xyz'],
  ...over,
});

type Over = {
  grant?: PushGrant;
  alive?: number;
  stage?: () => Promise<{ pushDir: string; head: string } | { nothing: string }>;
  push?: (g: PushGrant) => Promise<PushResult>;
  ids?: TrooperIdentities | null;
};

/**
 * A recorded world: every step logs, and stdin logs the moment anything first reads from it. The
 * grant line is only available once the ready line was emitted.
 */
function harness(o: Over = {}) {
  const log: string[] = [];
  const lines: string[] = [];
  const calls: Record<string, unknown[][]> = { commit: [], stage: [], push: [] };
  let ready = false;
  let sent = false;
  const stdin = new Readable({
    read() {
      log.push(ready ? 'stdin-read' : 'stdin-read-before-ready');
      if (ready && !sent) {
        sent = true;
        this.push(`${JSON.stringify(o.grant ?? grant())}\n`);
      }
    },
  });
  const pushDir = mkdtempSync(join(tmp, 'push-'));
  const deps: PushDeps = {
    stdin,
    emit: (l) => {
      lines.push(l);
      log.push(l === READY_LINE ? 'ready' : 'emit');
      if (l === READY_LINE) ready = true;
    },
    ids: o.ids === undefined ? IDS : o.ids,
    sweep: () => void log.push('sweep'),
    alive: (uid) => {
      log.push(`alive:${uid}`);
      return o.alive ?? 0;
    },
    sleep: async () => void log.push('sleep'),
    git: {
      commitIfDirty: async (...args) => {
        calls.commit?.push(args);
        log.push('commit');
        return true;
      },
      stageFromAgent: async (...args) => {
        calls.stage?.push(args);
        log.push('stage');
        args[2].sweep();
        return o.stage ? o.stage() : { pushDir, head: HEAD };
      },
      pushStaged: async (...args) => {
        calls.push?.push(args);
        log.push('push');
        rmSync(args[0], { recursive: true, force: true });
        return o.push ? o.push(args[1]) : { status: 'pushed', headSha: HEAD, alreadyThere: false };
      },
    },
  };
  const result = (): PushResult => {
    const last = lines.filter((l) => l.startsWith(RESULT_PREFIX));
    expect(last).toHaveLength(1);
    return JSON.parse((last[0] as string).slice(RESULT_PREFIX.length)) as PushResult;
  };
  return { deps, log, lines, calls, pushDir, result };
}

describe('survivors (issue #262)', () => {
  /** A recorded run of `survivors` over fixed readings. */
  async function run(readings: number[]) {
    const log: string[] = [];
    let i = 0;
    const result = await survivors(
      () => void log.push('sweep'),
      () => {
        const n = readings[i++] ?? 0;
        log.push(`alive=${n}`);
        return n;
      },
      async (ms) => void log.push(`sleep ${ms}`),
    );
    return { result, log };
  }

  test('one non-zero reading among zeros is a survivor', async () => {
    const { result, log } = await run([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result).toBe(true);
    // The sweep runs again before every reading.
    expect(log).toEqual(['sweep', 'alive=0', `sleep ${SURVIVOR_POLL_MS}`, 'sweep', 'alive=1']);
  });

  test('none only when every reading, each after its own sweep, is zero', async () => {
    const { result, log } = await run(Array(SURVIVOR_CHECKS).fill(0));
    expect(result).toBe(false);
    expect(log.filter((l) => l === 'sweep')).toHaveLength(SURVIVOR_CHECKS);
    expect(log.filter((l) => l.startsWith('alive='))).toHaveLength(SURVIVOR_CHECKS);
    for (let k = 0; k < log.length; k++)
      if (log[k]?.startsWith('alive=')) expect(log[k - 1]).toBe('sweep');
  });

  test('a survivor on the last reading still counts', async () => {
    const readings = Array(SURVIVOR_CHECKS).fill(0);
    readings[SURVIVOR_CHECKS - 1] = 1;
    expect((await run(readings)).result).toBe(true);
  });
});

describe('runPush', () => {
  test('ready only after staging and the sweep', async () => {
    const h = harness();
    const r = await runPush(payload(), h.deps);
    expect(r).toEqual({ status: 'pushed', headSha: HEAD, alreadyThere: false });
    // Every reading follows a fresh sweep, and every one of them is taken.
    const checks = Array.from({ length: SURVIVOR_CHECKS }, (_, i) =>
      i === 0 ? ['sweep', 'alive:10001'] : ['sleep', 'sweep', 'alive:10001'],
    ).flat();
    expect(h.log).toEqual(['stage', 'sweep', ...checks, 'ready', 'stdin-read', 'push', 'emit']);
    // The ready line is alone on its line, printed once.
    expect(h.lines.filter((l) => l === READY_LINE)).toHaveLength(1);
    expect(h.result()).toEqual(r);
    expect(h.calls.stage?.[0]?.slice(0, 2)).toEqual(['/home/agent/repo', B]);
    expect(h.calls.stage?.[0]?.[2]).toMatchObject({ as: IDS.agent });
  });

  test('no ready when an agent process survives', async () => {
    const h = harness({ alive: 1 });
    const r = await runPush(payload(), h.deps);
    expect(r).toEqual({
      status: 'failed',
      reason: 'agent process survived the sweep',
      retryable: true,
    });
    expect(h.log).not.toContain('ready');
    expect(h.log.some((l) => l.startsWith('stdin-read'))).toBe(false);
    expect(h.calls.push).toHaveLength(0);
    expect(h.result()).toEqual(r);
    // The staged copy never outlives a run that did not push it.
    expect(existsSync(h.pushDir)).toBe(false);
  });

  test('salvage commits as the agent, hardened, before staging', async () => {
    const h = harness();
    await runPush(payload({ salvage: true }), h.deps);
    expect(h.log.slice(0, 2)).toEqual(['commit', 'stage']);
    expect(h.calls.commit).toEqual([
      ['/home/agent/repo', 'wip: salvage', IDS.agent, { hardened: true }],
    ]);
  });

  test('no salvage commit without salvage', async () => {
    const h = harness();
    await runPush(payload(), h.deps);
    expect(h.calls.commit).toHaveLength(0);
  });

  test('a failed salvage commit still stages what was committed', async () => {
    const h = harness();
    h.deps.git.commitIfDirty = async () => {
      h.log.push('commit');
      throw new Error('git commit failed (exit 128): index.lock exists');
    };
    const r = await runPush(payload({ salvage: true }), h.deps);
    expect(r.status).toBe('pushed');
    expect(h.log.slice(0, 2)).toEqual(['commit', 'stage']);
  });

  test('the grant is consumed only after ready', async () => {
    const h = harness();
    await runPush(payload(), h.deps);
    expect(h.log).not.toContain('stdin-read-before-ready');
    expect(h.log.indexOf('stdin-read')).toBeGreaterThan(h.log.indexOf('ready'));
    expect(h.log.indexOf('push')).toBeGreaterThan(h.log.indexOf('stdin-read'));
  });

  test('a grant for another branch is refused', async () => {
    const h = harness({ grant: grant({ branch: 'agent/issue-2' }) });
    const r = await runPush(payload(), h.deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    expect(h.calls.push).toHaveLength(0);
    expect(existsSync(h.pushDir)).toBe(false);
    expect(h.result()).toEqual(r);
  });

  test('a grant that does not parse is a failure and removes the staged copy', async () => {
    const h = harness();
    h.deps.stdin = new Readable({
      read() {
        this.push('{"token":\n');
      },
    });
    const r = await runPush(payload(), h.deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    expect(h.calls.push).toHaveLength(0);
    expect(existsSync(h.pushDir)).toBe(false);
  });

  test('stdin ending after ready is a retryable failure', async () => {
    const h = harness();
    let ready = false;
    h.deps.stdin = new Readable({
      read() {
        if (ready) this.push(null);
      },
    });
    const emit = h.deps.emit;
    h.deps.emit = (l) => {
      emit(l);
      if (l === READY_LINE) {
        ready = true;
        h.deps.stdin.read(0);
      }
    };
    const r = await runPush(payload(), h.deps);
    expect(r).toMatchObject({ status: 'failed', retryable: true });
    expect(h.calls.push).toHaveLength(0);
    expect(existsSync(h.pushDir)).toBe(false);
  });

  test('a survivor on the second reading stops the push before ready (issue #262, D2)', async () => {
    const h = harness();
    let n = 0;
    h.deps.alive = () => (n++ === 1 ? 1 : 0);
    const r = await runPush(payload(), h.deps);
    expect(r).toEqual({
      status: 'failed',
      reason: 'agent process survived the sweep',
      retryable: true,
    });
    expect(h.lines).not.toContain(READY_LINE);
    expect(h.log.some((l) => l.startsWith('stdin-read'))).toBe(false);
    expect(h.calls.push).toHaveLength(0);
    expect(h.result()).toEqual(r);
    expect(existsSync(h.pushDir)).toBe(false);
  });

  test('a grant whose lease is not a SHA is refused before any git runs (issue #262)', async () => {
    const h = harness({ grant: grant({ lease: 'main' }) });
    const r = await runPush(payload(), h.deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    expect(h.calls.push).toHaveLength(0);
    expect(h.result()).toEqual(r);
    expect(existsSync(h.pushDir)).toBe(false);
  });

  test('the result line never contains the token or its basic-auth form', async () => {
    const h = harness({
      push: async () => ({
        status: 'failed',
        reason: `remote said ${TOKEN} and ${BASIC} and zone-secret-xyz`,
        retryable: true,
      }),
    });
    const r = await runPush(payload(), h.deps);
    for (const l of h.lines) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain(BASIC);
      expect(l).not.toContain('zone-secret-xyz');
    }
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r).toMatchObject({ status: 'failed', retryable: true });
  });

  describe('a GitLab grant (#716)', () => {
    const GL_BASIC = Buffer.from(`oauth2:${TOKEN}`).toString('base64');
    const gitlab = grant({
      forge: { kind: 'gitlab', origin: 'https://gitlab.com', projectPath: 'group/sub/project' },
    });

    test('a failure echoing the token and its oauth2 header leaves neither in the reason or line', async () => {
      const h = harness({
        grant: gitlab,
        push: async () => ({
          status: 'failed',
          reason: `remote said ${TOKEN} and AUTHORIZATION: basic ${GL_BASIC}`,
          retryable: true,
        }),
      });
      const r = await runPush(payload(), h.deps);
      expect(r).toMatchObject({ status: 'failed', retryable: true });
      expect(h.lines.some((l) => l.startsWith(RESULT_PREFIX))).toBe(true);
      for (const l of [...h.lines, JSON.stringify(r)]) {
        expect(l).not.toContain(TOKEN);
        expect(l).not.toContain(GL_BASIC);
      }
      expect(h.calls.push?.[0]?.[1]).toEqual(gitlab);
    });

    test('a thrown push error echoing the oauth2 header is redacted', async () => {
      const h = harness({
        grant: gitlab,
        push: async () => {
          throw new Error(`boom ${TOKEN} ${GL_BASIC}`);
        },
      });
      const r = await runPush(payload(), h.deps);
      expect(r).toMatchObject({ status: 'failed', retryable: false });
      for (const l of [...h.lines, JSON.stringify(r)]) {
        expect(l).not.toContain(TOKEN);
        expect(l).not.toContain(GL_BASIC);
      }
    });

    test('grantSecrets adds the oauth2 form only for a GitLab grant', () => {
      expect(grantSecrets(grant())).toEqual(['zone-secret-xyz', TOKEN, BASIC]);
      expect(grantSecrets(gitlab)).toEqual(['zone-secret-xyz', TOKEN, BASIC, GL_BASIC]);
    });
  });

  test('nothing is reported as nothing', async () => {
    const h = harness({ stage: async () => ({ nothing: 'branch not in the working copy' }) });
    const r = await runPush(payload(), h.deps);
    expect(r).toEqual({ status: 'nothing', reason: 'branch not in the working copy' });
    expect(h.result()).toEqual(r);
    expect(h.log).not.toContain('ready');
    expect(h.log.some((l) => l.startsWith('stdin-read'))).toBe(false);
    expect(h.calls.push).toHaveLength(0);
  });

  test('a thrown staging error is a bounded, redacted, non-retryable failure', async () => {
    const shaped = `ghp_${'A'.repeat(36)}`;
    const h = harness({
      stage: async () => {
        throw new Error(`git fetch failed (exit 128): ${shaped} ${'x'.repeat(5000)}`);
      },
    });
    const r = await runPush(payload(), h.deps);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.retryable).toBe(false);
    expect(r.reason.length).toBeLessThanOrEqual(2000);
    expect(r.reason).not.toContain(shaped);
    expect(h.log).not.toContain('ready');
    expect(h.result()).toEqual(r);
  });

  test('a thrown push error after the grant is redacted with the grant', async () => {
    const h = harness({
      push: async () => {
        throw new Error(`boom ${TOKEN} ${BASIC}`);
      },
    });
    const r = await runPush(payload(), h.deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    for (const l of h.lines) expect(l).not.toContain(TOKEN);
    expect(existsSync(h.pushDir)).toBe(false);
  });

  test('without the agent identity nothing is staged', async () => {
    const h = harness({ ids: null });
    const r = await runPush(payload(), h.deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    expect(h.calls.stage).toHaveLength(0);
    expect(h.log).not.toContain('ready');
  });
});
