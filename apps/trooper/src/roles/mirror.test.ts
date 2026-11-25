import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropPayload, DropResult } from '@jumpmaster/protocol';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { setProvidedMirrorDir } from '../git.js';
import type { TrooperDeps } from '../main.js';
import { roleWorld } from '../test/roleWorld.js';
import { runCrew } from './crew.js';
import { runDoctorRole } from './doctor.js';
import { runHeal } from './heal.js';
import { runImplement } from './implement.js';
import { runResolve } from './resolve.js';
import { runReview } from './review.js';
import type { RoleCtx } from './shared.js';

/** Where the fake provided mirror is, set through the test-only setter. */
const MIRROR = '/srv/test-provided-mirror';
const FORGE = 'ghp_' + 'FORGE1234567890abcdef';
const READ = 'github_pat_' + 'READREADREADREAD42';
const creds = { claudeToken: 'sk-ant-' + 'oat-SECRET1234567890', forgeToken: FORGE };
const repo = { owner: 'o', name: 'r', defaultBranch: 'main' };
const item = {
  protocol: 1 as const,
  dropId: 'dm',
  epoch: 1,
  repo,
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'p',
  image: 'img',
  protectedPaths: [],
  credentials: creds,
};
const pr = { number: 9, branch: 'agent/issue-1', headSha: 'sha1' };

type Runner = (p: DropPayload, d: TrooperDeps, c: RoleCtx) => Promise<DropResult>;
const ROLES: [string, Runner, DropPayload][] = [
  ['implement', runImplement, { ...item, role: 'implement', resume: false }],
  [
    'implement (resume)',
    runImplement,
    { ...item, role: 'implement', resume: true, resumeSha: 'sha1' },
  ],
  ['heal', runHeal, { ...item, role: 'heal', pr, feedback: 'f' }],
  ['resolve', runResolve, { ...item, role: 'resolve', pr }],
  ['review', runReview, { ...item, role: 'review', pr }],
  [
    'crew',
    runCrew,
    {
      protocol: 1,
      dropId: 'dc',
      epoch: 1,
      repo,
      model: 'm',
      maxTurns: 10,
      promptVersion: 'v1',
      prompt: 'p',
      image: 'img',
      protectedPaths: [],
      credentials: creds,
      role: 'crew-lead',
    },
  ],
  [
    'doctor',
    runDoctorRole,
    {
      protocol: 1,
      dropId: 'dd',
      epoch: 1,
      role: 'doctor',
      repo,
      model: 'm',
      image: 'img',
      gates: item.gates,
      credentials: { claudeToken: creds.claudeToken, readToken: READ },
    },
  ],
];

const provided = (p: DropPayload): DropPayload =>
  ({ ...p, repo: { ...p.repo, mirror: 'provided' } }) as DropPayload;
/** A provided-mirror payload with every token removed: no code path may need one. */
const tokenless = (p: DropPayload): DropPayload => {
  const { forgeToken: _f, readToken: _r, ...rest } = p.credentials as Record<string, string>;
  return { ...provided(p), credentials: rest } as DropPayload;
};

const newCtx = (): RoleCtx => ({
  workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-mirror-')),
  secrets: [creds.claudeToken],
  ids: null,
});

const REMOTE = ['mirrorFetch', 'remoteBranchSha', 'remoteBranchExists', 'cloneRepo'];

beforeEach(() => setProvidedMirrorDir(MIRROR));
afterEach(() => setProvidedMirrorDir(null));

describe('every agent role with a provided mirror (#842)', () => {
  for (const [name, run, payload] of ROLES) {
    test(`${name}: checks and clones the mirror, and makes no remote call`, async () => {
      const w = roleWorld({ merge: 'conflicts' });
      const ctx = newCtx();
      await run(tokenless(payload), w.deps, ctx);
      for (const r of REMOTE) expect(w.names()).not.toContain(r);
      expect(w.calls[0]).toEqual(['checkMirror', MIRROR]);
      expect(w.calls[1]).toEqual([
        'cloneFromMirror',
        {
          mirrorDir: MIRROR,
          dir: join(ctx.workdir, 'repo'),
          branch: 'main',
          // The agent's git config goes in the drop's workdir, never beside the read-only mirror.
          configDir: ctx.workdir,
          as: null,
        },
      ]);
      // No call carries a token.
      expect(JSON.stringify(w.calls)).not.toContain(FORGE);
      expect(JSON.stringify(w.calls)).not.toContain(READ);
    });
  }

  test('implement (resume) checks out the branch from the mirror, with no fetch', async () => {
    const w = roleWorld();
    const ctx = newCtx();
    await runImplement(tokenless(ROLES[1]?.[2] as DropPayload), w.deps, ctx);
    expect(w.names().slice(0, 3)).toEqual(['checkMirror', 'cloneFromMirror', 'checkoutBranch']);
  });

  test('implement answers "branch already exists" from the mirror: present', async () => {
    const w = roleWorld({ mirrorSha: 'abc123' });
    const r = await runImplement(provided(ROLES[0]?.[2] as DropPayload), w.deps, newCtx());
    expect(r).toMatchObject({
      status: 'failed',
      reason: 'branch agent/issue-1 already exists on remote',
    });
    expect(w.calls).toContainEqual(['mirrorBranchSha', MIRROR, 'agent/issue-1']);
    expect(w.names()).not.toContain('remoteBranchSha');
    expect(w.claude.runs).toBe(0);
  });

  test('implement answers "branch already exists" from the mirror: absent', async () => {
    const w = roleWorld({ mirrorSha: null });
    const ctx = newCtx();
    const r = await runImplement(provided(ROLES[0]?.[2] as DropPayload), w.deps, ctx);
    expect(r.status).toBe('completed');
    expect(w.calls).toContainEqual(['mirrorBranchSha', MIRROR, 'agent/issue-1']);
    expect(w.calls).toContainEqual([
      'prepareBranch',
      join(ctx.workdir, 'repo'),
      'agent/issue-1',
      'main',
      null,
    ]);
  });
});

describe('a provided mirror that fails its check (#842)', () => {
  const FAILURES = [
    ['the wrong config', 'the mirror config is not the fixed bare config'],
    ['a hooks directory', 'the mirror has a hooks directory'],
    ['no mirror at all', `no mirror at ${MIRROR}`],
  ];
  for (const [name, run, payload] of ROLES.filter(([n]) => n !== 'doctor')) {
    for (const [why, message] of FAILURES) {
      test(`${name} fails before any agent or gate runs: ${why}`, async () => {
        const w = roleWorld({ mirrorError: message });
        const r = await run(tokenless(payload), w.deps, newCtx());
        expect(r.status).toBe('failed');
        expect(r.reason).toBe(`provided mirror check failed: ${message}`);
        expect(w.names()).toEqual(['checkMirror']);
        expect(w.claude.runs).toBe(0);
      });
    }
  }

  for (const [why, message] of [
    ['a missing mirror', `no mirror at ${MIRROR}`],
    ['a mirror that fails the check', 'the mirror has a hooks directory'],
  ]) {
    test(`doctor with ${why} reports the clone failed and still runs its probe`, async () => {
      const w = roleWorld({ mirrorError: message });
      const doctor = ROLES.find(([n]) => n === 'doctor')?.[2] as DropPayload;
      const r = await runDoctorRole(tokenless(doctor), w.deps, newCtx());
      expect(r.status).toBe('completed');
      expect(r.doctor?.clone).toEqual({
        ok: false,
        error: `provided mirror check failed: ${message}`,
      });
      expect(r.doctor?.claude.ok).toBe(true);
      expect(w.claude.runs).toBe(1);
      // No clone, so no gate: the same as a failed clone today.
      expect(w.names()).toEqual(['checkMirror']);
    });
  }
});

describe('a payload without repo.mirror records exactly the calls it did before (#842)', () => {
  const BEFORE: Record<string, string[]> = {
    implement: [
      'cloneRepo',
      'remoteBranchSha',
      'prepareBranch',
      'commitIfDirty',
      'aheadOfBase',
      'headSha',
      'runGates',
    ],
    'implement (resume)': [
      'cloneRepo',
      'mirrorFetch',
      'checkoutBranch',
      'commitIfDirty',
      'aheadOfBase',
      'headSha',
      'runGates',
    ],
    heal: ['cloneRepo', 'mirrorFetch', 'checkoutBranch', 'commitIfDirty', 'headSha'],
    resolve: [
      'cloneRepo',
      'mirrorFetch',
      'checkoutBranch',
      'mergeBase',
      'conflictMarkers',
      'commitIfDirty',
      'mergeInProgress',
      'headSha',
      'runGates',
    ],
    review: ['cloneRepo', 'checkoutBranch', 'runGates', 'treeState', 'treeState'],
    crew: ['cloneRepo', 'prepareBranch', 'removeInstructionFiles', 'treeState', 'treeState'],
    doctor: ['cloneRepo', 'prepareBranch', 'headSha', 'runGates'],
  };
  for (const [name, run, payload] of ROLES) {
    test(name, async () => {
      const w = roleWorld({ merge: 'conflicts' });
      const ctx = newCtx();
      await run(payload, w.deps, ctx);
      expect(w.names()).toEqual(BEFORE[name]);
      const token = payload.role === 'doctor' ? READ : FORGE;
      expect(w.calls[0]).toEqual([
        'cloneRepo',
        {
          owner: 'o',
          name: 'r',
          token,
          dir: join(ctx.workdir, 'repo'),
          mirrorDir: join(ctx.workdir, 'mirror'),
          as: null,
        },
      ]);
      const fetch = w.calls.find((c) => c[0] === 'mirrorFetch');
      if (fetch) expect(fetch.slice(1, 3)).toEqual([join(ctx.workdir, 'mirror'), FORGE]);
      const lookup = w.calls.find((c) => c[0] === 'remoteBranchSha');
      if (lookup) {
        expect(lookup.slice(1)).toEqual([{ owner: 'o', name: 'r' }, 'agent/issue-1', FORGE]);
      }
    });
  }
});
