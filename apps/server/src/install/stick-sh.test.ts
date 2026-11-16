// The stick installer (issue #138), run with `sh` against stubbed uname, id, docker, curl and
// cosign on a PATH of its own, and the cloud-init snippet. The image download is a layout built
// from the real rc.2 signature (apps/stick/src/fixtures/rc2-stick); cosign is a fake that checks
// its exact arguments, or the real cosign v3.1.4 when COSIGN_BIN is set (issue #167).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import {
  fakeCosignScript,
  PINNED_ROOT,
  RC2_DIGEST,
  RC2_REPOSITORY,
  type Rc2Case,
  rc2Layout,
} from '../../../stick/src/test/rc2.js';
import {
  execCosign,
  releaseSigner,
  identityRegexp as stickIdentityRegexp,
  verifyLayout,
} from '../../../stick/src/verify.js';
import {
  COSIGN_SHA256,
  cloudInit,
  identityRegexp,
  installLine,
  repositoryOf,
  stickScript,
} from './stick-sh.js';

const SERVER = 'https://jm.tail1234.ts.net';
const DIGEST = RC2_DIGEST;
const REPO = RC2_REPOSITORY;
const STICK_REF = `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@${DIGEST}`;
/** The real cosign v3.1.4, when the environment has one (CLAIM = PROOF). */
const COSIGN_BIN = process.env.COSIGN_BIN ?? '';
const fileSha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ROOT_SHA = fileSha(PINNED_ROOT);
const CODE = `jm_enroll_${'C'.repeat(43)}`;

/** Real tools the script uses; docker, curl, uname, id and cosign are stubs. */
const TOOLS = [
  'sh',
  'sha256sum',
  'cut',
  'tar',
  'sed',
  'grep',
  'mktemp',
  'basename',
  'chmod',
  'rm',
  'mkdir',
  'cat',
  'head',
  'tail',
  'sleep',
  'stat',
  'cp',
  'tr',
  'ls',
  'timeout',
];

const which = (cmd: string): string => {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const path = r.stdout.trim();
  if (r.status !== 0 || !path.startsWith('/')) throw new Error(`no ${cmd} on this machine`);
  return path;
};

const COSIGN_STUB = fakeCosignScript({
  rootSha256: ROOT_SHA,
  identityRegexp: stickIdentityRegexp(REPO),
  repository: REPO,
});

const STUBS: Record<string, string> = {
  uname: `#!/bin/sh
case $1 in -s) echo "\${UNAME_S:-Linux}" ;; -m) echo "\${UNAME_M:-x86_64}" ;; esac
`,
  id: `#!/bin/sh
echo 0
`,
  curl: `#!/bin/sh
echo "curl $*" >>"$LOG"
out=
prev=
for a in "$@"; do
  [ "$prev" = -o ] && out=$a
  prev=$a
  url=$a
done
case $url in
  *get.docker.com*) printf '#!/bin/sh\\nexit 0\\n' >"$out" ;;
  */install/cosign*) [ -e "$WORK/no-cosign" ] && exit 22; cp "$WORK/cosign-stub" "$out" ;;
  */install/trusted-root.json*) cp "$WORK/trusted_root.json" "$out" ;;
  */install/stick-image.tar*) cp "$WORK/stick.tar" "$out" ;;
  *) exit 22 ;;
esac
`,
  docker: `#!/bin/sh
echo "docker $*" >>"$LOG"
case "$1 $2" in
  "container inspect") [ -n "\${EXISTS:-}" ] && exit 0; exit 1 ;;
  "volume create") exit 0 ;;
  "volume inspect") echo "$VOLDIR"; exit 0 ;;
  "volume rm") exit 0 ;;
esac
case $1 in
  load) echo 'Loaded image ID: sha256:0123456789abcdef' ;;
  tag) ;;
  run) echo "mode $(stat -c %a "$VOLDIR/enroll_code") $(cat "$VOLDIR/enroll_code")" >>"$LOG" ;;
  logs)
    if [ -n "\${ENROLL_FAIL:-}" ]; then echo 'enroll failed: 401 {"error":"unauthorized"}'
    else echo 'images: from the server, for linux/amd64'; echo 'enrolled as vps-1 (abc-123)'; fi ;;
  stop | rm) ;;
esac
exit 0
`,
};

type WorldOptions = {
  docker?: boolean;
  script?: string;
  /** The layout the image download holds. */
  layout?: Rc2Case;
  /** The signer the script is rendered with. */
  repo?: string;
  /** The real cosign at COSIGN_BIN instead of the fake. */
  realCosign?: boolean;
  /** What the server sends as the trusted root; default the pinned one. */
  root?: string;
};

function world(o: WorldOptions = {}) {
  const work = mkdtempSync(join(tmpdir(), 'jm-installer-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  for (const t of TOOLS) symlinkSync(which(t), join(bin, t));
  for (const [name, body] of Object.entries(STUBS)) {
    if (name === 'docker' && o.docker === false) continue;
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  }
  const cosign = join(work, 'cosign-stub');
  if (o.realCosign) copyFileSync(COSIGN_BIN, cosign);
  else writeFileSync(cosign, COSIGN_STUB);
  chmodSync(cosign, 0o755);
  writeFileSync(join(work, 'trusted_root.json'), o.root ?? readFileSync(PINNED_ROOT));
  // The image download: a tar of the server's OCI layout of the rc.2 stick image.
  const layout = rc2Layout(o.layout, join(work, 'layout'));
  spawnSync('tar', ['-cf', join(work, 'stick.tar'), '-C', layout.dir, '.']);
  const voldir = join(work, 'volume');
  mkdirSync(voldir);
  const log = join(work, 'log');
  writeFileSync(log, '');
  const script =
    o.script ??
    stickScript({
      serverUrl: SERVER,
      image: { ref: STICK_REF.replace(DIGEST, layout.digest), digest: layout.digest },
      signerRepository: o.repo ?? REPO,
      cosignSha256: { amd64: fileSha(cosign), arm64: fileSha(cosign) },
      trustedRootSha256: ROOT_SHA,
    });
  const file = join(work, 'stick.sh');
  writeFileSync(file, script);
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(join(bin, 'sh'), [file, ...args], {
      encoding: 'utf8',
      input: '',
      env: {
        PATH: bin,
        LOG: log,
        WORK: work,
        VOLDIR: voldir,
        TMPDIR: work,
        JM_INSTALL_TTY: join(work, 'no-tty'),
        JM_INSTALL_WAIT: '3',
        ...env,
      },
    });
    const text = readFileSync(log, 'utf8');
    return { ...r, log: text, loaded: text.split('\n').some((l) => l.startsWith('docker load')) };
  };
  return { run, voldir, work, bin, layout };
}

const SCRIPT_PARAMS = {
  serverUrl: SERVER,
  image: { ref: STICK_REF, digest: DIGEST },
  signerRepository: REPO,
  cosignSha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) },
  trustedRootSha256: ROOT_SHA,
};

describe('the installer script', () => {
  test('parses with sh -n', () => {
    const r = spawnSync('sh', ['-n'], { input: stickScript(SCRIPT_PARAMS) });
    expect(r.status).toBe(0);
  });

  test('refuses anything but Linux on x86_64 or aarch64, with a message', () => {
    const w = world();
    const mac = w.run([CODE], { UNAME_S: 'Darwin' });
    expect(mac.status).toBe(1);
    expect(mac.stderr).toContain('Linux only, not Darwin');
    const riscv = w.run([CODE], { UNAME_M: 'riscv64' });
    expect(riscv.status).toBe(1);
    expect(riscv.stderr).toContain('x86_64 or aarch64, not riscv64');
    expect(w.run([CODE], { UNAME_M: 'aarch64' }).log).toContain('platform=linux/arm64');
  });

  test('with no Docker, no --yes and no terminal it stops with instructions and never fetches get.docker.com', () => {
    const w = world({ docker: false });
    const r = w.run([CODE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Docker is not installed');
    expect(r.stderr).toContain('https://docs.docker.com/engine/install/');
    expect(r.stderr).toContain('--yes');
    expect(r.log).not.toContain('get.docker.com');
  });

  test('with no Docker and --yes it installs Docker with get.docker.com', () => {
    const w = world({ docker: false });
    const r = w.run(['--yes', CODE]);
    expect(r.log).toContain('https://get.docker.com');
  });

  test('the happy path: verified, loaded, run with the socket, the volume, the restart policy and the four variables; the code file 0600 then gone', () => {
    const w = world();
    const r = w.run([CODE]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Enrolled as vps-1. Back to your browser.');
    const lines = r.log.split('\n');
    const run = lines.find((l) => l.startsWith('docker run ')) ?? '';
    expect(run).toContain('--restart unless-stopped');
    expect(run).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(run).toContain('-v jm-stick:/state');
    expect(run).toContain(`-e JM_SERVER_URL=${SERVER}`);
    expect(run).toContain('-e JM_ENROLL_CODE_FILE=/state/enroll_code');
    expect(run).toContain('-e JM_IMAGE_SOURCE=server');
    expect(run).toContain('-e JM_IMAGE_POLICY=signed');
    expect(run).not.toContain(CODE);
    expect(r.log).toContain(`mode 600 ${CODE}`);
    // The trusted root is downloaded with the code; then cosign checks the bundle on the index
    // bytes, offline, against the downloaded root (the fake refuses any other arguments, a HOME
    // that is not empty, or another root), before load.
    expect(lines.some((l) => /^curl .*-H @\S+ .*\/install\/trusted-root\.json$/.test(l))).toBe(
      true,
    );
    const verify = lines.findIndex((l) => l.startsWith('cosign verify-blob-attestation --bundle '));
    const loaded = lines.findIndex((l) => l.startsWith('docker load'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(loaded).toBeGreaterThan(verify);
    expect(lines[verify]).toMatch(
      new RegExp(
        `--trusted-root ${w.work}/tmp\\.\\w+/trusted_root\\.json --offline --certificate-identity-regexp \\S+ --certificate-oidc-issuer https://token\\.actions\\.githubusercontent\\.com --certificate-github-workflow-trigger push --certificate-github-workflow-repository ${REPO} ${w.work}/tmp\\.\\w+/layout/blobs/sha256/${DIGEST.slice(7)}$`,
      ),
    );
    expect(lines[verify]).not.toMatch(/insecure/);
    expect(r.log).not.toContain('--local-image');
    // The code never rides on a command line.
    for (const l of lines.filter((l) => l.startsWith('curl '))) {
      expect(l).not.toContain(CODE);
      expect(l).toMatch(/-H @/);
    }
    expect(existsSync(join(w.voldir, 'enroll_code'))).toBe(false);
  });

  test('a cosign failure stops before docker load', () => {
    const w = world();
    const r = w.run([CODE], { COSIGN_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `not signed by ${REPO}'s release workflow: cosign exit 1: no matching signatures`,
    );
    expect(r.log).not.toContain('docker load');
    expect(r.log).not.toContain('docker run');
  });

  test('a trusted root that is not the pinned one is refused before cosign runs', () => {
    const w = world({
      root: '{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1","tlogs":[]}',
    });
    const r = w.run([CODE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the trusted root the server sent is not the pinned one');
    expect(r.log).not.toMatch(/^cosign /m);
    expect(r.loaded).toBe(false);
  });

  describe('every verification failure refuses and never loads (issue #167)', () => {
    const cases: [string, WorldOptions, Record<string, string>, string][] = [
      [
        'an index blob whose hash is not D',
        { layout: { tamperIndex: true } },
        {},
        `the image index blob in the download does not hash to ${DIGEST}`,
      ],
      [
        'no bundle entry',
        { layout: { noBundle: true } },
        {},
        `has no Sigstore bundle signing ${DIGEST}`,
      ],
      [
        'a bundle whose layer hash mismatches',
        { layout: { tamperBundle: true } },
        {},
        'does not hash to its digest',
      ],
      ['cosign exit != 0', {}, { COSIGN_FAIL: '1' }, 'cosign exit 1: no matching signatures'],
      [
        'a timeout',
        {},
        { COSIGN_SLEEP: '5', JM_INSTALL_COSIGN_TIMEOUT: '1' },
        'cosign timed out after 1s',
      ],
      [
        'another identity',
        { repo: 'someone-else/jumpmaster' },
        {},
        'no matching CertificateIdentity found',
      ],
    ];
    for (const [name, o, env, why] of cases)
      test(name, () => {
        const r = world(o).run([CODE], env);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(why);
        expect(r.loaded).toBe(false);
        expect(r.log).not.toContain('docker run');
      });

    test('cosign missing: the server has none to send', () => {
      const w = world();
      writeFileSync(join(w.work, 'no-cosign'), '');
      const r = w.run([CODE]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not download cosign');
      expect(r.loaded).toBe(false);
    });
  });

  test('a cosign that is not the pinned binary is refused', () => {
    const w = world();
    writeFileSync(join(w.work, 'cosign-stub'), `${COSIGN_STUB}# tampered\n`);
    chmodSync(join(w.work, 'cosign-stub'), 0o755);
    const r = w.run([CODE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not the pinned');
    expect(r.log).not.toContain('cosign verify');
  });

  test('an enrollment error is printed, and the code file removed', () => {
    const w = world();
    const r = w.run([CODE], { ENROLL_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('enroll failed: 401');
    expect(existsSync(join(w.voldir, 'enroll_code'))).toBe(false);
  });

  test('--uninstall removes the container and the volume', () => {
    const w = world();
    const r = w.run(['--uninstall']);
    expect(r.status).toBe(0);
    expect(r.log).toContain('docker stop jm-stick');
    expect(r.log).toContain('docker rm jm-stick');
    expect(r.log).toContain('docker volume rm jm-stick');
    expect(r.log).not.toContain('docker run');
  });

  test('a server with no stick image says so before anything is downloaded', () => {
    const w = world({
      script: stickScript({ ...SCRIPT_PARAMS, image: null }),
    });
    const r = w.run([CODE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mirrors no release stick image');
    expect(r.log).toBe('');
  });

  test('no code: a clear message', () => {
    const r = world().run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no enrollment code');
  });
});

test('a server with no trusted root says so before anything is downloaded', () => {
  const w = world({ script: stickScript({ ...SCRIPT_PARAMS, trustedRootSha256: null }) });
  const r = w.run([CODE]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('no Sigstore trusted root');
  expect(r.log).toBe('');
});

describe('sibling parity: the stick and the installer give the same verdict on the same layout (issue #167)', () => {
  // One cosign binary for both: the fake (it checks the exact arguments, the empty HOME and the
  // pinned root, and answers as cosign does on these fixtures), or the real one at COSIGN_BIN.
  const cases: [string, Rc2Case, string, boolean][] = [
    ['good', {}, REPO, true],
    ['tampered index', { tamperIndex: true }, REPO, false],
    ['index relabelled under its own digest', { relabelIndex: true }, REPO, false],
    ['no bundle', { noBundle: true }, REPO, false],
    ['tampered bundle', { tamperBundle: true }, REPO, false],
    ['wrong identity', {}, 'someone-else/jumpmaster', false],
  ];
  const real = COSIGN_BIN !== '';
  for (const [name, layout, repo, want] of cases)
    test(`${name}: ${want ? 'verified' : 'refused'} by both${real ? ' (real cosign)' : ''}`, async () => {
      const w = world({ layout, repo, realCosign: real });
      const installer = w.run([CODE]);
      const stick = await verifyLayout(
        w.layout.dir,
        `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@${w.layout.digest}`,
        {
          policy: 'signed',
          allowed: new Set(),
          signer: releaseSigner(repo),
          cosign: execCosign(join(w.work, 'cosign-stub'), { PATH: w.bin }),
          trustedRoot: PINNED_ROOT,
        },
      );
      expect(stick.ok, JSON.stringify(stick)).toBe(want);
      expect(installer.loaded, installer.stderr).toBe(want);
      if (want) expect(installer.status, installer.stderr).toBe(0);
    });
});

describe('the cloud-init snippet', () => {
  test('parses as YAML, starts with #cloud-config, joins the tailnet and runs the installer line', () => {
    const text = cloudInit(SERVER, CODE);
    expect(text.startsWith('#cloud-config\n')).toBe(true);
    const doc = load(text) as { runcmd: string[] };
    expect(doc.runcmd).toContain(installLine(SERVER, CODE));
    expect(doc.runcmd).toContain('tailscale up --authkey=TS_AUTHKEY');
    expect(doc.runcmd.indexOf('tailscale up --authkey=TS_AUTHKEY')).toBeLessThan(
      doc.runcmd.indexOf(installLine(SERVER, CODE)),
    );
    expect(text).toContain('TS_AUTHKEY');
  });
});

describe('the signer', () => {
  test("the identity is the stick verifier's, and the repository comes from the source URL", () => {
    expect(identityRegexp('o/jumpmaster')).toBe(
      '^https://github\\.com/o/jumpmaster/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$',
    );
    expect(repositoryOf('https://github.com/o/jumpmaster')).toBe('o/jumpmaster');
    expect(repositoryOf('https://example.com/o/jumpmaster')).toBeNull();
    expect(repositoryOf(undefined)).toBeNull();
  });

  test("the pinned cosign sums are the stick image's", () => {
    const dockerfile = readFileSync(
      new URL('../../../../images/stick/Dockerfile', import.meta.url),
      'utf8',
    );
    for (const [arch, sum] of Object.entries(COSIGN_SHA256))
      expect(dockerfile).toContain(`${arch}) sum=${sum}`);
  });
});
