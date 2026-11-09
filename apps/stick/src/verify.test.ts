// Image verification. Keyless signing can't run offline, so cosign's side is recorded: the
// fixtures under ./fixtures are cosign v3.1.4's real output, captured against a local registry
// (`cosign-verify-ok.stdout`: a key-signed image, whose JSON payload has the same shape a keyless
// signature's has; `cosign-verify-unsigned.stderr`: an image with no signature, exit 10) and
// against GHCR (`cosign-verify-wrong-identity.stderr`: an image signed keyless by someone else,
// verified with this repository's identity flags, exit 1). The keyless identity itself is checked
// by cosign's flags, which these tests pin exactly, and by the release workflow, which verifies
// every image it signs with the same flags.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  COSIGN_VERSION,
  type Cosign,
  type CosignResult,
  digestOf,
  execCosign,
  GITHUB_ISSUER,
  type ImageTrust,
  identityRegexp,
  prepareImageTrust,
  releaseSigner,
  signerKey,
  VerifyCache,
  verifyImage,
} from './verify.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const SIGNED_DIGEST = 'sha256:742bbaf3524be1effb687bb69e991a5e5a43ad35c306f88ea4b91553d6aa78ef';
const SIGNED = `jmreg:5000/demo@${SIGNED_DIGEST}`;
const OTHER = `jmreg:5000/demo@sha256:${'6'.repeat(64)}`;
const REPO = 'x-a-n-d-e-r-k/jumpmaster';
const DAY = 24 * 60 * 60 * 1000;

const fresh = () => mkdtempSync(join(tmpdir(), 'jm-verify-'));

/** A cosign that answers from a script and records its calls. */
function fakeCosign(answer: (args: string[]) => CosignResult | Promise<CosignResult>) {
  const calls: string[][] = [];
  const cosign: Cosign = async (args) => {
    calls.push(args);
    return answer(args);
  };
  return { cosign, calls };
}
const ok = (stdout = fixture('cosign-verify-ok.stdout')): CosignResult => ({
  code: 0,
  stdout,
  stderr: 'Verification for …',
});

function signedTrust(o: Partial<ImageTrust> & { cosign: Cosign; dir?: string; now?: () => Date }) {
  const dir = o.dir ?? fresh();
  const now = o.now ?? (() => new Date('2026-11-08T12:00:00Z'));
  return {
    policy: 'signed' as const,
    allowed: new Set<string>(),
    signer: releaseSigner(REPO),
    cache: new VerifyCache(join(dir, 'verified.json'), releaseSigner(REPO), { now }),
    ...o,
  } satisfies ImageTrust;
}

describe('the signing identity', () => {
  test('the identity regexp matches v0.4.0-rc.1 and v1.2.3, and rejects branch refs and other repositories', () => {
    const re = new RegExp(identityRegexp(REPO));
    const base = `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/`;
    for (const tag of ['v0.4.0-rc.1', 'v1.2.3', 'v10.20.30', 'v1.0.0-rc.12'])
      expect(re.test(`${base}${tag}`), tag).toBe(true);
    for (const bad of [
      `https://github.com/${REPO}/.github/workflows/release.yml@refs/heads/main`,
      `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v1.2`,
      `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v1.2.3-beta.1`,
      `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v1.2.3.evil`,
      `https://github.com/${REPO}/.github/workflows/images.yml@refs/tags/v1.2.3`,
      `https://github.com/${REPO}-evil/.github/workflows/release.yml@refs/tags/v1.2.3`,
      `https://github.com/other/jumpmaster/.github/workflows/release.yml@refs/tags/v1.2.3`,
      `https://github.com/${REPO}/.github/workflows/releaseXyml@refs/tags/v1.2.3`,
      `https://github.comX${REPO}/.github/workflows/release.yml@refs/tags/v1.2.3`,
      `xhttps://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v1.2.3`,
      `https://github.com/evil/x/.github/workflows/release.yml@refs/tags/v1.2.3#https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v1.2.3`,
    ])
      expect(re.test(bad), bad).toBe(false);
    // Anchored at both ends, with every dot escaped.
    expect(identityRegexp(REPO)).toBe(
      '^https://github\\.com/x-a-n-d-e-r-k/jumpmaster/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$',
    );
    expect(identityRegexp('o/jump.master')).toContain('/o/jump\\.master/');
    expect(() => releaseSigner('not a repo')).toThrow(/owner\/name/);
    expect(() => releaseSigner('o/n/x')).toThrow(/owner\/name/);
  });

  test('SECURITY.md documents exactly the identity the stick verifies', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../../../SECURITY.md', import.meta.url)),
      'utf8',
    );
    expect(doc).toContain(`--certificate-identity-regexp '${identityRegexp(REPO)}'`);
    expect(doc).toContain(`--certificate-oidc-issuer ${GITHUB_ISSUER}`);
  });

  test('digestOf takes only name@sha256:<64 hex> and never a flag', () => {
    expect(digestOf(SIGNED)).toBe(SIGNED_DIGEST);
    expect(digestOf(`ghcr.io/o/x:v1@${SIGNED_DIGEST}`)).toBe(SIGNED_DIGEST);
    for (const bad of [
      'ghcr.io/o/x:v1',
      'ghcr.io/o/x',
      `ghcr.io/o/x@sha256:${'A'.repeat(64)}`,
      `ghcr.io/o/x@sha256:${'a'.repeat(63)}`,
      `ghcr.io/o/x@sha512:${'a'.repeat(64)}`,
      `--output=x@${SIGNED_DIGEST}`,
      `@${SIGNED_DIGEST}`,
      `a b@${SIGNED_DIGEST}`,
      `ghcr.io/o/x@${SIGNED_DIGEST}\n`,
    ])
      expect(digestOf(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('verifyImage', () => {
  test('under signed, a tag ref is refused without calling cosign', async () => {
    const f = fakeCosign(() => ok());
    for (const ref of ['ghcr.io/o/jumpmaster-trooper:v1', 'jumpmaster-trooper:dev']) {
      const v = await verifyImage(ref, signedTrust({ cosign: f.cosign }));
      expect(v).toEqual({
        ok: false,
        reason: `image not verified: ${ref}: a tag reference; under the signed image policy images run only by digest (name@sha256:<64 hex>)`,
      });
    }
    // Even a tag the operator listed: under signed only digest pins count.
    const listed = signedTrust({ cosign: f.cosign, allowed: new Set(['jumpmaster-trooper:dev']) });
    expect((await verifyImage('jumpmaster-trooper:dev', listed)).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test('a pinned digest ref passes without calling cosign', async () => {
    const f = fakeCosign(() => ({ code: 1, stdout: '', stderr: 'Error: no signatures found' }));
    const t = signedTrust({ cosign: f.cosign, allowed: new Set([OTHER]) });
    expect(await verifyImage(OTHER, t)).toEqual({ ok: true, via: 'pinned' });
    expect(f.calls).toEqual([]);
    // The pin is the exact reference: the same digest under another name goes to cosign.
    expect((await verifyImage(`elsewhere/demo@${OTHER.split('@')[1]}`, t)).ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  test('a pin matches on name and digest, whatever tag either side carries', async () => {
    const f = fakeCosign(() => ({ code: 10, stdout: '', stderr: 'Error: no signatures found' }));
    const d = OTHER.split('@')[1];
    const pinned = (pin: string, ref: string) =>
      verifyImage(ref, signedTrust({ cosign: f.cosign, allowed: new Set([pin]) }));
    expect(await pinned(`jmreg:5000/demo:v1@${d}`, OTHER)).toEqual({ ok: true, via: 'pinned' });
    expect(await pinned(OTHER, `jmreg:5000/demo:v2@${d}`)).toEqual({ ok: true, via: 'pinned' });
    expect(await pinned(`jmreg:5000/demo:a@${d}`, `jmreg:5000/demo:b@${d}`)).toEqual({
      ok: true,
      via: 'pinned',
    });
    expect(f.calls).toEqual([]);
    // Another name with the same digest is not the pin; the refusal says why.
    const v = await pinned(`elsewhere/demo@${d}`, OTHER);
    expect(v).toEqual({
      ok: false,
      reason: `image not verified: ${OTHER}: cosign exit 10: no signatures found; JM_ALLOWED_IMAGES pins this digest as elsewhere/demo@${d}, under another name: a pin matches only the same name and digest`,
    });
  });

  test('cosign exit 0 with a matching digest passes and is cached by digest', async () => {
    const dir = fresh();
    const f = fakeCosign(() => ok());
    const t = signedTrust({ cosign: f.cosign, dir });
    expect(await verifyImage(SIGNED, t)).toEqual({ ok: true, via: 'cosign' });
    expect(await verifyImage(SIGNED, t)).toEqual({ ok: true, via: 'cache' });
    expect(f.calls).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(dir, 'verified.json'), 'utf8'));
    expect(Object.keys(saved.entries)).toEqual([SIGNED_DIGEST]);
    expect(statSync(join(dir, 'verified.json')).mode & 0o777).toBe(0o600);
  });

  test('cosign exit 0 with a different manifest digest is refused', async () => {
    const f = fakeCosign(() => ok());
    const v = await verifyImage(OTHER, signedTrust({ cosign: f.cosign }));
    expect(v.ok).toBe(false);
    expect(v.ok || v.reason).toBe(
      `image not verified: ${OTHER}: cosign verified ${SIGNED_DIGEST}, not ${OTHER.split('@')[1]}`,
    );
    // One matching payload among others isn't enough: every payload must name the digest.
    const payloads = JSON.parse(fixture('cosign-verify-ok.stdout'));
    const mixed = JSON.stringify([
      ...payloads,
      { critical: { image: { 'docker-manifest-digest': OTHER.split('@')[1] } } },
    ]);
    const g = fakeCosign(() => ok(mixed));
    expect((await verifyImage(SIGNED, signedTrust({ cosign: g.cosign }))).ok).toBe(false);
  });

  test('cosign non-zero, timeout or unparsable output is refused', async () => {
    const cases: [CosignResult, RegExp][] = [
      [
        { code: 10, stdout: '', stderr: fixture('cosign-verify-unsigned.stderr') },
        /: cosign exit 10: no signatures found$/,
      ],
      [
        { code: 1, stdout: '', stderr: fixture('cosign-verify-wrong-identity.stderr') },
        /: cosign exit 1: no matching attestations: failed to verify log inclusion/,
      ],
      // Rekor or the TUF CDN unreachable, or a hang: the wrapper reports it as an error.
      [
        { code: null, stdout: '', stderr: '', error: 'timed out after 60s' },
        /: timed out after 60s$/,
      ],
      [{ code: null, stdout: '', stderr: '', error: 'cosign not found' }, /: cosign not found$/],
      [ok('not json'), /: cosign output does not parse$/],
      [ok('[]'), /: cosign output names no signed digest$/],
      [ok('[{"critical":{}}]'), /: cosign output names no signed digest$/],
      [ok('{"critical":{}}'), /: cosign output names no signed digest$/],
      // Exit 0 with the right digest still fails if anything says it didn't verify.
      [{ code: 1, stdout: fixture('cosign-verify-ok.stdout'), stderr: '' }, /: cosign exit 1$/],
    ];
    for (const [answer, reason] of cases) {
      const dir = fresh();
      const f = fakeCosign(() => answer);
      const v = await verifyImage(SIGNED, signedTrust({ cosign: f.cosign, dir }));
      expect(v.ok, reason.source).toBe(false);
      expect(v.ok || v.reason, reason.source).toMatch(reason);
      expect(v.ok || v.reason).toMatch(/^image not verified: jmreg:5000\/demo@sha256:/);
      // A failure is never cached.
      expect(() => statSync(join(dir, 'verified.json'))).toThrow();
    }
    // A cosign that throws is a refusal, never a pass.
    const boom = fakeCosign(() => {
      throw new Error('spawn EACCES');
    });
    const v = await verifyImage(SIGNED, signedTrust({ cosign: boom.cosign }));
    expect(v).toEqual({ ok: false, reason: `image not verified: ${SIGNED}: spawn EACCES` });
  });

  test('cosign is called with the anchored regexp, issuer, push trigger and repository flags', async () => {
    const f = fakeCosign(() => ok());
    await verifyImage(SIGNED, signedTrust({ cosign: f.cosign }));
    expect(f.calls).toEqual([
      [
        'verify',
        '--certificate-identity-regexp',
        identityRegexp(REPO),
        '--certificate-oidc-issuer',
        'https://token.actions.githubusercontent.com',
        '--certificate-github-workflow-trigger',
        'push',
        '--certificate-github-workflow-repository',
        REPO,
        '--output',
        'json',
        '--',
        SIGNED,
      ],
    ]);
  });

  test('with no trusted signer, nothing unpinned verifies', async () => {
    const f = fakeCosign(() => ok());
    const t = { policy: 'signed' as const, allowed: new Set<string>(), cosign: f.cosign };
    expect(await verifyImage(SIGNED, t)).toEqual({
      ok: false,
      reason: `image not verified: ${SIGNED}: this stick has no trusted signer`,
    });
    expect(f.calls).toEqual([]);
  });

  test('allowlist policy behaves exactly as in M3', async () => {
    const t: ImageTrust = { policy: 'allowlist', allowed: new Set(['jumpmaster-trooper:dev']) };
    expect(await verifyImage('jumpmaster-trooper:dev', t)).toEqual({ ok: true, via: 'allowlist' });
    expect(await verifyImage('jumpmaster-trooper:other', t)).toEqual({
      ok: false,
      reason: 'image not allowed: jumpmaster-trooper:other',
    });
    // No prefix or digest leniency either.
    expect((await verifyImage(SIGNED, t)).ok).toBe(false);
  });
});

describe('the verify cache', () => {
  const now = (iso: string) => () => new Date(iso);

  test('the persisted cache survives a restart; a tampered or wrongly owned cache file is ignored', async () => {
    const dir = fresh();
    const file = join(dir, 'verified.json');
    const f = fakeCosign(() => ok());
    await verifyImage(SIGNED, signedTrust({ cosign: f.cosign, dir }));
    // A restart: a new cache object over the same file.
    const restarted = fakeCosign(() => ({
      code: 1,
      stdout: '',
      stderr: 'Error: rekor unreachable',
    }));
    expect(await verifyImage(SIGNED, signedTrust({ cosign: restarted.cosign, dir }))).toEqual({
      ok: true,
      via: 'cache',
    });
    expect(restarted.calls).toEqual([]);
    const good = readFileSync(file, 'utf8');
    const ignored = async (setup: () => void, uid?: number) => {
      writeFileSync(file, good, { mode: 0o600 });
      chmodSync(file, 0o600);
      setup();
      const g = fakeCosign(() => ({ code: 1, stdout: '', stderr: 'Error: rekor unreachable' }));
      const cache = new VerifyCache(file, releaseSigner(REPO), {
        now: now('2026-11-08T12:00:00Z'),
        ...(uid !== undefined ? { uid } : {}),
      });
      const v = await verifyImage(SIGNED, { ...signedTrust({ cosign: g.cosign, dir }), cache });
      expect(v.ok).toBe(false);
      expect(g.calls).toHaveLength(1);
    };
    await ignored(() => chmodSync(file, 0o644)); // readable by others: anyone could have read it, and a writable one anyone could change
    await ignored(() => chmodSync(file, 0o666));
    await ignored(() => {}, (process.getuid?.() ?? 0) + 1); // owned by another user
    await ignored(() => writeFileSync(file, `${good.slice(0, -5)}`)); // truncated
    await ignored(() => writeFileSync(file, 'null'));
    await ignored(() =>
      // An entry for a digest under another signer's identity.
      writeFileSync(file, good.replace(REPO, 'evil/jumpmaster')),
    );
    await ignored(() => writeFileSync(file, JSON.stringify({ ...JSON.parse(good), version: 2 })));
    // A tampered cache is rewritten by the next success.
    writeFileSync(file, 'garbage');
    chmodSync(file, 0o644);
    const h = fakeCosign(() => ok());
    expect((await verifyImage(SIGNED, signedTrust({ cosign: h.cosign, dir }))).ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).entries[SIGNED_DIGEST]).toBeDefined();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('a cached success expires after 7 days; a failure is never cached', async () => {
    const dir = fresh();
    let clock = new Date('2026-11-08T12:00:00Z');
    const nowFn = () => clock;
    let answer: CosignResult = ok();
    const f = fakeCosign(() => answer);
    const trust = () => signedTrust({ cosign: f.cosign, dir, now: nowFn });
    expect((await verifyImage(SIGNED, trust())).ok).toBe(true);
    clock = new Date(clock.getTime() + 7 * DAY - 1000);
    expect(await verifyImage(SIGNED, trust())).toEqual({ ok: true, via: 'cache' });
    clock = new Date(clock.getTime() + 2000);
    answer = { code: 1, stdout: '', stderr: 'Error: no signatures found' };
    expect((await verifyImage(SIGNED, trust())).ok).toBe(false);
    expect(f.calls).toHaveLength(2);
    // The failure left no entry: the next call asks cosign again.
    expect((await verifyImage(SIGNED, trust())).ok).toBe(false);
    expect(f.calls).toHaveLength(3);
    // An entry dated in the future (a clock set back, or a forged file) is not trusted.
    const cache = new VerifyCache(join(dir, 'future.json'), releaseSigner(REPO), {
      now: () => new Date('2026-11-08T12:00:00Z'),
    });
    writeFileSync(
      join(dir, 'future.json'),
      JSON.stringify({
        version: 1,
        signer: signerKey(releaseSigner(REPO)),
        entries: { [SIGNED_DIGEST]: '2027-01-01T00:00:00.000Z' },
      }),
      { mode: 0o600 },
    );
    expect(cache.has(SIGNED_DIGEST)).toBe(false);
    // And the next success drops it from the file rather than carrying it forward.
    cache.add(`sha256:${'7'.repeat(64)}`);
    const kept = JSON.parse(readFileSync(join(dir, 'future.json'), 'utf8')).entries;
    expect(Object.keys(kept)).toEqual([`sha256:${'7'.repeat(64)}`]);
  });
});

describe('startup under the signed policy', () => {
  const cosignVersion = (gitVersion: string | null) =>
    fakeCosign((args) => {
      if (args[0] !== 'version') throw new Error('unexpected');
      if (gitVersion === null)
        return { code: null, stdout: '', stderr: '', error: 'cosign not found' };
      return { code: 0, stdout: JSON.stringify({ gitVersion }), stderr: '' };
    });
  const base = (dir: string) => ({
    JM_IMAGE_POLICY: 'signed',
    JM_STATE_DIR: dir,
    TUF_ROOT: join(dir, 'sigstore'),
  });
  const release = { version: '0.4.0', repository: REPO };

  test('the stick refuses to start under signed when cosign is missing or the wrong version', async () => {
    const dir = fresh();
    const log: string[] = [];
    await expect(
      prepareImageTrust(base(dir), {
        cosign: cosignVersion(null).cosign,
        release,
        log: (l) => log.push(l),
      }),
    ).rejects.toThrow(/cosign not found.*JM_IMAGE_POLICY=signed needs cosign v3\.1\.4/);
    await expect(
      prepareImageTrust(base(dir), {
        cosign: cosignVersion('v2.6.5').cosign,
        release,
        log: () => {},
      }),
    ).rejects.toThrow(`cosign is v2.6.5, not the pinned ${COSIGN_VERSION}`);
    await expect(
      prepareImageTrust(base(dir), {
        cosign: fakeCosign(() => ({ code: 0, stdout: 'v3.1.4', stderr: '' })).cosign,
        release,
        log: () => {},
      }),
    ).rejects.toThrow(/cosign version does not parse/);
    const t = await prepareImageTrust(base(dir), {
      cosign: cosignVersion(COSIGN_VERSION).cosign,
      release,
      log: () => {},
    });
    expect(t.policy).toBe('signed');
    expect(t.signer).toEqual(releaseSigner(REPO));
    // The Sigstore TUF root is the stick's own: root-only.
    expect(statSync(join(dir, 'sigstore')).mode & 0o777).toBe(0o700);
  });

  test("under signed, a variable that repoints cosign's trust refuses startup, by name", async () => {
    const dir = fresh();
    const cosign = cosignVersion(COSIGN_VERSION).cosign;
    for (const name of [
      'SIGSTORE_ROOT_FILE',
      'SIGSTORE_REKOR_PUBLIC_KEY',
      'TUF_MIRROR',
      'COSIGN_REPOSITORY',
    ])
      await expect(
        prepareImageTrust({ ...base(dir), [name]: 'x' }, { cosign, release, log: () => {} }),
      ).rejects.toThrow(`${name} is set: it would change what cosign trusts; unset it`);
    // Under allowlist cosign never runs, so they don't matter.
    await expect(
      prepareImageTrust({ JM_STATE_DIR: dir, TUF_MIRROR: 'x' }, { cosign, log: () => {} }),
    ).resolves.toMatchObject({ policy: 'allowlist' });
  });

  test('a non-digest JM_ALLOWED_IMAGES entry refuses startup under signed', async () => {
    const dir = fresh();
    const cosign = cosignVersion(COSIGN_VERSION).cosign;
    const pin = `ghcr.io/o/svc@sha256:${'b'.repeat(64)}`;
    await expect(
      prepareImageTrust(
        { ...base(dir), JM_ALLOWED_IMAGES: `${pin}, postgres:16` },
        { cosign, release, log: () => {} },
      ),
    ).rejects.toThrow(
      'JM_ALLOWED_IMAGES entry postgres:16 is not a digest reference (name@sha256:<64 hex>); under the signed image policy every pin must be one',
    );
    for (const name of ['JM_TROOPER_IMAGE', 'JM_EGRESS_IMAGE'])
      await expect(
        prepareImageTrust(
          { ...base(dir), [name]: 'jumpmaster-x:dev' },
          { cosign, release, log: () => {} },
        ),
      ).rejects.toThrow(`${name} jumpmaster-x:dev is not a digest reference`);
    const t = await prepareImageTrust(
      { ...base(dir), JM_ALLOWED_IMAGES: pin },
      { cosign, release, log: () => {} },
    );
    expect([...t.allowed]).toEqual([pin]);
    // Without JM_ALLOWED_IMAGES there are no pins: the dev default is not a pin.
    expect([
      ...(await prepareImageTrust(base(dir), { cosign, release, log: () => {} })).allowed,
    ]).toEqual([]);
  });

  test('without a trusted signer the stick refuses to start; JM_TRUSTED_SIGNER_REPOSITORY overrides it and is logged', async () => {
    const dir = fresh();
    const cosign = cosignVersion(COSIGN_VERSION).cosign;
    await expect(prepareImageTrust(base(dir), { cosign, log: () => {} })).rejects.toThrow(
      /no trusted signer: this stick image was built without RELEASE_REPOSITORY/,
    );
    const log: string[] = [];
    const t = await prepareImageTrust(
      { ...base(dir), JM_TRUSTED_SIGNER_REPOSITORY: 'fork-owner/jumpmaster' },
      { cosign, release, log: (l) => log.push(l) },
    );
    expect(t.signer?.repository).toBe('fork-owner/jumpmaster');
    expect(log.map((l) => JSON.parse(l))).toContainEqual({
      event: 'trusted-signer-override',
      repository: 'fork-owner/jumpmaster',
      built: REPO,
    });
    await expect(
      prepareImageTrust(
        { ...base(dir), JM_TRUSTED_SIGNER_REPOSITORY: 'x/y/z' },
        { cosign, release, log: () => {} },
      ),
    ).rejects.toThrow(/JM_TRUSTED_SIGNER_REPOSITORY/);
  });

  test('under allowlist nothing about cosign is checked and the M3 allow-list applies', async () => {
    const f = fakeCosign(() => {
      throw new Error('must not run');
    });
    const t = await prepareImageTrust(
      { JM_STATE_DIR: fresh(), JM_ALLOWED_IMAGES: 'a:1,b:2' },
      { cosign: f.cosign, log: () => {} },
    );
    expect(t).toEqual({ policy: 'allowlist', allowed: new Set(['a:1', 'b:2']) });
    expect(f.calls).toEqual([]);
  });
});

describe('execCosign', () => {
  const script = (body: string) => {
    const file = join(fresh(), 'cosign');
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };

  test('passes args through, returns exit, stdout and stderr, and keeps JM_ secrets out of its env', async () => {
    const bin = script('echo "$@"; env | grep -c "^JM_" >&2; exit 3');
    const r = await execCosign(bin, {
      PATH: process.env.PATH,
      JM_JOIN_TOKEN: 'secret',
      TUF_ROOT: '/x',
    })(['verify', '--', 'a@b'], { timeoutMs: 5000 });
    expect(r).toEqual({ code: 3, stdout: 'verify -- a@b\n', stderr: '0\n' });
  });

  test('cosign gets an allow-listed environment: nothing can repoint its trust root', async () => {
    const bin = script('env | cut -d= -f1 | sort');
    const r = await execCosign(bin, {
      PATH: process.env.PATH,
      HOME: '/root',
      TMPDIR: '/tmp',
      TUF_ROOT: '/state/sigstore',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      SIGSTORE_ROOT_FILE: '/evil/root.json',
      SIGSTORE_REKOR_PUBLIC_KEY: '/evil/rekor.pub',
      TUF_MIRROR: 'https://evil.example',
      COSIGN_EXPERIMENTAL: '1',
      JM_JOIN_TOKEN: 'secret',
      LD_PRELOAD: '/evil.so',
    })(['version'], { timeoutMs: 5000 });
    const names = r.stdout
      .trim()
      .split('\n')
      .filter((n) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n));
    expect(names).toEqual([
      'HOME',
      'HTTPS_PROXY',
      'PATH',
      'SSL_CERT_FILE',
      'TMPDIR',
      'TUF_ROOT',
      'no_proxy',
    ]);
  });

  test('a missing binary or a timeout is an error, never an exit 0', async () => {
    const missing = await execCosign(join(fresh(), 'nope'), {})(['version'], { timeoutMs: 5000 });
    expect(missing.code).toBeNull();
    expect(missing.error).toMatch(/cosign not found/);
    const slow = await execCosign(script('sleep 5'), { PATH: process.env.PATH })(['verify'], {
      timeoutMs: 200,
    });
    expect(slow).toMatchObject({ code: null, error: 'timed out after 0.2s' });
  });
});
