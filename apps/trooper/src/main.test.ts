import type { DropPayload, GateResult } from '@jumpmaster/protocol';
import { expect, test } from 'vitest';
import type { TrooperDeps } from './main.js';
import { runTrooper } from './main.js';

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

function fakeDeps(o: { ahead?: number; claude: string[]; gateExit?: number; throwOn?: string }) {
  const state = {
    lines: [] as string[],
    pushed: false,
    calls: [] as string[],
    claudeEnv: {} as Record<string, string | undefined>,
  };
  const deps: TrooperDeps = {
    git: {
      cloneRepo: async () => {
        state.calls.push('clone');
        if (o.throwOn === 'clone') throw new Error(`boom ${payload.credentials.forgeToken}`);
      },
      prepareBranch: async () => void state.calls.push('branch'),
      commitIfDirty: async () => true,
      headSha: async () => 'abc123',
      aheadOfBase: async () => o.ahead ?? 1,
      pushNewBranch: async () => {
        state.pushed = true;
      },
    },
    async *runClaude(_args, env) {
      state.claudeEnv = env;
      for (const l of o.claude) yield l;
    },
    runGates: async (gates): Promise<GateResult[]> =>
      gates.map((g) => ({
        name: g.name,
        exitCode: o.gateExit ?? 0,
        durationMs: 1,
        timedOut: false,
        outputTail: 'tail',
      })),
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
