import { describe, expect, test } from 'vitest';
import {
  appendEvents,
  insertDrop,
  setKilled,
  setUsageState,
  setZoneMode,
  stampStick,
} from '../db/repo.js';
import { ago, NOW, one, PG, world } from '../test/doctorWorld.js';
import { okProbes } from '../test/fakes.js';

describe('a healthy install', () => {
  test('passes every check but those that cannot run yet, which say so', async () => {
    const checks = await world().run();
    const notPass = checks.filter((c) => c.status !== 'pass');
    expect(notPass.map((c) => [c.id, c.status])).toEqual([
      ['claude.token-age', 'skip'],
      ['zone.identity', 'skip'],
      ['zone.doctor-drop', 'skip'],
    ]);
    for (const c of checks) {
      expect(c.summary.length).toBeGreaterThan(10);
      if (c.status !== 'pass') expect(c.fix ?? c.summary).toBeTruthy();
    }
    expect(one(checks, 'forge.author').zoneId).toBe('main');
    expect(one(checks, 'config.listen').zoneId).toBeNull();
  });
});

describe('global checks', () => {
  test('config.listen warns on a non-loopback host outside a container only', async () => {
    const w = world({ config: { listen: { host: '0.0.0.0', port: 7420 } } });
    w.deps.env.inContainer = false;
    expect(one(await w.run(), 'config.listen')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('127.0.0.1'),
    });
    w.deps.env.inContainer = true;
    expect(one(await w.run(), 'config.listen').status).toBe('pass');
  });

  test('config.uid warns as root, and skips under rootless Docker (unsupported in this release)', async () => {
    const w = world();
    w.deps.env.uid = 0;
    expect(one(await w.run(), 'config.uid')).toMatchObject({ status: 'warn' });
    w.deps.env.uidMap = '         0       1000          1\n         1     100000      65536\n';
    expect(one(await w.run(), 'config.uid')).toMatchObject({
      status: 'skip',
      summary: expect.stringContaining('rootless unsupported in this release'),
    });
  });

  test('claude.token-age warns from 330 days, fails past a year, and skips when undeclared', async () => {
    const at = (days: number) =>
      ago(days * 86_400_000)
        .toISOString()
        .slice(0, 10);
    const w = world({ config: { claude: { plan: 'max', fableWeeklyDropCap: 5 } } });
    expect(one(await w.run(), 'claude.token-age')).toMatchObject({
      status: 'skip',
      fix: expect.stringContaining('tokenCreatedAt'),
    });
    w.config.claude.tokenCreatedAt = at(100);
    expect(one(await w.run(), 'claude.token-age').status).toBe('pass');
    w.config.claude.tokenCreatedAt = at(331);
    expect(one(await w.run(), 'claude.token-age')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('claude setup-token'),
    });
    w.config.claude.tokenCreatedAt = at(370);
    expect(one(await w.run(), 'claude.token-age').status).toBe('fail');
  });

  test('claude.plan shows the declared plan, and warns on fableModel with a plan without Fable', async () => {
    const w = world({ config: { claude: { plan: 'pro', fableWeeklyDropCap: 5 } } });
    expect(one(await w.run(), 'claude.plan')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('pro'),
    });
    w.config.claude.fableModel = 'claude-fable-1';
    expect(one(await w.run(), 'claude.plan')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('Fable never runs'),
    });
  });

  test('stick.seen fails when last_seen_at is older than two minutes, or no stick enrolled', async () => {
    const w = world();
    stampStick(
      w.db,
      's1',
      { capabilities: [], imagePolicy: 'signed', version: null, pinnedImages: [] },
      ago(121_000),
    );
    expect(one(await w.run(), 'stick.seen')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('stick-1'),
      fix: expect.stringContaining('logs'),
    });
    const empty = world();
    empty.db.prepare('DELETE FROM sticks').run();
    expect(one(await empty.run(), 'stick.seen')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('No stick has enrolled'),
    });
  });

  test('stick.capabilities fails a zone no live stick can run, naming what each lacks and why', async () => {
    const w = world({ config: { requireSignedImages: true } });
    stampStick(
      w.db,
      's1',
      { capabilities: [], imagePolicy: 'allowlist', version: '0.3.0', pinnedImages: [] },
      ago(10_000),
    );
    const c = one(await w.run(), 'stick.capabilities');
    expect(c).toMatchObject({ status: 'fail', zoneId: 'main' });
    expect(c.summary).toContain('egress-v1');
    expect(c.summary).toContain('image-policy:signed');
    expect(c.fix).toContain('JM_IMAGE_POLICY=signed');
    expect(c.fix).toContain('egress');
  });

  test('stick.image-policy warns on allowlist, and fails it when signed images are required', async () => {
    const w = world({ zone: { egress: { mode: 'off', allow: [] } } });
    stampStick(
      w.db,
      's1',
      { capabilities: ['egress-v1'], imagePolicy: 'allowlist', version: null, pinnedImages: [] },
      ago(10_000),
    );
    expect(one(await w.run(), 'stick.image-policy').status).toBe('warn');
    w.config.requireSignedImages = true;
    expect(one(await w.run(), 'stick.image-policy').status).toBe('fail');
  });

  test('usage.gate fails during a credits stop and warns while the usage limit pauses dispatch', async () => {
    const w = world();
    setUsageState(w.db, { pausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }, NOW);
    expect(one(await w.run(), 'usage.gate')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('2026-11-09T13:00:00.000Z'),
    });
    setUsageState(
      w.db,
      {
        pausedUntil: null,
        overageStoppedAt: ago(60_000).toISOString(),
        overageDropId: 'd9',
        overageUntil: new Date(NOW.getTime() + 7_200_000).toISOString(),
      },
      NOW,
    );
    expect(one(await w.run(), 'usage.gate')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('usage credits'),
      fix: expect.stringContaining('/briefings'),
    });
  });

  test('the kill switch fails control.kill, and a paused zone warns zone.mode', async () => {
    const w = world();
    setKilled(w.db, true, NOW);
    setZoneMode(w.db, 'main', 'paused', NOW);
    const checks = await w.run();
    expect(one(checks, 'control.kill')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('ctl unkill'),
    });
    expect(one(checks, 'zone.mode')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('ctl resume main'),
    });
  });
});

describe('forge checks', () => {
  test('forge.author summary states that token permissions are not introspected', async () => {
    const c = one(await world().run(), 'forge.author');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('author-bot');
    expect(c.summary).toContain(
      "the token's own permissions can't be read — a missing Contents or Issues write shows at the first push or filing",
    );
  });

  test('forge.author fails an account without push', async () => {
    const w = world();
    w.f.state.access.author.permissions.push = false;
    expect(one(await w.run(), 'forge.author')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('Write'),
    });
  });

  test('a token expiring within two weeks warns, naming the date', async () => {
    const w = world();
    w.f.state.access.reviewer.tokenExpiresAt = '2026-11-15T00:00:00.000Z';
    expect(one(await w.run(), 'forge.reviewer')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('2026-11-15'),
    });
  });

  test('reviewer with the author login, without push, or as admin fails forge.reviewer', async () => {
    const same = world();
    same.f.state.logins.reviewer = 'author-bot';
    expect(one(await same.run(), 'forge.reviewer')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('same account'),
    });
    const noPush = world();
    noPush.f.state.access.reviewer.permissions.push = false;
    expect(one(await noPush.run(), 'forge.reviewer').status).toBe('fail');
    const admin = world();
    admin.f.state.access.reviewer.permissions.admin = true;
    expect(one(await admin.run(), 'forge.reviewer')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('admin'),
    });
  });

  test('forge.admin fails an admin author unless authorMayBeAdmin, and warns when it is set', async () => {
    const w = world();
    w.f.state.access.author.permissions.admin = true;
    expect(one(await w.run(), 'forge.admin').status).toBe('fail');
    const allowed = world({ zone: { authorMayBeAdmin: true } });
    allowed.f.state.access.author.permissions.admin = true;
    expect(one(await allowed.run(), 'forge.admin').status).toBe('warn');
    const unneeded = world({ zone: { authorMayBeAdmin: true } });
    expect(one(await unneeded.run(), 'forge.admin')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('authorMayBeAdmin: false'),
    });
  });

  test('a fine-grained token refused Actions read fails forge.author-reads naming Actions: read', async () => {
    const w = world();
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Checks: read'
        ? { ...p, status: 403 }
        : p.permission === 'Actions: read'
          ? { ...p, status: 403, accepted: 'actions=read' }
          : p,
    );
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('Actions: read');
    expect(c.summary).toContain('actions=read');
    expect(c.fix).toContain('Actions: Read-only');
  });

  test('check runs refused but Actions readable passes, noting CI is read through Actions jobs', async () => {
    const w = world();
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Checks: read' ? { ...p, status: 403 } : p,
    );
    expect(one(await w.run(), 'forge.author-reads')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('Actions jobs'),
    });
  });

  test('a 403 on a read is a fail naming the permission, never a crash', async () => {
    const w = world();
    w.f.author.failNext('listLabels', { status: 403, message: 'Resource not accessible' });
    w.f.author.failNext('listDir', { status: 403 });
    w.f.author.failNext('listDir', { status: 403 });
    const checks = await w.run();
    expect(one(checks, 'forge.labels')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('Issues: read'),
    });
    expect(one(checks, 'forge.ci')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('Contents: read'),
    });
    const thrown = world();
    thrown.f.author.failNext('repoAccess', 'throw');
    const c = one(await thrown.run(), 'forge.author');
    expect(['warn', 'fail']).toContain(c.status);
    expect(c.summary).toContain('could not');
  });

  test('a rejected token (401) fails, telling how to replace it', async () => {
    const w = world();
    w.f.reviewer.failNext('viewerLogin', { status: 401, message: 'Bad credentials' });
    expect(one(await w.run(), 'forge.reviewer')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('401'),
      fix: expect.stringContaining('JM_GITHUB_REVIEWER_TOKEN'),
    });
  });

  test('a private repository without a read token fails forge.private-clone', async () => {
    const w = world();
    w.f.state.access.author.private = true;
    expect(one(await w.run(), 'forge.private-clone')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('JM_GITHUB_READ_TOKEN'),
    });
    // The token alone is not enough: the zone must say reviewReadToken.
    const tokenOnly = world({ readToken: true });
    tokenOnly.f.state.access.author.private = true;
    expect(one(await tokenOnly.run(), 'forge.private-clone')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('reviewReadToken: true'),
    });
    const ok = world({ readToken: true, zone: { reviewReadToken: true } });
    ok.f.state.access.author.private = true;
    expect(one(await ok.run(), 'forge.private-clone').status).toBe('pass');
    const unreadable = world({ readToken: true, zone: { reviewReadToken: true } });
    unreadable.f.state.access.author.private = true;
    unreadable.read.author.failNext('listDir', { status: 403 });
    expect(one(await unreadable.run(), 'forge.private-clone')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('Contents: read'),
    });
  });

  test('branch rules with bypass, without a PR rule or with an unpinned check fail with the fix text', async () => {
    const w = world();
    w.f.state.rules.reviewer = {
      kind: 'ok',
      rules: {
        requiredApprovals: 0,
        dismissStaleOnPush: false,
        requiredChecks: ['ci'],
        unpinnedChecks: ['ci'],
        viewerCanBypass: true,
        viewerIsAdmin: false,
        requiresPullRequest: false,
        requireCodeOwnerReview: false,
      },
    };
    const c = one(await w.run(), 'forge.branch-rules');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('bot can bypass');
    expect(c.summary).toContain('no pull request rule');
    expect(c.summary).toContain('required check not pinned: ci');
    expect(c.fix).toContain('select GitHub Actions as the source');
    expect(c.fix).toContain('bypass list');
    expect(c.fix).toContain('Require a pull request before merging');
  });

  test('branch rules that cannot be read are never a pass', async () => {
    const w = world();
    w.f.state.rules.author = { kind: 'unavailable' };
    expect(one(await w.run(), 'forge.branch-rules').status).toBe('warn');
  });

  test('forge.codeowners warns when code-owner review is required and the reviewer owns nothing', async () => {
    const w = world();
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind === 'ok') r.rules.requireCodeOwnerReview = true;
    }
    w.f.state.files.set('main:.github/CODEOWNERS', '* @someone-else\n');
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('reviewer-bot'),
    });
    w.f.state.files.set('main:.github/CODEOWNERS', '* @reviewer-bot\n');
    expect(one(await w.run(), 'forge.codeowners').status).toBe('pass');
  });

  test('no workflows and no required checks fails forge.ci under ciRequired and hints ciRequired false', async () => {
    const w = world();
    w.f.state.dirs.delete('main:.github/workflows');
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind === 'ok') r.rules.requiredChecks = [];
    }
    expect(one(await w.run(), 'forge.ci')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('ciRequired: false'),
    });
    const noCi = world({ zone: { ciRequired: false } });
    noCi.f.state.dirs.delete('main:.github/workflows');
    expect(one(await noCi.run(), 'forge.ci')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('no-CI-yet'),
    });
  });

  test('missing labels fail forge.labels and the fix lists gh label create lines', async () => {
    const w = world({
      zone: {
        crew: {
          enabled: true,
          goalPath: 'GOAL.md',
          cycleMinutes: 60,
          maxDropsPerDay: 24,
          stagedLabel: 'agent-staged',
          maxStaged: 3,
          refutePromotes: false,
          maxRefute: 2,
        },
        protectedPaths: ['GOAL.md'],
      },
    });
    w.f.state.labels = ['bug'];
    const c = one(await w.run(), 'forge.labels');
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('gh label create agent-ready --repo octo/demo');
    expect(c.fix).toContain('gh label create agent-retry --repo octo/demo');
    expect(c.fix).toContain('gh label create agent-staged --repo octo/demo');
  });
});

describe('zone checks', () => {
  test('a service image without a digest or not pinned on the stick fails zone.services', async () => {
    const tagged = world({
      zone: {
        services: [{ name: 'db', image: 'postgres:16', port: 5432, readyTimeoutSeconds: 60 }],
      },
    });
    expect(one(await tagged.run(), 'zone.services')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('docker buildx imagetools inspect postgres:16'),
    });
    const unpinned = `redis@sha256:${'c'.repeat(64)}`;
    const signed = world({
      config: { requireSignedImages: true },
      zone: { services: [{ name: 'cache', image: unpinned, port: 6379, readyTimeoutSeconds: 60 }] },
    });
    expect(one(await signed.run(), 'zone.services')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('JM_ALLOWED_IMAGES'),
    });
    const pinned = world({
      config: { requireSignedImages: true },
      zone: { services: [{ name: 'db', image: PG, port: 5432, readyTimeoutSeconds: 60 }] },
    });
    expect(one(await pinned.run(), 'zone.services').status).toBe('pass');
  });

  test('egress monitor warns with observed hosts missing from the allow list', async () => {
    const w = world({ zone: { egress: { mode: 'monitor', allow: ['pypi.org'] } } });
    insertDrop(
      w.db,
      { id: 'd1', dropZoneId: 'main', workItemId: null, role: 'crew-lead', state: 'succeeded' },
      ago(3_600_000),
    );
    appendEvents(w.db, 'd1', [
      {
        ts: NOW.toISOString(),
        kind: 'egress',
        data: { host: 'registry.npmjs.org', decision: 'allow', count: 3 },
      },
      {
        ts: NOW.toISOString(),
        kind: 'egress',
        data: { host: 'evil.example', decision: 'unlisted', count: 2 },
      },
      {
        ts: NOW.toISOString(),
        kind: 'egress',
        data: { host: 'pypi.org', decision: 'unlisted', count: 1 },
      },
    ]);
    const c = one(await w.run(), 'zone.egress');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('evil.example');
    expect(c.summary).not.toContain('pypi.org');
    expect(c.fix).toContain('flip to enforce when this is empty');
  });

  test('egress off warns, and enforce passes', async () => {
    expect(
      one(await world({ zone: { egress: { mode: 'off', allow: [] } } }).run(), 'zone.egress')
        .status,
    ).toBe('warn');
    expect(one(await world().run(), 'zone.egress').status).toBe('pass');
  });

  test('zone.preset warns on a local :dev image, and when the repository looks like another stack', async () => {
    const dev = world({ zone: { image: 'jumpmaster-trooper-python:dev', preset: 'python' } });
    dev.f.state.dirs.set('main:', ['pyproject.toml']);
    dev.f.state.files.set('main:pyproject.toml', '[project]\nname = "x"\n');
    expect(one(await dev.run(), 'zone.preset')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('JM_DEV_IMAGES'),
    });
    const other = world();
    other.f.state.dirs.set('main:', ['go.mod']);
    other.f.state.files.set('main:go.mod', 'module x\n');
    expect(one(await other.run(), 'zone.preset')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('go'),
    });
  });

  test('zone.goals and zone.crew-cap appear for crew zones only; the cap says until when', async () => {
    const crew = {
      enabled: true,
      goalPath: 'GOAL.md',
      cycleMinutes: 60,
      maxDropsPerDay: 2,
      stagedLabel: 'agent-staged',
      maxStaged: 3,
      refutePromotes: false,
      maxRefute: 2,
    };
    expect((await world().run()).some((c) => c.id === 'zone.crew-cap')).toBe(false);
    const w = world({ zone: { crew, protectedPaths: ['GOAL.md'] } });
    w.f.state.labels.push('agent-staged');
    for (const [id, at] of [
      ['c1', ago(5 * 3_600_000)],
      ['c2', ago(3_600_000)],
    ] as const)
      insertDrop(
        w.db,
        { id, dropZoneId: 'main', workItemId: null, role: 'crew-lead', state: 'succeeded' },
        at,
      );
    const checks = await w.run();
    expect(one(checks, 'zone.crew-cap')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('daily cap 2/2 until 2026-11-10T07:00:00.000Z'),
    });
    expect(one(checks, 'zone.goals')).toMatchObject({ status: 'warn' });
  });

  test('zone.identity and zone.doctor-drop report skip until their tasks land', async () => {
    const checks = await world().run();
    expect(one(checks, 'zone.identity')).toMatchObject({
      status: 'skip',
      summary: expect.stringContaining('available after Task 13'),
    });
    expect(one(checks, 'zone.doctor-drop')).toMatchObject({
      status: 'skip',
      summary: expect.stringContaining('after Task 12'),
    });
  });
});
