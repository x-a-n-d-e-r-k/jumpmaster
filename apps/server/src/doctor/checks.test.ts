import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ConfigStatus } from '../config/source.js';
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
import { installDocUrl } from './checks.js';
import { processEnv } from './run.js';

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
      // The pages have a login now; what crosses the network in clear is the passphrase.
      summary: expect.stringContaining('the login passphrase crosses it in clear'),
    });
    expect(one(await w.run(), 'config.listen').summary).not.toContain('no login');
    w.deps.env.inContainer = true;
    expect(one(await w.run(), 'config.listen').status).toBe('pass');
  });

  test('config.listen fails on a non-loopback allowed host without tlsTerminated, passes with it, and a non-loopback listen host alone stays a warning', async () => {
    const lan = { host: '0.0.0.0', port: 7420, allowedHosts: ['127.0.0.1:7420', 'jm.lan:7420'] };
    const w = world({ config: { listen: lan } });
    w.deps.env.inContainer = true;
    expect(one(await w.run(), 'config.listen')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('jm.lan:7420'),
      fix: 'put a TLS terminator in front and set JM_TLS_TERMINATED=1, or remove jm.lan:7420 from JM_ALLOWED_HOSTS',
    });
    // Declared behind a TLS terminator: the passphrase does not cross the network in clear.
    const tls = world({ config: { listen: { ...lan, tlsTerminated: true } } });
    tls.deps.env.inContainer = true;
    expect(one(await tls.run(), 'config.listen').status).toBe('pass');
    // Loopback names in any form never fail.
    for (const h of ['localhost:7420', '[::1]:7420', '127.0.0.1'])
      expect(
        one(
          await world({
            config: { listen: { host: '127.0.0.1', port: 7420, allowedHosts: [h] } },
          }).run(),
          'config.listen',
        ).status,
        h,
      ).toBe('pass');
    // A non-loopback listen host with loopback-only allowed hosts: the warning it was.
    const bare = world({ config: { listen: { host: '0.0.0.0', port: 7420 } } });
    bare.deps.env.inContainer = false;
    expect(one(await bare.run(), 'config.listen').status).toBe('warn');
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
        /^https:\/\/github\.com\/x-a-n-d-e-r-k\/jumpmaster\/blob\/(main|v[0-9][^/]*)\/docs\/runbooks\/install\.md#[a-z0-9-]+$/,
      );
  });

  test("doc URLs follow the server image's release version, and main for a development build", () => {
    const base = 'https://github.com/x-a-n-d-e-r-k/jumpmaster/blob';
    const tail = 'docs/runbooks/install.md';
    expect(installDocUrl('0.4.0-rc.1')).toBe(`${base}/v0.4.0-rc.1/${tail}`);
    expect(installDocUrl('1.2.3')).toBe(`${base}/v1.2.3/${tail}`);
    for (const dev of [undefined, '', '0.0.0-dryrun.abc', 'main', '1.2', 'v1.2.3', '1.2.3/../x'])
      expect(installDocUrl(dev), String(dev)).toBe(`${base}/main/${tail}`);
  });

  test('zone.preset warns when the zone has no gates, naming the risk and the fix', async () => {
    const none = one(await world({ zone: { gates: [] } }).run(), 'zone.preset');
    expect(none.status).toBe('warn');
    expect(none.summary).toMatch(/no gates/);
    expect(none.summary).toMatch(/no checks of their own/);
    expect(none.fix).toMatch(/gates/);
    const some = one(
      await world({
        zone: { gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 20 }] },
      }).run(),
      'zone.preset',
    );
    expect(some.status).toBe('pass');
  });

  test('config.secret-files reads the real modes: a 0644 file fails and a 0600 file passes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-secret-modes-'));
    chmodSync(dir, 0o700);
    const file = join(dir, 'claude_token');
    writeFileSync(file, 'x\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    const w = world();
    // The server sees the file through a bind mount, not the host directory: a 0700 directory
    // around a 0644 file still fails.
    w.deps.env = processEnv({ JM_CLAUDE_TOKEN_FILE: file });
    const c = one(await w.run(), 'config.secret-files');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain(file);
    expect(c.summary).toContain('644');
    chmodSync(file, 0o600);
    w.deps.env = processEnv({ JM_CLAUDE_TOKEN_FILE: file });
    expect(one(await w.run(), 'config.secret-files').status).toBe('pass');
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

  test('a queued doctor drop says what holds it: the usage pause, a credits stop, or no capable stick', async () => {
    const w = world();
    withDrop(w, { state: 'queued', at: ago(46 * 60_000) });
    const summary = async () => one(await w.run(), 'zone.doctor-drop').summary;
    expect(await summary()).toContain('waiting for a free stick slot');
    // The throttle (finishing_only) no longer holds a doctor drop.
    setUsageState(w.db, { status: 'allowed_warning', observedAt: ago(60_000).toISOString() }, NOW);
    expect(await summary()).toContain('waiting for a free stick slot');
    setUsageState(w.db, { pausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }, NOW);
    expect(await summary()).toContain('held: usage paused until 2026-11-09T13:00:00.000Z');
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
    expect(await summary()).toContain('held: credits stop');
  });

  test('a queued doctor drop under the usage probe or a credits Resume says it is held', async () => {
    const w = world();
    withDrop(w, { state: 'queued', at: ago(5 * 60_000) });
    const summary = async () => one(await w.run(), 'zone.doctor-drop').summary;
    setUsageState(w.db, { status: 'rejected' }, NOW);
    expect(await summary()).toContain(
      'held: the usage limit was hit, and a doctor drop is never the probe',
    );
    setUsageState(
      w.db,
      {
        status: 'allowed',
        overageResumeUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
        overageResumeDropId: 'd9',
        overageResumeWorkItemId: 4,
      },
      NOW,
    );
    expect(await summary()).toContain(
      'held: resuming after a credits stop, only work item 4 runs until 2026-11-09T13:00:00.000Z',
    );
  });

  test('a queued doctor drop with no stick connected says so', async () => {
    const w = world();
    w.db.prepare('DELETE FROM sticks').run();
    withDrop(w, { state: 'queued', at: ago(5 * 60_000) });
    expect(one(await w.run(), 'zone.doctor-drop').summary).toContain(
      'waiting for a stick: no stick is connected',
    );
  });

  test('a queued doctor drop no live stick can take says so', async () => {
    const w = world({ config: { requireSignedImages: true } });
    stampStick(
      w.db,
      's1',
      { capabilities: [], imagePolicy: 'allowlist', version: '0.3.0', pinnedImages: [] },
      ago(10_000),
    );
    withDrop(w, { state: 'queued', at: ago(5 * 60_000) });
    expect(one(await w.run(), 'zone.doctor-drop').summary).toContain(
      'waiting for a stick that can run zone main',
    );
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

describe('config store checks', () => {
  const status = (o: Partial<ConfigStatus> = {}): ConfigStatus => ({
    mode: 'db',
    revision: 4,
    restartPending: [],
    ...o,
  });

  test('without the store status the config checks are not run', async () => {
    const ids = (await world().run()).map((c) => c.id);
    expect(ids).not.toContain('config.file');
    expect(ids).not.toContain('config.restart');
  });

  test('config.file passes in either mode, and fails while the file is invalid, keeping the old config', async () => {
    const w = world();
    w.deps.configStatus = status();
    expect(one(await w.run(), 'config.file')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('db mode, revision 4'),
    });
    w.deps.configStatus = status({ mode: 'file', filePath: '/config/jm.json' });
    expect(one(await w.run(), 'config.file')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('/config/jm.json'),
    });
    w.deps.configStatus = status({
      mode: 'file',
      filePath: '/config/jm.json',
      fileProblem: [{ path: 'pollSeconds', message: 'Too small' }],
    });
    expect(one(await w.run(), 'config.file')).toMatchObject({
      status: 'fail',
      summary: expect.stringMatching(/invalid.*revision 4/),
      fix: expect.stringMatching(/pollSeconds: Too small[\s\S]*jumpmaster ctl config reload/),
    });
  });

  test('config.file notes a file ignored in db mode, and warns when it no longer mirrors the config', async () => {
    const w = world();
    w.deps.configStatus = status({
      filePath: '/config/jm.json',
      fileIgnored: 'config file ignored: adopted on 2026-11-01T00:00:00.000Z',
      fileMatchesExport: true,
    });
    expect(one(await w.run(), 'config.file')).toMatchObject({
      status: 'pass',
      summary: expect.stringMatching(/config file ignored: adopted on 2026-11-01.*mirrors/),
    });
    w.deps.configStatus = { ...w.deps.configStatus, fileMatchesExport: false };
    expect(one(await w.run(), 'config.file')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('config file ignored: adopted on 2026-11-01'),
      fix: expect.stringContaining('ctl config export'),
    });
  });

  test('config.file warns when the file runs only after an adjustment (an out-of-range pollSeconds)', async () => {
    const w = world();
    const warning = 'pollSeconds 1 is outside 5..86400: running with 5; set it in range';
    w.deps.configStatus = status({
      mode: 'file',
      filePath: '/config/jm.json',
      warnings: [warning],
    });
    expect(one(await w.run(), 'config.file')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('/config/jm.json'),
      fix: expect.stringContaining(warning),
    });
  });

  test('config.restart warns while a restart-only setting waits for a restart', async () => {
    const w = world();
    w.deps.configStatus = status();
    expect(one(await w.run(), 'config.restart').status).toBe('pass');
    w.deps.configStatus = status({ restartPending: ['mcp.enabled'] });
    expect(one(await w.run(), 'config.restart')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('mcp.enabled'),
      fix: expect.stringContaining('docker compose restart jumpmaster'),
    });
  });
});
