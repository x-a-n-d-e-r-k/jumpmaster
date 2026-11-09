// The compose install as a release publishes it: deploy/compose.yaml.tmpl rendered with a lock,
// the .env example, the from-source override, and the override `jumpmaster init` writes for
// starter mode and private repositories (checked with `docker compose config` where Docker is).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { composeEnv, withEnvBlock } from '../apps/server/src/init.js';
import { RELEASE_IMAGES, renderCompose } from '../scripts/render-compose.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const LOCK = {
  registry: 'ghcr.io/x-a-n-d-e-r-k',
  images: Object.fromEntries(RELEASE_IMAGES.map((n, i) => [n, digest('abcdef0'[i] as string)])),
};

type Service = {
  image?: string;
  user?: string;
  command?: string | string[];
  entrypoint?: string | string[];
  profiles?: string[];
  read_only?: boolean;
  tmpfs?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  secrets?: string[];
  build?: unknown;
};
type Compose = {
  services: Record<string, Service>;
  secrets: Record<string, { file: string }>;
  volumes?: Record<string, unknown>;
};

const rendered = renderCompose(read('deploy/compose.yaml.tmpl'), LOCK);
const compose = load(rendered) as Compose;
const svc = (name: string): Service => {
  const s = compose.services[name];
  if (!s) throw new Error(`no service ${name}`);
  return s;
};

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

describe('the released compose file', () => {
  test('only the stick service mounts a docker socket', () => {
    const socket = Object.entries(compose.services)
      .filter(([, s]) => (s.volumes ?? []).some((v) => /docker\.sock|DOCKER_SOCKET/.test(v)))
      .map(([n]) => n);
    expect(socket).toEqual(['stick']);
    expect(svc('stick').volumes).toContain(
      '${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock',
    );
  });

  test('jumpmaster and init run as ${JM_UID}:${JM_GID}; init mounts the install dir read-write', () => {
    for (const name of ['jumpmaster', 'init'])
      expect(svc(name).user).toMatch(/^\$\{JM_UID:\?[^}]*\}:\$\{JM_GID:\?[^}]*\}$/);
    const init = svc('init');
    expect(init.profiles).toEqual(['init']);
    expect(init.entrypoint).toEqual(['jumpmaster', 'init']);
    expect(init.volumes).toEqual(['.:/install']);
    expect(init.environment?.JM_INSTALL_DIR).toBe('/install');
    expect(init.image).toBe(svc('jumpmaster').image);
    expect(init.read_only).toBe(true);
    expect(init.cap_drop).toEqual(['ALL']);
  });

  test('the jumpmaster service publishes 127.0.0.1 only, is read_only and has tmpfs /tmp', () => {
    const j = svc('jumpmaster');
    expect(j.ports).toEqual(['127.0.0.1:7420:7420']);
    expect(j.read_only).toBe(true);
    expect(j.tmpfs).toEqual(['/tmp']);
    expect(j.cap_drop).toEqual(['ALL']);
    expect(j.security_opt).toEqual(['no-new-privileges:true']);
    expect(j.command).toEqual(['serve', '/config/jumpmaster.config.json']);
    expect(j.volumes).toEqual(['./data:/data', './config:/config:ro']);
    for (const s of Object.values(compose.services))
      for (const p of s.ports ?? []) expect(p).toMatch(/^127\.0\.0\.1:/);
  });

  test('no compose service passes a JM_ secret as a plain environment value', () => {
    const secretVar = /^JM_.*(TOKEN|SECRET)/;
    // A secret's variable names a file under /run/secrets, possibly behind a .env default.
    const fileRef =
      /^(\/run\/secrets\/[a-z_]+|\$\{JM_[A-Z_]+-\/run\/secrets\/[a-z_]+\}|\$\{JM_[A-Z_]+:-\})$/;
    for (const [name, s] of Object.entries(compose.services))
      for (const [key, value] of Object.entries(s.environment ?? {})) {
        if (!secretVar.test(key)) continue;
        expect(key, `${name}.${key}`).toMatch(/_FILE$/);
        expect(String(value), `${name}.${key}`).toMatch(fileRef);
      }
    // Each secret is a file next to compose.yaml (or /dev/null for one that is off).
    for (const [name, def] of Object.entries(compose.secrets))
      expect(def.file).toMatch(
        new RegExp(`^(\\./secrets/${name}|\\$\\{JM_[A-Z_]+:-(\\./secrets/${name}|/dev/null)\\})$`),
      );
  });

  test('the template needs no override file and no Compose YAML tags', () => {
    const tmpl = read('deploy/compose.yaml.tmpl');
    expect(tmpl).not.toMatch(/!override|!reset/);
    expect(svc('jumpmaster').environment).toMatchObject({
      JM_GITHUB_REVIEWER_TOKEN_FILE: '${JM_REVIEWER_TOKEN_FILE-/run/secrets/github_reviewer_token}',
      JM_GITHUB_READ_TOKEN_FILE: '${JM_READ_TOKEN_FILE:-}',
    });
    expect(compose.secrets.github_reviewer_token?.file).toBe(
      '${JM_REVIEWER_TOKEN_SRC:-./secrets/github_reviewer_token}',
    );
    expect(compose.secrets.github_read_token?.file).toBe('${JM_READ_TOKEN_SRC:-/dev/null}');
    expect(svc('jumpmaster').secrets).toContain('github_read_token');
  });

  test('the stick service sets JM_IMAGE_POLICY=signed and keeps state on a volume', () => {
    const s = svc('stick');
    expect(s.environment).toMatchObject({
      JM_SERVER_URL: 'http://jumpmaster:7420',
      JM_IMAGE_POLICY: 'signed',
      JM_STATE_DIR: '/state',
      JM_JOIN_TOKEN_FILE: '/run/secrets/join_token',
      JM_SLOTS: '${JM_SLOTS:-1}',
      JM_DROP_SUBNET_POOL: '${JM_DROP_SUBNET_POOL:-}',
      // The release's own proxy, by digest, from the lock the compose file was rendered with.
      JM_EGRESS_IMAGE: `ghcr.io/x-a-n-d-e-r-k/jumpmaster-egress@${LOCK.images['jumpmaster-egress']}`,
    });
    expect(s.volumes).toContain('jm-stick:/state');
    expect(compose.volumes).toHaveProperty('jm-stick');
    expect(s.read_only).toBe(true);
    expect(s.tmpfs).toEqual(['/tmp']);
    expect(s.secrets).toEqual(['join_token']);
  });

  test('every image is the release image by digest, the server and init alike', () => {
    expect(svc('jumpmaster').image).toBe(
      `ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@${LOCK.images['jumpmaster-server']}`,
    );
    expect(svc('stick').image).toBe(
      `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@${LOCK.images['jumpmaster-stick']}`,
    );
  });

  test('.env.example names the uid, gid and the optional stick settings', () => {
    const env = read('deploy/.env.example');
    for (const v of ['JM_UID=', 'JM_GID=', 'DOCKER_SOCKET', 'JM_SLOTS', 'JM_DROP_SUBNET_POOL'])
      expect(env).toContain(v);
    // Nothing secret belongs in .env.
    expect(env).not.toMatch(/^JM_[A-Z_]*TOKEN/m);
  });
});

describe("init's .env block", () => {
  test('starter mode unmounts the reviewer token; a private repository mounts the read token', () => {
    expect(composeEnv({ starter: false, privateRepo: false })).toEqual([]);
    expect(composeEnv({ starter: true, privateRepo: false })).toEqual([
      'JM_REVIEWER_TOKEN_FILE=',
      'JM_REVIEWER_TOKEN_SRC=/dev/null',
    ]);
    const both = composeEnv({ starter: true, privateRepo: true });
    expect(both).toContain('JM_READ_TOKEN_SRC=./secrets/github_read_token');
    // The block replaces itself and leaves the operator's lines alone.
    const once = withEnvBlock('JM_UID=1\nJM_GID=1\n', both);
    expect(withEnvBlock(once, both)).toBe(once);
    expect(withEnvBlock(once, [])).toBe('JM_UID=1\nJM_GID=1\n');
  });

  test.skipIf(!hasCompose)('docker compose resolves the .env block as intended', () => {
    const resolve = (lines: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'));
      writeFileSync(join(dir, 'compose.yaml'), rendered);
      writeFileSync(join(dir, '.env'), withEnvBlock('JM_UID=1000\nJM_GID=1000\n', lines));
      const r = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
        cwd: dir,
        encoding: 'utf8',
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !/^(JM_|DOCKER_SOCKET)/.test(k)),
        ),
      });
      expect(r.status, r.stderr).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        services: Record<
          string,
          { environment?: Record<string, string | null>; secrets?: { source: string }[] }
        >;
        secrets: Record<string, { file: string }>;
      };
      return { doc };
    };
    const plain = resolve([]).doc;
    expect(plain.services.jumpmaster?.environment?.JM_GITHUB_REVIEWER_TOKEN_FILE).toBe(
      '/run/secrets/github_reviewer_token',
    );
    expect(plain.services.jumpmaster?.environment?.JM_GITHUB_READ_TOKEN_FILE ?? '').toBe('');
    expect(plain.secrets.github_read_token?.file).toBe('/dev/null');
    const { doc } = resolve(composeEnv({ starter: true, privateRepo: true }));
    const env = doc.services.jumpmaster?.environment ?? {};
    expect(env.JM_GITHUB_REVIEWER_TOKEN_FILE ?? '').toBe('');
    expect(env.JM_GITHUB_READ_TOKEN_FILE).toBe('/run/secrets/github_read_token');
    expect(doc.secrets.github_reviewer_token?.file).toBe('/dev/null');
    expect(doc.secrets.github_read_token?.file).toMatch(/\/secrets\/github_read_token$/);
    expect(doc.services.stick?.secrets?.map((s) => s.source)).toEqual(['join_token']);
  });
});

describe('the from-source override', () => {
  const build = load(read('deploy/compose.build.yaml')) as Compose;

  test('builds the server and stick from this checkout, and runs local images unsigned', () => {
    for (const name of ['jumpmaster', 'stick', 'init'])
      expect(build.services[name]?.image, name).toMatch(/^jumpmaster-(server|stick):dev$/);
    expect(build.services.jumpmaster?.build).toBeDefined();
    expect(build.services.stick?.build).toBeDefined();
    expect(build.services.jumpmaster?.environment?.JM_DEV_IMAGES).toBe('1');
    expect(build.services.stick?.environment?.JM_IMAGE_POLICY).toBe('allowlist');
    expect(build.services.stick?.environment?.JM_EGRESS_IMAGE).toBe('jumpmaster-egress:dev');
  });

  test.skipIf(!hasCompose)('docker compose accepts it over the template', () => {
    const r = spawnSync(
      'docker',
      [
        'compose',
        '--project-directory',
        mkdtempSync(join(tmpdir(), 'jm-dev-')),
        '-f',
        join(ROOT, 'deploy/compose.yaml.tmpl'),
        '-f',
        join(ROOT, 'deploy/compose.build.yaml'),
        'config',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, JM_UID: '1000', JM_GID: '1000', JM_SOURCE: ROOT },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as { services: Record<string, { image: string }> };
    expect(doc.services.jumpmaster?.image).toBe('jumpmaster-server:dev');
    expect(doc.services.stick?.image).toBe('jumpmaster-stick:dev');
  });
});
