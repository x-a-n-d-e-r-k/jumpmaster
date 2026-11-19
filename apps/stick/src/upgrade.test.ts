// The stick's side of upgrading itself (issue #430): it verifies the offered release itself (the
// real decideUpgrade, fetchFromServer and verify path, on signed layouts with synthetic release
// certificates and a fake cosign), drains, starts the helper and reports.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Readable } from 'node:stream';
import type { DropPayload, UpgradeOffer } from '@jumpmaster/protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StickClient } from './client.js';
import type { HelperMount, UpgradeDriver, UpgradeHelperSpec } from './driver.js';
import type { ServerImageDeps } from './fetch-image.js';
import { runLeaseLoop } from './lease-loop.js';
import { SlotTarget } from './slots.js';
import { type Entry, PLATFORM, tar } from './test/layout.js';
import { PINNED_ROOT, platformImage, rc2Layout } from './test/rc2.js';
import {
  cleanupAtStartup,
  decideUpgrade,
  HELPER_ENTRY,
  StickUpgrade,
  upgradeFiles,
} from './upgrade.js';
import {
  type Cosign,
  canonicalRef,
  type ImageTrust,
  identityRegexp,
  releaseSigner,
  VerifyCache,
} from './verify.js';

afterEach(() => vi.unstubAllGlobals());

const REPO = 'x-a-n-d-e-r-k/jumpmaster';
const OWN = '0.5.1';
const fresh = (p = 'jm-upgrade-') => mkdtempSync(join(tmpdir(), p));
const cert = (tag: string) =>
  readFileSync(new URL(`./fixtures/certs/release-${tag}.crt`, import.meta.url), 'utf8');
/** A Sigstore bundle whose signing certificate names release `tag` of REPO. */
const bundleFor = (tag: string) =>
  Buffer.from(
    JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        certificate: {
          rawBytes: cert(tag)
            .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
            .replace(/\s+/g, ''),
        },
      },
    }),
  );

/** The layout directory as the server's tar. */
function tarOf(dir: string): Buffer {
  const entries: Entry[] = [
    { name: 'oci-layout', body: readFileSync(join(dir, 'oci-layout')) },
    { name: 'index.json', body: readFileSync(join(dir, 'index.json')) },
    { name: 'manifest.json', body: readFileSync(join(dir, 'manifest.json')) },
    { name: 'blobs/', type: '5' },
    { name: 'blobs/sha256/', type: '5' },
  ];
  const blobs = join(dir, 'blobs', 'sha256');
  for (const f of readdirSync(blobs))
    entries.push({ name: relative(dir, join(blobs, f)), body: readFileSync(join(blobs, f)) });
  return tar(entries);
}

/** Name to content of a tar the stick built. */
function untar(b: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, ''), 8);
    off += 512;
    out.set(name, b.subarray(off, off + size));
    off += size + ((512 - (size % 512)) % 512);
  }
  return out;
}

/**
 * A cosign that answers as the real one would for these layouts: Verified OK when it is asked
 * for the identity of `signer` (default REPO's release workflow); `fail` makes it exit 1.
 */
function fakeCosign(o: { signer?: string; fail?: boolean } = {}) {
  const calls: string[][] = [];
  const cosign: Cosign = async (args) => {
    calls.push(args);
    if (o.fail) return { code: 1, stdout: '', stderr: 'Error: no matching signatures\n' };
    const at = args.indexOf('--certificate-identity-regexp');
    if (args[at + 1] !== identityRegexp(o.signer ?? REPO))
      return {
        code: 1,
        stdout: '',
        stderr:
          'Error: failed to verify certificate identity: no matching CertificateIdentity found\n',
      };
    return { code: 0, stdout: '', stderr: 'Verified OK\n' };
  };
  return { cosign, calls };
}

type Engine = {
  driver: UpgradeDriver & ServerImageDeps['loader'];
  helpers: UpgradeHelperSpec[];
  /** pending.json as it was when each helper started. */
  pendingAtStart: (string | undefined)[];
  /** Ends the latest helper with this exit code. */
  exit: (code: number) => void;
  containers: Set<string>;
};

/** The engine: loads what the stick built, names it, reads its labels; runs the helper. */
function fakeEngine(stateDir: string): Engine {
  const refs = new Map<string, string>();
  const labels = new Map<string, Record<string, string>>();
  const helpers: UpgradeHelperSpec[] = [];
  const pendingAtStart: (string | undefined)[] = [];
  const containers = new Set<string>(['jm-stick']);
  let exit: (code: number) => void = () => {};
  const mounts: HelperMount[] = [
    { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' },
    { type: 'volume', source: 'jm-stick', target: stateDir },
    { type: 'bind', source: '/srv/other', target: '/other' },
  ];
  const driver: Engine['driver'] = {
    async imageExists(ref) {
      return refs.has(canonicalRef(ref));
    },
    async loadImage(t: Readable) {
      const chunks: Buffer[] = [];
      for await (const c of t) chunks.push(c as Buffer);
      const files = untar(Buffer.concat(chunks));
      const [m] = JSON.parse((files.get('manifest.json') as Buffer).toString()) as {
        Config: string;
      }[];
      const configPath = (m as { Config: string }).Config;
      const config = JSON.parse((files.get(configPath) as Buffer).toString()) as {
        config?: { Labels?: Record<string, string> };
      };
      const id = `sha256:${configPath.slice('blobs/sha256/'.length)}`;
      labels.set(id, config.config?.Labels ?? {});
      return [id];
    },
    async removeImage() {},
    async tagImage(id, ref) {
      refs.set(canonicalRef(ref), id);
    },
    async imageId(ref) {
      return refs.get(ref);
    },
    async imageLabels(id) {
      const l = labels.get(id);
      if (!l) throw new Error(`no such image ${id}`);
      return l;
    },
    async ownContainer() {
      return { name: 'jm-stick', mounts };
    },
    async containerExists(name) {
      return containers.has(name);
    },
    async startUpgradeHelper(spec) {
      helpers.push(spec);
      pendingAtStart.push(
        existsSync(upgradeFiles(stateDir).pending)
          ? readFileSync(upgradeFiles(stateDir).pending, 'utf8')
          : undefined,
      );
      const done = new Promise<number>((r) => {
        exit = r;
      });
      return { wait: async () => ({ exitCode: await done }) };
    },
  };
  return {
    driver,
    helpers,
    pendingAtStart,
    exit: (code) => exit(code),
    containers,
  };
}

type World = {
  offer: UpgradeOffer;
  trust: ImageTrust;
  server: ServerImageDeps;
  engine: Engine;
  stateDir: string;
  fetches: string[];
  cosign: ReturnType<typeof fakeCosign>;
  configDigest: string;
};

/**
 * A server mirroring a stick image signed with bundles for `tags` (in order), titled `title`,
 * offered as `version`; a 0.5.1 stick under signed that fetches from it.
 */
function world(
  o: {
    tags?: string[];
    title?: string;
    version?: string;
    repository?: string;
    cosign?: { signer?: string; fail?: boolean };
    fetchThrows?: boolean;
  } = {},
): World {
  const image = platformImage({ 'org.opencontainers.image.title': o.title ?? 'jumpmaster-stick' });
  const l = rc2Layout({ image, bundles: (o.tags ?? ['v0.6.0']).map(bundleFor) });
  const body = tarOf(l.dir);
  const stateDir = fresh('jm-state-');
  const engine = fakeEngine(stateDir);
  const fetches: string[] = [];
  const cosign = fakeCosign(o.cosign);
  const signer = releaseSigner(REPO, OWN);
  const trust: ImageTrust = {
    policy: 'signed',
    allowed: new Set(),
    signer,
    cosign: cosign.cosign,
    cache: new VerifyCache(join(fresh(), 'verified.json'), signer),
    trustedRoot: PINNED_ROOT,
  };
  const server: ServerImageDeps = {
    client: {
      async imageLayout(ref) {
        fetches.push(ref);
        if (o.fetchThrows) throw new Error('connection reset');
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.length) },
        });
      },
      async reportImageFetch() {},
    },
    loader: engine.driver,
    stateDir,
    platform: PLATFORM,
    log: () => {},
  };
  return {
    offer: {
      version: o.version ?? '0.6.0',
      image: `ghcr.io/x-a-n-d-e-r-k/${o.repository ?? 'jumpmaster-stick'}@${l.digest}`,
    },
    trust,
    server,
    engine,
    stateDir,
    fetches,
    cosign,
    configDigest: image.amd64.configDigest,
  };
}

const decide = (w: World, offer = w.offer) =>
  decideUpgrade(offer, { version: OWN }, w.trust, {
    server: w.server,
    images: w.engine.driver,
  });

function upgrader(w: World, o: { version?: string; pending?: () => number } = {}) {
  const logs: string[] = [];
  const up = new StickUpgrade({
    stateDir: w.stateDir,
    version: o.version ?? OWN,
    trust: w.trust,
    server: w.server,
    driver: w.engine.driver,
    enabled: () => true,
    pendingPushes: o.pending ?? (() => 0),
    log: (l) => logs.push(l),
  });
  return { up, logs, events: () => logs.map((l) => (JSON.parse(l) as { event: string }).event) };
}

describe('deciding an offer (issue #430)', () => {
  test('accept: a layout signed for v0.6.0, titled jumpmaster-stick, offered to a 0.5.1 stick', async () => {
    const w = world();
    expect(await decide(w)).toEqual({ ok: true, imageId: w.configDigest });
    expect(w.fetches).toEqual([w.offer.image]);
    expect(w.cosign.calls).toHaveLength(1);
  });

  test.each(['0.5.0', '0.5.1', '0.5.1-rc.3'])(
    'D1: a downgrade or the same version (%s) is refused before any fetch',
    async (version) => {
      const w = world({ version });
      expect(await decide(w)).toEqual({ ok: false, reason: `not newer than v${OWN}` });
      expect(w.fetches).toEqual([]);
      expect(w.cosign.calls).toEqual([]);
    },
  );

  test('a reference to another repository is refused before any fetch', async () => {
    const w = world({ repository: 'jumpmaster-trooper' });
    expect(await decide(w)).toEqual({ ok: false, reason: 'not a stick image reference' });
    expect(w.fetches).toEqual([]);
  });

  test('exact tag: the only bundle is for v0.6.1, offered as 0.6.0 (above the floor), is refused', async () => {
    const w = world({ tags: ['v0.6.1'] });
    const d = await decide(w);
    expect(d.ok).toBe(false);
    expect(d.ok || d.reason).toMatch(
      /^signature check failed: .*no signature for release v0\.6\.0$/,
    );
    expect(w.cosign.calls).toHaveLength(1);
  });

  test('exact tag: every bundle is tried; v0.5.1 first and v0.6.0 second is accepted', async () => {
    const w = world({ tags: ['v0.5.1', 'v0.6.0'] });
    expect(await decide(w)).toEqual({ ok: true, imageId: w.configDigest });
    expect(w.cosign.calls).toHaveLength(2);
  });

  test('cache bypass: a digest verified before, whose bundle says another tag, is refused', async () => {
    const w = world({ tags: ['v0.6.1'] });
    const digest = w.offer.image.slice(w.offer.image.indexOf('@') + 1);
    w.trust.cache?.add(digest);
    // Already on the engine too.
    expect(await decide({ ...w, offer: { ...w.offer, version: '0.6.1' } })).toMatchObject({
      ok: true,
    });
    const d = await decide(w);
    expect(d).toMatchObject({ ok: false });
    expect(d.ok || d.reason).toMatch(/no signature for release v0\.6\.0/);
    expect(w.fetches).toHaveLength(2);
  });

  test('a pin is no shortcut either', async () => {
    const w = world({ tags: ['v0.6.1'] });
    const trust = { ...w.trust, allowed: new Set([w.offer.image]) };
    const d = await decideUpgrade(w.offer, { version: OWN }, trust, {
      server: w.server,
      images: w.engine.driver,
    });
    expect(d.ok).toBe(false);
  });

  test('wrong image: a signed layout titled jumpmaster-trooper is refused', async () => {
    const w = world({ title: 'jumpmaster-trooper' });
    expect(await decide(w)).toEqual({
      ok: false,
      reason: 'not a stick image (titled jumpmaster-trooper)',
    });
    // It was fetched and verified first.
    expect(w.cosign.calls).toHaveLength(1);
  });

  test('D1: another signer (cosign rejects the identity) is refused', async () => {
    const w = world({ cosign: { signer: 'someone-else/jumpmaster' } });
    const d = await decide(w);
    expect(d.ok).toBe(false);
    expect(d.ok || d.reason).toMatch(/^signature check failed: .*no matching CertificateIdentity/);
  });

  test('D2: cosign exiting non-zero, or the fetch throwing, refuses with a reason', async () => {
    const failing = world({ cosign: { fail: true } });
    const d1 = await decide(failing);
    expect(d1.ok || d1.reason).toMatch(/^signature check failed: .*cosign exit 1/);
    const thrown = world({ fetchThrows: true });
    const d2 = await decide(thrown);
    expect(d2.ok || d2.reason).toMatch(/image fetch failed: .*connection reset/);
  });

  test('a stick with no release version refuses', async () => {
    const w = world();
    expect(
      await decideUpgrade(w.offer, { version: '0.0.0-dev' }, w.trust, {
        server: w.server,
        images: w.engine.driver,
      }),
    ).toMatchObject({ ok: false });
    expect(w.fetches).toEqual([]);
  });
});

describe('acting on an offer (issue #430)', () => {
  test('accepted: pending.json holds 0.6.0, and the helper gets exactly its spec', async () => {
    const w = world();
    const { up, events } = upgrader(w);
    up.answered(w.offer);
    expect(up.holding()).toBe(true);
    up.idle(0);
    await vi.waitFor(() => expect(w.engine.helpers).toHaveLength(1));
    const spec = w.engine.helpers[0] as UpgradeHelperSpec;
    expect(spec).toEqual({
      name: 'jm-stick-upgrade',
      image: w.configDigest,
      entrypoint: [
        'node',
        HELPER_ENTRY,
        '--container',
        'jm-stick',
        '--image',
        w.configDigest,
        '--version',
        '0.6.0',
        '--state',
        w.stateDir,
        '--timeout',
        '900',
      ],
      mounts: [
        { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' },
        { type: 'volume', source: 'jm-stick', target: w.stateDir },
      ],
      networkMode: 'none',
      autoRemove: true,
    });
    expect(spec.mounts).toHaveLength(2);
    expect(JSON.parse(w.engine.pendingAtStart[0] as string)).toEqual({ version: '0.6.0' });
    expect(events()).toEqual(['upgrade-offer', 'upgrade-drain', 'upgrade-helper-started']);
    // Drops stay held while the helper runs; an answer without the offer changes nothing now.
    up.answered(undefined);
    expect(up.holding()).toBe(true);
  });

  test('refused: reported with its reason on the next lease, and drops resume', async () => {
    const w = world({ tags: ['v0.6.1'] });
    const { up, events } = upgrader(w);
    up.answered(w.offer);
    up.idle(0);
    await up.settled();
    expect(w.engine.helpers).toEqual([]);
    expect(up.holding()).toBe(false);
    const lease = up.beforeLease();
    expect(lease.report).toMatchObject({ version: '0.6.0', result: 'refused' });
    expect(lease.report?.reason).toMatch(/no signature for release v0\.6\.0/);
    lease.answered?.();
    expect(up.beforeLease().report).toBeUndefined();
    expect(events()).toContain('upgrade-refused');
    expect(events()).toContain('upgrade-reported');
  });

  test('D2: a failed check never starts the helper', async () => {
    for (const w of [world({ cosign: { fail: true } }), world({ fetchThrows: true })]) {
      const { up } = upgrader(w);
      up.answered(w.offer);
      up.idle(0);
      await up.settled();
      expect(w.engine.helpers).toEqual([]);
      expect(existsSync(upgradeFiles(w.stateDir).pending)).toBe(false);
      expect(up.holding()).toBe(false);
      expect(up.beforeLease().report?.result).toBe('refused');
    }
  });

  test('a refusal reason is cut to 500 characters', async () => {
    const w = world({ fetchThrows: true });
    const digest = w.offer.image.slice(w.offer.image.indexOf('@'));
    const offer = { ...w.offer, image: `ghcr.io/${'a'.repeat(700)}/jumpmaster-stick${digest}` };
    const { up } = upgrader(w);
    up.answered(offer);
    up.idle(0);
    await up.settled();
    const report = up.beforeLease().report;
    expect(report?.result).toBe('refused');
    expect(report?.reason).toMatch(/^image fetch failed: ghcr\.io\/a+$/);
    expect(report?.reason).toHaveLength(500);
  });

  test('D3: offers arriving while a decision is in progress start at most one helper', async () => {
    const w = world();
    const { up } = upgrader(w);
    up.answered(w.offer);
    up.idle(0);
    for (let i = 0; i < 5; i++) {
      up.answered({ ...w.offer });
      up.idle(0);
    }
    await up.settled();
    await vi.waitFor(() => expect(w.engine.helpers).toHaveLength(1));
    up.answered(w.offer);
    up.idle(0);
    expect(w.engine.helpers).toHaveLength(1);
    expect(w.fetches).toHaveLength(1);
  });

  test('an offer withdrawn while deciding starts nothing', async () => {
    const w = world();
    const { up } = upgrader(w);
    up.answered(w.offer);
    up.idle(0);
    up.answered(undefined);
    await up.settled();
    expect(w.engine.helpers).toEqual([]);
    expect(up.holding()).toBe(false);
  });

  test('helper exit 3: "another upgrade is running" is reported, pending.json stays, drops resume', async () => {
    const w = world();
    const { up } = upgrader(w);
    up.answered(w.offer);
    up.idle(0);
    await vi.waitFor(() => expect(w.engine.helpers).toHaveLength(1));
    w.engine.exit(3);
    await up.helperExited();
    expect(up.holding()).toBe(false);
    expect(up.beforeLease().report).toEqual({
      version: '0.6.0',
      result: 'failed',
      reason: 'another upgrade is running',
    });
    expect(existsSync(upgradeFiles(w.stateDir).pending)).toBe(true);
  });

  test('helper exit 2 with a result: it is reported, the files are removed, drops resume', async () => {
    const w = world();
    const { up } = upgrader(w);
    up.answered(w.offer);
    up.idle(0);
    await vi.waitFor(() => expect(w.engine.helpers).toHaveLength(1));
    const files = upgradeFiles(w.stateDir);
    const result = { version: '0.6.0', result: 'failed', reason: 'container jm-stick not found' };
    writeFileSync(files.result, JSON.stringify(result));
    w.engine.exit(2);
    await up.helperExited();
    expect(up.holding()).toBe(false);
    expect(existsSync(files.pending)).toBe(false);
    const lease = up.beforeLease();
    expect(lease.report).toEqual(result);
    lease.answered?.();
    expect(existsSync(files.result)).toBe(false);
    expect(up.beforeLease().report).toBeUndefined();
  });

  test('helper exit without a result: failed with the exit code', async () => {
    const w = world();
    const { up } = upgrader(w);
    up.answered(w.offer);
    up.idle(0);
    await vi.waitFor(() => expect(w.engine.helpers).toHaveLength(1));
    w.engine.exit(1);
    await up.helperExited();
    expect(up.beforeLease().report).toEqual({
      version: '0.6.0',
      result: 'failed',
      reason: 'the upgrade helper exited with code 1',
    });
  });

  test('an offer is ignored while the stick cannot upgrade', () => {
    const w = world();
    const up = new StickUpgrade({
      stateDir: w.stateDir,
      version: OWN,
      trust: w.trust,
      server: w.server,
      driver: w.engine.driver,
      enabled: () => false,
      pendingPushes: () => 0,
      log: () => {},
    });
    up.answered(w.offer);
    expect(up.holding()).toBe(false);
  });
});

describe('the new stick: health handshake and startup cleanup (issue #430)', () => {
  const pendingFor = (stateDir: string, version: string) => {
    const f = upgradeFiles(stateDir);
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(f.pending, JSON.stringify({ version }));
    return f;
  };

  test('ok is not written after a 204 that came before the self-check settled', () => {
    const w = world();
    const f = pendingFor(w.stateDir, '0.6.0');
    const { up } = upgrader(w, { version: '0.6.0' });
    const early = up.beforeLease();
    up.selfCheckSettled(true);
    early.answered?.();
    expect(existsSync(f.ok)).toBe(false);
    // A failed lease confirms nothing either.
    up.beforeLease();
    expect(existsSync(f.ok)).toBe(false);
    up.beforeLease().answered?.();
    expect(readFileSync(f.ok, 'utf8')).toBe('0.6.0');
  });

  test('ok is written after a passing check and a later 204, through the client', async () => {
    const w = world();
    const f = pendingFor(w.stateDir, '0.6.0');
    const { up } = upgrader(w, { version: '0.6.0' });
    const client = new StickClient('http://127.0.0.1:1', 't');
    client.upgradeHooks = up;
    let status = 503;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(status === 204 ? null : '{}', { status })),
    );
    up.selfCheckSettled(true);
    await expect(client.lease(0)).rejects.toThrow();
    expect(existsSync(f.ok)).toBe(false);
    status = 204;
    await client.lease(0);
    expect(readFileSync(f.ok, 'utf8')).toBe('0.6.0');
  });

  test('ok is never written when the base check failed', () => {
    const w = world();
    const f = pendingFor(w.stateDir, '0.6.0');
    const { up } = upgrader(w, { version: '0.6.0' });
    up.selfCheckSettled(false);
    for (let i = 0; i < 3; i++) up.beforeLease().answered?.();
    expect(existsSync(f.ok)).toBe(false);
  });

  test('a pending.json naming another version is deleted at startup and gets no ok', async () => {
    const w = world();
    const f = pendingFor(w.stateDir, '0.6.0');
    await cleanupAtStartup({
      stateDir: w.stateDir,
      version: OWN,
      driver: w.engine.driver,
      log: () => {},
    });
    expect(existsSync(f.pending)).toBe(false);
    const { up } = upgrader(w);
    up.selfCheckSettled(true);
    up.beforeLease().answered?.();
    up.beforeLease().answered?.();
    expect(existsSync(f.ok)).toBe(false);
  });

  test('a pending.json naming this version stays; a leftover lock goes only without a helper container', async () => {
    const w = world();
    const f = pendingFor(w.stateDir, OWN);
    writeFileSync(f.lock, new Date().toISOString());
    const clean = () =>
      cleanupAtStartup({
        stateDir: w.stateDir,
        version: OWN,
        driver: w.engine.driver,
        log: () => {},
      });
    w.engine.containers.add('jm-stick-upgrade');
    await clean();
    expect(existsSync(f.lock)).toBe(true);
    w.engine.containers.delete('jm-stick-upgrade');
    await clean();
    expect(existsSync(f.lock)).toBe(false);
    expect(existsSync(f.pending)).toBe(true);
  });
});

describe('reporting result.json (issue #430)', () => {
  function reporting() {
    const w = world();
    const { up } = upgrader(w);
    const client = new StickClient('http://127.0.0.1:1', 't');
    client.upgradeHooks = up;
    const bodies: { upgrade?: unknown }[] = [];
    const answer = { status: 204 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(answer.status === 204 ? null : '{}', { status: answer.status });
      }),
    );
    const f = upgradeFiles(w.stateDir);
    mkdirSync(f.dir, { recursive: true });
    return { client, bodies, answer, f };
  }

  test('a result.json appearing while the stick runs is sent on the very next lease, then deleted', async () => {
    const r = reporting();
    await r.client.lease(0);
    expect(r.bodies[0]?.upgrade).toBeUndefined();
    const result = { version: '0.6.0', result: 'failed', reason: 'the new stick restarted' };
    writeFileSync(r.f.result, JSON.stringify(result));
    await r.client.lease(0);
    expect(r.bodies[1]?.upgrade).toEqual(result);
    expect(existsSync(r.f.result)).toBe(false);
    await r.client.lease(0);
    expect(r.bodies[2]?.upgrade).toBeUndefined();
  });

  test('it is resent until a 2xx answer', async () => {
    const r = reporting();
    const result = { version: '0.6.0', result: 'ok' };
    writeFileSync(r.f.result, JSON.stringify(result));
    r.answer.status = 500;
    await expect(r.client.lease(0)).rejects.toThrow();
    await expect(r.client.lease(0)).rejects.toThrow();
    expect(existsSync(r.f.result)).toBe(true);
    r.answer.status = 204;
    await r.client.lease(0);
    expect(r.bodies.map((b) => b.upgrade)).toEqual([result, result, result]);
    expect(existsSync(r.f.result)).toBe(false);
  });

  test('a 3,000-character reason is cut to 500', async () => {
    const r = reporting();
    writeFileSync(
      r.f.result,
      JSON.stringify({ version: '0.6.0', result: 'failed', reason: 'x'.repeat(3000) }),
    );
    await r.client.lease(0);
    expect(r.bodies[0]?.upgrade).toEqual({
      version: '0.6.0',
      result: 'failed',
      reason: 'x'.repeat(500),
    });
  });

  test('a result.json that does not parse is dropped, never resent forever', async () => {
    const r = reporting();
    writeFileSync(r.f.result, 'garbage');
    await r.client.lease(0);
    expect(r.bodies[0]?.upgrade).toBeUndefined();
    expect(existsSync(r.f.result)).toBe(false);
  });
});

describe('the drain in the lease loop (issue #430)', () => {
  const DROP = (n: number) => ({ dropId: `d${n}`, epoch: 1 }) as unknown as DropPayload;

  /**
   * A server leasing a drop on every lease with a free slot while it offers nothing; while it
   * offers, it answers 204 with the header. Drops run until the test finishes them.
   */
  function drain(o: { slots?: number; pending?: () => number; offerAtStart?: boolean } = {}) {
    const w = world();
    const { up } = upgrader(w, o.pending ? { pending: o.pending } : {});
    const server = { offer: o.offerAtStart ? w.offer : (undefined as UpgradeOffer | undefined) };
    const leases: number[] = [];
    let n = 0;
    const client = {
      upgradeOffer: undefined as UpgradeOffer | undefined,
      reportStarting() {},
      async lease(free: number) {
        leases.push(free);
        client.upgradeOffer = server.offer;
        if (server.offer || free < 1) return { drop: null, skipped: [], slots: null };
        return { drop: DROP(++n), skipped: [], slots: null };
      },
    };
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    let stop = false;
    let clock = 0;
    const done = runLeaseLoop({
      client,
      target: new SlotTarget(o.slots ?? 2, 4),
      terms: () => ({ capabilities: ['upgrade-v1'] }),
      firstCheck: Promise.resolve(),
      recheck: async () => {},
      start: (drop) => {
        started.push(drop.dropId);
        return new Promise<void>((r) => finish.set(drop.dropId, r));
      },
      image: 'trooper',
      leaseLog: { skipped: () => {}, error: () => {} },
      log: () => {},
      sleep: () => new Promise((r) => setImmediate(r)),
      now: () => {
        clock += 1_000;
        return clock;
      },
      stopped: () => stop,
      upgrade: up,
    });
    return {
      w,
      up,
      server,
      leases,
      started,
      finish: (id: string) => finish.get(id)?.(),
      stop: async () => {
        stop = true;
        await done;
      },
    };
  }

  test('with two running drops the loop asks for zero slots and starts no drop until both finish', async () => {
    const h = drain();
    await vi.waitFor(() => expect(h.started).toEqual(['d1', 'd2']));
    h.server.offer = h.w.offer;
    await vi.waitFor(() => expect(h.up.holding()).toBe(true));
    const at = h.leases.length;
    await vi.waitFor(() => expect(h.leases.length).toBeGreaterThan(at + 3));
    h.finish('d1');
    await vi.waitFor(() => expect(h.leases.length).toBeGreaterThan(at + 6));
    expect(h.w.engine.helpers).toEqual([]);
    expect(h.w.fetches).toEqual([]);
    h.finish('d2');
    await vi.waitFor(() => expect(h.w.engine.helpers).toHaveLength(1));
    expect(h.leases.slice(at).every((free) => free === 0)).toBe(true);
    expect(h.started).toEqual(['d1', 'd2']);
    await h.stop();
  });

  test('a pending push keeps it waiting', async () => {
    let pending = 1;
    const h = drain({ pending: () => pending, offerAtStart: true });
    await vi.waitFor(() => expect(h.leases.length).toBeGreaterThan(5));
    expect(h.up.holding()).toBe(true);
    expect(h.w.fetches).toEqual([]);
    expect(h.started).toEqual([]);
    pending = 0;
    await vi.waitFor(() => expect(h.w.engine.helpers).toHaveLength(1));
    expect(h.leases.every((free) => free === 0)).toBe(true);
    await h.stop();
  });

  test('an answer without the header ends the drain', async () => {
    const h = drain({ pending: () => 1, offerAtStart: true });
    await vi.waitFor(() => expect(h.up.holding()).toBe(true));
    expect(h.started).toEqual([]);
    h.server.offer = undefined;
    await vi.waitFor(() => expect(h.started.length).toBeGreaterThan(0));
    expect(h.up.holding()).toBe(false);
    expect(h.w.engine.helpers).toEqual([]);
    await h.stop();
  });
});

// The test helpers write real layouts; the stick's temporary fetch directories are removed.
test('a fetch leaves no temporary directory behind', async () => {
  const w = world();
  await decide(w);
  const base = join(w.stateDir, 'image-fetch');
  expect(existsSync(base) ? readdirSync(base) : []).toEqual([]);
  expect(statSync(w.stateDir).isDirectory()).toBe(true);
});
