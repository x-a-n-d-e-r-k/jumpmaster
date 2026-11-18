// The stick installer (issue #138), run with `sh` against stubbed uname, id, docker, curl and
// cosign on a PATH of its own, and the cloud-init snippet. The image download is a layout built
// like the server's around the real rc.2 signature (apps/stick/src/fixtures/rc2-stick); cosign is
// a fake that checks its exact arguments, or the real cosign v3.1.4 when COSIGN_BIN is set (issue
// #167). The rc.2 fixtures lack the platform blobs, so tests that load use a synthetic signed
// image laid out the same way (issue #168); the signature parity tests use the rc.2 index.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { bindLayout, loadIndexJson, loadTar } from '../../../stick/src/fetch-image.js';
import {
  fakeCosignScript,
  PINNED_ROOT,
  platformImage,
  RC2_INDEX,
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
/** The stick image the tests load: synthetic, signed (as far as the fake cosign knows). */
const IMAGE = platformImage();
const DIGEST = IMAGE.digest;
const REPO = RC2_REPOSITORY;
const STICK_NAME = 'ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick';
const STICK_REF = `${STICK_NAME}@${DIGEST}`;
/** The real cosign v3.1.4, when the environment has one (CLAIM = PROOF). */
const COSIGN_BIN = process.env.COSIGN_BIN ?? '';
const fileSha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ROOT_SHA = fileSha(PINNED_ROOT);
const CODE = `jm_enroll_${'C'.repeat(43)}`;
/** The install token the fake server swaps the code for (issue #269). */
const INSTALL_TOKEN = `jm_install_${'T'.repeat(43)}`;

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
  'ln',
  'wc',
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
  signedIndex: IMAGE.index,
});
const RC2_COSIGN_STUB = fakeCosignScript({
  rootSha256: ROOT_SHA,
  identityRegexp: stickIdentityRegexp(REPO),
  repository: REPO,
  signedIndex: RC2_INDEX,
});

const STUBS: Record<string, string> = {
  uname: `#!/bin/sh
case $1 in -s) echo "\${UNAME_S:-Linux}" ;; -m) echo "\${UNAME_M:-x86_64}" ;; esac
`,
  id: `#!/bin/sh
echo "\${ID_U:-0}"
`,
  chown: `#!/bin/sh
echo "chown $*" >>"$LOG"
`,
  curl: `#!/bin/sh
echo "curl $*" >>"$LOG"
out=
prev=
hdr=
for a in "$@"; do
  [ "$prev" = -o ] && out=$a
  if [ "$prev" = -H ]; then case $a in @*) hdr=\${a#@} ;; esac; fi
  prev=$a
  url=$a
done
# What each call sent in its header file, which no argv shows.
if [ -n "$hdr" ]; then printf '%s %s\\n' "$url" "$(cat "$hdr")" >>"$WORK/headers"; fi
case $url in
  */install/exchange)
    if [ -n "\${EXCHANGE_STATUS:-}" ]; then
      printf '{"error":"%s"}' "\${EXCHANGE_ERROR:-unauthorized}" >"$out"
      printf '%s' "$EXCHANGE_STATUS"
      exit 0
    fi
    printf '{"token":"%s"}' "$INSTALL_TOKEN_VALUE" >"$out"
    printf 200 ;;
  */install/cancel) [ -n "\${CANCEL_FAIL:-}" ] && exit 28; exit 0 ;;
  *get.docker.com*) printf '#!/bin/sh\\nexit 0\\n' >"$out" ;;
  */install/cosign*) [ -e "$WORK/no-cosign" ] && exit 22; cp "$WORK/cosign-stub" "$out" ;;
  */install/trusted-root.json*) cp "$WORK/trusted_root.json" "$out" ;;
  */install/stick-image.tar*) cp "$WORK/stick.tar" "$out" ;;
  *) exit 22 ;;
esac
`,
  docker: `#!/bin/sh
echo "docker $*" >>"$LOG"
[ "$1 $2" = "run -d" ] && [ -n "\${RUN_FAIL:-}" ] && exit 125
case "$1 $2" in
  "container inspect") [ -n "\${EXISTS:-}" ] && exit 0; exit 1 ;;
  "volume create") exit 0 ;;
  "volume inspect") if [ -n "\${VOLDIR_HIDDEN:-}" ]; then echo /var/lib/docker/volumes/jm-stick/_data; else echo "$VOLDIR"; fi; exit 0 ;;
  "volume rm") exit 0 ;;
  "image inspect") [ -n "\${IMAGE_ID:-}" ] || { echo "Error: No such image: $5" >&2; exit 1; }; echo "$IMAGE_ID"; exit 0 ;;
  "image rm") exit 0 ;;
esac
if [ "$1" = run ]; then
  case " $* " in
    *" /cosign "*)
      while [ "$1" != /cosign ]; do shift; done
      shift
      exec "$WORK/imported/cosign" "$@" ;;
    *" --entrypoint sh "*"/state "*)
      cat >"$VOLDIR/enroll_code"
      chmod 600 "$VOLDIR/enroll_code"
      exit 0 ;;
    *" --entrypoint rm "*)
      rm -f "$VOLDIR/enroll_code"
      exit 0 ;;
  esac
fi
case $1 in
  import) mkdir -p "$WORK/imported"; tar -xf - -C "$WORK/imported"; echo sha256:imported ;;
  load) cp "$3" "$WORK/loaded.tar"; echo "Loaded image: \${LOADED:-}" ;;
  tag) ;;
  run) echo "mode $(stat -c %a "$VOLDIR/enroll_code" 2>/dev/null || stat -f %Lp "$VOLDIR/enroll_code") $(cat "$VOLDIR/enroll_code")" >>"$LOG" ;;
  logs)
    if [ -n "\${ENROLL_FAIL:-}" ]; then echo 'enroll failed: 401 {"error":"unauthorized"}'
    elif [ -n "\${ENROLL_SILENT:-}" ]; then echo 'images: from the server, for linux/amd64'
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
  /** The download holds the real rc.2 index (signature only: no platform blobs to load). */
  rc2?: boolean;
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
  else writeFileSync(cosign, o.rc2 ? RC2_COSIGN_STUB : COSIGN_STUB);
  chmodSync(cosign, 0o755);
  writeFileSync(join(work, 'trusted_root.json'), o.root ?? readFileSync(PINNED_ROOT));
  // The image download: a tar of the server's OCI layout of the rc.2 stick image.
  const layout = rc2Layout(
    { ...o.layout, ...(o.rc2 ? {} : { image: IMAGE }) },
    join(work, 'layout'),
  );
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
        INSTALL_TOKEN_VALUE: INSTALL_TOKEN,
        // The engine: Docker's containerd store, which names the loaded index by its digest.
        IMAGE_ID: layout.digest,
        LOADED: `${STICK_NAME}@${layout.digest}`,
        ...env,
      },
    });
    const text = readFileSync(log, 'utf8');
    const hdrs = join(work, 'headers');
    return {
      ...r,
      log: text,
      loaded: text.split('\n').some((l) => l.startsWith('docker load')),
      /** Each curl call's URL and the header its header file held. */
      headers: existsSync(hdrs) ? readFileSync(hdrs, 'utf8').split('\n').filter(Boolean) : [],
    };
  };
  /** The files of the tar the script gave `docker load`. */
  const loadedTar = (): Map<string, Buffer> => {
    const dir = mkdtempSync(join(work, 'loaded-'));
    const r = spawnSync('tar', ['-xf', join(work, 'loaded.tar'), '-C', dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`untar: ${r.stderr}`);
    const out = new Map<string, Buffer>();
    const walk = (rel: string) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const name = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(name);
        else out.set(name, readFileSync(join(dir, name)));
      }
    };
    walk('');
    return out;
  };
  return { run, voldir, work, bin, layout, loadedTar };
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

  test('refuses anything but Linux or macOS on x86_64 or aarch64, with a message', () => {
    const w = world();
    const bsd = w.run([CODE], { UNAME_S: 'FreeBSD' });
    expect(bsd.status).toBe(1);
    expect(bsd.stderr).toContain('Linux or macOS (Docker Desktop) only, not FreeBSD');
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
    expect(r.log).toContain(`mode 600 ${INSTALL_TOKEN}`);
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
    // It loads the tar it built, then tags the digest reference, never a `Loaded image` line.
    expect(lines.filter((l) => l.startsWith('docker load'))).toEqual([
      expect.stringMatching(new RegExp(`^docker load -i ${w.work}/tmp\\.\\w+/load\\.tar$`)),
    ]);
    expect(lines.filter((l) => l.startsWith('docker tag'))).toEqual([
      `docker tag ${STICK_REF} jumpmaster-stick:installed`,
    ]);
    expect(lines).toContain(`docker image inspect -f {{.Id}} ${STICK_REF}`);
    expect(r.log).not.toContain('docker image rm');
  });

  describe('on macOS with Docker Desktop', () => {
    const MAC = { UNAME_S: 'Darwin', UNAME_M: 'arm64', ID_U: '501', VOLDIR_HIDDEN: '1' };

    test('installs as the user, not root: cosign runs in a container with no network, the code goes in through stdin, the stick runs linux/arm64', () => {
      const w = world();
      const r = w.run([CODE], MAC);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Enrolled as vps-1. Back to your browser.');
      const lines = r.log.split('\n');
      expect(r.log).toContain('platform=linux/arm64');
      // The pinned Linux cosign is imported as a one-file image and run with no network, the
      // work directory mounted at the same path; the image goes once verification is done.
      const imp = lines.findIndex((l) => l.startsWith('docker import - '));
      const runCosign = lines.findIndex(
        (l) => l.startsWith('docker run ') && l.includes(' /cosign '),
      );
      const verify = lines.findIndex((l) =>
        l.startsWith('cosign verify-blob-attestation --bundle '),
      );
      const loaded = lines.findIndex((l) => l.startsWith('docker load'));
      expect(imp).toBeGreaterThanOrEqual(0);
      expect(runCosign).toBeGreaterThan(imp);
      expect(lines[runCosign]).toContain('--network none');
      expect(lines[runCosign]).toMatch(new RegExp(`-v (${w.work}/tmp\\.\\w+):\\1 `));
      expect(verify).toBeGreaterThan(runCosign);
      expect(loaded).toBeGreaterThan(verify);
      expect(lines.some((l) => l.startsWith('docker image rm jm-install-cosign'))).toBe(true);
      // The volume's Mountpoint is inside Docker Desktop's VM: the code is written by a
      // container, read from stdin, never on a command line, 0600, and removed once enrolled.
      expect(r.log).toContain(`mode 600 ${INSTALL_TOKEN}`);
      for (const l of lines.filter((l) => l.startsWith('docker '))) expect(l).not.toContain(CODE);
      expect(existsSync(join(w.voldir, 'enroll_code'))).toBe(false);
      const stick = lines.find((l) => l.startsWith('docker run -d ')) ?? '';
      expect(stick).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
      expect(stick).toContain('-e JM_IMAGE_POLICY=signed');
    });

    test('under sudo it hands the work directory to the user Docker Desktop reads files as, before cosign runs', () => {
      const w = world();
      const r = w.run([CODE], { ...MAC, ID_U: '0', SUDO_UID: '501', SUDO_GID: '20' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.log.split('\n');
      const chown = lines.findIndex((l) =>
        new RegExp(`^chown -R 501:20 ${w.work}/tmp\\.\\w+$`).test(l),
      );
      const runCosign = lines.findIndex(
        (l) => l.startsWith('docker run ') && l.includes(' /cosign '),
      );
      expect(chown).toBeGreaterThanOrEqual(0);
      expect(runCosign).toBeGreaterThan(chown);
    });

    test('without sudo it changes no owner', () => {
      const r = world().run([CODE], MAC);
      expect(r.status).toBe(0);
      expect(r.log).not.toMatch(/^chown /m);
    });

    test('without Docker it points at Docker Desktop and never runs get.docker.com, even with --yes', () => {
      const w = world({ docker: false });
      const r = w.run(['--yes', CODE], MAC);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Docker Desktop');
      expect(r.log).not.toContain('get.docker.com');
    });

    test('a failed enrollment removes the code from the volume through a container', () => {
      const w = world();
      const r = w.run([CODE], { ...MAC, ENROLL_FAIL: '1' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not enroll');
      expect(existsSync(join(w.voldir, 'enroll_code'))).toBe(false);
    });
  });

  test('on Linux a volume with no directory on this host (rootless Docker) gets the code through a container too', () => {
    const w = world();
    const r = w.run([CODE], { VOLDIR_HIDDEN: '1' });
    expect(r.status).toBe(0);
    expect(r.log).toContain(`mode 600 ${INSTALL_TOKEN}`);
    expect(existsSync(join(w.voldir, 'enroll_code'))).toBe(false);
  });

  test('on Linux under sudo it changes no owner', () => {
    const r = world().run([CODE], { SUDO_UID: '1000', SUDO_GID: '1000' });
    expect(r.status).toBe(0);
    expect(r.log).not.toMatch(/^chown /m);
  });

  test('Linux still requires root', () => {
    const w = world();
    const r = w.run([CODE], { ID_U: '1000' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run it as root');
  });

  describe('what it loads: a sparse index named by its digest, this platform alone (issue #168)', () => {
    for (const [uname, arch] of [
      ['x86_64', 'amd64'],
      ['aarch64', 'arm64'],
    ] as const)
      test(`on ${uname}`, () => {
        const w = world();
        const r = w.run([CODE], { UNAME_M: uname });
        expect(r.status, r.stderr).toBe(0);
        const files = w.loadedTar();
        const part = IMAGE[arch];
        const blob = (d: string) => `blobs/sha256/${d.slice(7)}`;
        expect([...files.keys()].sort()).toEqual(
          [
            'oci-layout',
            'index.json',
            'manifest.json',
            blob(DIGEST),
            blob(part.manifestDigest),
            blob(part.configDigest),
            blob(part.layerDigest),
          ].sort(),
        );
        const index = JSON.parse(String(files.get('index.json')));
        expect(index.manifests).toEqual([
          {
            mediaType: 'application/vnd.oci.image.index.v1+json',
            digest: DIGEST,
            size: IMAGE.index.length,
            annotations: {
              'io.containerd.image.name': STICK_REF,
              'org.opencontainers.image.ref.name': STICK_REF,
            },
          },
        ]);
        expect(JSON.parse(String(files.get('manifest.json')))).toEqual([
          {
            Config: blob(part.configDigest),
            RepoTags: [],
            Layers: [blob(part.layerDigest)],
          },
        ]);
        expect(files.get(blob(part.layerDigest))).toEqual(part.blobs[2]);
      });

    test('D5 parity: the same layout gives the stick and the installer byte-identical index.json and manifest.json', async () => {
      const w = world();
      expect(w.run([CODE]).status).toBe(0);
      const files = w.loadedTar();
      const bound = bindLayout(w.layout.dir, DIGEST, 'linux/amd64');
      expect(String(files.get('index.json'))).toBe(String(loadIndexJson(bound, STICK_REF)));
      const chunks: Buffer[] = [];
      for await (const c of loadTar(w.layout.dir, bound, STICK_REF)) chunks.push(c as Buffer);
      const stick = Buffer.concat(chunks);
      const at = stick.indexOf('[{"Config"');
      expect(at).toBeGreaterThan(0);
      expect(String(files.get('manifest.json'))).toBe(
        stick.subarray(at, stick.indexOf(0, at)).toString('utf8'),
      );
    });

    test('a platform blob missing from the download refuses before docker load', () => {
      const w = world();
      rmSync(join(w.layout.dir, 'blobs', 'sha256', IMAGE.amd64.layerDigest.slice(7)));
      spawnSync('tar', ['-cf', join(w.work, 'stick.tar'), '-C', w.layout.dir, '.']);
      const r = w.run([CODE]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`layer ${IMAGE.amd64.layerDigest} in the download does not hash`);
      expect(r.loaded).toBe(false);
    });

    test('the classic store answers the config digest: accepted', () => {
      const w = world();
      const r = w.run([CODE], { IMAGE_ID: IMAGE.amd64.configDigest });
      expect(r.status, r.stderr).toBe(0);
      expect(r.log).toContain(`docker tag ${STICK_REF} jumpmaster-stick:installed`);
    });

    for (const [name, id] of [
      ['another id', `sha256:${'e'.repeat(64)}`],
      ['the platform manifest digest', IMAGE.amd64.manifestDigest],
      ['no image at all', ''],
    ] as const)
      test(`the engine answers ${name} for the reference: what it loaded is removed, and it refuses`, () => {
        const w = world();
        const r = w.run([CODE], { IMAGE_ID: id });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`did not load the stick image as ${STICK_REF}`);
        expect(r.log).toContain(`docker image rm -f ${STICK_REF}`);
        expect(r.log).not.toContain('docker tag');
        expect(r.log).not.toContain('docker run');
      });
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

describe('the code is swapped for an install token at once, and a failure cancels (issue #269)', () => {
  const SPENT = 'this code was already used to start an install; make a new one on the sticks page';
  const WARNING = 'the invite may still be pending: press Cancel on the sticks page';
  const curls = (log: string) => log.split('\n').filter((l) => l.startsWith('curl '));
  const argv = (log: string) =>
    log.split('\n').filter((l) => /^(curl|docker|sudo|cosign|chown) /.test(l));

  test('CLAIM = PROOF: the script says where the code appears, and its first network call is the exchange, with the code in a header file', () => {
    const script = stickScript(SCRIPT_PARAMS);
    expect(script).toContain(
      "# The code appears on the pasted line (and so in ps, shell history and sudo's log) only until\n# the exchange, which is the first network call",
    );
    expect(script).not.toContain('The code goes in a header file, never on a command line');
    const r = world().run([CODE]);
    expect(r.status, r.stderr).toBe(0);
    const calls = curls(r.log);
    expect(calls[0]).toBe(
      `curl -sS -X POST -H @${calls[0]?.match(/-H @(\S+)/)?.[1]} -o ${calls[0]?.match(/-o (\S+)/)?.[1]} -w %{http_code} ${SERVER}/install/exchange`,
    );
    expect(r.headers[0]).toBe(`${SERVER}/install/exchange Authorization: Bearer ${CODE}`);
    // Every later call sends the token, never the code.
    expect(r.headers.length).toBe(calls.length);
    for (const h of r.headers.slice(1)) expect(h).toMatch(/ Authorization: Bearer jm_install_T+$/);
  });

  test('after the exchange no curl, docker or other argv holds the code or the token; the volume gets the token', () => {
    for (const env of [{}, { VOLDIR_HIDDEN: '1' }]) {
      const r = world().run([CODE], env);
      expect(r.status, r.stderr).toBe(0);
      for (const l of argv(r.log)) {
        expect(l).not.toContain(CODE);
        expect(l).not.toContain(INSTALL_TOKEN);
      }
      expect(r.log).toContain(`mode 600 ${INSTALL_TOKEN}`);
      expect(r.log).not.toContain(`mode 600 ${CODE}`);
      expect(r.log).not.toContain('/install/cancel');
    }
  });

  test("a refused exchange shows the server's reason and stops: nothing downloaded, nothing to cancel", () => {
    const r = world().run([CODE], { EXCHANGE_STATUS: '401', EXCHANGE_ERROR: SPENT });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(SPENT);
    expect(curls(r.log)).toHaveLength(1);
    expect(r.log).not.toContain('/install/cancel');
    expect(r.log).not.toMatch(/^docker (load|run)/m);
  });

  test('a stick already installed here stops before the exchange, so the code is not spent', () => {
    const r = world().run([CODE], { EXISTS: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already installed');
    expect(curls(r.log)).toEqual([]);
  });

  const failures: [string, WorldOptions, Record<string, string>, string][] = [
    ['docker run failed', {}, { RUN_FAIL: '1' }, 'docker run failed'],
    ['enroll failed', {}, { ENROLL_FAIL: '1' }, 'could not enroll'],
    ['the timeout', {}, { ENROLL_SILENT: '1', JM_INSTALL_WAIT: '1' }, 'did not enroll within 1'],
    ['verification failed', {}, { COSIGN_FAIL: '1' }, 'is not signed by'],
    ['a download failed', {}, {}, 'could not download cosign'],
    ['Docker refused', { docker: false }, {}, 'Docker is not installed'],
  ];
  for (const [name, o, env, why] of failures) {
    test(`D2: ${name} → a cancel call with the token, then non-zero, never success`, () => {
      const w = world(o);
      if (name === 'a download failed') writeFileSync(join(w.work, 'no-cosign'), '');
      const r = w.run([CODE], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(why);
      expect(r.stdout).not.toContain('Enrolled as');
      const calls = curls(r.log);
      const last = calls.at(-1) ?? '';
      expect(last).toMatch(
        new RegExp(`^curl -fsS -m 5 -X POST -H @\\S+ -o /dev/null ${SERVER}/install/cancel$`),
      );
      expect(calls.filter((l) => l.includes('/install/cancel'))).toHaveLength(1);
      expect(r.headers.at(-1)).toBe(
        `${SERVER}/install/cancel Authorization: Bearer ${INSTALL_TOKEN}`,
      );
      expect(r.stderr).not.toContain(WARNING);
    });
  }

  test('a failing cancel adds the warning, and still exits non-zero', () => {
    const r = world().run([CODE], { ENROLL_FAIL: '1', CANCEL_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not enroll');
    expect(r.stderr).toContain(WARNING);
    expect(r.stdout).not.toContain('Enrolled as');
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
      const w = world({ layout, repo, realCosign: real, rc2: true });
      const installer = w.run([CODE]);
      const stick = await verifyLayout(
        w.layout.dir,
        `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@${w.layout.digest}`,
        {
          policy: 'signed',
          allowed: new Set(),
          // A stick at the fixture's own release (v0.4.0-rc.2), so the version floor (#270),
          // which the installer doesn't apply to the stick image it pins, passes.
          signer: releaseSigner(repo, '0.4.0-rc.2'),
          cosign: execCosign(join(w.work, 'cosign-stub'), { PATH: w.bin }),
          trustedRoot: PINNED_ROOT,
        },
      );
      expect(stick.ok, JSON.stringify(stick)).toBe(want);
      expect(installer.stdout.includes(`Signed by ${repo}'s release workflow`)).toBe(want);
      // The rc.2 fixtures hold no platform blobs, so even a verified one is never loaded.
      expect(installer.loaded, installer.stderr).toBe(false);
      if (want) expect(installer.stderr).toContain('has no linux/amd64 image');
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

/**
 * The words `sh` splits `line` into when it runs it, with `curl` and `sudo` stubbed: curl prints
 * each argument it got on its own line to stderr, and nothing runs as root or reaches the network.
 */
function curlArgs(line: string): string[] {
  const r = spawnSync(
    'sh',
    [
      '-c',
      `curl() { for a; do printf '[%s]\\n' "$a" >&2; done; }; sudo() { cat >/dev/null; }; ${line}`,
    ],
    { encoding: 'utf8' },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stderr.split('\n').filter((l) => l !== '');
}

describe('the pasted line carries the URL as one single-quoted shell word (issue #254)', () => {
  test('installLine quotes the address', () => {
    expect(installLine('https://h.example', 'jm_enroll_x')).toBe(
      "curl -fsSL 'https://h.example/install/stick.sh' | sudo sh -s -- jm_enroll_x",
    );
  });

  // Constructed directly, past validation: the quoting holds on its own.
  const HOSTILE = "https://h.example';touch /tmp/jm-pwned-254;'$(id)`id`;x";

  test('installLine: a value with a quote is still one word to sh', () => {
    const line = installLine(HOSTILE, 'jm_enroll_x');
    expect(spawnSync('sh', ['-n', '-c', line]).status).toBe(0);
    expect(curlArgs(line)).toEqual(['[-fsSL]', `[${HOSTILE}/install/stick.sh]`]);
  });

  test('cloudInit: the runcmd entry is the same line, still one word to sh', () => {
    const doc = load(cloudInit(HOSTILE, 'jm_enroll_x')) as { runcmd: string[] };
    const line = doc.runcmd.find((c) => c.includes('/install/stick.sh')) as string;
    expect(line).toBe(installLine(HOSTILE, 'jm_enroll_x'));
    expect(curlArgs(line)).toEqual(['[-fsSL]', `[${HOSTILE}/install/stick.sh]`]);
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
