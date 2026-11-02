import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DropPayload, GateResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { TrooperDeps } from '../main.js';
import { runTrooper } from '../main.js';
import type { TrooperIdentities } from '../privilege.js';
import { runImplement } from './implement.js';
import { type RoleCtx, runAgent, runGatesPhase } from './shared.js';

const rolesDir = dirname(fileURLToPath(import.meta.url));

const impl: DropPayload = {
  protocol: 1,
  dropId: 'd1',
  epoch: 1,
  role: 'implement',
  resume: false,
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 5, title: 't', body: 'b' },
  branch: 'agent/issue-5',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'do it',
  image: 'img',
  protectedPaths: [],
  credentials: { claudeToken: 'sk-ant-oat-SECRET1234567890', forgeToken: 'ghp_FORGE1234567890' },
};

const ids: TrooperIdentities = {
  agent: { uid: 10001, gid: 10001, home: '/home/agent' },
  gate: { uid: 10002, gid: 10002, home: '/home/gate' },
};
// runAgent writes the system prompt and settings into the workdir, so it must exist.
const ctx: RoleCtx = {
  workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-roles-')),
  secrets: ['sk-ant-oat-SECRET1234567890'],
  ids: null,
};
const ctxWithIds: RoleCtx = { ...ctx, ids };

const completeResult = JSON.stringify({
  type: 'result',
  is_error: false,
  structured_output: { status: 'COMPLETE', summary: 'done' },
  terminal_reason: 'completed',
  session_id: 's1',
});
const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });

function recorder(o: { claude?: string[] } = {}) {
  const state = {
    order: [] as string[],
    lines: [] as string[],
    swept: [] as number[],
    m0Sweeps: 0,
    pushSweep: undefined as undefined | (() => void),
  };
  const deps = {
    git: {
      cloneRepo: async () => void state.order.push('clone'),
      prepareBranch: async () => undefined,
      commitIfDirty: async () => true,
      headSha: async () => 'h',
      aheadOfBase: async () => 1,
      remoteBranchSha: async () => null,
      pushNewBranch: async (
        _d: string,
        _b: string,
        _t: string,
        _tg: unknown,
        sweep: () => void,
      ) => {
        state.pushSweep = sweep;
        return 'abc';
      },
      sweepProcesses: () => {
        state.m0Sweeps++;
        return false;
      },
      cloneForGates: async () => void state.order.push('cloneForGates'),
      removeTree: async () => undefined,
    },
    async *runClaude() {
      for (const l of o.claude ?? [initLine, completeResult]) yield l;
    },
    runGates: async (
      gates: { name: string }[],
      go: { cwd: string; as?: { uid: number } | null },
    ): Promise<GateResult[]> => {
      state.order.push(`gate:${go.as ? go.as.uid : 'self'}@${go.cwd}`);
      return gates.map((g) => ({
        name: g.name,
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        outputTail: '',
      }));
    },
    emit: (l: string) => void state.lines.push(l),
    privilege: {
      sweepUid: (uid: number) => {
        state.swept.push(uid);
        state.order.push(`sweepUid:${uid}`);
        return 0;
      },
    },
  } as unknown as TrooperDeps;
  return { state, deps };
}

describe('runGatesPhase', () => {
  test('gates run as the gate uid after an agent sweep', async () => {
    const r = recorder();
    await runGatesPhase(impl, r.deps, ctxWithIds, '/home/agent/repo');
    expect(r.state.order).toEqual([
      'sweepUid:10001',
      'cloneForGates',
      'gate:10002@/home/gate/repo',
    ]);
  });

  test('without identities gates run in the working copy with no sweep', async () => {
    const r = recorder();
    await runGatesPhase(impl, r.deps, ctx, '/work/w1/repo');
    expect(r.state.order).toEqual(['gate:self@/work/w1/repo']);
  });
});

describe('runImplement', () => {
  test('the push sweep kills both the agent and gate uids', async () => {
    const r = recorder();
    await runImplement(impl, r.deps, ctxWithIds);
    r.state.pushSweep?.();
    expect(r.state.swept).toEqual(expect.arrayContaining([10001, 10002]));
    expect(r.state.m0Sweeps).toBe(1);
  });
});

describe('runAgent', () => {
  test('results carry the last rate-limit report', async () => {
    const rl = (status: string, util: number) =>
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status,
          resetsAt: 1767225600,
          rateLimitType: 'five_hour',
          unifiedWindows: { five_hour: { utilization: util } },
        },
      });
    const r = recorder({ claude: [rl('allowed', 0.1), rl('rejected', 1), completeResult] });
    const out = await runAgent(
      impl,
      r.deps,
      ctx,
      { prompt: 'p', outputSchema: {} },
      '/work/w1/repo',
    );
    expect(out.rateLimited).toBe(true);
    expect(out.rateLimit).toEqual({
      status: 'rejected',
      resetsAt: '2026-01-01T00:00:00.000Z',
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 1 } },
    });
    const events = r.state.lines
      .filter((l) => l.startsWith('JM_EVENT ') && l.includes('"rate_limit"'))
      .map((l) => JSON.parse(l.slice('JM_EVENT '.length)).data);
    expect(Object.keys(events[0]).sort()).toEqual(
      ['rateLimitType', 'resetsAt', 'status', 'unifiedWindows'].sort(),
    );
  });

  test('records the init session id', async () => {
    const r = recorder({
      claude: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        completeResult,
      ],
    });
    const out = await runAgent(
      impl,
      r.deps,
      ctx,
      { prompt: 'p', outputSchema: {} },
      '/work/w1/repo',
    );
    expect(out.initSessionId).toBe('s1');
    expect(out.results).toHaveLength(1);
  });
});

describe('runTrooper dispatch', () => {
  test('unknown role fails without cloning', async () => {
    const r = recorder();
    const review = {
      ...impl,
      role: 'review',
      pr: { number: 1, branch: 'agent/issue-5', headSha: 'h' },
    } as unknown as DropPayload;
    // Review and heal/resolve land in Tasks 18–19; until then they report failed.
    const res = await runTrooper({ ...review, role: 'mystery' } as unknown as DropPayload, r.deps);
    expect(res).toMatchObject({ status: 'failed', reason: 'role not implemented' });
    expect(r.state.order).not.toContain('clone');
  });
});

test('roles read no agent-written file except through readAgentFile', () => {
  for (const f of readdirSync(rolesDir).filter(
    (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'),
  )) {
    expect(readFileSync(join(rolesDir, f), 'utf8')).not.toMatch(/\breadFile(Sync)?\(/);
  }
});
