// The stick installer (issue #138), run with `sh` against stubbed uname, id, docker, curl and
// cosign on a PATH of its own, and the cloud-init snippet.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
  COSIGN_SHA256,
  cloudInit,
  identityRegexp,
  installLine,
  repositoryOf,
  stickScript,
} from './stick-sh.js';

const SERVER = 'https://jm.tail1234.ts.net';
const DIGEST = `sha256:${'d'.repeat(64)}`;
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
];

const which = (cmd: string): string => {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const path = r.stdout.trim();
  if (r.status !== 0 || !path.startsWith('/')) throw new Error(`no ${cmd} on this machine`);
  return path;
};

const COSIGN_STUB = `#!/bin/sh
echo "cosign $*" >>"$LOG"
if [ -n "\${COSIGN_FAIL:-}" ]; then echo 'Error: no matching signatures' >&2; exit 1; fi
printf '[{"critical":{"image":{"docker-manifest-digest":"%s"}}}]\\n' "$SIGNED_DIGEST"
`;

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
  */install/cosign*) cp "$WORK/cosign-stub" "$out" ;;
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

function world(o: { docker?: boolean; script?: string } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'jm-installer-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  for (const t of TOOLS) symlinkSync(which(t), join(bin, t));
  for (const [name, body] of Object.entries(STUBS)) {
    if (name === 'docker' && o.docker === false) continue;
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  }
  writeFileSync(join(work, 'cosign-stub'), COSIGN_STUB, { mode: 0o755 });
  // The image download: a tar of an OCI layout (its content is cosign's business here).
  const layout = join(work, 'layout');
  mkdirSync(layout);
  writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  writeFileSync(join(layout, 'index.json'), '{}');
  spawnSync('tar', ['-cf', join(work, 'stick.tar'), '-C', layout, '.']);
  const voldir = join(work, 'volume');
  mkdirSync(voldir);
  const log = join(work, 'log');
  writeFileSync(log, '');
  const script =
    o.script ??
    stickScript({
      serverUrl: SERVER,
      image: { ref: `ghcr.io/o/jumpmaster-stick@${DIGEST}`, digest: DIGEST },
      signerRepository: 'o/jumpmaster',
      cosignSha256: {
        amd64: createHash('sha256').update(COSIGN_STUB).digest('hex'),
        arm64: 'f'.repeat(64),
      },
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
        SIGNED_DIGEST: DIGEST,
        TMPDIR: work,
        JM_INSTALL_TTY: join(work, 'no-tty'),
        JM_INSTALL_WAIT: '3',
        ...env,
      },
    });
    return { ...r, log: readFileSync(log, 'utf8') };
  };
  return { run, voldir, work };
}

describe('the installer script', () => {
  test('parses with sh -n', () => {
    const r = spawnSync('sh', ['-n'], {
      input: stickScript({
        serverUrl: SERVER,
        image: { ref: `ghcr.io/o/jumpmaster-stick@${DIGEST}`, digest: DIGEST },
        signerRepository: 'o/jumpmaster',
        cosignSha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) },
      }),
    });
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
    // cosign before load, with the pinned identity, offline.
    const verify = lines.findIndex((l) => l.startsWith('cosign verify --local-image --offline'));
    const loaded = lines.findIndex((l) => l.startsWith('docker load'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(loaded).toBeGreaterThan(verify);
    expect(lines[verify]).toContain('--certificate-github-workflow-repository o/jumpmaster');
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
    expect(r.stderr).toContain('not signed by o/jumpmaster');
    expect(r.log).not.toContain('docker load');
    expect(r.log).not.toContain('docker run');
  });

  test('cosign verifying another digest stops before docker load', () => {
    const w = world();
    const r = w.run([CODE], { SIGNED_DIGEST: `sha256:${'e'.repeat(64)}` });
    expect(r.status).toBe(1);
    expect(r.log).not.toContain('docker load');
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
      script: stickScript({
        serverUrl: SERVER,
        image: null,
        signerRepository: 'o/jumpmaster',
        cosignSha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) },
      }),
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
