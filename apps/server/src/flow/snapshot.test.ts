import { beforeEach, describe, expect, test } from 'vitest';
import { getWorkItem, insertVerdict, recordGateAllowance, type VerdictRow } from '../db/repo.js';
import { zoneWorld } from '../test/fixtures.js';
import { decide } from './decide.js';
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
