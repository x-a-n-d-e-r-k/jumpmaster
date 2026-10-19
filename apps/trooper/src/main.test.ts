import { Readable } from 'node:stream';
import type { DropPayload, GateResult } from '@jumpmaster/protocol';
import { expect, test } from 'vitest';
import type { TrooperDeps } from './main.js';
import { readPayload, runTrooper } from './main.js';

const payload: DropPayload = {
  protocol: 1,
  dropId: 'd1',
  epoch: 1,
  role: 'implement',
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 5, title: 't', body: 'b' },
  branch: 'agent/issue-5',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'do it',
  image: 'jumpmaster-trooper:test',
  protectedPaths: [],
  credentials: {
    claudeToken: 'sk-ant-oat-SECRETSECRETSECRET1234',
    forgeToken: 'ghp_FORGESECRETFORGESECRET1234',
  },
};

const completeResult = JSON.stringify({
  type: 'result',
  is_error: false,
  structured_output: { status: 'COMPLETE', summary: 'done' },
  usage: { input_tokens: 1 },
  modelUsage: { m: { inputTokens: 1 } },
  num_turns: 3,
});
const blockedResult = JSON.stringify({
  type: 'result',
  is_error: false,
  structured_output: { status: 'BLOCKED', summary: 'need a decision' },
});
const rateLimitRejectedLine = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 1900000000 },
});

function fakeDeps(o: {
  ahead?: number;
  claude: string[];
  gateExit?: number;
  throwOn?: string;
  remoteHasBranch?: boolean;
}) {
  const state = {
    lines: [] as string[],
    pushed: false,
    calls: [] as string[],
    sweeps: 0,
    claudeRan: false,
    claudeEnv: {} as Record<string, string | undefined>,
  };
  const deps: TrooperDeps = {
    git: {
      cloneRepo: async (c) => {
        state.cloneDir = c.dir;
        state.calls.push('clone');
        if (o.throwOn === 'clone') throw new Error(`boom ${payload.credentials.forgeToken}`);
      },
      prepareBranch: async () => void state.calls.push('branch'),
      commitIfDirty: async () => true,
      headSha: async () => 'working-copy-sha',
      aheadOfBase: async () => o.ahead ?? 1,
      remoteBranchExists: async (t, b, tok) => {
        state.calls.push('ls-remote');
        state.lsRemote = { t, b, tok };
        return o.remoteHasBranch ?? false;
      },
      pushNewBranch: async (_dir, _branch, _tok, t, sweep) => {
        state.pushTarget = t;
        state.pushSweep = sweep;
        state.pushed = true;
        return 'abc123';
      },
      sweepProcesses: () => {
        state.sweeps++;
        return false;
      },
    },
    async *runClaude(_args, env, cwd) {
      state.claudeRan = true;
      state.claudeEnv = env;
      state.claudeCwd = cwd;
      for (const l of o.claude) yield l;
    },
    runGates: async (gates, go): Promise<GateResult[]> => {
      state.gatesEnv = go.env;
      return gates.map((g) => ({
        name: g.name,
        exitCode: o.gateExit ?? 0,
        durationMs: 1,
        timedOut: false,
        outputTail: 'tail',
      }));
    },
    emit: (l) => void state.lines.push(l),
  };
  return Object.assign(state, { deps });
}

test('happy path pushes and completes with headSha', async () => {
  const f = fakeDeps({ claude: [completeResult] });
  const r = await runTrooper(payload, f.deps);
  expect(r).toMatchObject({ status: 'completed', headSha: 'abc123', numTurns: 3 });
  expect(f.pushed).toBe(true);
  expect(f.claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(payload.credentials.claudeToken);
  expect(JSON.stringify(f.claudeEnv)).not.toContain(payload.credentials.forgeToken);
  expect(f.lines.at(-1)).toMatch(/^JM_RESULT /);
});

test('no commits → no_changes and no push', async () => {
  const f = fakeDeps({ ahead: 0, claude: [completeResult] });
  expect((await runTrooper(payload, f.deps)).status).toBe('no_changes');
  expect(f.pushed).toBe(false);
});

test('BLOCKED → blocked with summary, no push', async () => {
  const f = fakeDeps({ claude: [blockedResult] });
  const r = await runTrooper(payload, f.deps);
  expect(r).toMatchObject({ status: 'blocked', reason: 'need a decision' });
  expect(f.pushed).toBe(false);
});

test('failing gate → failed, no push', async () => {
  const f = fakeDeps({ claude: [completeResult], gateExit: 1 });
  const r = await runTrooper(payload, f.deps);
  expect(r).toMatchObject({ status: 'failed', reason: 'gate test failed' });
  expect(f.pushed).toBe(false);
});

test('no result line → failed', async () => {
  const f = fakeDeps({ claude: ['{"type":"assistant"}'] });
  const r = await runTrooper(payload, f.deps);
  expect(r.status).toBe('failed');
  expect(f.pushed).toBe(false);
});

test('error result → failed', async () => {
  const f = fakeDeps({
    claude: [JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'max_turns' })],
  });
  const r = await runTrooper(payload, f.deps);
  expect(r.status).toBe('failed');
  expect(r.reason).toContain('max_turns');
});

test('thrown error → failed with redacted reason', async () => {
  const f = fakeDeps({ claude: [], throwOn: 'clone' });
  const r = await runTrooper(payload, f.deps);
  expect(r.status).toBe('failed');
  expect(r.reason).not.toContain(payload.credentials.forgeToken);
  expect(f.lines.join('\n')).not.toContain(payload.credentials.forgeToken);
});

test('rate limit lines are emitted as events and secrets are redacted', async () => {
  const f = fakeDeps({
    claude: [
      rateLimitRejectedLine,
      `{"type":"assistant","text":"${payload.credentials.claudeToken}"}`,
      completeResult,
    ],
  });
  await runTrooper(payload, f.deps);
  expect(f.lines.some((l) => l.startsWith('JM_EVENT ') && l.includes('"rate_limit"'))).toBe(true);
  expect(f.lines.join('\n')).not.toContain(payload.credentials.claudeToken);
  expect(f.lines.at(-1)).toMatch(/^JM_RESULT /);
});

test('claude runs inside the clone dir', async () => {
  const f = fakeDeps({ claude: [completeResult] });
  await runTrooper(payload, f.deps);
  expect(f.cloneDir).not.toBe('');
  expect(f.claudeCwd).toBe(f.cloneDir);
});

test('gates env carries no credentials', async () => {
  const saved = { ...process.env };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = payload.credentials.claudeToken;
  process.env.GH_TOKEN = payload.credentials.forgeToken;
  process.env.JM_SECRET = 'x';
  try {
    const f = fakeDeps({ claude: [completeResult] });
    await runTrooper(payload, f.deps);
    const env = JSON.stringify(f.gatesEnv);
    expect(env).not.toContain(payload.credentials.claudeToken);
    expect(env).not.toContain(payload.credentials.forgeToken);
    expect(f.gatesEnv).not.toHaveProperty('JM_SECRET');
  } finally {
    process.env = saved;
  }
});

test('forge token never reaches claude env even if present in process env', async () => {
  const saved = { ...process.env };
  process.env.GITHUB_TOKEN = payload.credentials.forgeToken;
  try {
    const f = fakeDeps({ claude: [completeResult] });
    await runTrooper(payload, f.deps);
    expect(JSON.stringify(f.claudeEnv)).not.toContain(payload.credentials.forgeToken);
  } finally {
    process.env = saved;
  }
});

test('claude non-zero exit code is included in the failed reason', async () => {
  const f = fakeDeps({
    claude: [JSON.stringify({ type: 'claude_stderr', exitCode: 3, stderr: 'x' })],
  });
  const r = await runTrooper(payload, f.deps);
  expect(r.status).toBe('failed');
  expect(r.reason).toContain('exit 3');
});

test('readPayload parses the payload from stdin', async () => {
  const text = JSON.stringify(payload);
  const p = await readPayload(undefined, Readable.from([text.slice(0, 20), text.slice(20)]));
  expect(p.dropId).toBe('d1');
  await expect(readPayload(undefined, Readable.from(['{}']))).rejects.toThrow();
});

test('push goes to the explicit repo target with the process sweep, and reports the pushed sha', async () => {
  const f = fakeDeps({ claude: [completeResult] });
  const r = await runTrooper(payload, f.deps);
  expect(f.pushTarget).toEqual({ owner: 'o', name: 'r' });
  expect(typeof f.pushSweep).toBe('function');
  f.pushSweep();
  expect(f.sweeps).toBe(1);
  expect(r.headSha).toBe('abc123');
});

test('existing remote branch → failed before claude runs', async () => {
  const f = fakeDeps({ claude: [completeResult], remoteHasBranch: true });
  const r = await runTrooper(payload, f.deps);
  expect(r).toMatchObject({
    status: 'failed',
    reason: 'branch agent/issue-5 already exists on remote',
  });
  expect(f.claudeRan).toBe(false);
  expect(f.pushed).toBe(false);
  expect(f.lsRemote).toEqual({
    t: { owner: 'o', name: 'r' },
    b: 'agent/issue-5',
    tok: payload.credentials.forgeToken,
  });
  expect(f.calls.indexOf('ls-remote')).toBeGreaterThan(f.calls.indexOf('clone'));
});

test('every emitted event line stays under 64 KB and secrets cut by truncation are still redacted', async () => {
  const big = 'x'.repeat(200_000);
  // A secret positioned so a naive cut would split it.
  const sliced = `${'y'.repeat(16 * 1024 - 12)}${payload.credentials.claudeToken}${'z'.repeat(100_000)}`;
  const f = fakeDeps({
    claude: [
      JSON.stringify({ type: 'assistant', text: big, nested: { arr: [big, sliced] } }),
      completeResult,
    ],
  });
  await runTrooper(payload, f.deps);
  const events = f.lines.filter((l) => l.startsWith('JM_EVENT '));
  expect(events.length).toBeGreaterThan(0);
  for (const l of events) {
    expect(Buffer.byteLength(l)).toBeLessThanOrEqual(64 * 1024);
    expect(() => JSON.parse(l.slice('JM_EVENT '.length))).not.toThrow();
  }
  const joined = f.lines.join('\n');
  expect(joined).not.toContain(payload.credentials.claudeToken);
  expect(joined).not.toContain(payload.credentials.claudeToken.slice(0, 12));
});

test('implement without a forge token is refused', async () => {
  const f = fakeDeps({ claude: [completeResult] });
  const p = { ...payload, credentials: { claudeToken: payload.credentials.claudeToken } };
  await expect(runTrooper(p, f.deps)).rejects.toThrow('forge token required for implement');
});
