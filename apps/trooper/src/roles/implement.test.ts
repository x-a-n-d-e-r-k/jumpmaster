import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropPayload, GateResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { ParsedLine } from '../claude.js';
import type { TrooperDeps } from '../main.js';
import { runImplement } from './implement.js';
import { acceptOutcome, type RoleCtx } from './shared.js';

const impl: DropPayload = {
  protocol: 1,
  dropId: 'd1',
  epoch: 1,
  role: 'implement',
  resume: false,
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'do it',
  image: 'img',
  protectedPaths: ['.github/**'],
  credentials: { claudeToken: 'sk-ant-oat-SECRET1234567890', forgeToken: 'ghp_FORGE1234567890' },
};

const ctx: RoleCtx = {
  workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-impl-')),
  secrets: ['sk-ant-oat-SECRET1234567890'],
  ids: null,
};
const repoDir = join(ctx.workdir, 'repo');

const init = (s: string) => JSON.stringify({ type: 'system', subtype: 'init', session_id: s });
const resultLine = (
  o: { session?: string; terminal?: string; status?: string; isError?: boolean } = {},
) =>
  JSON.stringify({
    type: 'result',
    is_error: o.isError ?? false,
    terminal_reason: o.terminal ?? 'completed',
    session_id: o.session ?? 's',
    structured_output: { status: o.status ?? 'COMPLETE', summary: 'done' },
  });
const rateLimit = (status: string) =>
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1767225600 } });
const complete = [init('s'), resultLine()];

function world(
  stream: string[],
  o: { remoteSha?: string | null; dirty?: boolean; ahead?: number; pushError?: string } = {},
) {
  const calls: unknown[][] = [];
  let committed = false;
  const rec =
    <T>(name: string, ret: (...a: unknown[]) => T) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return ret(...a);
    };
  const push = (name: string) =>
    rec(name, () => {
      if (o.pushError) throw new Error(o.pushError);
      return 'ck1';
    });
  const deps = {
    git: {
      cloneRepo: rec('cloneRepo', () => undefined),
      mirrorFetch: rec('mirrorFetch', () => undefined),
      checkoutBranch: rec('checkoutBranch', () => undefined),
      remoteBranchSha: rec('remoteBranchSha', () => o.remoteSha ?? null),
      remoteBranchExists: rec('remoteBranchExists', () => false),
      prepareBranch: rec('prepareBranch', () => undefined),
      commitIfDirty: rec('commitIfDirty', () => {
        committed = o.dirty ?? false;
        return committed;
      }),
      headSha: rec('headSha', () => 'h'),
      aheadOfBase: rec('aheadOfBase', () => o.ahead ?? (committed ? 1 : 0)),
      pushNewBranch: push('pushNewBranch'),
      pushExistingBranch: push('pushExistingBranch'),
      sweepProcesses: () => false,
      cloneForGates: rec('cloneForGates', () => undefined),
      removeTree: rec('removeTree', () => undefined),
    },
    async *runClaude() {
      for (const l of stream) yield l;
    },
    runGates: async (gates: { name: string }[]): Promise<GateResult[]> =>
      gates.map((g) => ({
        name: g.name,
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        outputTail: '',
      })),
    emit: () => undefined,
  } as unknown as TrooperDeps;
  return { deps, calls, names: () => calls.map((c) => c[0]) };
}

describe('runImplement', () => {
  test('resume continues the existing branch instead of failing fast', async () => {
    const w = world(complete, { ahead: 1 });
    const r = await runImplement({ ...impl, resume: true, resumeSha: 'ck0' }, w.deps, ctx);
    expect(w.calls).toContainEqual(['checkoutBranch', repoDir, 'agent/issue-1', 'ck0', null]);
    expect(w.calls).toContainEqual([
      'mirrorFetch',
      join(ctx.workdir, 'mirror'),
      impl.credentials.forgeToken,
      { owner: 'o', name: 'r' },
      ['agent/issue-1'],
    ]);
    expect(w.names()).not.toContain('remoteBranchSha');
    expect(w.names()).not.toContain('prepareBranch');
    const push = w.calls.find((c) => c[0] === 'pushExistingBranch');
    expect(push?.slice(1, 6)).toEqual([
      repoDir,
      'agent/issue-1',
      impl.credentials.forgeToken,
      { owner: 'o', name: 'r' },
      'ck0',
    ]);
    expect(r.status).toBe('completed');
  });

  test('resume:false with an existing branch fails fast', async () => {
    const w = world(complete, { remoteSha: 'abc' });
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({
      status: 'failed',
      reason: 'branch agent/issue-1 already exists on remote',
    });
    expect(w.names()).not.toContain('remoteBranchExists');
    expect(w.names()).not.toContain('prepareBranch');
  });

  test('rate_limited implement pushes a checkpoint and reports headSha', async () => {
    const w = world([init('s'), rateLimit('rejected')], { ahead: 1 });
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({ status: 'rate_limited', headSha: 'ck1' });
    expect(w.calls).toContainEqual(['commitIfDirty', repoDir, 'wip: checkpoint', null]);
    const push = w.calls.find((c) => c[0] === 'pushNewBranch');
    expect(push?.[6]).toEqual({
      as: null,
      base: 'main',
      protectedPaths: ['.github/**'],
      secrets: ctx.secrets,
    });
  });

  test('a dirty tree with nothing committed is still checkpointed', async () => {
    const w = world([init('s'), rateLimit('rejected')], { dirty: true });
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({ status: 'rate_limited', headSha: 'ck1' });
  });

  test('nothing to checkpoint gives the status without headSha', async () => {
    const w = world([init('s'), rateLimit('rejected')]);
    const r = await runImplement(impl, w.deps, ctx);
    expect(r.status).toBe('rate_limited');
    expect(r.headSha).toBeUndefined();
    expect(w.names()).not.toContain('pushNewBranch');
  });

  test('max turns gives interrupted with a checkpoint', async () => {
    const w = world([init('s'), resultLine({ terminal: 'max_turns', isError: true })], {
      dirty: true,
    });
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({ status: 'interrupted', headSha: 'ck1' });
  });

  test('a resumed checkpoint is pushed onto the existing branch', async () => {
    const w = world([init('s'), rateLimit('rejected')], { dirty: true });
    await runImplement({ ...impl, resume: true, resumeSha: 'ck0' }, w.deps, ctx);
    expect(w.calls.find((c) => c[0] === 'pushExistingBranch')?.[5]).toBe('ck0');
    expect(w.names()).not.toContain('pushNewBranch');
  });

  test('a protected-path change is never pushed and fails', async () => {
    const w = world(complete, { ahead: 1, pushError: 'protected path .github/workflows/ci.yml' });
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({
      status: 'failed',
      reason: 'protected path .github/workflows/ci.yml',
    });
  });

  test('a non-zero claude exit is failed even with a result line', async () => {
    const w = world([
      ...complete,
      JSON.stringify({ type: 'claude_stderr', exitCode: 2, stderr: '' }),
    ]);
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({ status: 'failed', reason: 'claude exit 2' });
    expect(w.names()).not.toContain('pushNewBranch');
  });

  test('a claude killed by a signal is not a clean exit', async () => {
    const w = world([
      ...complete,
      JSON.stringify({ type: 'claude_stderr', exitCode: null, stderr: '' }),
    ]);
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({ status: 'failed', reason: 'claude exit -1' });
  });

  test('a stop signal mid-run checkpoints and reports interrupted', async () => {
    const stop = new AbortController();
    const w = world([], { dirty: true });
    (w.deps as { runClaude: unknown }).runClaude = async function* () {
      yield init('s');
      stop.abort(); // SIGTERM arrives; the agent is killed, so the stream just ends
    };
    const r = await runImplement(impl, { ...w.deps, signal: stop.signal }, ctx);
    expect(r).toMatchObject({ status: 'interrupted', headSha: 'ck1' });
    expect(w.calls).toContainEqual(['commitIfDirty', repoDir, 'wip: checkpoint', null]);
  });

  test('two result events are failed', async () => {
    const w = world([init('s'), resultLine(), resultLine()], { ahead: 1 });
    const r = await runImplement(impl, w.deps, ctx);
    expect(r).toMatchObject({ status: 'failed', reason: 'multiple results' });
  });
});

describe('acceptOutcome', () => {
  const result = (sessionId: string): Extract<ParsedLine, { type: 'result' }> => ({
    type: 'result',
    isError: false,
    sessionId,
    terminalReason: 'completed',
  });

  test('a result whose session id differs from init is failed', () =>
    expect(
      acceptOutcome({
        exitCode: 0,
        results: [result('other')],
        initSessionId: 's',
        rateLimited: false,
      }),
    ).toEqual({ ok: false, reason: 'session mismatch' }));

  test('a single matching result is accepted', () =>
    expect(
      acceptOutcome({
        exitCode: 0,
        results: [result('s')],
        initSessionId: 's',
        rateLimited: false,
      }),
    ).toMatchObject({ ok: true }));

  test('a missing init session id is a mismatch', () =>
    expect(
      acceptOutcome({
        exitCode: 0,
        results: [result('s')],
        initSessionId: null,
        rateLimited: false,
      }),
    ).toEqual({ ok: false, reason: 'session mismatch' }));
});
