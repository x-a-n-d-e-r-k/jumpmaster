import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CrewDropPayload, crewOutputJsonSchema } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { TrooperDeps } from '../main.js';
import { runCrew } from './crew.js';
import type { RoleCtx } from './shared.js';

const SECRET = 'sk-ant-oat-SECRET1234567890';
const READ = 'ghp_READ1234567890abcdef';

const base = {
  protocol: 1 as const,
  dropId: 'dc',
  epoch: 1,
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'crew prompt',
  image: 'img',
  protectedPaths: ['.github/**'],
  credentials: { claudeToken: SECRET, forgeToken: READ },
};
const lead: CrewDropPayload = { ...base, role: 'crew-lead' };
const diagnose: CrewDropPayload = {
  ...base,
  role: 'diagnose',
  checkout: { number: 9, branch: 'agent/issue-1', headSha: 'h9' },
};

const leadOut = { summary: 'nothing to file', fileIssues: [], briefings: [] };

function newCtx(): RoleCtx {
  return {
    workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-crew-')),
    secrets: [SECRET, READ],
    ids: null,
  };
}

function world(
  o: {
    output?: unknown;
    writes?: boolean;
    commits?: boolean;
    rateLimited?: boolean;
    terminal?: string;
  } = {},
) {
  const calls: unknown[][] = [];
  let tree = 'sha1\n';
  const claude = { args: [] as string[], cwd: '', cwdEntries: [] as string[], cwdMode: 0 };
  const rec =
    <T>(name: string, ret: (...a: unknown[]) => T) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return ret(...a);
    };
  const deps = {
    git: {
      cloneRepo: rec('cloneRepo', () => undefined),
      checkoutBranch: rec('checkoutBranch', () => undefined),
      prepareBranch: rec('prepareBranch', () => undefined),
      treeState: rec('treeState', () => tree),
      commitIfDirty: rec('commitIfDirty', () => false),
      pushNewBranch: rec('pushNewBranch', () => 'x'),
      pushExistingBranch: rec('pushExistingBranch', () => 'x'),
      sweepProcesses: () => false,
      removeTree: rec('removeTree', () => undefined),
    },
    async *runClaude(args: string[], _env: NodeJS.ProcessEnv, cwd: string) {
      claude.args = args;
      claude.cwd = cwd;
      claude.cwdEntries = readdirSync(cwd);
      claude.cwdMode = statSync(cwd).mode & 0o777;
      if (o.writes) tree = 'sha1\n?? notes.md';
      if (o.commits) tree = 'sha2\n';
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' });
      if (o.rateLimited) {
        yield JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
        return;
      }
      yield JSON.stringify({
        type: 'result',
        is_error: false,
        terminal_reason: o.terminal ?? 'completed',
        session_id: 's',
        structured_output: o.output ?? leadOut,
        modelUsage: { m: { outputTokens: 5 } },
      });
    },
    runGates: async () => {
      calls.push(['runGates']);
      return [];
    },
    emit: () => undefined,
  } as unknown as TrooperDeps;
  return { deps, calls, claude, names: () => calls.map((c) => c[0]) };
}

describe('runCrew', () => {
  test('crew-lead clones read-only, runs claude from an empty cwd with --add-dir <clone> and returns its output', async () => {
    const w = world();
    const ctx = newCtx();
    const r = await runCrew(lead, w.deps, ctx);
    expect(r).toMatchObject({ status: 'completed', role: 'crew-lead', crew: leadOut, gates: [] });
    const clone = join(ctx.workdir, 'repo');
    expect(w.calls[0]).toEqual(['cloneRepo', expect.objectContaining({ token: READ, dir: clone })]);
    expect(w.claude.cwd).toBe(join(ctx.workdir, 'crew-cwd'));
    expect(w.claude.cwdEntries).toEqual([]);
    expect(w.claude.cwdMode).toBe(0o755);
    const addDir = w.claude.args.indexOf('--add-dir');
    expect(w.claude.args.slice(addDir, addDir + 2)).toEqual(['--add-dir', clone]);
    expect(w.claude.args.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(w.claude.args[w.claude.args.indexOf('--json-schema') + 1]).toBe(
      JSON.stringify(crewOutputJsonSchema('crew-lead')),
    );
    expect(w.claude.args[w.claude.args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(w.names()).not.toContain('runGates');
  });

  test('diagnose checks out the given head; crew-lead stays on the default branch', async () => {
    const d = world({
      output: { diagnosis: 'flaky', recommendation: 'retry', detail: 'rerun' },
    });
    const ctx = newCtx();
    expect((await runCrew(diagnose, d.deps, ctx)).status).toBe('completed');
    expect(d.calls.find((c) => c[0] === 'checkoutBranch')).toEqual([
      'checkoutBranch',
      join(ctx.workdir, 'repo'),
      'agent/issue-1',
      'h9',
      null,
    ]);
    expect(d.names()).not.toContain('prepareBranch');
    const l = world();
    const lctx = newCtx();
    await runCrew(lead, l.deps, lctx);
    expect(l.names()).not.toContain('checkoutBranch');
    // A local branch at origin/<default>: the clone has a HEAD to read, and nothing is pushed.
    expect(l.calls.find((c) => c[0] === 'prepareBranch')).toEqual([
      'prepareBranch',
      join(lctx.workdir, 'repo'),
      'jm-crew',
      'main',
      null,
    ]);
  });

  test('a crew drop that changes the tree fails with "crew modified the tree"', async () => {
    const w = world({ writes: true });
    const r = await runCrew(lead, w.deps, newCtx());
    expect(r).toMatchObject({ status: 'failed', reason: 'crew modified the tree' });
    expect(r.crew).toBeUndefined();
  });

  test('a crew drop never pushes, even when it commits', async () => {
    const w = world({ commits: true });
    const r = await runCrew(lead, w.deps, newCtx());
    expect(r.status).toBe('failed');
    expect(w.names()).not.toContain('pushNewBranch');
    expect(w.names()).not.toContain('pushExistingBranch');
    expect(w.names()).not.toContain('commitIfDirty');
  });

  test('an output that fails parseCrewOutput fails the drop', async () => {
    const w = world({ output: { ...leadOut, extra: 1 } });
    const r = await runCrew(lead, w.deps, newCtx());
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/^invalid crew output: /);
    expect(r.crew).toBeUndefined();
  });

  test('a rate limit or stop mid-run returns rate_limited or interrupted', async () => {
    expect((await runCrew(lead, world({ rateLimited: true }).deps, newCtx())).status).toBe(
      'rate_limited',
    );
    expect((await runCrew(lead, world({ terminal: 'max_turns' }).deps, newCtx())).status).toBe(
      'interrupted',
    );
  });

  test('secrets in crew text are redacted', async () => {
    const w = world({
      output: {
        summary: `used ${SECRET}`,
        fileIssues: [
          {
            key: 'k',
            objective: 'o',
            title: `title ${READ}`,
            body: `body ${SECRET}`,
          },
        ],
        briefings: [
          {
            subject: 's',
            decision: `d ${READ}`,
            why: 'w',
            options: [`a ${SECRET}`, 'b'],
            recommendation: 'r',
            onHold: 'h',
          },
        ],
      },
    });
    const r = await runCrew(lead, w.deps, newCtx());
    expect(r.status).toBe('completed');
    const text = JSON.stringify(r.crew);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(READ);
    expect(text).toContain('used ');
  });

  test('the model usage is passed back for the served model', async () => {
    const r = await runCrew(lead, world().deps, newCtx());
    expect(r.modelUsage).toEqual({ m: { outputTokens: 5 } });
    expect(r.servedModel).toBe('m');
  });
});

describe('crew prompts', () => {
  const read = (role: string) =>
    readFileSync(new URL(`../../prompts/${role}.md`, import.meta.url), 'utf8');

  test('each crew prompt template states the data and escalation rules', () => {
    for (const role of ['crew-lead', 'refute', 'diagnose']) {
      const t = read(role);
      expect(t, role).toMatch(/<<<jm-data:<id>:begin NAME>>>/);
      expect(t, role).toMatch(/\(trusted instructions\)/);
      expect(t, role).toMatch(/never modify|Never modify/);
      expect(t, role).toMatch(/structured output/);
    }
    const lead = read('crew-lead');
    expect(lead).toMatch(/current objective/i);
    expect(lead).toMatch(/Free slots/);
    expect(lead).toMatch(/## Acceptance criteria/);
    expect(lead).toMatch(/## Required tests/);
    expect(lead).toMatch(/one drop/i);
    expect(lead).toMatch(/prerequisites are merged/i);
    expect(lead).toMatch(/protected path/i);
    for (const concern of [
      'deploys',
      'IAM',
      'CI',
      'secrets',
      'spend',
      'public claims',
      'data deletion',
      'goal changes',
    ]) {
      expect(lead, concern).toContain(concern);
    }
    expect(lead).toMatch(/raise a briefing/i);
    const refute = read('refute');
    expect(refute).toMatch(/break the issue/i);
    expect(refute).toMatch(/testable/);
    expect(refute).toMatch(/single drop|one drop/);
    expect(refute).toMatch(/protected path/i);
    expect(refute).toMatch(/promote.*only if every criterion survives/i);
    const diag = read('diagnose');
    expect(diag).toMatch(/evidence/);
    expect(diag).toMatch(/`retry` only when a fresh run would plausibly succeed/);
  });
});
