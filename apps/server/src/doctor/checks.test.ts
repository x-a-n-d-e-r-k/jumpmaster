import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ConfigStatus } from '../config/source.js';
import { type DropZoneConfig, STARTER_WARNING } from '../config.js';
import { openDb } from '../db/open.js';
import {
  appendEvents,
  insertDrop,
  insertStick,
  recordUsageWindows,
  setKilled,
  setUsageState,
  setZoneMode,
  stampStick,
} from '../db/repo.js';
import { GitLabForge } from '../forge/gitlab.js';
import { InstallationCheckError } from '../forge/installation-verifier.js';
import { ScrubSet } from '../forge/scrub-set.js';
import { APP_MANIFEST_PERMISSIONS } from '../github/app-manifest.js';
import { AUTHOR_TOKEN, ago, NOW, one, PG, world } from '../test/doctorWorld.js';
import { ACCESS, type FakeGitLab, fakeGitLab } from '../test/fake-gitlab.js';
import { okProbes } from '../test/fakes.js';
import { makeZone } from '../test/fixtures.js';
import { tmpDbFile } from '../test/helpers.js';
import { addTranscriptDrop } from '../test/transcriptWorld.js';
import { prunePass } from '../transcripts.js';
import { gateReason, gateReasonText } from '../usage.js';
import { type Resolved, shadowedAppEntries } from '../vault/credentials.js';
import {
  type AppEntryRead,
  type GitHubAppEntry,
  readAppEntry,
  serializeAppEntry,
} from '../vault/github-app-entries.js';
import { credentialProblems } from '../vault/problems.js';
import { type ResolvedApps, resolveAppEntries } from '../vault/resolution.js';
import { openVault } from '../vault/vault.js';
import {
  ADD_CHAT_SERVICE,
  CHECK_IDS,
  chatServiceCheck,
  type DoctorCheck,
  type DoctorDeps,
  installDocUrl,
  zoneChecks,
} from './checks.js';
import { processEnv } from './run.js';

describe('a healthy install', () => {
  test('passes every check but those that cannot run yet, which say so', async () => {
    // Setup asks for the read token, which the chat reads the zone's code with (R3).
    const checks = await world({ readToken: true }).run();
    const notPass = checks.filter((c) => c.status !== 'pass');
    expect(notPass.map((c) => [c.id, c.status])).toEqual([
      ['claude.token-age', 'skip'],
      ['server.public-url', 'info'],
      ['transcripts.retention', 'info'],
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
    // After a host restart the stick is only back if Docker starts at boot.
    expect(one(await w.run(), 'stick.seen').fix).toContain('Docker start at boot');
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

  describe("a stick's egress ceiling (#780)", () => {
    // The world's zone runs the node preset under enforce; this ceiling covers its hosts.
    const NODE = [
      'api.anthropic.com',
      'codeload.github.com',
      'github.com',
      'nodejs.org',
      'objects.githubusercontent.com',
      'registry.npmjs.org',
    ];
    const stampCeiling = (w: ReturnType<typeof world>, egressCeiling: string[] | null) =>
      stampStick(
        w.db,
        's1',
        {
          capabilities: ['egress-v1', 'image-verify-v1', 'push-v1'],
          imagePolicy: 'signed',
          version: '0.4.0',
          pinnedImages: [],
          egressCeiling,
        },
        ago(10_000),
      );

    test('stick.capabilities names a host outside the ceiling and how to add it', async () => {
      const w = world({ zone: { egress: { mode: 'enforce', allow: ['gitlab.example.com'] } } });
      stampCeiling(w, NODE);
      const c = one(await w.run(), 'stick.capabilities');
      expect(c.status).toBe('fail');
      expect(c.summary).toContain(
        "stick-1 lacks gitlab.example.com in the stick's JM_EGRESS_CEILING",
      );
      expect(c.fix).toBe('add gitlab.example.com to JM_EGRESS_CEILING on the stick and restart it');
      expect(c.fix).not.toContain('upgrade the stick');
      // Added, and the stick restarted: it can run the project.
      stampCeiling(w, [...NODE, 'gitlab.example.com']);
      expect(one(await w.run(), 'stick.capabilities').status).toBe('pass');
      // No ceiling at all: as before.
      stampCeiling(w, null);
      expect(one(await w.run(), 'stick.capabilities').status).toBe('pass');
    });

    test('a zone in monitor: set its egress to enforce', async () => {
      const w = world({ zone: { egress: { mode: 'monitor', allow: [] } } });
      stampCeiling(w, NODE);
      const c = one(await w.run(), 'stick.capabilities');
      expect(c.status).toBe('fail');
      expect(c.summary).toContain(
        "stick-1 lacks egress set to enforce (the stick's JM_EGRESS_CEILING requires it)",
      );
      expect(c.fix).toBe("set the zone's egress to enforce");
      expect(c.fix).not.toContain('upgrade the stick');
    });
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

  test('stick.volumes passes, warns and fails', async () => {
    const w = world();
    const stamp = (id: string, name: string, caps: string[]) => {
      insertStick(w.db, { id, name, tokenHash: `h-${id}`, slots: 1 });
      stampStick(
        w.db,
        id,
        { capabilities: caps, imagePolicy: 'signed', version: null, pinnedImages: [] },
        ago(10_000),
      );
    };
    // The world's own stick-1 advertises push-v1 (see the world's stampStick).
    expect(one(await w.run(), 'stick.volumes').status).toBe('pass');
    stamp('s2', 'stick-2', ['egress-v1']);
    const warn = one(await w.run(), 'stick.volumes');
    expect(warn.status).toBe('warn');
    expect(warn.summary).toContain('stick-2');
    expect(warn.summary).not.toContain('stick-1');
    w.db.prepare("UPDATE sticks SET capabilities_json = '[]' WHERE id = 's1'").run();
    const fail = one(await w.run(), 'stick.volumes');
    expect(fail.status).toBe('fail');
    expect(fail.fix).toBe(
      'Update the stick, and check that it can create Docker volumes and has 10 GiB free: without that it takes no implement, heal or resolve work.',
    );
    expect(fail.doc).toMatch(/install\.md#sticks$/);
  });

  test('stick.volumes skips with no live stick', async () => {
    const w = world();
    w.db.prepare('DELETE FROM sticks').run();
    expect(one(await w.run(), 'stick.volumes').status).toBe('skip');
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
      fix: expect.stringContaining('/#waiting-on-you'),
    });
  });

  test('usage.gate warns while Command overrides the throttle, with what is left (#728)', async () => {
    const w = world();
    const until = new Date(NOW.getTime() + 3_600_000).toISOString();
    setUsageState(
      w.db,
      {
        status: 'allowed_warning',
        warningWindow: 'five_hour',
        warningAt: NOW.toISOString(),
        overrideUntil: until,
        overrideStarts: 5,
        overrideStartsLeft: 3,
        overrideBy: 'token',
      },
      NOW,
    );
    expect(one(await w.run(), 'usage.gate')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining(`3 of 5 starts left, until ${until}`),
      fix: expect.stringContaining('ctl usage override --clear'),
    });
  });

  describe('usage.gate names what holds the throttle (#753)', () => {
    const reset = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
    const reason = (w: ReturnType<typeof world>) =>
      gateReasonText(gateReason(w.db, w.config.usage, NOW));

    test('a threshold hold names the window, its figure and the threshold', async () => {
      const w = world();
      w.config.usage = { ...w.config.usage, throttleUtilization: 0.8 };
      recordUsageWindows(
        w.db,
        {
          five_hour: { utilization: 0.2, resetsAt: reset },
          seven_day: { utilization: 0.834, resetsAt: reset },
        },
        NOW,
        null,
      );
      const c = one(await w.run(), 'usage.gate');
      expect(c.status).toBe('warn');
      expect(c.summary).toBe(
        '7-day usage at 83% is at or above the 80% throttle: only finishing work (review, heal, resolve) dispatches',
      );
      expect(c.summary).toContain(reason(w));
    });

    test("the warning fallback says it is Claude's warning with no figure", async () => {
      const w = world();
      setUsageState(
        w.db,
        { status: 'allowed_warning', warningWindow: 'five_hour', warningAt: NOW.toISOString() },
        NOW,
      );
      const c = one(await w.run(), 'usage.gate');
      expect(c.summary).toBe(
        'Claude warned of 5-hour usage and reported no figure for it: only finishing work (review, heal, resolve) dispatches',
      );
    });

    test('an override over a threshold hold names the hold it lifts', async () => {
      const w = world();
      w.config.usage = { ...w.config.usage, throttleUtilization: 0.8 };
      recordUsageWindows(w.db, { seven_day: { utilization: 0.834, resetsAt: reset } }, NOW, null);
      const until = new Date(NOW.getTime() + 3_600_000).toISOString();
      setUsageState(
        w.db,
        { overrideUntil: until, overrideStarts: 5, overrideStartsLeft: 3, overrideBy: 'token' },
        NOW,
      );
      const c = one(await w.run(), 'usage.gate');
      expect(c.status).toBe('warn');
      expect(c.summary).toBe(
        `7-day usage at 83% is at or above the 80% throttle; Command's override has 3 of 5 starts left, until ${until}`,
      );
      expect(c.summary).toBe(`${reason(w)}, until ${until}`);
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

  test('an unknown bypass with no other problem warns, naming the ruleset and how to check', async () => {
    const w = world();
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind !== 'ok') throw new Error('world rules');
      w.f.state.rules[id] = {
        kind: 'ok',
        rules: {
          ...r.rules,
          asApp: true,
          bypass: [
            { rulesetId: 1, name: 'jumpmaster', restrictUpdatesOnly: false, can: 'no' },
            ...(id === 'reviewer'
              ? [
                  {
                    rulesetId: 2,
                    name: 'jumpmaster-merge',
                    restrictUpdatesOnly: true,
                    can: 'unknown' as const,
                  },
                ]
              : []),
          ],
        },
      };
    }
    const c = one(await w.run(), 'forge.branch-rules');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('jumpmaster-merge');
    expect(c.summary).not.toContain('jumpmaster,');
    expect(c.fix).toContain('Settings → Rules → Rulesets → jumpmaster-merge → Bypass list');
    expect(c.fix).toContain('only on jumpmaster-merge');
    expect(c.fix).toContain('author app');
  });

  test('every bypass read as no is a pass, as before', async () => {
    const w = world();
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind !== 'ok') throw new Error('world rules');
      w.f.state.rules[id] = {
        kind: 'ok',
        rules: {
          ...r.rules,
          asApp: true,
          bypass: [{ rulesetId: 1, name: 'jumpmaster', restrictUpdatesOnly: false, can: 'no' }],
        },
      };
    }
    expect(one(await w.run(), 'forge.branch-rules').status).toBe('pass');
  });

  test('branch rules that cannot be read are never a pass', async () => {
    const w = world();
    w.f.state.rules.author = { kind: 'unavailable' };
    expect(one(await w.run(), 'forge.branch-rules').status).toBe('warn');
  });

  test('forge.codeowners in two-bot reads CODEOWNERS by path: the bot must own what is not protected, and people only what is', async () => {
    const w = world();
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind === 'ok') r.rules.requireCodeOwnerReview = true;
    }
    // A catch-all naming only people: GitHub would refuse every merge.
    w.f.state.files.set('main:.github/CODEOWNERS', '# owners\n* @someone-else\n');
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('line 2 (*)'),
      fix: expect.stringContaining(
        'name @reviewer-bot on that line (the protected lines after it stay people-only; the last match wins), or turn code-owner review off',
      ),
    });
    // The bot on the catch-all and people only on the protected lines after it: pass.
    w.f.state.files.set(
      'main:.github/CODEOWNERS',
      '* @someone-else @reviewer-bot\n.github/** @someone-else\nCODEOWNERS @someone-else\npnpm-workspace.yaml @someone-else\n',
    );
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('people'),
    });
    // The bot on a protected line: its approval would stand in for a person's.
    w.f.state.files.set(
      'main:.github/CODEOWNERS',
      '* @someone-else @reviewer-bot\n.github/** @reviewer-bot\nCODEOWNERS @someone-else\npnpm-workspace.yaml @someone-else\n',
    );
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('.github/** through line 2 (.github/**)'),
    });
    // A protected path no line owns: GitHub asks no person for it.
    w.f.state.files.set(
      'main:.github/CODEOWNERS',
      '* @someone-else @reviewer-bot\n.github/** @someone-else\nCODEOWNERS @someone-else\npnpm-workspace.yaml\n',
    );
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('pnpm-workspace.yaml'),
    });
    // A team owner may include the bot, which Jumpmaster cannot see: a warn, not a fail.
    w.f.state.files.set(
      'main:.github/CODEOWNERS',
      '* @octo/devs\n.github/** @someone-else\nCODEOWNERS @someone-else\npnpm-workspace.yaml @someone-else\n',
    );
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining(
        'line 1 (*) names a team or an e-mail: if @reviewer-bot is not a member, nothing merges; name @reviewer-bot on the line to be sure',
      ),
    });
    // Required, with no CODEOWNERS file: nobody owns the protected paths on GitHub.
    w.f.state.files.delete('main:.github/CODEOWNERS');
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('no CODEOWNERS'),
    });
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
          maxTriage: 2,
          arbiter: true,
        },
        protectedPaths: ['GOAL.md'],
      },
    });
    w.f.state.labels = ['bug'];
    const c = one(await w.run(), 'forge.labels');
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('gh label create drop-ready --repo octo/demo');
    expect(c.fix).toContain('gh label create agent-retry --repo octo/demo');
    expect(c.fix).toContain('gh label create agent-staged --repo octo/demo');
  });

  test('forge.labels reports a missing triage label on a zone whose triage gate is on', async () => {
    const crew = { ...makeZone().crew, enabled: true };
    const w = world({ zone: { crew, protectedPaths: ['GOAL.md'] } });
    w.f.state.labels = ['drop-ready', 'agent-retry', 'agent-staged'];
    const c = one(await w.run(), 'forge.labels');
    expect(c).toMatchObject({ status: 'fail', summary: expect.stringContaining('jm-triage') });
    expect(c.fix).toContain('gh label create jm-triage --repo octo/demo');
    w.f.state.labels.push('jm-triage');
    const triaged = one(await w.run(), 'forge.labels');
    expect(triaged).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('jm-triaged'),
    });
    expect(triaged.fix).toContain('gh label create jm-triaged --repo octo/demo');
    w.f.state.labels.push('jm-triaged');
    expect(one(await w.run(), 'forge.labels').status).toBe('pass');
    // With the gate off (or the crew off) nothing writes the label, so it is not needed.
    const off = world({ zone: { crew, protectedPaths: ['GOAL.md'], triage: { gate: false } } });
    off.f.state.labels = ['drop-ready', 'agent-retry', 'agent-staged'];
    expect(one(await off.run(), 'forge.labels').status).toBe('pass');
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

  test('branch rules the token reads but whose repository it cannot reach say so, not "no ruleset"', async () => {
    const w = world();
    w.f.state.rules.reviewer = { kind: 'unreachable' };
    const c = one(await w.run(), 'forge.branch-rules');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain("can't reach");
    expect(c.summary).not.toContain('no ruleset');
    expect(c.fix).toContain('repository access');
    expect(c.fix).not.toContain('Create a branch ruleset');
    // Starter mode reads the author alone, and says the same.
    const s = world();
    s.f.state.rules.author = { kind: 'unreachable' };
    const sc = one(await s.run(), 'forge.branch-rules');
    expect(sc.status).toBe('fail');
    expect(sc.summary).not.toContain('no ruleset');
    expect(sc.fix).toContain('repository access');
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
      maxTriage: 2,
      arbiter: true,
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

  test('zone.crew-cap passes with maxDropsPerDay 0: no daily limit, usage paces the crew (#398)', async () => {
    const crew = {
      enabled: true,
      goalPath: 'GOAL.md',
      cycleMinutes: 60,
      maxDropsPerDay: 0,
      stagedLabel: 'agent-staged',
      maxStaged: 3,
      refutePromotes: false,
      maxRefute: 2,
      maxTriage: 2,
      arbiter: true,
    };
    const w = world({ zone: { crew, protectedPaths: ['GOAL.md'] } });
    w.f.state.labels.push('agent-staged');
    for (let n = 0; n < 100; n++)
      insertDrop(
        w.db,
        {
          id: `c${n}`,
          dropZoneId: 'main',
          workItemId: null,
          role: 'crew-lead',
          state: 'succeeded',
        },
        ago(3_600_000),
      );
    expect(one(await w.run(), 'zone.crew-cap')).toMatchObject({
      status: 'pass',
      summary: 'crew drops in the last 24 hours: 100 (no daily limit; Claude usage paces the crew)',
    });
  });

  test('zone.crew-cap counts every crew role as crewDropsToday does: an arbitrate drop dates the cap (D5)', async () => {
    const crew = {
      enabled: true,
      goalPath: 'GOAL.md',
      cycleMinutes: 60,
      maxDropsPerDay: 2,
      stagedLabel: 'agent-staged',
      maxStaged: 3,
      refutePromotes: false,
      maxRefute: 2,
      maxTriage: 2,
      arbiter: true,
    };
    const w = world({ zone: { crew, protectedPaths: ['GOAL.md'] } });
    w.f.state.labels.push('agent-staged');
    for (const [id, role, at] of [
      ['c1', 'arbitrate', ago(5 * 3_600_000)],
      ['c2', 'crew-lead', ago(3_600_000)],
    ] as const)
      insertDrop(w.db, { id, dropZoneId: 'main', workItemId: null, role, state: 'succeeded' }, at);
    expect(one(await w.run(), 'zone.crew-cap')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('daily cap 2/2 until 2026-11-10T07:00:00.000Z'),
    });
  });

  test('zone.crew-cap leaves diagnose drops out, as crewDropsToday does (#397)', async () => {
    const crew = {
      enabled: true,
      goalPath: 'GOAL.md',
      cycleMinutes: 60,
      maxDropsPerDay: 2,
      stagedLabel: 'agent-staged',
      maxStaged: 3,
      refutePromotes: false,
      maxRefute: 2,
      maxTriage: 2,
      arbiter: true,
    };
    const w = world({ zone: { crew, protectedPaths: ['GOAL.md'] } });
    w.f.state.labels.push('agent-staged');
    for (const [id, role, at] of [
      ['c1', 'diagnose', ago(6 * 3_600_000)],
      ['c2', 'diagnose', ago(5 * 3_600_000)],
      ['c3', 'crew-lead', ago(3_600_000)],
    ] as const)
      insertDrop(w.db, { id, dropZoneId: 'main', workItemId: null, role, state: 'succeeded' }, at);
    expect(one(await w.run(), 'zone.crew-cap')).toMatchObject({
      status: 'pass',
      summary: 'crew drops in the last 24 hours: 1/2',
    });
    insertDrop(
      w.db,
      { id: 'c4', dropZoneId: 'main', workItemId: null, role: 'refute', state: 'succeeded' },
      ago(2 * 3_600_000),
    );
    // The oldest counted drop (c4, not the diagnoses) dates the cap; diagnoses still run.
    const cap = one(await w.run(), 'zone.crew-cap');
    expect(cap).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('daily cap 2/2 until 2026-11-10T10:00:00.000Z'),
    });
    expect(cap.summary).toContain('only parked briefings are still diagnosed');
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
    const checks = await world({ zone: { identity: 'starter' }, readToken: true }).run();
    expect(checks.filter((c) => c.status !== 'pass').map((c) => [c.id, c.status])).toEqual([
      ['claude.token-age', 'skip'],
      ['server.public-url', 'info'],
      ['transcripts.retention', 'info'],
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

  test('forge.codeowners in starter mode: a required code owner review could never be given; Jumpmaster parks those pull requests instead', async () => {
    const w = starter();
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('parks every pull request'),
    });
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules.requireCodeOwnerReview = true;
    expect(one(await w.run(), 'forge.codeowners')).toMatchObject({
      status: 'warn',
      summary: expect.stringMatching(
        /starter mode.*never lets an author approve.*parks every pull request/,
      ),
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
    setUsageState(
      w.db,
      {
        status: 'allowed_warning',
        warningWindow: 'five_hour',
        warningAt: ago(60_000).toISOString(),
      },
      NOW,
    );
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

  test('a queued doctor drop in a paused zone names the zone id only inside the ctl command (#99)', async () => {
    const w = world();
    withDrop(w, { state: 'queued', at: ago(5 * 60_000) });
    setZoneMode(w.db, 'main', 'paused', NOW);
    const summary = one(await w.run(), 'zone.doctor-drop').summary;
    expect(summary).toContain('held: the project is paused (jumpmaster ctl resume main)');
    expect(summary).not.toContain('zone main');
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
      'waiting for a stick that can run project main',
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

describe('credential checks (Task 4)', () => {
  const problem = (kind: 'missing' | 'kind' | 'same', credential: string, message: string) => ({
    zoneId: 'main',
    kind,
    credential: credential as never,
    message,
  });
  const creds = (o: Partial<NonNullable<DoctorDeps['credentials']>> = {}) => ({
    problems: [],
    shadowed: [],
    vaultKey: { status: 'empty' as const },
    ...o,
  });

  test('without credential information the checks are not run', async () => {
    const ids = (await world().run()).map((c) => c.id);
    for (const id of [
      'credential.missing',
      'credential.kind',
      'credential.same',
      'credential.shadowed',
      'vault.key',
    ])
      expect(ids).not.toContain(id);
  });

  test('a credential change that invalidates a zone fails credential.kind or credential.same for that zone', async () => {
    const w = world();
    w.deps.credentials = creds();
    let checks = await w.run();
    for (const id of ['credential.missing', 'credential.kind', 'credential.same'])
      expect(one(checks, id)).toMatchObject({ zoneId: 'main', status: 'pass' });
    w.deps.credentials = creds({
      problems: [
        problem(
          'kind',
          'githubAuthorToken',
          'zone main is a starter zone, which merges with the author token',
        ),
        problem(
          'same',
          'githubReviewerToken',
          "the reviewer token belongs to the author's account (bot)",
        ),
      ],
    });
    checks = await w.run();
    expect(one(checks, 'credential.kind')).toMatchObject({
      zoneId: 'main',
      status: 'fail',
      summary: 'githubAuthorToken: zone main is a starter zone, which merges with the author token',
    });
    expect(one(checks, 'credential.same')).toMatchObject({
      status: 'fail',
      credentials: ['githubReviewerToken'],
    });
    expect(one(checks, 'credential.kind').credentials).toEqual(['githubAuthorToken']);
    expect(one(checks, 'credential.missing').status).toBe('pass');
  });

  describe('GitHub App roles need no PAT (issue #458)', () => {
    const entry = {
      source: 'vault',
      fingerprint: 'fp',
      entry: { appId: '9', slug: 'bot', clientId: 'c', pem: 'unused', importedAt: '2026-11-01' },
    } as const;
    const noPats = (): Resolved =>
      ({
        claudeToken: { value: 'sk-ant-oat01-x', source: 'vault', fingerprint: 'fp' },
        githubAuthorToken: { source: 'missing' },
        githubReviewerToken: { source: 'missing' },
        githubReadToken: { source: 'missing' },
      }) as Resolved;
    const appsOf = (
      zone: DropZoneConfig,
      author: AppEntryRead,
      reviewer: AppEntryRead,
    ): ResolvedApps => new Map([[zone.repo.split('/')[0]!.toLowerCase(), { author, reviewer }]]);

    test('a two-bot zone with both app entries and no PATs passes every credential check', async () => {
      const w = world();
      w.deps.credentials = creds({
        problems: credentialProblems(w.zone, noPats(), appsOf(w.zone, entry, entry)),
      });
      const checks = await w.run();
      for (const id of ['credential.missing', 'credential.kind', 'credential.same'])
        expect(one(checks, id)).toMatchObject({ zoneId: w.zone.id, status: 'pass' });
    });

    test('an undecryptable author entry fails credential.missing on the author token', async () => {
      const w = world();
      const broken: AppEntryRead = { source: 'missing', undecryptable: true };
      w.deps.credentials = creds({
        problems: credentialProblems(w.zone, noPats(), appsOf(w.zone, broken, entry)),
      });
      const checks = await w.run();
      expect(one(checks, 'credential.missing')).toMatchObject({
        status: 'fail',
        credentials: ['githubAuthorToken'],
      });
      expect(one(checks, 'credential.kind').status).toBe('pass');
      expect(one(checks, 'credential.same').status).toBe('pass');
    });
  });

  describe('a GitLab zone is judged by its gitlab-pat entries (issue #764)', () => {
    const AUTHOR = ['glpat', 'D'.repeat(20)].join('-');
    const REVIEWER = ['glpat', 'E'.repeat(20)].join('-');
    // A Claude token and no GitHub token: a GitLab zone needs none.
    const claudeOnly = (): Resolved =>
      ({
        claudeToken: { value: 'sk-ant-oat01-x', source: 'vault', fingerprint: 'fp' },
        githubAuthorToken: { source: 'missing' },
        githubReviewerToken: { source: 'missing' },
        githubReadToken: { source: 'missing' },
      }) as Resolved;
    const gitlabOf = (zone: DropZoneConfig): DropZoneConfig => ({
      ...zone,
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.com' },
    });

    test('with its pats in the vault, no credential check fails', async () => {
      const w = world();
      const pats = new Map([[w.zone.id, { author: AUTHOR, reviewer: REVIEWER }]]);
      w.deps.credentials = creds({
        problems: credentialProblems(gitlabOf(w.zone), claudeOnly(), new Map(), pats),
      });
      const checks = await w.run();
      for (const id of ['credential.missing', 'credential.kind', 'credential.same'])
        expect(one(checks, id)).toMatchObject({ zoneId: w.zone.id, status: 'pass' });
    });

    test('without them, credential.missing names gitlab-pat/<zone>/author, and no value', async () => {
      const w = world();
      w.deps.credentials = creds({
        problems: credentialProblems(
          gitlabOf(w.zone),
          claudeOnly(),
          new Map(),
          new Map([[w.zone.id, { reviewer: REVIEWER }]]),
        ),
      });
      const checks = await w.run();
      expect(one(checks, 'credential.missing')).toMatchObject({
        status: 'fail',
        credentials: [`gitlab-pat/${w.zone.id}/author`],
      });
      expect(one(checks, 'credential.missing').summary).toContain(
        `gitlab-pat/${w.zone.id}/author: no GitLab author token is set`,
      );
      expect(one(checks, 'credential.kind').status).toBe('pass');
      expect(JSON.stringify(checks)).not.toContain(REVIEWER);
    });

    test('equal author and reviewer values fail credential.same on the reviewer entry', async () => {
      const w = world();
      w.deps.credentials = creds({
        problems: credentialProblems(
          gitlabOf(w.zone),
          claudeOnly(),
          new Map(),
          new Map([[w.zone.id, { author: AUTHOR, reviewer: AUTHOR }]]),
        ),
      });
      const checks = await w.run();
      expect(one(checks, 'credential.same')).toMatchObject({
        status: 'fail',
        credentials: [`gitlab-pat/${w.zone.id}/reviewer`],
      });
      expect(JSON.stringify(checks)).not.toContain(AUTHOR);
    });
  });

  test('credential.shadowed warns naming the file and both fingerprints, never a value', async () => {
    const w = world();
    w.deps.credentials = creds({
      shadowed: [
        {
          name: 'githubAuthorToken',
          path: '/secrets/github_author_token',
          fileFingerprint: 'aaaa1111',
          vaultFingerprint: 'bbbb2222',
        },
      ],
    });
    const c = one(await w.run(), 'credential.shadowed');
    expect(c).toMatchObject({ status: 'warn', zoneId: null });
    expect(c.summary).toBe(
      'githubAuthorToken is set by /secrets/github_author_token (aaaa1111) and in the vault (bbbb2222): the file is in use',
    );
    expect(JSON.stringify(c)).not.toContain(AUTHOR_TOKEN);
  });

  test('the token case keeps its fix text (issue #551 regression)', async () => {
    const w = world();
    w.deps.credentials = creds({
      shadowed: [
        {
          name: 'githubAuthorToken',
          path: '/secrets/github_author_token',
          fileFingerprint: 'aaaa1111',
          vaultFingerprint: 'bbbb2222',
        },
      ],
    });
    expect(one(await w.run(), 'credential.shadowed')).toMatchObject({
      status: 'warn',
      credentials: ['githubAuthorToken'],
      fix: 'Remove the one you do not mean: delete the file (then jumpmaster ctl secrets reload), or remove the vault entry with jumpmaster ctl secrets remove <name>.',
    });
    w.deps.credentials = creds();
    expect(one(await w.run(), 'credential.shadowed')).toMatchObject({
      status: 'pass',
      summary: 'no credential is set both in a file and in the vault',
    });
  });

  describe('credential.shadowed for a GitHub App entry (issue #551)', () => {
    const pemOf = (): string =>
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
    const FILE_PEM = pemOf();
    const VAULT_PEM = pemOf();
    const CLIENT_ID = 'Iv23liSHADOWEDCLIENT551';
    const app = (pem: string): GitHubAppEntry => ({
      appId: '551',
      slug: 'acme-author',
      clientId: CLIENT_ID,
      pem,
      importedAt: '2026-11-15T10:00:00.000Z',
    });
    const setup = (filePem: string | undefined, vaultPem: string | undefined, prefer = false) => {
      const keyFile = join(mkdtempSync(join(tmpdir(), 'jm-key-')), 'vault_key');
      writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
      const v = openVault(keyFile, openDb(tmpDbFile()));
      if (v === 'disabled') throw new Error('no vault');
      if (vaultPem) v.put('github-app/acme/author', serializeAppEntry(app(vaultPem)), { now: NOW });
      const dir = mkdtempSync(join(tmpdir(), 'jm-secrets-'));
      const path = join(dir, 'github-app', 'acme', 'author.json');
      if (filePem) {
        mkdirSync(join(dir, 'github-app', 'acme'), { recursive: true });
        writeFileSync(path, JSON.stringify(app(filePem), null, 2), { mode: 0o600 });
        chmodSync(path, 0o600);
      }
      const apps = resolveAppEntries([{ repo: 'acme/x' }], {
        vault: v,
        secretsDir: dir,
        preferVault: prefer,
        scrubSet: new ScrubSet(),
      });
      return { shadowed: shadowedAppEntries(apps, v), path };
    };
    const expectNoSecret = (c: DoctorCheck): void => {
      const text = `${c.summary}\n${c.fix ?? ''}\n${JSON.stringify(c)}`;
      expect(text).not.toContain(CLIENT_ID);
      for (const pem of [FILE_PEM, VAULT_PEM]) {
        expect(text).not.toContain(pem);
        for (const line of pem.split('\n').filter((l) => l.length > 0))
          expect(text).not.toContain(line);
        expect(text).not.toContain(JSON.stringify(pem));
      }
    };

    test('a differing file and vault entry warns, naming the entry, the file and the source in use', async () => {
      const { shadowed, path } = setup(FILE_PEM, VAULT_PEM);
      const w = world();
      w.deps.credentials = creds({ shadowed });
      const c = one(await w.run(), 'credential.shadowed');
      expect(c).toMatchObject({
        status: 'warn',
        zoneId: null,
        credentials: ['github-app/acme/author'],
      });
      const [s] = shadowed;
      expect(c.summary).toBe(
        `github-app/acme/author is set by ${path} (${s?.fileFingerprint}) and in the vault (${s?.vaultFingerprint}): the file is in use`,
      );
      expect(c.fix).toContain('jumpmaster ctl secrets reload');
      expect(c.fix).toContain('jumpmaster ctl secrets remove github-app/<owner>/<role>');
      expectNoSecret(c);
    });

    test('the fix names no action refused for a file-sourced entry: no Replace key, no Settings control (issue #599)', async () => {
      for (const prefer of [false, true]) {
        const { shadowed } = setup(FILE_PEM, VAULT_PEM, prefer);
        const w = world();
        w.deps.credentials = creds({ shadowed });
        const c = one(await w.run(), 'credential.shadowed');
        expect(c.fix).toBe(
          'For a GitHub App entry (github-app/<owner>/<role>), keep the one you mean: delete the file secrets/github-app/<owner>/<role>.json (then jumpmaster ctl secrets reload), or remove the vault copy with jumpmaster ctl secrets remove github-app/<owner>/<role>.',
        );
        expect(c.fix).not.toMatch(/replace/i);
        expect(c.fix).not.toContain('/system/credentials');
        expect(c.fix).not.toContain('/key');
      }
    });

    test('under prefer-vault the summary says the vault entry is in use', async () => {
      const { shadowed, path } = setup(FILE_PEM, VAULT_PEM, true);
      const w = world();
      w.deps.credentials = creds({ shadowed });
      const c = one(await w.run(), 'credential.shadowed');
      expect(c.status).toBe('warn');
      expect(c.summary).toContain(`github-app/acme/author is set by ${path}`);
      expect(c.summary).toMatch(/: the vault entry is in use$/);
      expectNoSecret(c);
    });

    test('equal entries, or one source alone, pass with the existing summary', async () => {
      for (const [f, v] of [
        [FILE_PEM, FILE_PEM],
        [FILE_PEM, undefined],
        [undefined, VAULT_PEM],
      ] as const) {
        const w = world();
        w.deps.credentials = creds({ shadowed: setup(f, v).shadowed });
        expect(one(await w.run(), 'credential.shadowed')).toMatchObject({
          status: 'pass',
          summary: 'no credential is set both in a file and in the vault',
        });
      }
    });

    test('a token and an app entry both shadowed: each fix is given, each with its own remove', async () => {
      const { shadowed } = setup(FILE_PEM, VAULT_PEM);
      const w = world();
      w.deps.credentials = creds({
        shadowed: [
          {
            name: 'githubAuthorToken',
            path: '/secrets/github_author_token',
            fileFingerprint: 'aaaa1111',
            vaultFingerprint: 'bbbb2222',
          },
          ...shadowed,
        ],
      });
      const c = one(await w.run(), 'credential.shadowed');
      expect(c.credentials).toEqual(['githubAuthorToken', 'github-app/acme/author']);
      expect(c.fix).toContain('jumpmaster ctl secrets remove <name>');
      expect(c.fix).toContain('jumpmaster ctl secrets remove github-app/<owner>/<role>');
      expectNoSecret(c);
    });
  });

  test('a wrong key fails vault.key, naming no value', async () => {
    const w = world();
    w.deps.credentials = creds({ vaultKey: { status: 'mismatch', names: ['claudeToken'] } });
    expect(one(await w.run(), 'vault.key')).toMatchObject({
      status: 'fail',
      summary:
        'the vault key changed: restore the key file or re-enter each credential (claudeToken)',
    });
    w.deps.credentials = creds({ vaultKey: { status: 'disabled' } });
    expect(one(await w.run(), 'vault.key')).toMatchObject({ status: 'skip' });
    w.deps.credentials = creds({ vaultKey: { status: 'ok' }, vaultKeyFile: '/secrets/vault_key' });
    expect(one(await w.run(), 'vault.key').status).toBe('pass');
  });

  test('a Claude token set in the UI dates claude.token-age from the vault, not claude.tokenCreatedAt', async () => {
    const w = world();
    w.deps.credentials = creds({ claudeTokenCreatedAt: NOW.toISOString().slice(0, 10) });
    expect(one(await w.run(), 'claude.token-age')).toMatchObject({ status: 'pass' });
  });
});

test('config.secret-files checks every file under the secrets directory, the four credential names included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-secrets-'));
  for (const [name, mode] of [
    ['claude_token', 0o644],
    ['github_author_token', 0o600],
    ['vault_key', 0o600],
  ] as const) {
    writeFileSync(join(dir, name), 'x', { mode });
    chmodSync(join(dir, name), mode);
  }
  const env = processEnv({ JM_SECRETS_DIR: dir, JM_JOIN_TOKEN_FILE: join(dir, 'vault_key') });
  expect(env.secretFiles).toEqual([
    { variable: 'JM_JOIN_TOKEN_FILE', path: join(dir, 'vault_key'), mode: 0o600 },
    { variable: 'secrets/claude_token', path: join(dir, 'claude_token'), mode: 0o644 },
    {
      variable: 'secrets/github_author_token',
      path: join(dir, 'github_author_token'),
      mode: 0o600,
    },
  ]);
});

const APP_ENTRY: GitHubAppEntry = {
  appId: '123456',
  slug: 'acme-jumpmaster-author',
  clientId: 'Iv1.0123456789abcdef',
  pem: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
  importedAt: '2026-11-17T00:00:00.000Z',
};

/** The app id a GitHub App JWT (a `Bearer` header) is issued for. */
const issOf = (auth: string): string =>
  String(
    (JSON.parse(Buffer.from(auth.split('.')[1] ?? '', 'base64url').toString()) as { iss: unknown })
      .iss,
  );

test('#258 D5 parity: one mode rule for a top-level secret file and a GitHub App entry file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-secrets-app-'));
  mkdirSync(join(dir, 'github-app', 'acme'), { recursive: true });
  const top = join(dir, 'claude_token');
  const app = join(dir, 'github-app', 'acme', 'author.json');
  writeFileSync(top, 'x');
  writeFileSync(app, serializeAppEntry(APP_ENTRY));
  // Not an entry file: a stray non-JSON name and a deeper level are not listed.
  writeFileSync(join(dir, 'github-app', 'acme', 'notes.txt'), 'x');
  for (const p of [top, app, join(dir, 'github-app', 'acme', 'notes.txt')]) chmodSync(p, 0o644);
  const w = world();
  w.deps.env = processEnv({ JM_SECRETS_DIR: dir });
  expect(w.deps.env.secretFiles).toEqual([
    { variable: 'secrets/claude_token', path: top, mode: 0o644 },
    { variable: 'secrets/github-app/acme/author.json', path: app, mode: 0o644 },
  ]);
  const c = one(await w.run(), 'config.secret-files');
  expect(c.status).toBe('fail');
  expect(c.summary).toBe(
    `secret file(s) other users on the host can read: ${top} (secrets/claude_token, mode 644), ${app} (secrets/github-app/acme/author.json, mode 644)`,
  );
  expect(c.fix).toContain('chmod 600 secrets/github-app/*/*.json');
  // The server refuses the same app entry file the doctor reports.
  expect(() => readAppEntry({ vault: 'disabled', secretsDir: dir }, 'acme', 'author')).toThrow(
    `${app} is readable by others; chmod 600 it`,
  );
  // At 0600 both pass, and the entry is read.
  for (const p of [top, app]) chmodSync(p, 0o600);
  w.deps.env = processEnv({ JM_SECRETS_DIR: dir });
  expect(one(await w.run(), 'config.secret-files')).toMatchObject({
    status: 'pass',
    summary: 'every secret file is readable by its owner only (2)',
  });
  expect(readAppEntry({ vault: 'disabled', secretsDir: dir }, 'acme', 'author')).toMatchObject({
    source: 'file',
    path: app,
  });
});

const KEY_IN_DATA_DIR =
  'The vault key is stored in the data directory, beside the data it protects. A copy of that directory can read every stored credential. Set JM_SECRETS_DIR to a directory outside it and turn the vault on again.';

describe('vault.key judges the effective key path (#258)', () => {
  const on = (keyFile?: string): NonNullable<DoctorDeps['credentials']> => ({
    problems: [],
    shadowed: [],
    vaultKey: { status: 'ok' },
    ...(keyFile ? { vaultKeyFile: keyFile } : {}),
  });

  test('a key from JM_VAULT_KEY_FILE under the data directory warns; outside it passes', async () => {
    const w = world();
    w.deps.credentials = on();
    w.deps.env.vaultKeyFile = '/tmp/x/keys/vault_key';
    expect(one(await w.run(), 'vault.key')).toMatchObject({
      status: 'warn',
      summary: KEY_IN_DATA_DIR,
    });
    w.deps.env.vaultKeyFile = '/secrets/vault_key';
    expect(one(await w.run(), 'vault.key')).toMatchObject({
      status: 'pass',
      summary: 'every vault entry decrypts with the key /secrets/vault_key',
    });
    expect(processEnv({ JM_VAULT_KEY_FILE: '/secrets/vault_key' }).vaultKeyFile).toBe(
      '/secrets/vault_key',
    );
  });

  test('a Settings-created key at <dataDir>/vault/vault_key warns (it passed before)', async () => {
    const w = world();
    delete w.deps.env.vaultKeyFile;
    w.deps.credentials = on('/tmp/x/vault/vault_key');
    const c = one(await w.run(), 'vault.key');
    expect(c).toMatchObject({ status: 'warn', summary: KEY_IN_DATA_DIR });
    expect(c.fix).toContain('/tmp/x/vault/vault_key');
    // The examined path is the store's effective one: JM_VAULT_KEY_FILE when set, which wins.
    w.deps.credentials = on('/run/secrets/vault_key');
    w.deps.env.vaultKeyFile = '/run/secrets/vault_key';
    expect(one(await w.run(), 'vault.key')).toMatchObject({
      status: 'pass',
      summary: 'every vault entry decrypts with the key /run/secrets/vault_key',
    });
  });

  test('a pass names the key path it examined; with no path known, the check does not pass', async () => {
    const w = world();
    delete w.deps.env.vaultKeyFile;
    w.deps.credentials = on();
    const c = one(await w.run(), 'vault.key');
    expect(c.status).not.toBe('pass');
    expect(c.summary).toMatch(/key file/);
  });

  test('neither set and the vault off: the existing off result, not a pass', async () => {
    const w = world();
    delete w.deps.env.vaultKeyFile;
    w.deps.credentials = { problems: [], shadowed: [], vaultKey: { status: 'disabled' } };
    expect(one(await w.run(), 'vault.key')).toMatchObject({
      status: 'skip',
      summary:
        'no vault key (the vault is off: turn it on under System, Credentials, or set JM_VAULT_KEY_FILE): credentials come from files and the environment only',
    });
  });
});

test('config.secret-files fails a group- or world-readable target reached through a link, saying to chmod the file it points to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-secret-link-'));
  writeFileSync(join(dir, 'real'), 'x', { mode: 0o644 });
  chmodSync(join(dir, 'real'), 0o644);
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  const w = world();
  w.deps.env = processEnv({ JM_CLAUDE_TOKEN_FILE: join(dir, 'link') });
  expect(w.deps.env.secretFiles).toEqual([
    { variable: 'JM_CLAUDE_TOKEN_FILE', path: join(dir, 'link'), mode: 0o644, link: true },
  ]);
  const c = one(await w.run(), 'config.secret-files');
  expect(c.status).toBe('fail');
  expect(c.summary).toBe(
    `secret file(s) other users on the host can read: ${join(dir, 'link')} (JM_CLAUDE_TOKEN_FILE, mode 644; a link: chmod 600 the file it points to)`,
  );
});

describe('install-wide credentials', () => {
  const creds = (o: { claude?: boolean; author?: boolean }) => ({
    problems: [],
    shadowed: [],
    vaultKey: { status: 'ok' as const },
    install: { claudeToken: o.claude ?? true, githubAuthorToken: o.author ?? true },
  });

  test('with no zone, a missing Claude or author token fails, pointing at the wizard step and ctl', async () => {
    const w = world();
    w.deps.config = { ...w.deps.config, dropZones: [] };
    w.deps.credentials = creds({ claude: false, author: false });
    const c = one(await w.run(), 'credential.install');
    expect(c).toMatchObject({ status: 'fail', zoneId: null });
    expect(c.summary).toMatch(/Claude token/);
    expect(c.summary).toMatch(/GitHub author token/);
    expect(c.fix).toContain('/setup/claude');
    expect(c.fix).toContain('/setup/forge');
    expect(c.fix).toContain('jumpmaster ctl secrets set claudeToken');
    expect(c.fix).toContain('jumpmaster ctl secrets set githubAuthorToken');
    w.deps.credentials = creds({});
    expect(one(await w.run(), 'credential.install').status).toBe('pass');
  });

  test('once zones exist the per-zone checks report credentials and this one does not repeat them', async () => {
    const w = world();
    w.deps.credentials = creds({ claude: false });
    const c = one(await w.run(), 'credential.install');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/each project's credential checks/);
  });

  test("claude.token-age names the Claude step's Made on field, with its link", async () => {
    const w = world({ config: { claude: { plan: 'max', fableWeeklyDropCap: 5 } } });
    const c = one(await w.run(), 'claude.token-age');
    expect(c.status).toBe('skip');
    expect(c.fix).toContain('“Made on”');
    expect(c.fix).toContain('/setup/claude');
  });
});

test('CHECK_IDS names exactly the check ids this file reports', () => {
  const src = readFileSync(join(import.meta.dirname, 'checks.ts'), 'utf8');
  const ids = new Set([...src.matchAll(/\bid: '([a-z]+\.[a-z-]+)'/g)].map((m) => m[1] as string));
  for (const m of src.matchAll(/\bg\('([a-z]+\.[a-z-]+)'/g)) ids.add(m[1] as string);
  for (const who of ['author', 'reviewer']) ids.add(`forge.${who}`).add(`forge.${who}-reads`);
  expect([...ids].sort()).toEqual([...CHECK_IDS].sort());
});

describe('server.public-url (issue #139)', () => {
  test('unset: info, not a failure, saying where to set it; nothing is fetched', async () => {
    const w = world();
    let fetched = 0;
    w.deps.reach = async () => {
      fetched++;
      return { ok: true, message: 'Reachable' };
    };
    const c = one(await w.run(), 'server.public-url');
    expect(c.status).toBe('info');
    expect(c.summary).toContain('Set the address other machines reach this server at');
    expect(fetched).toBe(0);
  });

  test('set and reachable: pass', async () => {
    const w = world({ config: { server: { publicUrl: 'https://a.b.ts.net' } } });
    const asked: string[] = [];
    w.deps.reach = async (url) => {
      asked.push(url);
      return { ok: true, message: 'Reachable' };
    };
    const c = one(await w.run(), 'server.public-url');
    expect(asked).toEqual(['https://a.b.ts.net']);
    expect(c.status).toBe('pass');
    expect(c.summary).toBe('https://a.b.ts.net is reachable (/healthz answered)');
  });

  test('set and unreachable: warn with the Check button text', async () => {
    const w = world({ config: { server: { publicUrl: 'https://a.b.ts.net' } } });
    const message = 'timeout: https://a.b.ts.net/healthz did not answer within 5 seconds';
    w.deps.reach = async () => ({ ok: false, message });
    const c = one(await w.run(), 'server.public-url');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain(message);
  });
});

describe('server.image-mirror (issue #140)', () => {
  const row = (
    name: string,
    state: 'complete' | 'fetching' | 'failed' | 'pending',
    error?: string,
  ) => ({
    name,
    digest: `sha256:${'a'.repeat(64)}`,
    ref: `ghcr.io/o/${name}@sha256:${'a'.repeat(64)}`,
    state,
    ...(error ? { error } : {}),
    platforms: ['linux/amd64', 'linux/arm64'],
    size: 1000,
    current: true,
  });

  test('absent without a mirror (a test app); with one and no lock: info, nothing to mirror', async () => {
    const w = world();
    expect((await w.run()).some((c) => c.id === 'server.image-mirror')).toBe(false);
    w.deps.imageMirror = () => ({ lock: false, images: [] });
    const c = one(await w.run(), 'server.image-mirror');
    expect(c.status).toBe('info');
    expect(c.summary).toContain('runs from a checkout; nothing to mirror');
  });

  test('every image complete: pass', async () => {
    const w = world();
    w.deps.imageMirror = () => ({
      lock: true,
      images: [row('jumpmaster-trooper', 'complete'), row('jumpmaster-egress', 'complete')],
    });
    const c = one(await w.run(), 'server.image-mirror');
    expect(c.status).toBe('pass');
    expect(c.summary).toBe('2 release images mirrored for sticks (linux/amd64, linux/arm64)');
  });

  test('every image complete: the pass message adds the store size on disk (issue #426)', async () => {
    const w = world();
    w.deps.imageMirror = () => ({
      lock: true,
      images: [row('jumpmaster-trooper', 'complete'), row('jumpmaster-egress', 'complete')],
      storeBytes: Math.round(2.9 * 1024 ** 3),
    });
    const c = one(await w.run(), 'server.image-mirror');
    expect(c.status).toBe('pass');
    expect(c.summary).toBe(
      '2 release images mirrored for sticks (linux/amd64, linux/arm64); store 2.9 GiB',
    );
  });

  test('an image failed: warn naming it and the reason', async () => {
    const w = world();
    w.deps.imageMirror = () => ({
      lock: true,
      images: [
        row('jumpmaster-trooper', 'complete'),
        row('jumpmaster-egress', 'failed', 'the registry refused anonymous access'),
      ],
    });
    const c = one(await w.run(), 'server.image-mirror');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('jumpmaster-egress: the registry refused anonymous access');
  });

  test('still fetching: info, saying so', async () => {
    const w = world();
    w.deps.imageMirror = () => ({
      lock: true,
      images: [row('jumpmaster-trooper', 'fetching'), row('jumpmaster-egress', 'pending')],
    });
    const c = one(await w.run(), 'server.image-mirror');
    expect(c.status).toBe('info');
    expect(c.summary).toContain('2 of 2 release images are still being mirrored');
  });
});

describe('transcripts.retention (issue #197)', () => {
  test("info: each zone's setting, the archive size and the drops due", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jm-doc-'));
    const w = world({ config: { dataDir } });
    mkdirSync(join(dataDir, 'transcripts/main/2026-08'), { recursive: true });
    writeFileSync(join(dataDir, 'transcripts/main/2026-08/a.jsonl.gz'), 'x'.repeat(2048));
    addTranscriptDrop(w.db, {
      id: 'old',
      zone: 'main',
      createdAt: 't',
      finishedAt: ago(100 * 86_400_000).toISOString(),
    });
    addTranscriptDrop(w.db, {
      id: 'held',
      zone: 'main',
      state: 'push_pending',
      createdAt: 't',
      finishedAt: ago(100 * 86_400_000).toISOString(),
    });
    expect(one(await w.run(), 'transcripts.retention')).toMatchObject({
      status: 'info',
      zoneId: null,
      summary:
        'transcript retention: main keeps 90 days, archived (1 drop due); archive directory 2.0 KiB',
    });
    w.zone.transcripts = { retainDays: 0, archive: false };
    expect(one(await w.run(), 'transcripts.retention').summary).toBe(
      'transcript retention: main keeps forever; archive directory 2.0 KiB',
    );
  });

  test('warn after an archive write failed in the last 24 hours; info again after', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jm-doc-'));
    const w = world({ config: { dataDir } });
    addTranscriptDrop(w.db, {
      id: 'old',
      zone: 'main',
      createdAt: 't',
      finishedAt: ago(100 * 86_400_000).toISOString(),
      events: [{ kind: 'log', dataJson: '{}' }],
    });
    await prunePass(w.db, {
      dataDir,
      zones: [w.zone],
      now: ago(3_600_000),
      log: () => {},
      write: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    const c = one(await w.run(), 'transcripts.retention');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('an archive write failed at 2026-11-09T11:00:00.000Z');
    expect(c.summary).toContain('drop old in project main: EACCES: permission denied');
    expect(c.summary).toContain('main keeps 90 days, archived (1 drop due)');
    expect(c.fix).toContain('transcripts');
    w.deps.now = () => new Date(NOW.getTime() + 24 * 3_600_000);
    expect(one(await w.run(), 'transcripts.retention').status).toBe('info');
  });
});

describe('zone.ready-label (#198)', () => {
  test('a zone on agent-ready gets an INFO with the two steps to drop-ready, in order', async () => {
    const checks = await world({ zone: { readyLabel: 'agent-ready' } }).run();
    const c = one(checks, 'zone.ready-label');
    expect(c).toMatchObject({ status: 'info', zoneId: 'main' });
    expect(c.summary).toContain('drop-ready');
    const fix = c.fix ?? '';
    const rename = fix.indexOf('Issues → Labels → `agent-ready` → Edit');
    const set = fix.indexOf('jumpmaster ctl zones set main readyLabel=drop-ready');
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(rename);
  });

  test.each(['drop-ready', 'go'])('a zone on %s gets none', async (readyLabel) => {
    const checks = await world({ zone: { readyLabel } }).run();
    expect(checks.filter((c) => c.id === 'zone.ready-label')).toEqual([]);
  });
});

describe('forge.private-clone for an app-reviewer zone (issue #237)', () => {
  const reviewer = {
    source: 'vault',
    fingerprint: 'fp',
    entry: { appId: '9', slug: 'jm-reviewer', clientId: 'c', pem: 'unused', importedAt: 'x' },
  } as const;
  const apps = new Map([['octo', { author: reviewer, reviewer }]]) as unknown as ResolvedApps;
  const appWorld = (o: { readToken?: boolean } = {}) => {
    const w = world({
      ...o,
      zone: { githubApp: { repositoryId: 5, installations: { reviewer: 7 } } },
    });
    w.deps.resolvedApps = () => apps;
    // The read forge on the reviewer app's token (makeReadForgeFor is app-first for this zone).
    w.deps.readForge = () => w.read.author;
    return w;
  };

  test('a private repository passes when the app reads the default branch, without reviewReadToken or a read token', async () => {
    const w = appWorld();
    w.f.state.access.author.private = true;
    const c = one(await w.run(), 'forge.private-clone');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('jm-reviewer');
  });

  test('a read that gets 404 fails naming the reviewer app, with the install fix and no read-token advice', async () => {
    const w = appWorld({ readToken: true });
    w.f.state.access.author.private = true;
    w.read.author.failNext('listDir', { status: 404 });
    const c = one(await w.run(), 'forge.private-clone');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('jm-reviewer');
    expect(c.summary).toContain('HTTP 404');
    expect(c.fix).toContain('Install the reviewer GitHub App (jm-reviewer) on octo/demo');
    expect(`${c.summary} ${c.fix}`).not.toMatch(/JM_GITHUB_READ_TOKEN|reviewReadToken/);
  });

  test('a public repository says drops clone with the reviewer app', async () => {
    const w = appWorld();
    const c = one(await w.run(), 'forge.private-clone');
    expect(c).toMatchObject({
      status: 'pass',
      summary:
        "octo/demo is public: review, crew and doctor drops clone it with the reviewer GitHub App (jm-reviewer)'s token",
    });
  });

  test('a zone without a recorded reviewer installation keeps the PAT messages', async () => {
    const w = world({ zone: { githubApp: { repositoryId: 5, installations: { author: 1 } } } });
    w.deps.resolvedApps = () => apps;
    w.f.state.access.author.private = true;
    expect(one(await w.run(), 'forge.private-clone')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('JM_GITHUB_READ_TOKEN'),
    });
  });
});

describe("forge.author and forge.reviewer verify an app zone's ids (issue #267)", () => {
  const API = 'https://ghe.ids.test.invalid/api/v3';
  // Two apps on a real key, each of which GitHub (a fake `GET /app`) recognises (issue #435).
  const entry = (appId: string, slug: string) =>
    ({
      source: 'vault',
      fingerprint: 'fp',
      entry: { ...APP_ENTRY, appId, slug, importedAt: 'x' },
    }) as const;
  const apps = new Map([
    ['octo', { author: entry('9', 'jm'), reviewer: entry('10', 'jm-reviewer') }],
  ]) as unknown as ResolvedApps;
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
  });
  const appWorld = (verify: (role: string) => Promise<void>) => {
    const w = world({
      zone: { githubApp: { repositoryId: 5, installations: { author: 7, reviewer: 8 } } },
    });
    w.deps.resolvedApps = () => apps;
    w.deps.appApiBase = API;
    for (const [id, slug] of [
      ['9', 'jm'],
      ['10', 'jm-reviewer'],
    ] as const)
      nock(API, { reqheaders: { authorization: (v: string) => issOf(v) === id } })
        .persist()
        .get('/app')
        .reply(200, { id: Number(id), slug });
    const asked: string[] = [];
    w.deps.verifiedInstallation = async (zone, role) => {
      asked.push(`${zone.id}/${role}`);
      await verify(role);
      return {
        owner: 'octo',
        installationId: role === 'author' ? 7 : 8,
        repositoryId: 5,
        fingerprint: 'fp',
        broker: {} as never,
      };
    };
    return { w, asked };
  };

  test('a match passes both checks', async () => {
    const { w, asked } = appWorld(async () => {});
    const checks = await w.run();
    expect(one(checks, 'forge.author').status).toBe('pass');
    expect(one(checks, 'forge.reviewer').status).toBe('pass');
    expect(asked.sort()).toEqual(['main/author', 'main/reviewer']);
  });

  test("a mismatch fails the role's check, naming the zone and role", async () => {
    const { w } = appWorld(async (role) => {
      if (role === 'reviewer')
        throw new InstallationCheckError(
          'main: the recorded reviewer repository id does not match octo/demo',
          true,
        );
    });
    const checks = await w.run();
    expect(one(checks, 'forge.author').status).toBe('pass');
    const c = one(checks, 'forge.reviewer');
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('main: the recorded reviewer repository id does not match octo/demo');
    expect(c.fix).toContain('githubApp');
  });

  test('a check that could not run warns, and is never a pass', async () => {
    const { w } = appWorld(async (role) => {
      if (role === 'author')
        throw new InstallationCheckError('main: could not verify the author app', false);
    });
    const c = one(await w.run(), 'forge.author');
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('could not verify');
  });

  test('a PAT zone is not verified', async () => {
    const w = world();
    let asked = 0;
    w.deps.verifiedInstallation = async () => {
      asked++;
      throw new Error('never');
    };
    const checks = await w.run();
    expect(one(checks, 'forge.author').status).toBe('pass');
    expect(asked).toBe(0);
  });
});

describe('chat.service (#336)', () => {
  const healthy = async () => ({ ok: true, claude: true, forge: true });
  const global = (checks: DoctorCheck[]) =>
    checks.find((c) => c.id === 'chat.service' && c.zoneId === null) as DoctorCheck;

  test('no chat service configured warns with the add-the-service command', async () => {
    const c = await chatServiceCheck(undefined);
    expect(c).toMatchObject({ id: 'chat.service', zoneId: null, status: 'warn' });
    expect(c.summary).toContain('no chat service');
    expect(c.fix).toContain(ADD_CHAT_SERVICE);
    expect(ADD_CHAT_SERVICE).toContain('docker compose up -d');
    const w = world();
    delete w.deps.chatHealth;
    expect(global(await w.run()).status).toBe('warn');
  });

  test('an unreachable service fails', async () => {
    const c = await chatServiceCheck(async () => null);
    expect(c).toMatchObject({ id: 'chat.service', status: 'fail' });
    expect(c.summary).toContain('not answering');
    const thrown = await chatServiceCheck(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(thrown.status).toBe('fail');
  });

  test("a service that can't reach Claude or the forge fails naming which", async () => {
    const claude = await chatServiceCheck(async () => ({ ok: false, claude: false, forge: true }));
    expect(claude.status).toBe('fail');
    expect(claude.summary).toContain('Claude');
    expect(claude.summary).not.toContain('GitHub');
    const forge = await chatServiceCheck(async () => ({ ok: false, claude: true, forge: false }));
    expect(forge.status).toBe('fail');
    expect(forge.summary).toContain('GitHub');
    expect(forge.summary).not.toContain('Claude');
    const both = await chatServiceCheck(async () => ({ ok: false, claude: false, forge: false }));
    expect(both.summary).toContain('Claude');
    expect(both.summary).toContain('GitHub');
  });

  test('a healthy service passes', async () => {
    const c = await chatServiceCheck(healthy);
    expect(c).toMatchObject({ id: 'chat.service', zoneId: null, status: 'pass' });
    const w = world({ readToken: true });
    w.deps.chatHealth = healthy;
    const checks = (await w.run()).filter((x) => x.id === 'chat.service');
    expect(checks.map((x) => [x.zoneId, x.status])).toEqual([[null, 'pass']]);
  });

  test("a PAT zone with no githubReadToken warns that the chat can't read that zone's code, naming the zone (R3)", async () => {
    const w = world();
    w.deps.chatHealth = healthy;
    const c = one(
      (await w.run()).filter((x) => x.zoneId === 'main'),
      'chat.service',
    );
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('main');
    expect(c.summary).toContain("can't read");
    expect(c.fix).toContain('JM_GITHUB_READ_TOKEN');
    // An app-reviewer zone reads with the reviewer app's token: no warning.
    const reviewer = {
      source: 'vault',
      fingerprint: 'fp',
      entry: { appId: '9', slug: 'jm-reviewer', clientId: 'c', pem: 'unused', importedAt: 'x' },
    } as const;
    const app = world({ zone: { githubApp: { repositoryId: 5, installations: { reviewer: 7 } } } });
    app.deps.resolvedApps = () =>
      new Map([['octo', { author: reviewer, reviewer }]]) as unknown as ResolvedApps;
    app.deps.chatHealth = healthy;
    expect((await app.run()).filter((x) => x.id === 'chat.service' && x.zoneId)).toEqual([]);
  });
});

describe('forge.author and forge.reviewer for GitHub App roles (issue #435)', () => {
  const API = 'https://ghe.doctor.test.invalid/api/v3';
  const DAY = 86_400_000;
  const AUTHOR_APP: GitHubAppEntry = { ...APP_ENTRY, importedAt: ago(10 * DAY).toISOString() };
  const REVIEWER_APP: GitHubAppEntry = {
    ...AUTHOR_APP,
    appId: '654321',
    slug: 'acme-jumpmaster-reviewer',
  };
  const SENTINEL = 'ghs_' + 'SENTINELSENTINELSENTINEL0123456789';
  const pemBody = APP_ENTRY.pem
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('-----'))
    .join('');
  const read = (entry: GitHubAppEntry | null) =>
    entry ? { source: 'vault', fingerprint: 'fp', entry } : { source: 'missing' };
  const appWorld = (o: { author?: GitHubAppEntry | null; reviewer?: GitHubAppEntry | null }) => {
    const w = world({
      zone: { githubApp: { repositoryId: 5, installations: { author: 7, reviewer: 8 } } },
    });
    const apps = new Map([
      [
        'octo',
        {
          author: read(o.author === undefined ? AUTHOR_APP : o.author),
          reviewer: read(o.reviewer === undefined ? REVIEWER_APP : o.reviewer),
        },
      ],
    ]) as unknown as ResolvedApps;
    w.deps.resolvedApps = () => apps;
    w.deps.appApiBase = API;
    return w;
  };
  /** A fake `GET /app`: answers by the app id the JWT is issued for. */
  const getApp = (answer: (appId: string) => [number, unknown]) => {
    for (const id of [AUTHOR_APP.appId, REVIEWER_APP.appId])
      nock(API, { reqheaders: { authorization: (v: string) => issOf(v) === id } })
        .persist()
        .get('/app')
        .reply(() => answer(id));
  };
  const byId = (id: string): [number, unknown] =>
    id === AUTHOR_APP.appId
      ? [200, { id: Number(AUTHOR_APP.appId), slug: AUTHOR_APP.slug }]
      : [200, { id: Number(REVIEWER_APP.appId), slug: REVIEWER_APP.slug }];

  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
  });

  test("an app author whose GET /app names the entry's id and slug, with push, passes", async () => {
    getApp(byId);
    const checks = await appWorld({}).run();
    const c = one(checks, 'forge.author');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('acme-jumpmaster-author[bot]');
    expect(c.summary).toContain('GitHub App');
    expect(c.summary).toContain('write on octo/demo');
    expect(c.summary).not.toMatch(/unrecognised|unset token|123456/);
    expect(one(checks, 'forge.reviewer').status).toBe('pass');
  });

  test("the installation token's expiry an hour ahead is not the token-expiry warn", async () => {
    getApp(byId);
    const w = appWorld({});
    w.f.state.access.author.tokenExpiresAt = new Date(NOW.getTime() + 3_600_000).toISOString();
    const c = one(await w.run(), 'forge.author');
    expect(c.status).toBe('pass');
    expect(c.summary).not.toContain('expires');
  });

  test('a key GitHub rejects (401) fails, naming the key', async () => {
    getApp(() => [401, { message: 'Bad credentials' }]);
    const c = one(await appWorld({}).run(), 'forge.author');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('key');
    expect(c.fix).toContain('private key');
    expect(c.fix).toContain('import');
  });

  test('a key that cannot sign fails, naming the key', async () => {
    const c = one(
      await appWorld({ author: { ...AUTHOR_APP, pem: 'not a key' } }).run(),
      'forge.author',
    );
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('key');
    expect(c.fix).toContain('private key');
  });

  test('another app id for the right slug fails, saying to re-import', async () => {
    getApp(() => [200, { id: 999, slug: AUTHOR_APP.slug }]);
    const c = one(await appWorld({}).run(), 'forge.author');
    expect(c.status).toBe('fail');
    expect(c.fix).toMatch(/re-import/i);
  });

  test('another slug for the author fails, naming authorLoginAliases and the old login', async () => {
    getApp((id) => [200, { id: Number(id), slug: 'renamed-app' }]);
    const c = one(await appWorld({}).run(), 'forge.author');
    expect(c.status).toBe('fail');
    expect(c.fix).toMatch(/re-import/i);
    expect(c.fix).toContain('authorLoginAliases');
    expect(c.fix).toContain('acme-jumpmaster-author[bot]');
  });

  test('another slug for the reviewer fails without authorLoginAliases', async () => {
    getApp((id) =>
      id === AUTHOR_APP.appId ? byId(id) : [200, { id: Number(id), slug: 'renamed-app' }],
    );
    const checks = await appWorld({}).run();
    expect(one(checks, 'forge.author').status).toBe('pass');
    const c = one(checks, 'forge.reviewer');
    expect(c.status).toBe('fail');
    expect(c.fix).toMatch(/re-import/i);
    expect(c.fix).not.toContain('authorLoginAliases');
  });

  test('no answer, a 503 or an unparseable body warns to run the doctor again', async () => {
    nock(API).persist().get('/app').replyWithError('socket hang up');
    const none = one(await appWorld({ reviewer: null }).run(), 'forge.author');
    expect(none.status).toBe('warn');
    expect(none.fix).toContain('doctor again');
    nock.cleanAll();
    getApp(() => [503, 'unavailable']);
    const busy = one(await appWorld({ reviewer: null }).run(), 'forge.author');
    expect(busy.status).toBe('warn');
    expect(busy.fix).toContain('doctor again');
    nock.cleanAll();
    nock(API).persist().get('/app').reply(200, 'not json', { 'content-type': 'text/plain' });
    expect(one(await appWorld({ reviewer: null }).run(), 'forge.author').status).toBe('warn');
  });

  test("a reviewer app with the author's appId fails forge.reviewer; a different one does not", async () => {
    getApp((id) => byId(id));
    const same = await appWorld({ reviewer: { ...AUTHOR_APP } }).run();
    const c = one(same, 'forge.reviewer');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('approve its own pull request');
    expect(one(same, 'forge.author').status).toBe('pass');
    expect(one(await appWorld({}).run(), 'forge.reviewer').status).toBe('pass');
  });

  test('a key imported more than 365 days ago warns; 364 days passes', async () => {
    getApp(byId);
    const old = one(
      await appWorld({ author: { ...AUTHOR_APP, importedAt: ago(366 * DAY).toISOString() } }).run(),
      'forge.author',
    );
    expect(old.status).toBe('warn');
    expect(old.fix).toContain('new private key');
    expect(old.fix).toContain('delete the old key');
    const fresh = one(
      await appWorld({ author: { ...AUTHOR_APP, importedAt: ago(364 * DAY).toISOString() } }).run(),
      'forge.author',
    );
    expect(fresh.status).toBe('pass');
  });

  test('Replace key (#487): an old importedAt warns; the same entry with the fresh importedAt a replace writes does not', async () => {
    getApp(byId);
    const old = { ...AUTHOR_APP, importedAt: ago(400 * DAY).toISOString() };
    expect(one(await appWorld({ author: old }).run(), 'forge.author').status).toBe('warn');
    getApp(byId);
    // The replace keeps appId, slug and clientId, sets the new PEM and importedAt = now.
    const replaced = { ...old, importedAt: NOW.toISOString() };
    const after = one(await appWorld({ author: replaced }).run(), 'forge.author');
    expect(after.status).toBe('pass');
    expect(after.summary).not.toContain('days ago');
  });

  test('the write-role and reviewer-admin fixes name the app and its installation, not a PAT variable', async () => {
    getApp(byId);
    const w = appWorld({});
    w.f.state.access.author.permissions.push = false;
    w.f.state.access.reviewer.permissions.admin = true;
    const checks = await w.run();
    const a = one(checks, 'forge.author');
    expect(a.status).toBe('fail');
    expect(a.fix).toContain('acme-jumpmaster-author');
    expect(a.fix).toContain('installation');
    expect(a.fix).not.toMatch(/JM_GITHUB_/);
    const r = one(checks, 'forge.reviewer');
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('admin');
    expect(r.fix).toContain('acme-jumpmaster-reviewer');
    expect(r.fix).not.toMatch(/JM_GITHUB_/);
  });

  test("a PAT zone, a hybrid zone's PAT role, and no resolvedApps give today's results", async () => {
    const tokens = `${installDocUrl(process.env.JM_RELEASE_VERSION)}#tokens`;
    const limit =
      "account has push; the token's own permissions can't be read — a missing Contents or Issues write shows at the first push or filing";
    const author = {
      id: 'forge.author',
      zoneId: 'main',
      doc: tokens,
      status: 'pass',
      summary: `author account author-bot has write on octo/demo (fine-grained token); ${limit}`,
    };
    const reviewer = {
      id: 'forge.reviewer',
      zoneId: 'main',
      doc: tokens,
      status: 'pass',
      summary: `reviewer account reviewer-bot has write on octo/demo (fine-grained token); ${limit}`,
    };
    const bare = await world().run();
    expect(one(bare, 'forge.author')).toEqual(author);
    expect(one(bare, 'forge.reviewer')).toEqual(reviewer);
    const pat = await appWorld({ author: null, reviewer: null }).run();
    expect(one(pat, 'forge.author')).toEqual(author);
    expect(one(pat, 'forge.reviewer')).toEqual(reviewer);
    getApp(byId);
    const hybrid = await appWorld({ author: null }).run();
    expect(one(hybrid, 'forge.author')).toEqual(author);
    expect(one(hybrid, 'forge.reviewer').summary).toContain('GitHub App');
  });

  test('no summary, fix or log line holds the PEM, a JWT or a token', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(' '));
      }),
    );
    try {
      const outcomes: Array<(id: string) => [number, unknown]> = [
        byId,
        () => [401, { message: SENTINEL }],
        (id) => [200, { id: Number(id), slug: SENTINEL }],
        () => [200, { id: 1, slug: SENTINEL }],
        () => [503, SENTINEL],
      ];
      const texts: string[] = [];
      for (const answer of outcomes) {
        nock.cleanAll();
        getApp(answer);
        const w = appWorld({
          author: { ...AUTHOR_APP, importedAt: ago(400 * DAY).toISOString() },
        });
        w.f.state.access.author.tokenExpiresAt = SENTINEL;
        for (const c of await w.run()) texts.push(c.summary, c.fix ?? '');
      }
      for (const t of [...texts, ...logged]) {
        expect(t).not.toContain(pemBody.slice(0, 40));
        expect(t).not.toContain('PRIVATE KEY');
        expect(t).not.toMatch(/eyJ/);
        expect(t).not.toContain(SENTINEL);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  describe("the installation grant against the app's manifest (issue #457)", () => {
    type Grants = Partial<Record<'author' | 'reviewer', Record<string, string>>>;
    type GrantRead = (
      role: 'author' | 'reviewer',
    ) => Promise<{ permissions: Record<string, string> }>;
    /** An app world with a fake grant dependency; `calls` records each read. */
    const grantWorld = (grants: Grants | GrantRead, o: Parameters<typeof appWorld>[0] = {}) => {
      const w = appWorld(o);
      const calls: string[] = [];
      w.deps.installationGrant = (zoneId, role) => {
        calls.push(`${zoneId}:${role}`);
        if (typeof grants === 'function') return grants(role);
        return Promise.resolve({
          permissions: grants[role] ?? { ...APP_MANIFEST_PERMISSIONS[role] },
        });
      };
      return { w, calls };
    };

    test('a grant equal to the manifest passes, as before', async () => {
      getApp(byId);
      const { w, calls } = grantWorld({});
      const checks = await w.run();
      expect(one(checks, 'forge.author').status).toBe('pass');
      expect(one(checks, 'forge.reviewer').status).toBe('pass');
      expect(calls.sort()).toEqual(['main:author', 'main:reviewer']);
    });

    test('an author grant without checks warns, naming checks and the owner who must accept', async () => {
      getApp(byId);
      const { checks: _omit, ...lacking } = APP_MANIFEST_PERMISSIONS.author;
      const { w } = grantWorld({ author: lacking });
      const c = one(await w.run(), 'forge.author');
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('checks');
      expect(c.fix).toContain('owner octo');
      expect(c.fix).toContain('Review request');
      expect(c.fix).toContain('installation');
      expect(c.fix).toMatch(/old grant until/);
    });

    test('a reviewer granted contents: read where the manifest asks write warns, naming the level', async () => {
      getApp(byId);
      const { w } = grantWorld({
        reviewer: { ...APP_MANIFEST_PERMISSIONS.reviewer, contents: 'read' },
      });
      const c = one(await w.run(), 'forge.reviewer');
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('contents (read; the manifest asks write)');
    });

    test('an extra issues: write on the reviewer warns, naming it, with a fix on the app page', async () => {
      getApp(byId);
      const { w } = grantWorld({
        reviewer: { ...APP_MANIFEST_PERMISSIONS.reviewer, issues: 'write' },
      });
      const c = one(await w.run(), 'forge.reviewer');
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('issues (write)');
      expect(c.fix).toContain('Remove issues');
      expect(c.fix).toContain('page on GitHub');
    });

    test("a grant differing only in administration or workflows is not this check's warn", async () => {
      getApp(byId);
      const { w } = grantWorld({
        author: { ...APP_MANIFEST_PERMISSIONS.author, administration: 'write', workflows: 'write' },
        reviewer: { ...APP_MANIFEST_PERMISSIONS.reviewer, administration: 'read' },
      });
      const checks = await w.run();
      expect(one(checks, 'forge.author').status).toBe('pass');
      expect(one(checks, 'forge.reviewer').status).toBe('pass');
    });

    test('a grant read that rejects warns that it could not be read, never a fail', async () => {
      getApp(byId);
      const { w } = grantWorld(() => Promise.reject(new Error('boom')));
      const checks = await w.run();
      for (const id of ['forge.author', 'forge.reviewer']) {
        const c = one(checks, id);
        expect(c.status).toBe('warn');
        expect(c.summary).toContain('could not be read');
        expect(c.summary).not.toContain('boom');
      }
    });

    test('a grant read that never answers warns that it could not be read', async () => {
      getApp(byId);
      const { w } = grantWorld(() => new Promise(() => {}));
      w.deps.checkTimeoutMs = 2_000;
      const c = one(await w.run(), 'forge.author');
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('could not be read');
    });

    test('an old key plus a grant difference is one warn mentioning both', async () => {
      getApp(byId);
      const { checks: _omit, ...lacking } = APP_MANIFEST_PERMISSIONS.author;
      const { w } = grantWorld(
        { author: lacking },
        { author: { ...AUTHOR_APP, importedAt: ago(400 * DAY).toISOString() } },
      );
      const c = one(await w.run(), 'forge.author');
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('365 days');
      expect(c.summary).toContain('checks');
      expect(c.fix).toContain('new private key');
      expect(c.fix).toContain('Review request');
    });

    test('a PAT zone makes no grant read and its results are unchanged', async () => {
      const before = await appWorld({ author: null, reviewer: null }).run();
      const { w, calls } = grantWorld({}, { author: null, reviewer: null });
      const after = await w.run();
      expect(calls).toEqual([]);
      for (const id of ['forge.author', 'forge.reviewer'])
        expect(one(after, id)).toEqual(one(before, id));
    });

    test("no result's JSON holds the PEM", async () => {
      getApp(byId);
      const texts: string[] = [];
      const cases: (Grants | GrantRead)[] = [
        { author: { issues: 'write' }, reviewer: { contents: 'read' } },
        () => Promise.reject(new Error(APP_ENTRY.pem)),
      ];
      for (const g of cases) {
        const { w } = grantWorld(g);
        texts.push(JSON.stringify(await w.run()));
      }
      for (const t of texts) {
        expect(t).not.toContain(pemBody.slice(0, 40));
        expect(t).not.toContain('PRIVATE KEY');
      }
    });
  });

  describe('the install runbook troubleshooting section (issue #472)', () => {
    const runbook = readFileSync(
      new URL('../../../../docs/runbooks/install.md', import.meta.url),
      'utf8',
    );
    const start = runbook.indexOf('\n## Troubleshooting by check id\n');
    const rest = runbook.slice(start + 1);
    const next = rest.indexOf('\n## ', 1);
    const section = next === -1 ? rest : rest.slice(0, next);
    /** The text under `### \`<id>\``, up to the next heading. */
    const entry = (id: string): string => {
      const head = `### \`${id}\`\n`;
      const at = section.indexOf(head);
      if (at === -1) return '';
      const body = section.slice(at + head.length);
      const end = body.search(/^#{2,3} /m);
      return end === -1 ? body : body.slice(0, end);
    };

    test('every check id the doctor emits, in a token zone and a two-app zone, has a heading', async () => {
      expect(start).toBeGreaterThan(-1);
      getApp(byId);
      const ids = new Set<string>();
      for (const w of [world({ readToken: true }), appWorld({})])
        for (const c of await w.run()) ids.add(c.id);
      expect(ids.size).toBeGreaterThan(25);
      const headings = new Set(
        [...section.matchAll(/^### `([a-z]+\.[a-z-]+)`$/gm)].map((m) => m[1]),
      );
      expect([...ids].filter((id) => !headings.has(id))).toEqual([]);
    });

    test('the app-role texts stay: jumpmaster-merge for the rules and owners, the key for the author', () => {
      expect(entry('forge.codeowners')).toContain('jumpmaster-merge');
      expect(entry('forge.branch-rules')).toContain('jumpmaster-merge');
      expect(entry('forge.author')).toMatch(/private key/);
      expect(entry('forge.author')).toMatch(/GitHub App/);
    });

    test('no token, key or secret-looking literal appears in the section', () => {
      expect(section).not.toMatch(/gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}/);
      expect(section).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|sk-ant-/);
    });
  });
});

describe('forge.branch-rules in a two-app zone needs jumpmaster-merge (issue #436)', () => {
  type Bypass = {
    rulesetId: number;
    name: string;
    restrictUpdatesOnly: boolean;
    can: 'yes' | 'no' | 'unknown';
  };
  const entry = (appId: string, slug: string) =>
    ({
      source: 'vault',
      fingerprint: 'fp',
      entry: { appId, slug, clientId: 'c', pem: 'unused', importedAt: 'x' },
    }) as const;
  const apps = new Map([
    ['octo', { author: entry('8', 'jm-author'), reviewer: entry('9', 'jm-reviewer') }],
  ]) as unknown as ResolvedApps;
  const main = (can: Bypass['can'] = 'no'): Bypass => ({
    rulesetId: 1,
    name: 'jumpmaster',
    restrictUpdatesOnly: false,
    can,
  });
  const merge = (can: Bypass['can'], restrictUpdatesOnly = true): Bypass => ({
    rulesetId: 2,
    name: 'jumpmaster-merge',
    restrictUpdatesOnly,
    can,
  });
  const appWorld = (
    o: {
      author?: Bypass[] | null;
      reviewer?: Bypass[];
      installations?: { author?: number; reviewer?: number };
    } = {},
  ) => {
    const w = world({
      zone: {
        githubApp: {
          repositoryId: 5,
          installations: o.installations ?? { author: 7, reviewer: 8 },
        },
      },
    });
    w.deps.resolvedApps = () => apps;
    const lists = {
      author: o.author === undefined ? [main(), merge('yes')] : o.author,
      reviewer: o.reviewer ?? [main(), merge('no')],
    };
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind !== 'ok') throw new Error('world rules');
      const list = lists[id];
      w.f.state.rules[id] = {
        kind: 'ok',
        rules: {
          ...r.rules,
          asApp: true,
          ...(list === null ? {} : { bypass: list }),
          viewerCanBypass: id === 'reviewer' && (list ?? []).some((b) => b.can === 'yes'),
        },
      };
    }
    return w;
  };
  const check = async (w: ReturnType<typeof appWorld>) => one(await w.run(), 'forge.branch-rules');
  const noSecrets = (c: { summary: string; fix?: string }) =>
    expect(`${c.summary} ${c.fix ?? ''}`).not.toMatch(/unused|ghp_|BEGIN|secret/i);

  test('the merge ruleset, update-only, bypassed by the author app alone, passes with the merge sentence', async () => {
    const c = await check(appWorld());
    expect(c.status).toBe('pass');
    expect(c.summary).toContain(
      "the reviewer can't bypass, and only the author app and admins can merge, through jumpmaster-merge",
    );
    expect(c.summary).not.toContain('neither bot can bypass');
  });

  test('no jumpmaster-merge fails, with the steps naming the author app', async () => {
    const c = await check(appWorld({ author: [main()], reviewer: [main()] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain(
      'no jumpmaster-merge ruleset: anyone with write access can merge an approved pull request',
    );
    expect(c.fix).toContain('Settings → Rules → Rulesets → New branch ruleset');
    expect(c.fix).toContain('Restrict updates');
    expect(c.fix).toContain('jm-author');
    expect(c.fix).toContain('Repository admin');
    noSecrets(c);
  });

  test('a jumpmaster-merge with more than Restrict updates fails', async () => {
    const c = await check(appWorld({ author: [main(), merge('no', false)] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('jumpmaster-merge must hold only the Restrict updates rule');
    expect(c.fix).toContain('jm-author');
    noSecrets(c);
  });

  test('a jumpmaster-merge with more than Restrict updates that the author app bypasses names the real fix', async () => {
    const c = await check(appWorld({ author: [main(), merge('yes', false)] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('jumpmaster-merge must hold only the Restrict updates rule');
    expect(c.fix).toContain('tick only Restrict updates');
    expect(c.fix).toContain('jm-author');
    expect(c.fix).not.toContain('Remove the bot accounts');
    noSecrets(c);
  });

  test('the same jumpmaster-merge beside another rules problem still names the real fix', async () => {
    const w = appWorld({ author: [main(), merge('yes', false)] });
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules = { ...r.rules, dismissStaleOnPush: false };
    const c = await check(w);
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('stale approvals not dismissed');
    expect(c.summary).toContain('jumpmaster-merge must hold only the Restrict updates rule');
    expect(c.summary).not.toContain('bot can bypass');
    expect(c.fix).toContain('tick only Restrict updates');
    expect(c.fix).not.toContain('Remove the bot accounts');
    noSecrets(c);
  });

  test('a second jumpmaster-merge with extra rules that the author app bypasses never passes', async () => {
    const extra: Bypass = {
      rulesetId: 3,
      name: 'jumpmaster-merge',
      restrictUpdatesOnly: false,
      can: 'yes',
    };
    const c = await check(appWorld({ author: [main(), merge('yes'), extra] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(
      /bot can bypass|jumpmaster-merge must hold only the Restrict updates rule/,
    );
    noSecrets(c);
  });

  test('the same two rulesets beside another rules problem still name the bypass', async () => {
    const extra: Bypass = {
      rulesetId: 3,
      name: 'jumpmaster-merge',
      restrictUpdatesOnly: false,
      can: 'yes',
    };
    const w = appWorld({ author: [main(), merge('yes'), extra] });
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules = { ...r.rules, dismissStaleOnPush: false };
    const c = await check(w);
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('stale approvals not dismissed');
    expect(c.summary).toMatch(
      /bot can bypass|jumpmaster-merge must hold only the Restrict updates rule/,
    );
  });

  test('two jumpmaster-merge rulesets, the extra-rules one listed first, fail alone and beside another problem', async () => {
    const extra: Bypass = {
      rulesetId: 3,
      name: 'jumpmaster-merge',
      restrictUpdatesOnly: false,
      can: 'yes',
    };
    const c = await check(appWorld({ author: [main(), extra, merge('yes')] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(
      /bot can bypass|jumpmaster-merge must hold only the Restrict updates rule/,
    );
    noSecrets(c);
    const w = appWorld({ author: [main(), extra, merge('yes')] });
    const r = w.f.state.rules.author;
    if (r.kind === 'ok') r.rules = { ...r.rules, dismissStaleOnPush: false };
    const c2 = await check(w);
    expect(c2.status).toBe('fail');
    expect(c2.summary).toContain('stale approvals not dismissed');
    expect(c2.summary).toMatch(
      /bot can bypass|jumpmaster-merge must hold only the Restrict updates rule/,
    );
    noSecrets(c2);
  });

  test('an author app that can bypass the main ruleset still fails as bot can bypass', async () => {
    const c = await check(appWorld({ author: [main('yes'), merge('yes')] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('bot can bypass');
    expect(c.fix).toContain('Remove the bot accounts');
  });

  test("an author app that can't bypass jumpmaster-merge fails", async () => {
    const c = await check(appWorld({ author: [main(), merge('no')] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('author app must be on its bypass list');
    expect(c.fix).toContain('jm-author');
  });

  test('a reviewer that can bypass jumpmaster-merge fails as today', async () => {
    const c = await check(appWorld({ reviewer: [main(), merge('yes')] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('bot can bypass');
  });

  test("an author's unknown bypass on jumpmaster-merge warns", async () => {
    const c = await check(appWorld({ author: [main(), merge('unknown')] }));
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('jumpmaster-merge');
  });

  test('an author read with no bypass list warns, naming the manual check', async () => {
    const c = await check(appWorld({ author: null }));
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('Settings → Rules → Rulesets → jumpmaster-merge');
  });

  test('no jumpmaster-merge fails even when another ruleset reads unknown', async () => {
    const c = await check(appWorld({ author: [main('unknown')], reviewer: [main()] }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('no jumpmaster-merge ruleset');
  });

  test('a hybrid zone (app author, PAT reviewer) without jumpmaster-merge keeps today’s pass', async () => {
    const c = await check(
      appWorld({ author: [main()], reviewer: [main()], installations: { author: 7 } }),
    );
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('neither bot can bypass');
  });
});

describe('forge.codeowners in an app-reviewer zone (issue #450)', () => {
  const entry = (appId: string, slug: string) =>
    ({
      source: 'vault',
      fingerprint: 'fp',
      entry: { appId, slug, clientId: 'c', pem: 'unused', importedAt: 'x' },
    }) as const;
  const apps = new Map([
    ['octo', { author: entry('8', 'jm-author'), reviewer: entry('9', 'jm-reviewer') }],
  ]) as unknown as ResolvedApps;
  const PROTECTED = '.github/** @alice\nCODEOWNERS @alice\npnpm-workspace.yaml @alice\n';
  const appWorld = (
    o: {
      codeowners?: string | null;
      required?: boolean;
      installations?: { author?: number; reviewer?: number };
    } = {},
  ) => {
    const w = world({
      zone: {
        githubApp: {
          repositoryId: 5,
          installations: o.installations ?? { author: 7, reviewer: 8 },
        },
      },
    });
    w.deps.resolvedApps = () => apps;
    for (const id of ['author', 'reviewer'] as const) {
      const r = w.f.state.rules[id];
      if (r.kind === 'ok') r.rules.requireCodeOwnerReview = o.required ?? true;
    }
    if (o.codeowners === null || o.codeowners === undefined)
      w.f.state.files.delete('main:.github/CODEOWNERS');
    else w.f.state.files.set('main:.github/CODEOWNERS', o.codeowners);
    return w;
  };
  const check = async (w: ReturnType<typeof appWorld>) => one(await w.run(), 'forge.codeowners');
  const noSecrets = (c: { summary: string; fix?: string }) =>
    expect(`${c.summary} ${c.fix ?? ''}`).not.toMatch(/unused|ghp_|BEGIN|secret/i);
  const noPage = (c: { summary: string; fix?: string }) =>
    expect(`${c.summary} ${c.fix ?? ''}`).not.toMatch(/\/github|generated/);

  test('a person owning a non-protected path fails, the fix naming the hybrid reviewer', async () => {
    const c = await check(appWorld({ codeowners: `* @alice\n${PROTECTED}` }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('line 1 (*)');
    expect(c.fix).toContain('hybrid reviewer');
    expect(c.fix).not.toContain('[bot]');
    expect(c.fix).not.toContain('/github');
    noSecrets(c);
    noPage(c);
  });

  test('a team owning a non-protected path fails, not warns', async () => {
    const c = await check(appWorld({ codeowners: `* @org/team\n${PROTECTED}` }));
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('hybrid reviewer');
    expect(c.fix).not.toContain('[bot]');
    noSecrets(c);
    noPage(c);
  });

  test('an e-mail owning a non-protected path fails', async () => {
    const c = await check(appWorld({ codeowners: `docs/ dev@example.com\n${PROTECTED}` }));
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('line 1 (docs/)');
    noSecrets(c);
  });

  test("the reviewer app named on a line fails: an app can't be a code owner", async () => {
    const c = await check(appWorld({ codeowners: `* @jm-reviewer[bot]\n${PROTECTED}` }));
    expect(c.status).toBe('fail');
    expect(c.fix).toContain("an app can't be a code owner");
    expect(c.fix).toContain('remove @jm-reviewer[bot] from line 1 (*)');
    expect(c.fix).not.toContain('hybrid reviewer');
    noSecrets(c);
    noPage(c);
  });

  test('a line naming the app and people gets both fixes', async () => {
    const c = await check(appWorld({ codeowners: `* @alice @jm-reviewer[bot]\n${PROTECTED}` }));
    expect(c.status).toBe('fail');
    expect(c.fix).toContain("an app can't be a code owner");
    expect(c.fix).toContain('hybrid reviewer');
    noSecrets(c);
  });

  test('people on the protected paths and no other owner passes, naming jumpmaster-merge', async () => {
    const c = await check(appWorld({ codeowners: PROTECTED }));
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('jumpmaster-merge');
    expect(c.summary).toContain('jm-reviewer');
    noSecrets(c);
    noPage(c);
  });

  test('a later unowned line clears an earlier owner', async () => {
    const c = await check(appWorld({ codeowners: `* @alice\n*\n${PROTECTED}` }));
    expect(c.status).toBe('pass');
  });

  test('a protected path with no covering line warns, naming it', async () => {
    const c = await check(appWorld({ codeowners: '.github/** @alice\nCODEOWNERS @alice\n' }));
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('pnpm-workspace.yaml');
    noSecrets(c);
    noPage(c);
  });

  test('a protected path owned only by the app warns', async () => {
    const c = await check(
      appWorld({
        codeowners: '.github/** @jm-reviewer[bot]\nCODEOWNERS @alice\npnpm-workspace.yaml @alice\n',
      }),
    );
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('.github/**');
    noSecrets(c);
    noPage(c);
  });

  test('no CODEOWNERS warns, mentioning no bot owning anything', async () => {
    const c = await check(appWorld({ codeowners: null }));
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('no CODEOWNERS');
    expect(c.fix).toContain('.github/CODEOWNERS');
    expect(`${c.summary} ${c.fix ?? ''}`).not.toContain('reviewer bot');
    expect(`${c.summary} ${c.fix ?? ''}`).not.toContain('[bot]');
    noSecrets(c);
    noPage(c);
  });

  test("a hybrid zone (app author, PAT reviewer) keeps today's two-bot pass", async () => {
    const c = await check(
      appWorld({ codeowners: `* @reviewer-bot\n${PROTECTED}`, installations: { author: 7 } }),
    );
    expect(c).toMatchObject({
      status: 'pass',
      summary:
        'code owner review is required: the protected paths are owned by people, and the reviewer reviewer-bot owns the rest, so GitHub holds a protected-path pull request for a person and merges the others',
    });
  });

  describe('a PAT author with an app reviewer (issue #506)', () => {
    const patAuthor = (codeowners: string) =>
      appWorld({ codeowners, installations: { reviewer: 8 } });

    test('people-only protected lines do not claim the jumpmaster-merge fence, and warn', async () => {
      const c = await check(patAuthor(PROTECTED));
      expect(`${c.summary} ${c.fix ?? ''}`).not.toContain('jumpmaster-merge limits');
      expect(c.summary).not.toContain('ruleset limits who may merge');
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('any account with write access');
      expect(c.fix).toContain('make the author a GitHub App too');
      expect(c.fix).toContain('machine user with a personal access token');
      noSecrets(c);
      noPage(c);
    });

    test('a person owning a non-protected path fails; the fix does not say to keep an author app', async () => {
      const c = await check(patAuthor(`* @alice\n${PROTECTED}`));
      expect(c.status).toBe('fail');
      expect(c.fix).not.toContain('keep the author app');
      expect(c.fix).not.toContain('hybrid reviewer');
      expect(c.fix).toContain('machine user with a personal access token');
      expect(c.fix).toContain('make the author a GitHub App too');
      expect(`${c.summary} ${c.fix ?? ''}`).not.toContain('jumpmaster-merge limits');
      noSecrets(c);
      noPage(c);
    });

    test("the reviewer app named on a line still fails: an app can't be a code owner", async () => {
      const c = await check(patAuthor(`* @jm-reviewer[bot]\n${PROTECTED}`));
      expect(c.status).toBe('fail');
      expect(c.fix).toContain("an app can't be a code owner");
      expect(c.fix).toContain('remove @jm-reviewer[bot] from line 1 (*)');
      expect(c.fix).not.toContain('keep the author app');
      noSecrets(c);
      noPage(c);
    });
  });

  test('code-owner review not required passes as today', async () => {
    const c = await check(appWorld({ required: false, codeowners: `* @alice\n${PROTECTED}` }));
    expect(c).toMatchObject({
      status: 'pass',
      summary: 'the rules do not require a code owner review',
    });
  });
});

describe('forge.admin for GitHub App roles (issue #447)', () => {
  type Bypass = {
    rulesetId: number;
    name: string;
    restrictUpdatesOnly: boolean;
    can: 'yes' | 'no' | 'unknown';
  };
  type Role = 'author' | 'reviewer';
  const AUTHOR_SLUG = 'jm-author-app';
  const REVIEWER_SLUG = 'jm-reviewer-app';
  const entry = (appId: string, slug: string, pem = 'unused') =>
    ({
      source: 'vault',
      fingerprint: 'fp',
      entry: { appId, slug, clientId: 'c', pem, importedAt: 'x' },
    }) as const;
  type Read = ReturnType<typeof entry> | { source: 'missing'; undecryptable?: true };
  const CLEAN = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' };
  const main = (can: Bypass['can'] = 'no'): Bypass => ({
    rulesetId: 1,
    name: 'jumpmaster',
    restrictUpdatesOnly: false,
    can,
  });
  const merge = (can: Bypass['can']): Bypass => ({
    rulesetId: 2,
    name: 'jumpmaster-merge',
    restrictUpdatesOnly: true,
    can,
  });
  /**
   * A two-bot zone whose roles are apps (an entry), PATs (missing) or undecryptable apps. Each
   * app role gets `grant` (CLEAN by default) and `bypass` (null: no bypass field).
   */
  const appWorld = (
    o: {
      author?: Read;
      reviewer?: Read;
      grant?: Partial<Record<Role, Record<string, string>>>;
      bypass?: Partial<Record<Role, Bypass[] | null>>;
    } = {},
  ) => {
    const w = world({
      zone: { githubApp: { repositoryId: 5, installations: { author: 7, reviewer: 8 } } },
    });
    const roles = {
      author: o.author ?? entry('8', AUTHOR_SLUG),
      reviewer: o.reviewer ?? entry('9', REVIEWER_SLUG),
    };
    w.deps.resolvedApps = () => new Map([['octo', roles]]) as unknown as ResolvedApps;
    const lists = {
      author: o.bypass?.author === undefined ? [main(), merge('yes')] : o.bypass.author,
      reviewer: o.bypass?.reviewer === undefined ? [main(), merge('no')] : o.bypass.reviewer,
    };
    for (const who of ['author', 'reviewer'] as const) {
      if (roles[who].source === 'missing') continue;
      w.f.state.access[who].grantedPermissions = o.grant?.[who] ?? { ...CLEAN };
      const r = w.f.state.rules[who];
      if (r.kind !== 'ok') throw new Error('world rules');
      const list = lists[who];
      w.f.state.rules[who] = {
        kind: 'ok',
        rules: { ...r.rules, asApp: true, ...(list === null ? {} : { bypass: list }) },
      };
    }
    return w;
  };
  const admin = async (w: ReturnType<typeof appWorld>) => one(await w.run(), 'forge.admin');
  const PERMISSIONS_PAGE = 'Settings → Developer settings → GitHub Apps';

  describe('a two-app zone', () => {
    test('an author grant with administration: write fails, naming it and the author slug', async () => {
      const c = await admin(appWorld({ grant: { author: { ...CLEAN, administration: 'write' } } }));
      expect(c.status).toBe('fail');
      expect(c.summary).toContain('administration');
      expect(c.summary).toContain(AUTHOR_SLUG);
      expect(c.fix).toContain(PERMISSIONS_PAGE);
      expect(c.fix).toContain('Permissions & events');
      expect(c.fix).toContain('installation');
    });

    test('a reviewer grant with workflows: read fails, naming it and the reviewer slug', async () => {
      const c = await admin(appWorld({ grant: { reviewer: { ...CLEAN, workflows: 'read' } } }));
      expect(c.status).toBe('fail');
      expect(c.summary).toContain('workflows');
      expect(c.summary).toContain(REVIEWER_SLUG);
      expect(c.summary).not.toContain(AUTHOR_SLUG);
    });

    test('clean grants, and only the author bypassing jumpmaster-merge, pass with the two-app summary', async () => {
      const c = await admin(appWorld());
      expect(c).toMatchObject({
        id: 'forge.admin',
        status: 'pass',
        summary: `neither installation (${AUTHOR_SLUG}, ${REVIEWER_SLUG}) has administration or workflows, and no app bypasses any ruleset except the author app on jumpmaster-merge, which forge.branch-rules checks`,
      });
      expect(c.summary).not.toMatch(/can bypass/);
    });

    test("the author app's unknown on jumpmaster-merge passes: forge.branch-rules reports it", async () => {
      const c = await admin(appWorld({ bypass: { author: [main(), merge('unknown')] } }));
      expect(c.status).toBe('pass');
    });
  });

  describe('bypass', () => {
    test('the reviewer app bypassing jumpmaster-merge fails, naming the ruleset and the reviewer slug', async () => {
      const c = await admin(appWorld({ bypass: { reviewer: [main(), merge('yes')] } }));
      expect(c.status).toBe('fail');
      expect(c.summary).toContain('jumpmaster-merge');
      expect(c.summary).toContain(REVIEWER_SLUG);
      expect(c.fix).toContain(`Remove ${REVIEWER_SLUG} from the bypass list of jumpmaster-merge`);
    });

    test('the author app bypassing jumpmaster fails, naming the ruleset and the author slug', async () => {
      const c = await admin(appWorld({ bypass: { author: [main('yes'), merge('yes')] } }));
      expect(c.status).toBe('fail');
      expect(c.summary).toContain('ruleset jumpmaster ');
      expect(c.summary).toContain(AUTHOR_SLUG);
      expect(c.fix).toContain(`Remove ${AUTHOR_SLUG} from the bypass list of jumpmaster`);
    });

    test('an unknown on another ruleset warns, naming the ruleset and the Bypass list path', async () => {
      const c = await admin(appWorld({ bypass: { reviewer: [main('unknown'), merge('no')] } }));
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('jumpmaster');
      expect(c.summary).toContain(REVIEWER_SLUG);
      expect(c.fix).toContain('Settings → Rules → Rulesets → jumpmaster → Bypass list');
    });

    test('an ok read with no bypass field warns that the bypass check did not run', async () => {
      const c = await admin(appWorld({ bypass: { author: null } }));
      expect(c.status).toBe('warn');
      expect(c.summary).toContain('the bypass check did not run');
      expect(c.summary).toContain(AUTHOR_SLUG);
    });

    test.each([{ kind: 'unavailable' } as const, { kind: 'none' } as const])(
      'a rules read of kind $kind warns that the bypass check did not run',
      async (read) => {
        const w = appWorld();
        w.f.state.rules.reviewer = read;
        const c = await admin(w);
        expect(c.status).toBe('warn');
        expect(c.summary).toContain('the bypass check did not run');
        expect(c.summary).toContain(REVIEWER_SLUG);
      },
    );
  });

  test('a forbidden grant with an unknown bypass fails, and the summary names both', async () => {
    const c = await admin(
      appWorld({
        grant: { author: { ...CLEAN, workflows: 'write' } },
        bypass: { reviewer: [main('unknown'), merge('no')] },
      }),
    );
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('workflows');
    expect(c.summary).toMatch(/could not tell whether[^;]*jm-reviewer-app/);
    expect(c.fix).toContain(PERMISSIONS_PAGE);
    expect(c.fix).toContain('Bypass list');
  });

  test('a grant read that rejects warns, claiming nothing about the permissions', async () => {
    const w = appWorld();
    w.f.author.failNext('repoAccess', 'throw');
    const c = await admin(w);
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('the permission check did not run');
    expect(c.summary).toContain(AUTHOR_SLUG);
    expect(c.summary).not.toMatch(/administration|workflows/);
  });

  test('an app access read without a raw grant warns the same way', async () => {
    const w = appWorld();
    delete w.f.state.access.reviewer.grantedPermissions;
    const c = await admin(w);
    expect(c.status).toBe('warn');
    expect(c.summary).toContain('the permission check did not run');
    expect(c.summary).toContain(REVIEWER_SLUG);
  });

  describe('a hybrid zone (app author, PAT reviewer)', () => {
    test('a clean author grant passes with the hybrid summary', async () => {
      const c = await admin(appWorld({ reviewer: { source: 'missing' } }));
      expect(c).toMatchObject({
        status: 'pass',
        summary: `the author installation (${AUTHOR_SLUG}) has neither administration nor workflows, and bypasses no ruleset other than jumpmaster-merge, which forge.branch-rules checks`,
      });
    });

    test('a reviewer account that is an admin still fails forge.reviewer as today', async () => {
      const pat = world();
      pat.f.state.access.reviewer.permissions.admin = true;
      const hybrid = appWorld({ reviewer: { source: 'missing' } });
      hybrid.f.state.access.reviewer.permissions.admin = true;
      const today = one(await pat.run(), 'forge.reviewer');
      expect(today.status).toBe('fail');
      expect(one(await hybrid.run(), 'forge.reviewer')).toEqual(today);
    });
  });

  describe('a PAT author with an app reviewer', () => {
    test("a clean reviewer grant passes with today's author text and the reviewer's", async () => {
      const c = await admin(appWorld({ author: { source: 'missing' } }));
      expect(c).toMatchObject({
        status: 'pass',
        summary: `neither bot account is a repository admin; the reviewer installation (${REVIEWER_SLUG}) has neither administration nor workflows, and bypasses no ruleset`,
      });
    });

    test('a reviewer grant with administration: read fails naming the reviewer slug', async () => {
      const c = await admin(
        appWorld({
          author: { source: 'missing' },
          grant: { reviewer: { ...CLEAN, administration: 'read' } },
        }),
      );
      expect(c.status).toBe('fail');
      expect(c.summary).toContain('administration');
      expect(c.summary).toContain(REVIEWER_SLUG);
    });

    test("a PAT author's finding combines with the reviewer app's", async () => {
      const w = appWorld({
        author: { source: 'missing' },
        bypass: { reviewer: [main('unknown'), merge('no')] },
      });
      w.f.state.access.author.permissions.admin = true;
      const c = await admin(w);
      expect(c.status).toBe('fail');
      expect(c.summary).toContain('(the author) is a repository admin');
      expect(c.summary).toContain(REVIEWER_SLUG);
      expect(c.fix).toContain('Give author-bot the Write role');
      expect(c.fix).toContain('Bypass list');
    });
  });

  test('an undecryptable app entry runs no PAT logic and claims nothing about its permissions', async () => {
    const w = appWorld({ author: { source: 'missing', undecryptable: true } });
    // The PAT logic would fail on this; the app logic would warn on the missing grant.
    w.f.state.access.author.permissions.admin = true;
    const c = await admin(w);
    expect(c.status).toBe('pass');
    expect(c.summary).not.toContain('author');
    expect(c.summary).toContain(REVIEWER_SLUG);
    const both = appWorld({
      author: { source: 'missing', undecryptable: true },
      reviewer: { source: 'missing', undecryptable: true },
    });
    both.f.state.access.author.permissions.admin = true;
    const none = await admin(both);
    expect(none.status).toBe('skip');
    expect(none.summary).not.toMatch(/administration|workflows|is a repository admin/);
  });

  test('no summary, fix or log line holds the PEM, a token or the app id', async () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAsentinelPEMbodyNOTAREALKEY0123456789',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const token = ['ghs', 'SECRETSENTINELTOKEN0123456789'].join('_');
    const appId = '987654321';
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(' '));
      }),
    );
    try {
      const texts: string[] = [];
      for (const grant of [CLEAN, { ...CLEAN, administration: 'write', workflows: 'write' }]) {
        const w = appWorld({
          author: entry(appId, AUTHOR_SLUG, pem),
          grant: { author: grant },
          bypass: { author: [main('yes'), merge('unknown')], reviewer: [main('unknown')] },
        });
        w.f.state.access.author.tokenExpiresAt = token;
        texts.push(JSON.stringify(await admin(w)));
      }
      const thrown = appWorld({ author: entry(appId, AUTHOR_SLUG, pem) });
      thrown.f.author.failNext('repoAccess', 'throw');
      texts.push(JSON.stringify(await admin(thrown)));
      for (const t of [...texts, ...logged]) {
        expect(t).not.toContain('sentinelPEMbody');
        expect(t).not.toContain('PRIVATE KEY');
        expect(t).not.toContain(token);
        expect(t).not.toContain(appId);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('forge.author-reads and forge.reviewer-reads for GitHub App roles (issue #456)', () => {
  const AUTHOR_SLUG = 'jm-author-app';
  const REVIEWER_SLUG = 'jm-reviewer-app';
  const MINTED = 'ghs_' + 'MINTEDMINTEDMINTEDMINTED0123456789';
  const pemBody = APP_ENTRY.pem
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('-----'))
    .join('');
  const entry = (appId: string, slug: string) =>
    ({
      source: 'vault',
      fingerprint: 'fp',
      entry: { ...APP_ENTRY, appId, slug, importedAt: 'x' },
    }) as const;
  // forge.author tests the app key against GET /app; nothing here may reach github.com.
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterAll(() => {
    nock.enableNetConnect();
  });
  const appWorld = (o: { reviewer?: 'app' | 'pat' } = {}) => {
    const w = world({
      zone: { githubApp: { repositoryId: 5, installations: { author: 7, reviewer: 8 } } },
    });
    w.deps.appApiBase = 'https://ghe.reads.test.invalid/api/v3';
    const roles = {
      author: entry('8', AUTHOR_SLUG),
      reviewer: o.reviewer === 'pat' ? { source: 'missing' } : entry('9', REVIEWER_SLUG),
    };
    w.deps.resolvedApps = () => new Map([['octo', roles]]) as unknown as ResolvedApps;
    return w;
  };
  const leaks = (c: DoctorCheck) => {
    const json = JSON.stringify(c);
    expect(json).not.toContain(pemBody);
    expect(json).not.toContain(pemBody.slice(0, 40));
    expect(json).not.toContain(MINTED);
    expect(json).not.toContain(AUTHOR_TOKEN);
  };

  test('check runs refused with Actions allowed fails naming check runs, never Actions', async () => {
    const w = appWorld();
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Checks: read' ? { ...p, status: 403, accepted: 'checks=read' } : p,
    );
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('check runs');
    expect(c.summary).toContain("can't read CI results");
    expect(c.fix).toContain('Checks: Read-only');
    expect(JSON.stringify(c)).not.toContain('Actions');
    leaks(c);
  });

  test('a refused Actions probe never changes an app role result, nor is named', async () => {
    const w = appWorld();
    w.f.state.access.author.private = true;
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Actions: read' ? { ...p, status: 403 } : p,
    );
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('pass');
    expect(JSON.stringify(c)).not.toContain('Actions');
    const both = appWorld();
    both.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Actions: read' || p.permission === 'Checks: read'
        ? { ...p, status: 404 }
        : p,
    );
    const f = one(await both.run(), 'forge.author-reads');
    expect(f.status).toBe('fail');
    expect(JSON.stringify(f)).not.toContain('Actions');
  });

  test('every probe allowed passes naming the app slug; private and public', async () => {
    const w = appWorld();
    w.f.state.access.author.private = true;
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain(`the author GitHub App ${AUTHOR_SLUG}`);
    expect(c.summary).toContain('Checks: read');
    expect(c.summary).not.toContain('token');
    leaks(c);
    const pub = one(await appWorld().run(), 'forge.author-reads');
    expect(pub.status).toBe('pass');
    expect(pub.summary).toContain(`the author GitHub App ${AUTHOR_SLUG}`);
    expect(pub.summary).toContain('is public');
    leaks(pub);
    const rev = one(await appWorld().run(), 'forge.reviewer-reads');
    expect(rev.status).toBe('pass');
    expect(rev.summary).toContain(`the reviewer GitHub App ${REVIEWER_SLUG}`);
  });

  test('Issues refused fails with a fix on the app permissions page and the installation', async () => {
    const w = appWorld();
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Issues: read' ? { ...p, status: 403 } : p,
    );
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('Issues: read');
    expect(c.fix).toContain(
      `Settings → Developer settings → GitHub Apps → ${AUTHOR_SLUG} → Permissions & events`,
    );
    expect(c.fix).toContain('Issues: Read-only');
    expect(c.fix).toContain('accept the new permissions on the installation');
    expect(c.fix).not.toContain('Fine-grained');
    expect(c.fix).not.toContain('_FILE');
    expect(c.fix).not.toMatch(/token/i);
    leaks(c);
  });

  test('a 401 probe on the reviewer app fails, never telling the operator to create a token', async () => {
    const w = appWorld();
    w.f.state.probes.reviewer = okProbes().map((p) =>
      p.permission === 'Contents: read' ? { ...p, status: 401 } : p,
    );
    const c = one(await w.run(), 'forge.reviewer-reads');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain(`the reviewer GitHub App ${REVIEWER_SLUG}`);
    expect(c.summary).toContain('minted token');
    expect(c.fix).toContain('forge.reviewer');
    expect(c.fix).toContain('run the doctor again');
    expect(c.fix).not.toMatch(/create a (new )?token/i);
    expect(c.fix).not.toContain('_FILE');
    leaks(c);
  });

  // What GitHub answers a server-reviewer token ({ pull_requests: 'write' }, spec §4.2): no
  // contents read on a private repository, so every probe but Pull requests: read is refused.
  const narrowedReviewer = () =>
    okProbes().map((p) =>
      p.permission === 'Pull requests: read' ? p : { ...p, status: 403, accepted: 'contents=read' },
    );
  const withGrant = (w: ReturnType<typeof appWorld>, reviewer: Record<string, string>) => {
    const calls: string[] = [];
    w.deps.installationGrant = (zoneId, role) => {
      calls.push(`${zoneId}:${role}`);
      return Promise.resolve({
        permissions: role === 'reviewer' ? reviewer : { ...APP_MANIFEST_PERMISSIONS.author },
      });
    };
    return calls;
  };

  test('a reviewer app whose server token is narrowed to pull_requests passes on a private repository (issue #522)', async () => {
    const w = appWorld();
    w.f.state.access.reviewer.private = true;
    w.f.state.probes.reviewer = narrowedReviewer();
    const c = one(await w.run(), 'forge.reviewer-reads');
    expect(c.status).toBe('pass');
    expect(c.fix ?? '').not.toContain('Contents: Read-only');
    // Only the proven read is listed; Contents is named only as not proven.
    expect(c.summary).toContain('reads it relies on: Pull requests: read;');
    expect(c.summary).not.toMatch(/relies on: [^;]*Contents/);
    expect(c.summary).toContain('Contents: read, which drops use, is not proven here');
    expect(c.summary).not.toContain('every read');
    leaks(c);
  });

  test('an app reviewer with Pull requests: read refused fails with the app fix text (issue #522)', async () => {
    const w = appWorld();
    w.f.state.access.reviewer.private = true;
    w.f.state.probes.reviewer = narrowedReviewer().map((p) =>
      p.permission === 'Pull requests: read'
        ? { ...p, status: 403, accepted: 'pull_requests=read' }
        : p,
    );
    const c = one(await w.run(), 'forge.reviewer-reads');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('Pull requests: read');
    expect(c.summary).not.toContain('Contents');
    expect(c.fix).toContain('Pull requests: Read-only');
    expect(c.fix).not.toContain('Contents');
    expect(c.fix).toContain(
      `Settings → Developer settings → GitHub Apps → ${REVIEWER_SLUG} → Permissions & events`,
    );
    expect(c.fix).toContain('accept the new permissions on the installation');
    expect(c.fix).not.toMatch(/token/i);
    leaks(c);
  });

  test('an app reviewer grant without contents fails naming Contents with the app fix (issue #522)', async () => {
    const w = appWorld();
    w.f.state.access.reviewer.private = true;
    w.f.state.probes.reviewer = narrowedReviewer();
    const { contents: _omit, ...lacking } = APP_MANIFEST_PERMISSIONS.reviewer;
    const calls = withGrant(w, lacking);
    const checks = await w.run();
    const c = one(checks, 'forge.reviewer-reads');
    expect(c.status).toBe('fail');
    expect(c.summary).toContain('Contents: read');
    expect(c.summary).toContain('installation grant');
    expect(c.fix).toContain('Contents: Read-only');
    expect(c.fix).toContain(
      `Settings → Developer settings → GitHub Apps → ${REVIEWER_SLUG} → Permissions & events`,
    );
    expect(c.fix).toContain('accept the new permissions on the installation');
    expect(c.fix).not.toMatch(/token/i);
    leaks(c);
    // forge.reviewer and forge.reviewer-reads share one grant read.
    expect(calls.filter((x) => x === 'main:reviewer')).toHaveLength(1);
  });

  test('an app reviewer grant with contents: read passes, listing both proven reads (issue #522)', async () => {
    const w = appWorld();
    w.f.state.access.reviewer.private = true;
    w.f.state.probes.reviewer = narrowedReviewer();
    withGrant(w, { ...APP_MANIFEST_PERMISSIONS.reviewer, contents: 'read' });
    const c = one(await w.run(), 'forge.reviewer-reads');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('Pull requests: read');
    expect(c.summary).toContain('Contents: read');
    expect(c.summary).toContain('installation grant');
    leaks(c);
  });

  test("a hybrid zone's PAT reviewer keeps the token texts", async () => {
    const w = appWorld({ reviewer: 'pat' });
    w.f.state.probes.reviewer = okProbes().map((p) =>
      p.permission === 'Contents: read' ? { ...p, status: 401 } : p,
    );
    const c = one(await w.run(), 'forge.reviewer-reads');
    expect(c.fix).toContain('Create a new token');
  });

  test('a PAT zone with check runs refused and Actions allowed still passes with the Actions note', async () => {
    const w = world();
    w.f.state.probes.author = okProbes().map((p) =>
      p.permission === 'Checks: read' ? { ...p, status: 403 } : p,
    );
    const c = one(await w.run(), 'forge.author-reads');
    expect(c.status).toBe('pass');
    expect(c.summary).toContain('CI is read through Actions jobs');
    expect(c.summary).toContain('the author token');
  });
});

describe('forge.author and forge.reviewer on a GitLab zone (issue #778)', () => {
  const GL = 'https://gitlab.example.com';
  const PATH = 'acme/demo';
  // Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
  const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
  const A_TOKEN = glpat('A');
  const R_TOKEN = glpat('R');
  type UserOpts = Omit<Parameters<FakeGitLab['addUser']>[0], 'username' | 'token'>;
  let fakes: FakeGitLab[] = [];
  const seen: DoctorCheck[] = [];

  beforeAll(() => nock.disableNetConnect());
  afterEach(() => {
    try {
      // No token in any summary or fix, of any GitLab identity check this block produced.
      for (const c of seen) {
        const text = `${c.summary}\n${c.fix ?? ''}\n${JSON.stringify(c)}`;
        for (const t of [A_TOKEN, R_TOKEN]) expect(text).not.toContain(t);
        if (c.status === 'skip') continue;
        expect(text).not.toMatch(/collaborator/i);
        expect(text).not.toContain('Metadata: read');
        expect(text).not.toMatch(/JM_\w*TOKEN/);
        expect(text).not.toContain('GitHub');
      }
    } finally {
      seen.length = 0;
      for (const gl of fakes) gl.stop();
      fakes = [];
      nock.cleanAll();
    }
  });
  afterAll(() => nock.enableNetConnect());

  function stubbed(routes: Record<string, () => Response>): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      for (const [suffix, answer] of Object.entries(routes))
        if (path.endsWith(suffix)) return answer();
      return fetch(url, init);
    }) as typeof fetch;
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function run(
    o: {
      author?: UserOpts;
      reviewer?: UserOpts | 'same';
      starter?: boolean;
      /** The author is not a member of the private project. */
      authorNonMember?: boolean;
      /** The author's token matches no GitLab user. */
      authorUnknown?: boolean;
      /** Answers the author forge's requests whose path ends with a key; the rest go to the fake. */
      authorStub?: Record<string, () => Response>;
    } = {},
  ) {
    const w = world({
      zone: {
        repo: PATH,
        forge: 'gitlab',
        gitlab: { baseUrl: GL },
        ...(o.starter ? { identity: 'starter' as const } : {}),
      },
    });
    const gl = fakeGitLab({ baseUrl: GL, project: { id: 7, path: PATH, visibility: 'private' } });
    fakes.push(gl);
    if (!o.authorUnknown)
      gl.addUser({
        username: 'jm-author',
        token: A_TOKEN,
        scopes: ['api'],
        ...(o.authorNonMember ? {} : { accessLevel: ACCESS.developer }),
        ...o.author,
      });
    if (o.reviewer !== 'same')
      gl.addUser({
        username: 'jm-reviewer',
        token: R_TOKEN,
        accessLevel: ACCESS.developer,
        scopes: ['api'],
        ...o.reviewer,
      });
    const reviewerToken = o.reviewer === 'same' ? A_TOKEN : R_TOKEN;
    w.deps.forges = () => ({
      author: new GitLabForge(
        GL,
        PATH,
        A_TOKEN,
        o.authorStub ? { fetch: stubbed(o.authorStub) } : {},
      ),
      reviewer: o.starter ? null : new GitLabForge(GL, PATH, reviewerToken),
    });
    const checks = await zoneChecks(w.deps, w.zone, []);
    const author = one(checks, 'forge.author');
    const reviewer = one(checks, 'forge.reviewer');
    seen.push(author, reviewer);
    return { author, reviewer, zone: w.zone.id };
  }

  test('passes a Developer author and reviewer whose tokens have the api scope', async () => {
    const { author, reviewer } = await run();
    expect(author).toMatchObject({ status: 'pass', zoneId: 'main' });
    expect(author.summary).toContain('jm-author');
    expect(author.summary).toContain('Developer');
    expect(author.summary).toContain('api');
    expect(author.summary).toContain(PATH);
    expect(reviewer).toMatchObject({ status: 'pass' });
    expect(reviewer.summary).toContain('jm-reviewer');
  });

  test('passes a Maintainer author with the api scope', async () => {
    const { author } = await run({
      author: { accessLevel: ACCESS.maintainer, scopes: ['api', 'read_user'] },
    });
    expect(author.status).toBe('pass');
    expect(author.summary).toContain('Maintainer');
    expect(author.summary).toContain('api, read_user');
  });

  test('fails a token GitLab rejects (401 on GET /user), naming its vault entry', async () => {
    const { author, zone } = await run({ authorUnknown: true });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain('GitLab rejected the author token (401)');
    expect(author.fix).toContain(`gitlab-pat/${zone}/author`);
    expect(author.fix).toContain('ctl secrets set');
  });

  test('fails when the project cannot be read (a non-member of a private project)', async () => {
    const { author } = await run({ authorNonMember: true });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain(`project ${PATH}`);
    expect(author.summary).toContain('GitLab');
    expect(author.fix).toContain('Developer');
    expect(author.fix).toContain('jm-author');
    expect(author.fix).toContain('project path');
  });

  test('fails a token that can read /user but not the project (no api or read_api) as a token problem', async () => {
    for (const scopes of [
      ['read_user', 'write_repository'],
      ['read_user', 'sudo'],
    ]) {
      const { author, zone } = await run({ author: { scopes } });
      expect(author.status).toBe('fail');
      expect(author.summary).toContain('HTTP 403');
      expect(author.summary).toContain('api scope');
      expect(author.summary).not.toContain('member');
      expect(author.fix).toContain(`gitlab-pat/${zone}/author`);
      expect(author.fix).toContain('neither sudo nor admin_mode');
      expect(author.fix).not.toContain('member');
    }
  });

  test('fails a token that cannot read its own user (403 on GET /user) for lack of the api scope', async () => {
    const { author, zone } = await run({ author: { scopes: ['write_repository'] } });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain('(HTTP 403): it lacks the api scope');
    expect(author.fix).toContain(`gitlab-pat/${zone}/author`);
  });

  test('fails a token GitLab rejects (401) on the project read, naming its vault entry', async () => {
    const { author, zone } = await run({
      authorStub: {
        [`/projects/${encodeURIComponent(PATH)}`]: () => json(401, { message: '401 Unauthorized' }),
      },
    });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain('GitLab rejected the author token (401)');
    expect(author.summary).toContain(`project ${PATH}`);
    expect(author.fix).toContain(`gitlab-pat/${zone}/author`);
  });

  test('warns, and does not judge the token, when GitLab gives no usable answer', async () => {
    const http500 = await run({
      authorStub: { '/user': () => json(500, { message: '500 Internal Server Error' }) },
    });
    expect(http500.author.status).toBe('warn');
    expect(http500.author.summary).toContain('HTTP 500');
    expect(http500.author.summary).toContain('the check did not run');
    expect(http500.author.fix).toContain(GL);
    const down = await run({
      authorStub: {
        '/user': () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    expect(down.author.status).toBe('warn');
    expect(down.author.summary).toContain('no HTTP answer');
  });

  test('fails an empty scope list as lacking api, naming it none', async () => {
    const { author } = await run({
      authorStub: {
        '/personal_access_tokens/self': () => json(200, { scopes: [], expires_at: null }),
      },
    });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain('(it has: none)');
  });

  test('fails a Reporter author, below Developer', async () => {
    const { author } = await run({ author: { accessLevel: ACCESS.reporter } });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain('Reporter');
    expect(author.fix).toContain('Developer');
  });

  test('fails an Owner author: no GitLab token above Maintainer', async () => {
    const { author } = await run({ author: { accessLevel: ACCESS.owner } });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain('Owner');
    expect(author.fix).toContain('Developer or Maintainer');
  });

  for (const scope of ['sudo', 'admin_mode'])
    test(`fails a token with the ${scope} scope`, async () => {
      const { author, zone } = await run({ author: { scopes: ['api', scope] } });
      expect(author.status).toBe('fail');
      expect(author.summary).toContain(scope);
      expect(author.fix).toContain(`gitlab-pat/${zone}/author`);
    });

  test('fails read_api plus write_repository without api', async () => {
    const { author, zone } = await run({ author: { scopes: ['read_api', 'write_repository'] } });
    expect(author.status).toBe('fail');
    expect(author.summary).toContain('api scope');
    expect(author.summary).toContain('read_api, write_repository');
    expect(author.fix).toContain('api scope');
    expect(author.fix).toContain('neither sudo nor admin_mode');
    expect(author.fix).toContain(`gitlab-pat/${zone}/author`);
  });

  for (const status of [401, 404] as const)
    test(`warns when the scopes can't be read (${status} on the token's own read)`, async () => {
      const { author, reviewer } = await run({
        author: { tokenSelfStatus: status },
        reviewer: { tokenSelfStatus: status },
      });
      for (const c of [author, reviewer]) {
        expect(c.status).toBe('warn');
        expect(c.summary).toContain('the scope check did not run');
      }
    });

  test('warns when the token expires within the window, and passes when it does not', async () => {
    const soon = new Date(NOW.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    const { author, reviewer, zone } = await run({
      author: { expiresAt: soon },
      reviewer: { expiresAt: '2027-09-01' },
    });
    expect(author.status).toBe('warn');
    expect(author.summary).toContain(`the token expires ${soon}`);
    expect(author.fix).toContain(`gitlab-pat/${zone}/author`);
    expect(reviewer.status).toBe('pass');
    expect(reviewer.summary).toContain('the token expires 2027-09-01');
  });

  test('fails a Maintainer or Owner reviewer', async () => {
    for (const level of [ACCESS.maintainer, ACCESS.owner]) {
      const { reviewer } = await run({ reviewer: { accessLevel: level } });
      expect(reviewer.status).toBe('fail');
      expect(reviewer.summary).toContain('approval rules');
      expect(reviewer.fix).toContain('Developer');
    }
  });

  test('fails a reviewer who is the same user as the author', async () => {
    const { reviewer } = await run({ reviewer: 'same' });
    expect(reviewer.status).toBe('fail');
    expect(reviewer.summary).toContain('same GitLab user as the author (jm-author)');
  });

  test('starter mode skips the reviewer check', async () => {
    const { author, reviewer } = await run({ starter: true });
    expect(author.status).toBe('pass');
    expect(reviewer.status).toBe('skip');
  });
});
