import { mkdtempSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorDropPayload, GateResult, GateSpec } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { TrooperDeps } from '../main.js';
import { runDoctorRole } from './doctor.js';
import type { RoleCtx } from './shared.js';

const CLAUDE = 'sk-ant-oat01-DOCTORDOCTORDOCTORDOCTOR';
const READ = 'github_pat_READREADREADREADREADREAD42';

const payload = (o: Partial<DoctorDropPayload> = {}): DoctorDropPayload => ({
  protocol: 1,
  dropId: 'doc',
  epoch: 1,
  role: 'doctor',
  repo: { owner: 'o', name: 'r', defaultBranch: 'trunk' },
  model: 'claude-opus-5-5',
  image: 'img',
  gates: [
    { name: 'lint', run: 'npm run lint', timeoutMinutes: 5 },
    { name: 'test', run: 'npm test', timeoutMinutes: 5 },
  ],
  credentials: { claudeToken: CLAUDE, readToken: READ },
  ...o,
});

const line = (o: unknown) => JSON.stringify(o);
const INIT = line({ type: 'system', subtype: 'init', session_id: 's' });
const OK = line({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 's',
  num_turns: 1,
  modelUsage: { 'claude-opus-5-5': { outputTokens: 3 } },
});

function world(o: { claude?: string[]; red?: string[]; cloneError?: string } = {}) {
  const calls: unknown[][] = [];
  const claude = { args: [] as string[][], env: [] as NodeJS.ProcessEnv[], cwd: [] as string[] };
  const emitted: string[] = [];
  const rec =
    <T>(name: string, ret: (...a: unknown[]) => T) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return ret(...a);
    };
  const deps = {
    git: {
      cloneRepo: rec('cloneRepo', () => {
        if (o.cloneError) throw new Error(o.cloneError);
      }),
      prepareBranch: rec('prepareBranch', () => undefined),
      headSha: rec('headSha', () => 'abc1234'),
      cloneForGates: rec('cloneForGates', () => undefined),
      pushNewBranch: rec('pushNewBranch', () => 'x'),
      pushExistingBranch: rec('pushExistingBranch', () => 'x'),
      commitIfDirty: rec('commitIfDirty', () => false),
      removeTree: rec('removeTree', () => undefined),
      sweepProcesses: () => false,
    },
    async *runClaude(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
      claude.args.push(args);
      claude.env.push(env);
      claude.cwd.push(cwd);
      for (const l of o.claude ?? [INIT, OK]) yield l;
    },
    runGates: async (gates: GateSpec[]): Promise<GateResult[]> => {
      calls.push(['runGates', gates.map((g) => g.name)]);
      return gates.map((g) => ({
        name: g.name,
        exitCode: o.red?.includes(g.name) ? 1 : 0,
        durationMs: 1,
        timedOut: false,
        outputTail: `${g.name} output`,
      }));
    },
    emit: (l: string) => emitted.push(l),
  } as unknown as TrooperDeps;
  const ctx: RoleCtx = {
    workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-doctor-')),
    secrets: [CLAUDE, READ],
    ids: null,
  };
  return { deps, ctx, calls, claude, emitted, names: () => calls.map((c) => c[0]) };
}

describe('the doctor role', () => {
  test('the doctor role clones without a write token and never calls push', async () => {
    const w = world();
    const r = await runDoctorRole(payload(), w.deps, w.ctx);
    const clone = w.calls.find((c) => c[0] === 'cloneRepo')?.[1] as { token: string };
    expect(clone.token).toBe(READ);
    expect(w.calls.find((c) => c[0] === 'prepareBranch')?.slice(2, 4)).toEqual([
      'jm-doctor',
      'trunk',
    ]);
    expect(w.names().filter((n) => /push|commit/i.test(String(n)))).toEqual([]);
    expect(r).toMatchObject({
      status: 'completed',
      role: 'doctor',
      doctor: { clone: { ok: true, sha: 'abc1234' }, claude: { ok: true } },
    });
    // A public repository: no read token, an anonymous clone.
    const anon = world();
    await runDoctorRole(payload({ credentials: { claudeToken: CLAUDE } }), anon.deps, anon.ctx);
    expect((anon.calls.find((c) => c[0] === 'cloneRepo')?.[1] as { token: string }).token).toBe('');
  });

  test('the Claude probe spends one turn with every tool off, from an empty working directory', async () => {
    const w = world();
    const r = await runDoctorRole(payload(), w.deps, w.ctx);
    const args = w.claude.args[0] ?? [];
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag('--max-turns')).toBe('1');
    expect(flag('--tools')).toBe('');
    expect(flag('--model')).toBe('claude-opus-5-5');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--add-dir');
    expect(w.claude.env[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE);
    const cwd = w.claude.cwd[0] ?? '';
    expect(readdirSync(cwd)).toEqual([]);
    expect(statSync(cwd).mode & 0o777).toBe(0o755);
    expect(r.doctor?.claude).toEqual({ ok: true, servedModel: 'claude-opus-5-5' });
    expect(r.servedModel).toBe('claude-opus-5-5');
  });

  test('a failing gate makes the doctor result fail that gate; other gates still run', async () => {
    const w = world({ red: ['lint'] });
    const r = await runDoctorRole(payload(), w.deps, w.ctx);
    expect(r.status).toBe('completed');
    expect(r.doctor?.gates.map((g) => [g.name, g.exitCode])).toEqual([
      ['lint', 1],
      ['test', 0],
    ]);
    expect(r.gates).toEqual(r.doctor?.gates);
  });

  test('an authentication_failed init makes claude.ok false with the reason', async () => {
    const w = world({
      claude: [
        INIT,
        line({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] },
          error: 'authentication_failed',
        }),
        line({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: `Invalid API key ${CLAUDE} · Please run /login`,
          session_id: 's',
        }),
      ],
    });
    const r = await runDoctorRole(payload(), w.deps, w.ctx);
    expect(r.doctor?.claude.ok).toBe(false);
    expect(r.doctor?.claude.error).toContain('authentication_failed');
    expect(JSON.stringify(r)).not.toContain(CLAUDE);
    // The rest still ran.
    expect(r.doctor?.gates).toHaveLength(2);
  });

  test('a Claude CLI that exits non-zero, or never answers, is not ok', async () => {
    const crashed = world({
      claude: [INIT, line({ type: 'claude_stderr', exitCode: 1, stderr: `bad token ${CLAUDE}` })],
    });
    const r = await runDoctorRole(payload(), crashed.deps, crashed.ctx);
    expect(r.doctor?.claude).toMatchObject({ ok: false });
    expect(r.doctor?.claude.error).toContain('exit 1');
    expect(JSON.stringify(r)).not.toContain(CLAUDE);
    const silent = world({ claude: [INIT] });
    const s = await runDoctorRole(payload(), silent.deps, silent.ctx);
    expect(s.doctor?.claude).toEqual({ ok: false, error: 'claude produced no result' });
  });

  test('a rejected usage limit is reported, and carried for the server', async () => {
    const w = world({
      claude: [
        INIT,
        line({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt: 1900000000 },
        }),
      ],
    });
    const r = await runDoctorRole(payload(), w.deps, w.ctx);
    expect(r.doctor?.claude.ok).toBe(false);
    expect(r.doctor?.claude.error).toContain('usage limit');
    expect(r.rateLimit?.status).toBe('rejected');
  });

  test('a service that never accepts a connection is reported not ok; the gates still run', async () => {
    const w = world();
    const r = await runDoctorRole(
      payload({
        services: [
          { name: 'jm-doctor-no-such-host', image: 'x', port: 5432, readyTimeoutSeconds: 0.2 },
        ],
      }),
      w.deps,
      w.ctx,
    );
    expect(r.doctor?.services).toEqual([{ name: 'jm-doctor-no-such-host', ok: false }]);
    expect(r.doctor?.gates).toHaveLength(2);
  });

  test('a failed clone is reported, the probe still runs, and no gate runs without a tree', async () => {
    const w = world({ cloneError: `fatal: Authentication failed for ${READ}` });
    const r = await runDoctorRole(payload(), w.deps, w.ctx);
    expect(r.doctor?.clone.ok).toBe(false);
    expect(r.doctor?.clone.error).toContain('Authentication failed');
    expect(r.doctor?.clone.error).not.toContain(READ);
    expect(r.doctor?.claude.ok).toBe(true);
    expect(r.doctor?.gates).toEqual([]);
    expect(w.names()).not.toContain('runGates');
  });
});
