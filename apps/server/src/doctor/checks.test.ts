import { describe, expect, test } from 'vitest';
import { STARTER_WARNING } from '../config.js';
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
    // The admin-only read is refused, so the token lacks Administration: allowed, and said why.
    expect(one(await allowed.run(), 'forge.admin')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('no Administration permission'),
    });
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
    // No HTTP answer: the check could not run, which is a warn (never a pass).
    expect(c.status).toBe('warn');
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

  // `imagetools inspect` reads a registry: a locally built image has no registry digest until it
  // is pushed, so the fix must say how to get one for both.
  test('a tag pin fix covers registry images and locally built ones', async () => {
    const zoneImage = world({ zone: { image: 'registry.example.com/team/trooper:1' } });
    const z = one(await zoneImage.run(), 'zone.preset');
    expect(z.status).toBe('warn');
    expect(z.fix).toContain('docker buildx imagetools inspect registry.example.com/team/trooper:1');
    expect(z.fix).toContain('docker push registry.example.com/team/trooper:1');
    expect(z.fix).toContain("docker image inspect --format '{{index .RepoDigests 0}}'");
    expect(z.fix).toContain('registry.example.com/team/trooper@sha256:<digest>');
    expect(z.fix).toContain('JM_ALLOWED_IMAGES');
    // A Docker Hub image is in a registry already: never tell anyone to push it.
    const service = world({
      zone: {
        services: [{ name: 'db', image: 'postgres:16', port: 5432, readyTimeoutSeconds: 60 }],
      },
    });
    const s = one(await service.run(), 'zone.services');
    expect(s.fix).toContain('docker buildx imagetools inspect postgres:16');
    expect(s.fix).not.toContain('docker push');
    expect(s.fix).toContain('postgres@sha256:<digest>');
    expect(s.fix).toContain('JM_ALLOWED_IMAGES');
  });

  test('every doc pointer is a full GitHub URL to an install.md anchor', async () => {
    const checks = await world({ zone: { egress: { mode: 'off', allow: [] } } }).run();
    const docs = checks.map((c) => c.doc).filter((d): d is string => d !== undefined);
    expect(docs.length).toBeGreaterThan(5);
    for (const d of docs)
      expect(d).toMatch(
        /^https:\/\/github\.com\/x-a-n-d-e-r-k\/jumpmaster\/blob\/main\/docs\/runbooks\/install\.md#[a-z0-9-]+$/,
      );
  });

  test('a private repository with no ruleset is told rulesets there need a paid plan', async () => {
    const w = world();
    for (const id of ['author', 'reviewer'] as const) {
      w.f.state.rules[id] = { kind: 'none' };
      w.f.state.access[id] = { ...w.f.state.access[id], private: true };
    }
    const c = one(await w.run(), 'forge.branch-rules');
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('GitHub Pro');
    // A public repository's fix doesn't mention plans.
    const pub = world();
    for (const id of ['author', 'reviewer'] as const) pub.f.state.rules[id] = { kind: 'none' };
    expect(one(await pub.run(), 'forge.branch-rules').fix).not.toContain('GitHub Pro');
  });

  test('config.secret-files fails on a secret file others can read, with the chmod fix', async () => {
    const w = world();
    w.deps.env = {
      ...w.deps.env,
      secretFiles: [
        { variable: 'JM_CLAUDE_TOKEN_FILE', path: '/run/secrets/claude_token', mode: 0o644 },
        { variable: 'JM_JOIN_TOKEN_FILE', path: '/run/secrets/join_token', mode: 0o600 },
      ],
    };
    const c = one(await w.run(), 'config.secret-files');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('claude_token');
    expect(c.summary).not.toContain('join_token');
    expect(c.fix).toContain('chmod 600 secrets/*');
    w.deps.env = {
      ...w.deps.env,
      secretFiles: [
        { variable: 'JM_CLAUDE_TOKEN_FILE', path: '/run/secrets/claude_token', mode: 0o600 },
      ],
    };
    expect(one(await w.run(), 'config.secret-files').status).toBe('pass');
    // Secrets from the environment, not files: nothing to judge.
    w.deps.env = { ...w.deps.env, secretFiles: [] };
    expect(one(await w.run(), 'config.secret-files').status).toBe('skip');
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

  test('zone.identity passes for two bot identities', async () => {
    expect(one(await world().run(), 'zone.identity')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('two-bot'),
    });
  });

  test('no check names a plan task number', async () => {
    for (const w of [world(), world({ zone: { identity: 'starter' } })])
      for (const c of await w.run()) expect(`${c.summary} ${c.fix ?? ''}`).not.toMatch(/\bTask \d/);
  });
});

describe('starter identity', () => {
  const starter = () => world({ zone: { identity: 'starter' } });

  test('zone.identity warns with the merge-any-green-PR consequence', async () => {
    const c = one(await starter().run(), 'zone.identity');
    expect(c).toMatchObject({ status: 'warn', summary: STARTER_WARNING });
    expect(STARTER_WARNING).toContain('can merge any green PR, including an unreviewed one');
    expect(STARTER_WARNING).toContain('no Workflows permission');
    expect(c.fix).toContain('JM_GITHUB_REVIEWER_TOKEN');
    expect(c.fix).toMatch(/personal repository[^.]*authorMayBeAdmin: true/);
    expect(c.doc).toMatch(/install\.md#/);
  });

  test('a healthy starter install warns only on its identity', async () => {
    const checks = await starter().run();
    expect(checks.filter((c) => c.status !== 'pass').map((c) => [c.id, c.status])).toEqual([
      ['claude.token-age', 'skip'],
      ['forge.reviewer', 'skip'],
      ['forge.reviewer-reads', 'skip'],
      ['zone.identity', 'warn'],
      ['zone.doctor-drop', 'skip'],
    ]);
    expect(one(checks, 'forge.reviewer').summary).toContain('starter mode');
  });

  test('starter reads only the author: the reviewer forge is never called', async () => {
    const w = starter();
    await w.run();
    expect(w.f.reviewer.calls).toEqual([]);
  });

  test('forge.branch-rules fails starter rules that require an approval, naming the fix', async () => {
    const w = starter();
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') {
      r.rules.requiredApprovals = 1;
      r.rules.nonActionsChecks = ['ci'];
    }
    const c = one(await w.run(), 'forge.branch-rules');
    expect(c).toMatchObject({ status: 'fail' });
    expect(c.summary).toContain('approvals required in starter mode');
    expect(c.summary).toContain('required check not from GitHub Actions: ci');
    expect(c.fix).toContain('Required approvals to 0');
    expect(c.fix).toContain('GitHub Actions');
  });

  test('a starter install on a personal repository: own admin account, authorMayBeAdmin, no Administration', async () => {
    const w = world({ zone: { identity: 'starter', authorMayBeAdmin: true } });
    w.f.state.access.author.permissions.admin = true;
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules.viewerIsAdmin = true;
    const checks = await w.run();
    expect(one(checks, 'forge.branch-rules').status).toBe('pass');
    expect(one(checks, 'forge.admin')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('personal repository'),
    });
  });

  test('forge.admin warns when the admin author token has Administration permission', async () => {
    const w = world({ zone: { identity: 'starter', authorMayBeAdmin: true } });
    w.f.state.access.author.permissions.admin = true;
    w.f.state.adminProbe.author = {
      permission: 'Administration: read',
      status: 200,
      accepted: null,
    };
    const c = one(await w.run(), 'forge.admin');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('Administration');
    expect(c.fix).toContain('Administration');
    w.f.state.adminProbe.author = {
      permission: 'Administration: read',
      status: 502,
      accepted: null,
    };
    expect(one(await w.run(), 'forge.admin')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('could not check'),
    });
  });

  test('a starter admin author without authorMayBeAdmin: the doctor names the personal-repository path', async () => {
    const w = starter();
    w.f.state.access.author.permissions.admin = true;
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules.viewerIsAdmin = true;
    const checks = await w.run();
    for (const id of ['forge.admin', 'forge.branch-rules']) {
      const c = one(checks, id);
      expect(c.status, id).toBe('fail');
      expect(c.fix, id).toMatch(/personal repository/);
      expect(c.fix, id).toContain('authorMayBeAdmin: true');
    }
  });

  test('forge.codeowners warns: a required code owner review needs a human in starter mode', async () => {
    const w = starter();
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules.requireCodeOwnerReview = true;
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('starter mode'),
    });
  });
});

describe('zone.doctor-drop', () => {
  const findings = {
    claude: { ok: true, servedModel: 'claude-opus-5-5' },
    clone: { ok: true, sha: 'abc1234def' },
    services: [{ name: 'db', ok: true }],
    gates: [
      { name: 'install', exitCode: 0, durationMs: 9000, timedOut: false, outputTail: 'ok' },
      { name: 'test', exitCode: 0, durationMs: 4000, timedOut: false, outputTail: 'ok' },
    ],
  };
  function withDrop(
    w: ReturnType<typeof world>,
    o: { state?: string; result?: unknown; at?: Date; events?: unknown[] } = {},
  ) {
    insertDrop(
      w.db,
      {
        id: 'doc1',
        dropZoneId: 'main',
        workItemId: null,
        role: 'doctor',
        state: (o.state ?? 'succeeded') as 'succeeded',
      },
      o.at ?? ago(600_000),
    );
    if (o.result !== undefined)
      w.db
        .prepare("UPDATE drops SET result_json = ?, finished_at = ? WHERE id = 'doc1'")
        .run(
          JSON.stringify(o.result),
          new Date((o.at ?? ago(600_000)).getTime() + 100_000).toISOString(),
        );
    if (o.events) appendEvents(w.db, 'doc1', o.events as never);
  }
  const ok = { status: 'completed', role: 'doctor', gates: findings.gates, doctor: findings };

  test('skips, naming the command, until a doctor drop has run', async () => {
    const w = world();
    expect(one(await w.run(), 'zone.doctor-drop')).toMatchObject({
      status: 'skip',
      fix: expect.stringContaining('jumpmaster ctl doctor main --drop'),
    });
    withDrop(w, { state: 'queued', at: ago(45 * 60_000) });
    expect(one(await w.run(), 'zone.doctor-drop')).toMatchObject({
      status: 'skip',
      summary: expect.stringContaining('queued for 45 minutes'),
      fix: expect.stringContaining('jumpmaster ctl doctor main --cancel'),
      dropId: 'doc1',
    });
  });

  test('a passing doctor drop passes, reporting claude, clone, services and each gate', async () => {
    const w = world();
    withDrop(w, { result: ok });
    const c = one(await w.run(), 'zone.doctor-drop');
    expect(c).toMatchObject({ status: 'pass', dropId: 'doc1' });
    for (const s of ['claude-opus-5-5', 'abc1234', 'db', 'install', 'test'])
      expect(c.summary).toContain(s);
  });

  test('a failing gate or a rejected Claude token fails it, saying what to do', async () => {
    const w = world();
    withDrop(w, {
      result: {
        ...ok,
        doctor: {
          ...findings,
          claude: { ok: false, error: 'authentication_failed' },
          gates: [
            findings.gates[0],
            {
              name: 'test',
              exitCode: 2,
              durationMs: 1,
              timedOut: false,
              outputTail: 'boom\nFAIL x',
            },
          ],
        },
      },
    });
    const c = one(await w.run(), 'zone.doctor-drop');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('authentication_failed');
    expect(c.summary).toContain('test exited 2');
    expect(c.summary).toContain('FAIL x');
    expect(c.fix).toContain('claude setup-token');
  });

  test('a drop that failed without findings reports its reason', async () => {
    const w = world();
    withDrop(w, {
      state: 'failed',
      result: {
        status: 'failed',
        role: 'doctor',
        reason: 'image x does not declare egress support',
        gates: [],
      },
    });
    expect(one(await w.run(), 'zone.doctor-drop')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('does not declare egress support'),
    });
  });

  test('reports the egress hosts the drop observed or was denied', async () => {
    const w = world({ zone: { egress: { mode: 'monitor', allow: [] } } });
    withDrop(w, {
      result: ok,
      events: [
        {
          ts: NOW.toISOString(),
          kind: 'egress',
          data: { host: 'files.example', decision: 'unlisted', count: 1 },
        },
        {
          ts: NOW.toISOString(),
          kind: 'egress',
          data: { host: 'github.com', decision: 'allow', count: 4 },
        },
      ],
    });
    expect(one(await w.run(), 'zone.doctor-drop')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('observed outside the allow list: files.example'),
    });
  });

  test('a doctor drop older than a week is reported as stale', async () => {
    const w = world();
    withDrop(w, { result: ok, at: ago(8 * 86_400_000) });
    expect(one(await w.run(), 'zone.doctor-drop').status).toBe('warn');
  });
});

describe('fix pass', () => {
  test('I-1: a rate-limited 403 on a read probe is a warn to run again, not a missing permission', async () => {
    const w = world();
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Issues: read' ? { ...p, status: 403, rateLimited: true } : p,
    );
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('rate limit');
    expect(c.fix).not.toContain('Read-only');
  });

  test('I-2: a required check with no workflow warns, naming the hang and the external-CI exception', async () => {
    const w = world();
    w.f.state.dirs.delete('main:.github/workflows');
    const c = one(await w.run(), 'forge.ci');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('no GitHub Actions workflow');
    expect(c.summary).toContain('wait forever');
    expect(c.summary).toContain('another CI');
  });

  test('I-3: a check whose read never answers turns into a warn after the deadline', async () => {
    const w = world();
    w.deps.checkTimeoutMs = 50;
    w.f.author.listLabels = () => new Promise(() => {});
    const checks = await w.run();
    expect(one(checks, 'forge.labels')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('did not answer within'),
    });
    expect(one(checks, 'forge.ci').status).toBe('pass');
  });

  test('I-5a: on a public repository the read probes disclaim instead of claiming the permissions', async () => {
    const c = one(await world().run(), 'forge.author-reads');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('is public');
    expect(c.summary).toContain('proves the token works, not its permissions');
    const priv = world();
    priv.f.state.access.author.private = true;
    expect(one(await priv.run(), 'forge.author-reads').summary).toContain(
      'can make every read the server relies on',
    );
  });

  test('I-5b: no push names both the account role and the token as the cause', async () => {
    const w = world();
    w.f.state.access.author.permissions.push = false;
    const c = one(await w.run(), 'forge.author');
    expect(c.fix).toContain('Write role');
    expect(c.fix).toContain("token's repository access");
    expect(c.fix).toContain('Contents: Read and write');
  });

  test('M-1: refused check runs name Checks: Read-only as a fix, without claiming it is impossible', async () => {
    const w = world();
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Checks: read'
        ? { ...p, status: 403, accepted: 'checks=read' }
        : p.permission === 'Actions: read'
          ? { ...p, status: 403 }
          : p,
    );
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('fail');
    expect(`${c.summary} ${c.fix}`).not.toContain('never');
    expect(c.summary).toContain('checks=read');
    expect(c.fix).toContain('Checks: Read-only');
    expect(c.fix).toContain('Actions: Read-only');
  });

  test('a cancelled doctor drop is a skip that says to run another, not a fail', async () => {
    const w = world();
    insertDrop(
      w.db,
      { id: 'docx', dropZoneId: 'main', workItemId: null, role: 'doctor', state: 'cancelled' },
      ago(60_000),
    );
    const c = one(await w.run(), 'zone.doctor-drop');
    expect(c.status).toBe('skip');
    expect(c.summary).toContain('was cancelled');
    expect(c.fix).toContain('jumpmaster ctl doctor main --drop');
    expect(c.fix).not.toContain('docker compose logs');
  });

  test('the enforce pass lists at most ten denied hosts, then how many more', async () => {
    const w = world();
    insertDrop(
      w.db,
      { id: 'd1', dropZoneId: 'main', workItemId: null, role: 'crew-lead', state: 'succeeded' },
      ago(3_600_000),
    );
    appendEvents(
      w.db,
      'd1',
      Array.from({ length: 12 }, (_, i) => ({
        ts: NOW.toISOString(),
        kind: 'egress' as const,
        data: { host: `h${String(i).padStart(2, '0')}.example`, decision: 'deny', count: 1 },
      })),
    );
    const c = one(await w.run(), 'zone.egress');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('h09.example');
    expect(c.summary).not.toContain('h10.example');
    expect(c.summary).toContain('and 2 more');
  });

  test('M-8: routine denials under enforce pass, saying what they mean', async () => {
    const w = world();
    insertDrop(
      w.db,
      { id: 'd1', dropZoneId: 'main', workItemId: null, role: 'crew-lead', state: 'succeeded' },
      ago(3_600_000),
    );
    appendEvents(w.db, 'd1', [
      {
        ts: NOW.toISOString(),
        kind: 'egress',
        data: { host: 'pypi.org', decision: 'deny', count: 2 },
      },
    ]);
    const c = one(await w.run(), 'zone.egress');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('pypi.org');
    expect(c.summary).toContain('refused, as enforce means');
  });
});
