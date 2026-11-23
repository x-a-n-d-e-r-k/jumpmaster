import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  applyPendingRulings,
  listBriefings,
  ruleBriefing,
  syncParkBriefings,
} from '../briefings.js';
import {
  addBranchUpdateFailure,
  type Drop,
  getWorkItem,
  getWorkItemPrFiles,
  insertDrop,
  insertVerdict,
  recordGateAllowance,
  setBranchUpdateOutcome,
  setWorkItemState,
  type VerdictRow,
} from '../db/repo.js';
import type { ChecksFacts } from '../forge/github.js';
import { zoneWorld } from '../test/fixtures.js';
import { decide } from './decide.js';
import { ADMINISTRATION_PROBLEM } from './guards.js';
import { buildSnapshot, gateDigest, zonePass } from './snapshot.js';

const now = new Date('2026-01-01T01:00:00Z');
const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts });

let w: ReturnType<typeof zoneWorld>;
let itemId: number;

const snapshotOf = async (id = itemId) => {
  const pass = await zonePass(w.forges, w.zone, 'main');
  const item = getWorkItem(w.db, id);
  if (!item) throw new Error('no item');
  return buildSnapshot(w.db, w.forges, w.zone, item, pass, now);
};

const approveRow = (headSha: string): VerdictRow => ({
  id: `v-${headSha}`,
  workItemId: itemId,
  headSha,
  decision: 'approve',
  forced: false,
  summary: 'ok',
  findingsJson: '[]',
  gatesJson: '[]',
  createdAt: now.toISOString(),
});

beforeEach(() => {
  w = zoneWorld();
  itemId = w.prItem(1, 'sha1');
});

describe('zonePass', () => {
  test('reads both bot logins and the author identity required checks', async () => {
    const p = await zonePass(w.forges, w.zone, 'main');
    expect(p.botLogins).toEqual(['author-bot', 'reviewer-bot']);
    expect(p.requiredChecks).toEqual(['ci']);
    expect(p.protectionProblems).toEqual([]);
  });
});

describe('author login aliases (issue #284)', () => {
  test('authorLogins is the viewer login then the aliases, case-insensitive duplicates removed', async () => {
    w = zoneWorld({ authorLoginAliases: ['old-bot', 'Author-Bot', 'OLD-BOT', 'app[bot]'] });
    const p = await zonePass(w.forges, w.zone, 'main');
    expect(p.authorLogins).toEqual(['author-bot', 'old-bot', 'app[bot]']);
    expect(p.botLogins).toEqual(['author-bot', 'old-bot', 'app[bot]', 'reviewer-bot']);
  });

  test('with no aliases, authorLogins is the viewer login alone', async () => {
    const p = await zonePass(w.forges, w.zone, 'main');
    expect(p.authorLogins).toEqual(['author-bot']);
  });

  test('starter mode: botLogins is authorLogins alone', async () => {
    w = zoneWorld({ identity: 'starter', authorLoginAliases: ['old-bot'] });
    const p = await zonePass(w.forges, w.zone, 'main');
    expect(p.botLogins).toEqual(['author-bot', 'old-bot']);
  });

  test('a trusted-looking review by an alias is not a trusted human review', async () => {
    w = zoneWorld({ authorLoginAliases: ['old-bot'] });
    itemId = w.prItem(1, 'sha1');
    w.f.state.trusted.push('old-bot', 'Old-Bot');
    w.f.state.review({ id: 1, author: 'old-bot', state: 'CHANGES_REQUESTED', commitId: 'sha1' });
    w.f.state.review({ id: 2, author: 'Old-Bot', state: 'CHANGES_REQUESTED', commitId: 'sha1' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests).toEqual([]);
    expect(s.humanBlockStanding).toBe(false);
  });
});

describe('the CODEOWNERS read behind a required code owner review', () => {
  test('a skipped read is logged once per zone until a read succeeds, and parks nothing', async () => {
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind === 'ok') r.rules.requireCodeOwnerReview = true;
    }
    const warned: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      warned.push(String(m));
    });
    try {
      for (let i = 0; i < 2; i++) {
        w.f.author.failNext('getFileAt', '5xx');
        expect((await zonePass(w.forges, w.zone, 'main')).protectionProblems).toEqual([]);
      }
      expect(warned.filter((m) => m.includes('CODEOWNERS'))).toEqual([
        `[jumpmaster] zone ${w.zone.id}: the CODEOWNERS read failed, so this pass did not check that the reviewer bot can satisfy the required code owner review`,
      ]);
      // A good read resets it: the next failure is said again.
      await zonePass(w.forges, w.zone, 'main');
      w.f.author.failNext('getFileAt', '5xx');
      await zonePass(w.forges, w.zone, 'main');
      expect(warned.filter((m) => m.includes('CODEOWNERS'))).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('starter identity (reviewer null)', () => {
  beforeEach(() => {
    w = zoneWorld({ identity: 'starter' });
    itemId = w.prItem(1, 'sha1');
  });

  test('a pass with reviewer null completes snapshot and reconcile reads with the author only', async () => {
    const p = await zonePass(w.forges, w.zone, 'main');
    expect(p.botLogins).toEqual(['author-bot']);
    expect(p.requiredChecks).toEqual(['ci']);
    expect(p.protectionProblems).toEqual([]);
    const s = await snapshotOf();
    expect(s.forgeUnavailable).toBeNull();
    expect(w.f.reviewer.calls).toEqual([]);
  });

  test('trusted reviews still exclude the author bot', async () => {
    w.f.state.review({ author: 'author-bot', state: 'CHANGES_REQUESTED', commitId: 'sha1' });
    w.f.state.review({ id: 9, author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha1' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests.map((r) => r.author)).toEqual(['human']);
  });

  describe('an admin author (authorMayBeAdmin)', () => {
    beforeEach(() => {
      w = zoneWorld({ identity: 'starter', authorMayBeAdmin: true });
      itemId = w.prItem(1, 'sha1');
      const r = w.f.state.rules.author;
      if (r.kind === 'ok') r.rules.viewerIsAdmin = true;
    });
    const probes = () => w.f.author.calls.filter((c) => c.method === 'probeAdministration');

    test('the pass probes Administration once, and a token that has it is a protection problem', async () => {
      w.f.state.adminProbe.author = {
        permission: 'Administration: read',
        status: 200,
        accepted: null,
      };
      const p = await zonePass(w.forges, w.zone, 'main');
      expect(p.protectionProblems).toEqual([ADMINISTRATION_PROBLEM]);
      expect(probes()).toHaveLength(1);
      expect(decide(await snapshotOf())).toMatchObject({
        kind: 'park',
        reason: expect.stringContaining('Administration'),
      });
    });

    test('a refused, rate-limited or unanswered probe never parks', async () => {
      for (const probe of [
        { permission: 'Administration: read', status: 403, accepted: null },
        { permission: 'Administration: read', status: 403, accepted: null, rateLimited: true },
        { permission: 'Administration: read', status: 502, accepted: null },
        { permission: 'Administration: read', status: null, accepted: null },
      ]) {
        w.f.state.adminProbe.author = probe;
        expect((await zonePass(w.forges, w.zone, 'main')).protectionProblems).toEqual([]);
      }
    });

    test('no probe for a non-admin author or a two-bot zone', async () => {
      const r = w.f.state.rules.author;
      if (r.kind === 'ok') r.rules.viewerIsAdmin = false;
      await zonePass(w.forges, w.zone, 'main');
      const two = zoneWorld();
      await zonePass(two.forges, two.zone, 'main');
      expect(probes()).toHaveLength(0);
      expect(two.f.author.calls.filter((c) => c.method === 'probeAdministration')).toHaveLength(0);
    });
  });

  test('starter rules requiring an approval are a protection problem', async () => {
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules.requiredApprovals = 1;
    const s = await snapshotOf();
    expect(s.protectionProblems).toEqual(['approvals required in starter mode']);
  });
});

describe('buildSnapshot', () => {
  test('gate script compare uses the merge base, not the base tip', async () => {
    w.f.state.compares.set('main...sha1', {
      aheadBy: 1,
      behindBy: 2,
      baseSha: 'base-tip',
      mergeBaseSha: 'mb',
    });
    w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
    w.f.state.files.set('mb:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('sha1:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('base-tip:package.json', pkg({ test: 'vitest --changed' }));
    expect((await snapshotOf()).gateScriptChanges).toEqual([]);
  });

  test('a changed gate script against the merge base is reported', async () => {
    w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
    w.f.state.files.set('base0:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('sha1:package.json', pkg({ test: 'exit 0' }));
    const s = await snapshotOf();
    expect(s.gateScriptChanges).toEqual(['test']);
    expect(s.gateDetails).toEqual({ scripts: ['test: "vitest" → "exit 0"'], tools: [] });
  });

  test('a script in a nested package.json, added or removed, is detailed with its path', async () => {
    w.f.state.pullFiles.set(1, { files: [{ path: 'pkg/a/package.json' }], complete: true });
    w.f.state.files.set('base0:pkg/a/package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('sha1:pkg/a/package.json', pkg({}));
    const s = await snapshotOf();
    expect(s.gateDetails.scripts).toEqual(['pkg/a/package.json test: "vitest" → (none)']);
  });

  test('a gate runner bumped in package.json is detailed old → new', async () => {
    const withDep = (v: string) =>
      JSON.stringify({ name: 'x', scripts: { test: 'vitest' }, devDependencies: { vitest: v } });
    w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
    w.f.state.files.set('base0:package.json', withDep('^1.0.0'));
    w.f.state.files.set('sha1:package.json', withDep('^2.0.0'));
    const s = await snapshotOf();
    expect(s.gateToolChanges).toContain('vitest version changed');
    expect(s.gateDetails.tools).toContain('vitest version changed: "^1.0.0" → "^2.0.0"');
  });

  test('a lockfile changed without any package.json is still checked', async () => {
    const npmLock = (packages: Record<string, unknown>): string =>
      JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });
    w.f.state.pullFiles.set(1, { files: [{ path: 'package-lock.json' }], complete: true });
    w.f.state.files.set('base0:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('sha1:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('base0:package-lock.json', npmLock({}));
    w.f.state.files.set(
      'sha1:package-lock.json',
      npmLock({ 'node_modules/evil': { version: '1.0.0', hasInstallScript: true } }),
    );
    expect((await snapshotOf()).gateToolChanges).toEqual(['install script: evil']);
  });

  test('a gate runner bumped in package-lock.json alone is reported', async () => {
    const npmLock = (v: string): string =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'x' },
          'node_modules/vitest': {
            version: v,
            resolved: `https://registry.npmjs.org/vitest/-/vitest-${v}.tgz`,
          },
        },
      });
    w.f.state.pullFiles.set(1, { files: [{ path: 'package-lock.json' }], complete: true });
    w.f.state.files.set('base0:package.json', pkg({ test: 'vitest run' }));
    w.f.state.files.set('sha1:package.json', pkg({ test: 'vitest run' }));
    w.f.state.files.set('base0:package-lock.json', npmLock('3.0.0'));
    w.f.state.files.set('sha1:package-lock.json', npmLock('3.0.1'));
    const s = await snapshotOf();
    expect(s.gateToolChanges).toEqual(['vitest version changed in lockfile']);
    expect(s.gateDetails.tools).toEqual(['vitest version changed in lockfile: "3.0.0" → "3.0.1"']);
  });

  describe('pnpm workspaces', () => {
    const lockV9 = (...keys: string[]): string =>
      [
        "lockfileVersion: '9.0'",
        'packages:',
        ...keys.map((k) => `  '${k}':\n    resolution: {integrity: sha512-${k.length}}`),
      ].join('\n');
    const deps = (d: Record<string, string>, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ name: 'a', devDependencies: d, ...extra });
    const addTypesNode = (rootPkg: string) => {
      w.f.state.pullFiles.set(1, {
        files: [{ path: 'packages/a/package.json' }, { path: 'pnpm-lock.yaml' }],
        complete: true,
      });
      w.f.state.files.set('base0:packages/a/package.json', deps({}));
      w.f.state.files.set('sha1:packages/a/package.json', deps({ '@types/node': '^26' }));
      w.f.state.files.set('base0:pnpm-lock.yaml', lockV9('vitest@4.1.0'));
      w.f.state.files.set('sha1:pnpm-lock.yaml', lockV9('vitest@4.1.0', '@types/node@26.6.5'));
      w.f.state.files.set('sha1:package.json', rootPkg);
    };

    test('reads pnpm-lock.yaml at the repo root for a nested package.json', async () => {
      addTypesNode(JSON.stringify({ name: 'root' }));
      expect((await snapshotOf()).gateToolChanges).toEqual([
        'dependency added: @types/node@26.6.5 (verified: registry integrity only; install scripts may run)',
      ]);
    });

    const added =
      'dependency added: @types/node@26.6.5 (verified: registry integrity only; install scripts may run)';
    const pinned = JSON.stringify({ name: 'root', packageManager: 'pnpm@10.4.1' });

    test('a pnpm 10 pin alone does not accept a new package: the zone must opt in', async () => {
      addTypesNode(pinned);
      expect((await snapshotOf()).gateToolChanges).toEqual([added]);
    });

    test('with trustPnpmBuildBlocking and pnpm 10 pinned a new registry dependency passes', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      expect((await snapshotOf()).gateToolChanges).toEqual([]);
    });

    test('trusted build blocking still reports an allow-listed build', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      w.f.state.files.set(
        'sha1:pnpm-workspace.yaml',
        "onlyBuiltDependencies:\n  - '@types/node'\n",
      );
      expect((await snapshotOf()).gateToolChanges).toEqual([
        'dependency added: @types/node@26.6.5 (in the build allow-list: its install script runs)',
      ]);
    });

    test('trusted build blocking still reports when a root .npmrc allows all builds', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      w.f.state.files.set('base0:.npmrc', 'dangerously-allow-all-builds=true\n');
      expect((await snapshotOf()).gateToolChanges).toEqual([
        'dependency added: @types/node@26.6.5 (all builds allowed: its install script runs)',
      ]);
    });

    test('trusted build blocking still reports when base allows all builds', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      w.f.state.files.set(
        'base0:package.json',
        JSON.stringify({ name: 'root', pnpm: { dangerouslyAllowAllBuilds: true } }),
      );
      expect((await snapshotOf()).gateToolChanges).toEqual([
        'dependency added: @types/node@26.6.5 (all builds allowed: its install script runs)',
      ]);
    });

    // pnpm runs a pnpmfile's hooks.updateConfig, which can allow every build: each route by which
    // pnpm finds one makes the new dependency reported.
    const allBuilds =
      'dependency added: @types/node@26.6.5 (pnpmfile present: build policy not verifiable)';

    test('trusted build blocking still reports when the head has a root .pnpmfile.mjs', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      w.f.state.dirs.set('sha1:', ['package.json', 'pnpm-lock.yaml', '.pnpmfile.mjs']);
      expect((await snapshotOf()).gateToolChanges).toEqual([allBuilds]);
    });

    test('trusted build blocking still reports when pnpm-workspace.yaml names a pnpmfile', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      w.f.state.files.set(
        'sha1:pnpm-workspace.yaml',
        "packages: ['packages/*']\npnpmfile: ./hooks.cjs\n",
      );
      expect((await snapshotOf()).gateToolChanges).toEqual([allBuilds]);
    });

    test('trusted build blocking still reports when the head lockfile has a pnpmfileChecksum', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      w.f.state.files.set(
        'sha1:pnpm-lock.yaml',
        `${lockV9('vitest@4.1.0', '@types/node@26.6.5')}\npnpmfileChecksum: sha256-abc`,
      );
      w.f.state.files.set(
        'base0:pnpm-lock.yaml',
        `${lockV9('vitest@4.1.0')}\npnpmfileChecksum: sha256-abc`,
      );
      expect((await snapshotOf()).gateToolChanges).toEqual([allBuilds]);
    });

    test('a root directory listing that fails leaves the pass waiting, not passing', async () => {
      w.zone.trustPnpmBuildBlocking = true;
      addTypesNode(pinned);
      w.f.author.failNext('listDir', { status: 500 });
      expect((await snapshotOf()).forgeUnavailable).toBe('listDir');
    });

    test('a dependency change with no lockfile anywhere fails closed', async () => {
      w.f.state.pullFiles.set(1, { files: [{ path: 'packages/a/package.json' }], complete: true });
      w.f.state.files.set('base0:packages/a/package.json', deps({}));
      w.f.state.files.set('sha1:packages/a/package.json', deps({ x: '^1' }));
      expect((await snapshotOf()).gateToolChanges).toEqual(['lockfile not found']);
    });

    test('a shared lockfile is read once per commit, and reads are memoized across passes', async () => {
      addTypesNode(JSON.stringify({ name: 'root' }));
      w.f.state.pullFiles.set(1, {
        files: [
          { path: 'packages/a/package.json' },
          { path: 'packages/b/package.json' },
          { path: 'pnpm-lock.yaml' },
        ],
        complete: true,
      });
      w.f.state.files.set('base0:packages/b/package.json', deps({}));
      w.f.state.files.set('sha1:packages/b/package.json', deps({ x: '^1' }));
      const reads = () =>
        w.f.author.calls.filter((c) => c.method === 'getFileAt').map((c) => c.args.join(':'));
      await snapshotOf();
      const first = reads();
      expect(first.filter((r) => r === 'sha1:pnpm-lock.yaml')).toHaveLength(1);
      expect(first.filter((r) => r === 'base0:pnpm-lock.yaml')).toHaveLength(1);
      expect(new Set(first).size).toBe(first.length);
      await snapshotOf();
      expect(reads()).toEqual(first);
    });

    test('a dependency change in a yarn project names the unsupported lockfile', async () => {
      w.f.state.pullFiles.set(1, { files: [{ path: 'packages/a/package.json' }], complete: true });
      w.f.state.files.set('base0:packages/a/package.json', deps({}));
      w.f.state.files.set('sha1:packages/a/package.json', deps({ x: '^1' }));
      w.f.state.files.set('sha1:yarn.lock', '# yarn lockfile v1\n');
      expect((await snapshotOf()).gateToolChanges).toEqual([
        'lockfile format not supported: yarn.lock',
      ]);
    });

    test('a package.json change without dependency changes reads no lockfile', async () => {
      w.f.state.pullFiles.set(1, { files: [{ path: 'packages/a/package.json' }], complete: true });
      w.f.state.files.set('base0:packages/a/package.json', deps({ x: '^1' }));
      w.f.state.files.set('sha1:packages/a/package.json', deps({ x: '^1' }, { version: '2.0.0' }));
      expect((await snapshotOf()).gateToolChanges).toEqual([]);
    });
  });

  describe('maintainer override of gate changes', () => {
    const gateChange = () => {
      w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
      w.f.state.files.set('base0:package.json', pkg({ test: 'vitest' }));
      w.f.state.files.set('sha1:package.json', pkg({ test: 'vitest --bail' }));
    };
    beforeEach(() => {
      gateChange();
      w.f.state.maintainers = ['human'];
    });

    test('a maintainer approval of the head SHA counts', async () => {
      w.f.state.review({ author: 'human', state: 'APPROVED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(true);
    });

    test('an approval of an older head does not count', async () => {
      w.f.state.review({ author: 'human', state: 'APPROVED', commitId: 'sha0' });
      expect((await snapshotOf()).maintainerApproved).toBe(false);
    });

    test('a dismissed approval, or a later change request, cancels it', async () => {
      w.f.state.review({ id: 1, author: 'human', state: 'DISMISSED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(false);
      w.f.state.review({ id: 2, author: 'human', state: 'APPROVED', commitId: 'sha1' });
      w.f.state.review({ id: 3, author: 'human', state: 'COMMENTED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(true);
      w.f.state.review({ id: 4, author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(false);
    });

    test('write access alone is not enough', async () => {
      w.f.state.maintainers = [];
      w.f.state.review({ author: 'human', state: 'APPROVED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(false);
    });

    test('a zone overrideApprover with write access counts; without write it does not', async () => {
      w.f.state.maintainers = [];
      w.zone.overrideApprovers = ['Human', 'outsider'];
      w.f.state.review({ author: 'outsider', state: 'APPROVED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(false);
      w.f.state.review({ author: 'human', state: 'APPROVED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(true);
    });

    test('bot logins never count, including starter mode where both bots are one login', async () => {
      w.f.state.logins = { author: 'human', reviewer: 'human' };
      w.f.state.maintainers = ['human', 'deps[bot]'];
      w.f.state.trusted.push('deps[bot]');
      w.f.state.review({ author: 'human', state: 'APPROVED', commitId: 'sha1' });
      w.f.state.review({ author: 'deps[bot]', state: 'APPROVED', commitId: 'sha1' });
      expect((await snapshotOf()).maintainerApproved).toBe(false);
    });

    test('a failed permission lookup is not a maintainer', async () => {
      w.f.state.review({ author: 'human', state: 'APPROVED', commitId: 'sha1' });
      w.f.author.failNext('isMaintainer', '5xx');
      const s = await snapshotOf();
      expect(s.maintainerApproved).toBe(false);
      expect(s.forgeUnavailable).toBe('isMaintainer');
    });

    test('a Command allowance counts only for the exact head, merge base and changes', async () => {
      const s0 = await snapshotOf();
      expect(s0.commandAllowed).toBe(false);
      const digest = gateDigest(s0.gateDetails);
      const allowance = { itemId, prNumber: 1, mergeBaseSha: 'base0', digest, rulingId: 1 };
      recordGateAllowance(w.db, { ...allowance, headSha: 'sha0' }, now);
      expect((await snapshotOf()).commandAllowed).toBe(false);
      recordGateAllowance(w.db, { ...allowance, headSha: 'sha1', digest: 'other' }, now);
      expect((await snapshotOf()).commandAllowed).toBe(false);
      w.db.prepare('DELETE FROM gate_allowances').run();
      recordGateAllowance(w.db, { ...allowance, headSha: 'sha1', mergeBaseSha: 'base9' }, now);
      expect((await snapshotOf()).commandAllowed).toBe(false);
      w.db.prepare('DELETE FROM gate_allowances').run();
      recordGateAllowance(w.db, { ...allowance, headSha: 'sha1', prNumber: 2 }, now);
      expect((await snapshotOf()).commandAllowed).toBe(false);
      w.db.prepare('DELETE FROM gate_allowances').run();
      recordGateAllowance(w.db, { ...allowance, headSha: 'sha1' }, now);
      expect((await snapshotOf()).commandAllowed).toBe(true);
      // The same head judged against another merge base (the base moved) is not allowed.
      w.f.state.compares.set('main...sha1', {
        aheadBy: 1,
        behindBy: 1,
        baseSha: 'base1',
        mergeBaseSha: 'base1',
      });
      w.f.state.files.set('base1:package.json', pkg({ test: 'vitest' }));
      expect((await snapshotOf()).commandAllowed).toBe(false);
      w.f.state.compares.delete('main...sha1');
      w.f.state.setHead(1, 'sha2');
      w.f.state.files.set('sha2:package.json', pkg({ test: 'vitest --bail' }));
      expect((await snapshotOf()).commandAllowed).toBe(false);
    });

    test('no gate change: no permission lookup', async () => {
      w.f.state.pullFiles.set(1, { files: [{ path: 'src/a.ts' }], complete: true });
      w.f.state.review({ author: 'human', state: 'APPROVED', commitId: 'sha1' });
      await snapshotOf();
      expect(w.f.author.calls.some((c) => c.method === 'isMaintainer')).toBe(false);
    });
  });

  test('a thrown package.json read is forge unavailability (the pass waits), not a park', async () => {
    w.f.state.pullFiles.set(1, { files: [{ path: 'pkg/package.json' }], complete: true });
    w.f.author.failNext('getFileAt', '5xx');
    const s = await snapshotOf();
    expect(s.forgeUnavailable).toBe('getFileAt');
    expect(s.gateScriptChanges).toEqual([]);
  });

  test('snapshot excludes both bots from trust', async () => {
    w.f.state.review({ author: 'reviewer-bot', state: 'CHANGES_REQUESTED' });
    w.f.state.review({ author: 'author-bot', state: 'CHANGES_REQUESTED' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests).toEqual([]);
    expect(s.humanBlockStanding).toBe(false);
  });

  test('a review body carrying an op marker is never trusted', async () => {
    w.f.state.review({ author: 'human', state: 'CHANGES_REQUESTED', body: 'x <!-- jm:op:k -->' });
    expect((await snapshotOf()).trustedChangeRequests).toEqual([]);
  });

  test('a trusted human change request on head is reported', async () => {
    w.f.state.review({ id: 7, author: 'human', state: 'CHANGES_REQUESTED', body: 'fix it' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests.map((r) => r.id)).toEqual([7]);
  });

  test('snapshot sees a standing human block on an older commit', async () => {
    w.f.state.review({ author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha0' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests).toEqual([]);
    expect(s.humanBlockStanding).toBe(true);
  });

  test('a later approval by the same author lifts the block; a comment does not', async () => {
    w.f.state.review({ id: 1, author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha0' });
    w.f.state.review({ id: 2, author: 'human', state: 'COMMENTED', commitId: 'sha0' });
    expect((await snapshotOf()).humanBlockStanding).toBe(true);
    w.f.state.review({ id: 3, author: 'human', state: 'APPROVED' });
    expect((await snapshotOf()).humanBlockStanding).toBe(false);
  });

  test('a failed trust lookup is untrusted', async () => {
    w.f.state.review({ author: 'stranger', state: 'CHANGES_REQUESTED' });
    w.f.author.failNext('isTrusted', '5xx');
    const s = await snapshotOf();
    expect(s.trustedChangeRequests).toEqual([]);
    expect(s.forgeUnavailable).toBe('isTrusted');
  });

  test('an approval on the previous head is not in verdictsOnHead', async () => {
    insertVerdict(w.db, approveRow('sha1'));
    w.f.state.setHead(1, 'sha2');
    w.f.state.checks.set('sha2', { state: 'success', names: ['ci'] });
    const s = await snapshotOf();
    expect(s.verdictsOnHead).toEqual([]);
    expect(decide(s)).toMatchObject({ kind: 'enqueue', role: 'review' });
  });

  test('a thrown listReviews never hides a human block', async () => {
    w.f.author.failNext('listReviews', '5xx');
    const s = await snapshotOf();
    expect(s.forgeUnavailable).toBe('listReviews');
    expect(decide(s)).toEqual({ kind: 'wait', on: 'forge' });
  });

  test('a thrown getPull gives pr null and starts the waiting clock', async () => {
    w.f.author.failNext('getPull', '5xx');
    const s = await snapshotOf();
    expect(s.pr).toBeNull();
    expect(s.missingSince).toBe(now.toISOString());
  });

  test('a branch answered absent is null without forgeUnavailable', async () => {
    w.f.state.branches.delete('agent/issue-1');
    const s = await snapshotOf();
    expect(s.branchSha).toBeNull();
    expect(s.forgeUnavailable).toBeNull();
  });

  test('the head change is recorded on the pull request row', async () => {
    w.f.state.setHead(1, 'sha2');
    const s = await snapshotOf();
    expect(s.pr?.headSha).toBe('sha2');
    expect(s.headFirstSeenAt).toBe(now.toISOString());
  });
});

describe('carry facts', () => {
  const at = (s: number) => new Date(now.getTime() - (100 - s) * 1000).toISOString();
  const row = (id: string, headSha: string, over: Partial<VerdictRow> = {}): VerdictRow => ({
    ...approveRow(headSha),
    id,
    ...over,
  });
  const digestReads = () => w.f.author.calls.filter((c) => c.method === 'changeDigest');
  const moveHead = (sha: string) => w.f.state.setHead(1, sha);

  test('reads both digests against the base when the newest verdict is an approve on an earlier head', async () => {
    insertVerdict(w.db, row('v1', 'sha1', { createdAt: at(1) }));
    moveHead('sha2');
    w.f.state.digests.set('main...sha1', { digest: 'd', complete: true });
    w.f.state.digests.set('main...sha2', { digest: 'd', complete: true });
    const s = await snapshotOf();
    expect(s.carry).toEqual({
      fromVerdictId: 'v1',
      fromHead: 'sha1',
      fromDecision: 'approve',
      fromForced: false,
      requestChangesAfter: false,
      digestFrom: { digest: 'd', complete: true },
      digestHead: { digest: 'd', complete: true },
    });
    expect(decide(s)).toEqual({ kind: 'carry_verdict', fromVerdictId: 'v1', headSha: 'sha2' });
  });

  test.each<[string, VerdictRow[]]>([
    ['there is no verdict', []],
    ['the newest verdict is forced', [row('v1', 'sha1', { forced: true })]],
    [
      'the newest verdict asks for changes',
      [
        row('v1', 'sha1', { createdAt: at(1) }),
        row('v2', 'sha1', { decision: 'request_changes', createdAt: at(2) }),
      ],
    ],
    [
      'the approved head also had a request-changes',
      [
        row('v1', 'sha1', { decision: 'request_changes', createdAt: at(1) }),
        row('v2', 'sha1', { createdAt: at(2) }),
      ],
    ],
    [
      'the head already has a verdict',
      [row('v1', 'sha1', { createdAt: at(1) }), row('v2', 'sha2', { createdAt: at(2) })],
    ],
  ])('is null, with no digest read, when %s', async (_, rows) => {
    for (const r of rows) insertVerdict(w.db, r);
    moveHead('sha2');
    const s = await snapshotOf();
    expect(s.carry).toBeNull();
    expect(digestReads()).toEqual([]);
  });

  test('is null when the head is behind (a resolve comes first)', async () => {
    insertVerdict(w.db, row('v1', 'sha1'));
    moveHead('sha2');
    w.f.state.compares.set('main...sha2', {
      aheadBy: 1,
      behindBy: 1,
      baseSha: 'b1',
      mergeBaseSha: 'b0',
    });
    expect((await snapshotOf()).carry).toBeNull();
    expect(digestReads()).toEqual([]);
  });

  test('a digest read that throws leaves it null and marks no read unavailable', async () => {
    insertVerdict(w.db, row('v1', 'sha1'));
    moveHead('sha2');
    w.f.author.failNext('changeDigest', '5xx');
    const s = await snapshotOf();
    expect(s.carry).toBeNull();
    expect(s.forgeUnavailable).toBeNull();
    expect(decide(s)).toMatchObject({ kind: 'enqueue', role: 'review' });
  });
});

describe('the update_conflict mark (issue #292)', () => {
  const behind = (baseSha: string) =>
    w.f.state.compares.set('main...sha1', { aheadBy: 1, behindBy: 2, baseSha, mergeBaseSha: 'b0' });

  test('a conflict mark for this head and base is read, and decide resolves', async () => {
    behind('b1');
    setBranchUpdateOutcome(w.db, itemId, 'sha1', 'b1', 'conflict', now);
    const s = await snapshotOf();
    expect(s.updateConflict).toBe(true);
    expect(decide(s)).toMatchObject({ kind: 'enqueue', role: 'resolve' });
  });

  test('a mark for another base sha does not count: the forge is asked again', async () => {
    behind('b2');
    setBranchUpdateOutcome(w.db, itemId, 'sha1', 'b1', 'conflict', now);
    const s = await snapshotOf();
    expect(s.updateConflict).toBe(false);
    expect(decide(s)).toEqual({ kind: 'update_branch', headSha: 'sha1', baseSha: 'b2' });
  });

  test('a mark for another head does not count', async () => {
    behind('b1');
    setBranchUpdateOutcome(w.db, itemId, 'sha0', 'b1', 'conflict', now);
    expect((await snapshotOf()).updateConflict).toBe(false);
  });

  test('failures short of a conflict and an updated outcome are no mark', async () => {
    behind('b1');
    addBranchUpdateFailure(w.db, itemId, 'sha1', 'b1', now);
    expect((await snapshotOf()).updateConflict).toBe(false);
    setBranchUpdateOutcome(w.db, itemId, 'sha1', 'b1', 'updated', now);
    expect((await snapshotOf()).updateConflict).toBe(false);
  });
});

describe('merge reservation', () => {
  const at = (minutesAgo: number): string =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  let n = 0;
  const verdict = (
    id: number,
    headSha: string,
    minutesAgo: number,
    decision: VerdictRow['decision'] = 'approve',
  ): void => {
    insertVerdict(w.db, {
      id: `r${++n}`,
      workItemId: id,
      headSha,
      decision,
      forced: false,
      summary: 's',
      findingsJson: '[]',
      gatesJson: '[]',
      createdAt: at(minutesAgo),
    });
  };
  let two: number;
  let three: number;
  beforeEach(() => {
    two = w.prItem(2, 'sha2');
    three = w.prItem(3, 'sha3');
  });

  test('the holder is the item with the oldest approve on its current head', async () => {
    verdict(itemId, 'sha1', 5);
    verdict(two, 'sha2', 20);
    verdict(three, 'sha3', 10);
    expect((await snapshotOf(itemId)).mergeReservedBy).toEqual({
      itemId: two,
      issueNumber: 2,
      since: at(20),
    });
    expect((await snapshotOf(three)).mergeReservedBy?.itemId).toBe(two);
  });

  test('a tie goes to the lower item id', async () => {
    verdict(three, 'sha3', 10);
    verdict(two, 'sha2', 10);
    expect((await snapshotOf(itemId)).mergeReservedBy?.itemId).toBe(two);
  });

  test("the holder's own snapshot has none", async () => {
    verdict(itemId, 'sha1', 5);
    verdict(two, 'sha2', 20);
    expect((await snapshotOf(two)).mergeReservedBy).toBeNull();
  });

  test('an approve on an older head does not count', async () => {
    verdict(itemId, 'sha1', 5);
    verdict(two, 'old2', 20);
    verdict(three, 'sha3', 10);
    expect((await snapshotOf(itemId)).mergeReservedBy?.itemId).toBe(three);
    verdict(three, 'old3', 15);
    expect((await snapshotOf(itemId)).mergeReservedBy?.itemId).toBe(three);
  });

  test('a request-changes newer than the approve on the same head does not count', async () => {
    verdict(itemId, 'sha1', 5);
    verdict(two, 'sha2', 20);
    verdict(two, 'sha2', 18, 'request_changes');
    expect((await snapshotOf(itemId)).mergeReservedBy).toBeNull();
  });

  test('an approve older than mergeReservationMinutes does not count', async () => {
    verdict(itemId, 'sha1', 5);
    verdict(two, 'sha2', 31);
    expect((await snapshotOf(itemId)).mergeReservedBy).toBeNull();
    verdict(three, 'sha3', 30);
    expect((await snapshotOf(itemId)).mergeReservedBy?.itemId).toBe(three);
  });

  test('an item that is not pr_open holds nothing', async () => {
    verdict(itemId, 'sha1', 5);
    verdict(two, 'sha2', 20);
    setWorkItemState(w.db, two, 'parked', 'x');
    expect((await snapshotOf(itemId)).mergeReservedBy).toBeNull();
  });

  test('mergeReservationMinutes 0 turns it off', async () => {
    w.zone = { ...w.zone, mergeReservationMinutes: 0 };
    verdict(itemId, 'sha1', 5);
    verdict(two, 'sha2', 20);
    expect((await snapshotOf(itemId)).mergeReservedBy).toBeNull();
  });
});

describe('the open PR file list is stored on the item (issue #291)', () => {
  test('a complete list is stored, renames with their previous path, sorted', async () => {
    w.f.state.pullFiles.set(1, {
      files: [{ path: 'src/b.ts' }, { path: 'src/new.ts', previousPath: 'src/old.ts' }],
      complete: true,
    });
    await snapshotOf();
    expect(getWorkItemPrFiles(w.db, itemId)).toEqual(['src/b.ts', 'src/new.ts', 'src/old.ts']);
  });

  test('a list GitHub cut short stores null (unknown)', async () => {
    w.f.state.pullFiles.set(1, { files: [{ path: 'src/a.ts' }], complete: true });
    await snapshotOf();
    w.f.state.pullFiles.set(1, { files: [{ path: 'src/a.ts' }], complete: false });
    await snapshotOf();
    expect(getWorkItemPrFiles(w.db, itemId)).toBeNull();
  });

  test('a failed read leaves the stored list as it was', async () => {
    w.f.state.pullFiles.set(1, { files: [{ path: 'src/a.ts' }], complete: true });
    await snapshotOf();
    w.f.author.failNext('listPullFiles', '5xx');
    await snapshotOf();
    expect(getWorkItemPrFiles(w.db, itemId)).toEqual(['src/a.ts']);
  });
});

describe('code-scanning alerts for a failed CodeQL check (#652)', () => {
  const alert = {
    path: 'apps/server/src/api/sticks.ts',
    startLine: 460,
    level: 'failure',
    title: 'Missing rate limiting',
    message: 'This route handler performs authorization, but is not rate-limited.',
  };
  const fail = (failed: ChecksFacts['failed']) =>
    w.f.state.checks.set('sha1', { state: 'failure', names: failed.map((f) => f.name), failed });

  test('a failed github-advanced-security run: its failure annotations are in codeScanning', async () => {
    fail([
      { name: 'CodeQL', conclusion: 'failure', checkRunId: 77, app: 'github-advanced-security' },
    ]);
    w.f.state.annotations.set(77, [{ ...alert, level: 'warning', title: 'w' }, alert]);
    const s = await snapshotOf();
    expect(s.codeScanning).toEqual([{ check: 'CodeQL', annotations: [alert] }]);
    expect(s.forgeUnavailable).toBeNull();
  });

  test('a status and an app-less check: no annotations call', async () => {
    fail([
      { name: 'ci/x', conclusion: 'error' },
      { name: 'jobs', conclusion: 'failure', checkRunId: 79 },
    ]);
    const s = await snapshotOf();
    expect(s.codeScanning).toEqual([]);
    expect(w.f.author.calls.some((c) => c.method === 'checkAnnotations')).toBe(false);
  });

  test('checks not in failure are never read for annotations', async () => {
    w.f.state.checks.set('sha1', {
      state: 'pending',
      names: ['CodeQL'],
      failed: [
        { name: 'CodeQL', conclusion: 'failure', checkRunId: 77, app: 'github-advanced-security' },
      ],
    });
    const s = await snapshotOf();
    expect(s.codeScanning).toEqual([]);
    expect(w.f.author.calls.some((c) => c.method === 'checkAnnotations')).toBe(false);
  });

  test('an annotations call that errors: an empty list, and the snapshot stays available', async () => {
    fail([
      { name: 'CodeQL', conclusion: 'failure', checkRunId: 77, app: 'github-advanced-security' },
    ]);
    w.f.state.annotations.set(77, [alert]);
    w.f.author.failNext('checkAnnotations', { status: 403 });
    const s = await snapshotOf();
    expect(s.codeScanning).toEqual([{ check: 'CodeQL', annotations: [] }]);
    expect(s.forgeUnavailable).toBeNull();
    expect(s.forgeDenied).toBeNull();
    expect(s.missingSince).toBeNull();
    expect(['wait', 'park']).not.toContain(decide(s).kind);
  });
});

describe('CI failure annotations for a failed GitHub Actions check (#720)', () => {
  const failing = {
    path: 'apps/trooper/src/git.test.ts',
    startLine: 300,
    level: 'failure',
    title: 'git.test.ts > scrubs the environment',
    message: "AssertionError: expected '{\"GITHUB_STATE\":…' not to contain 'github.com'",
  };
  const exit = {
    path: '.github',
    startLine: 1,
    level: 'failure',
    title: '',
    message: 'Process completed with exit code 1.',
  };
  const fail = (failed: ChecksFacts['failed']) =>
    w.f.state.checks.set('sha1', { state: 'failure', names: failed.map((f) => f.name), failed });

  test('a failed github-actions run: its annotations, less the exit-code line, in ciAnnotations', async () => {
    fail([{ name: 'ci', conclusion: 'failure', checkRunId: 78, app: 'github-actions' }]);
    w.f.state.annotations.set(78, [failing, exit]);
    const s = await snapshotOf();
    expect(s.ciAnnotations).toEqual([{ check: 'ci', annotations: [failing] }]);
    expect(s.codeScanning).toEqual([]);
    expect(s.forgeUnavailable).toBeNull();
    expect(w.f.author.calls.filter((c) => c.method === 'checkAnnotations')).toHaveLength(1);
  });

  test('a failed github-advanced-security run: codeScanning, unchanged, and no ciAnnotations', async () => {
    const alert = { ...failing, title: 'Missing rate limiting', message: 'not rate-limited.' };
    fail([
      { name: 'CodeQL', conclusion: 'failure', checkRunId: 77, app: 'github-advanced-security' },
    ]);
    w.f.state.annotations.set(77, [alert]);
    const s = await snapshotOf();
    expect(s.codeScanning).toEqual([{ check: 'CodeQL', annotations: [alert] }]);
    expect(s.ciAnnotations).toEqual([]);
  });

  test('a PAT zone: Actions jobs without a checkRunId are not read', async () => {
    fail([{ name: 'ci', conclusion: 'failure' }]);
    const s = await snapshotOf();
    expect(s.ciAnnotations).toEqual([]);
    expect(w.f.author.calls.some((c) => c.method === 'checkAnnotations')).toBe(false);
  });

  test('an annotations read that errors: an empty list, and the snapshot stays available', async () => {
    fail([{ name: 'ci', conclusion: 'failure', checkRunId: 78, app: 'github-actions' }]);
    w.f.state.annotations.set(78, [failing]);
    w.f.author.failNext('checkAnnotations', { status: 500 });
    const s = await snapshotOf();
    expect(s.ciAnnotations).toEqual([{ check: 'ci', annotations: [] }]);
    expect(s.forgeUnavailable).toBeNull();
    expect(s.forgeDenied).toBeNull();
    expect(s.missingSince).toBeNull();
    expect(['wait', 'park']).not.toContain(decide(s).kind);
  });
});

describe('lastCiHealKey: the code-scanning key of the last counted ci heal (#653)', () => {
  const alert = (title: string, path: string) => ({
    path,
    startLine: 1,
    level: 'failure',
    title,
    message: 'm',
  });
  const rate = alert('Missing rate limiting', 'b.ts');
  const other = alert('Clear-text logging', 'a.ts');
  let n = 0;
  /** A heal drop of item 1 created at `minute` past `now`, in `state`, with this input. */
  const heal = (minute: number, input: unknown, state: Drop['state'] = 'succeeded') =>
    insertDrop(
      w.db,
      {
        id: `heal-${++n}`,
        dropZoneId: 'main',
        workItemId: itemId,
        role: 'heal',
        state,
        inputJson: JSON.stringify(input),
      },
      new Date(now.getTime() + minute * 60_000),
    );
  const ci = (annotations: unknown[]) => ({
    feedback: { source: 'ci', text: 'CI failed' },
    codeScanning: [{ check: 'CodeQL', annotations }],
  });

  test('null with no heal', async () => {
    expect((await snapshotOf()).lastCiHealKey).toBeNull();
  });

  test('the key of the latest succeeded ci heal with codeScanning: sorted and de-duplicated', async () => {
    heal(1, ci([other]));
    heal(2, ci([rate, other, rate]));
    expect((await snapshotOf()).lastCiHealKey).toEqual([
      'Clear-text logging|a.ts',
      'Missing rate limiting|b.ts',
    ]);
  });

  test('ignores heals whose source is not ci, heals without codeScanning, and unfinished heals', async () => {
    heal(1, ci([rate]));
    heal(2, { feedback: { source: 'review', text: 'x' }, codeScanning: [] });
    heal(3, { feedback: { source: 'human', text: 'x' } });
    heal(4, { feedback: { source: 'ci', text: 'CI failed' } });
    heal(5, ci([other]), 'failed');
    heal(6, ci([other]), 'queued');
    expect((await snapshotOf()).lastCiHealKey).toEqual(['Missing rate limiting|b.ts']);
  });

  test('a review heal after the ci heal leaves its key standing', async () => {
    heal(1, ci([rate]));
    heal(2, { feedback: { source: 'review', text: 'x' } });
    expect((await snapshotOf()).lastCiHealKey).toEqual(['Missing rate limiting|b.ts']);
  });

  test('ignores heals created before the latest applied retry_item ruling', async () => {
    heal(1, ci([rate]));
    const at = (m: number) => new Date(now.getTime() + m * 60_000);
    setWorkItemState(w.db, itemId, 'parked', 'code scanning still flags', at(2));
    syncParkBriefings(w.db, w.zone, at(2));
    const b = listBriefings(w.db, { zoneId: 'main', state: 'open' }).find(
      (x) => x.kind === 'parked',
    );
    const retry = b?.options.find((o) => o.effect === 'retry_item');
    if (!b || !retry) throw new Error('no Retry option');
    expect(ruleBriefing(w.db, b.id, retry.id, 'the alert is accepted', at(3)).ok).toBe(true);
    // Ruled but not yet applied: the earlier heal still counts.
    expect((await snapshotOf()).lastCiHealKey).toEqual(['Missing rate limiting|b.ts']);
    const deps = { forges: () => w.forges, zone: () => w.zone };
    expect(await applyPendingRulings(w.db, deps, 'main', at(4))).toBe(1);
    expect(getWorkItem(w.db, itemId)?.state).toBe('pr_open');
    expect((await snapshotOf()).lastCiHealKey).toBeNull();
    heal(5, ci([other]));
    expect((await snapshotOf()).lastCiHealKey).toEqual(['Clear-text logging|a.ts']);
  });

  test('unparseable input is skipped', async () => {
    heal(1, ci([rate]));
    insertDrop(
      w.db,
      {
        id: 'heal-bad',
        dropZoneId: 'main',
        workItemId: itemId,
        role: 'heal',
        state: 'succeeded',
        inputJson: '{not json',
      },
      new Date(now.getTime() + 2 * 60_000),
    );
    expect((await snapshotOf()).lastCiHealKey).toEqual(['Missing rate limiting|b.ts']);
  });
});
