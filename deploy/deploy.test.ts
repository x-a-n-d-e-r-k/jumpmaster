// The compose install as a release publishes it: deploy/compose.yaml.tmpl rendered with a lock,
// the .env example and the from-source override (checked with `docker compose config` where Docker
// is), and the smoke cases (deploy/smoke.sh), which run here only with JM_SMOKE=1.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
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
  restart?: string;
  tmpfs?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  secrets?: string[];
  build?: unknown;
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] };
};
type Compose = {
  services: Record<string, Service>;
  secrets?: unknown;
  volumes?: Record<string, unknown>;
};

const TEMPLATE = read('deploy/compose.yaml.tmpl');
const rendered = renderCompose(TEMPLATE, LOCK);
const compose = load(rendered) as Compose;
const svc = (name: string): Service => {
  const s = compose.services[name];
  if (!s) throw new Error(`no service ${name}`);
  return s;
};
const USER = '${JM_UID:-1000}:${JM_GID:-1000}';
/** The credentials the server reads from /secrets by name (Task 4): never a compose variable. */
const CREDENTIALS = ['CLAUDE', 'GITHUB_AUTHOR', 'GITHUB_REVIEWER', 'GITHUB_READ'];

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
/** The environment `docker compose` runs with here: none of the install's own variables. */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(JM_|DOCKER_SOCKET)/.test(k)),
  ) as NodeJS.ProcessEnv;

describe('the released compose file', () => {
  test('the default compose declares no secrets key, no credential _FILE variable and no init .env interpolation, and reads the machine secrets from /secrets', () => {
    expect(compose.secrets).toBeUndefined();
    expect(TEMPLATE).not.toMatch(/^secrets:/m);
    expect(TEMPLATE).not.toMatch(/JM_(REVIEWER|READ)_TOKEN_(FILE|SRC)/);
    expect(TEMPLATE).not.toContain('/run/secrets');
    for (const [name, s] of Object.entries(compose.services)) {
      expect(s.secrets, name).toBeUndefined();
      for (const c of CREDENTIALS) {
        expect(s.environment?.[`JM_${c}_TOKEN_FILE`], `${name} JM_${c}_TOKEN_FILE`).toBeUndefined();
        expect(s.environment?.[`JM_${c}_TOKEN`], `${name} JM_${c}_TOKEN`).toBeUndefined();
      }
    }
    expect(svc('jumpmaster').environment).toEqual({
      JM_CONFIG: '/config/jumpmaster.config.json',
      JM_DATA_DIR: '/data',
      JM_SECRETS_DIR: '/secrets',
      JM_LISTEN_HOST: '0.0.0.0',
      JM_ALLOWED_HOSTS: '127.0.0.1:7420,localhost:7420',
      JM_JOIN_TOKEN_FILE: '/secrets/join_token',
      JM_OPERATOR_TOKEN_FILE: '/secrets/operator_token',
      JM_VAULT_KEY_FILE: '/secrets/vault_key',
    });
    expect(svc('jumpmaster').command).toEqual(['serve']);
    expect(svc('jumpmaster').volumes).toEqual([
      './data:/data',
      './config:/config:ro',
      './secrets:/secrets:ro',
    ]);
    expect(svc('stick').environment?.JM_JOIN_TOKEN_FILE).toBe('/secrets/join_token');
    expect(svc('stick').volumes).toContain('./secrets:/secrets:ro');
    // Every JM_ secret is a file under /secrets, never a value.
    for (const [name, s] of Object.entries(compose.services))
      for (const [key, value] of Object.entries(s.environment ?? {}))
        if (/^JM_.*(TOKEN|SECRET|KEY)(_FILE)?$/.test(key)) {
          expect(key, `${name}.${key}`).toMatch(/_FILE$/);
          expect(String(value), `${name}.${key}`).toMatch(/^\/secrets\/[a-z_]+$/);
        }
  });

  test('bootstrap runs before the server and the stick, as the same uid, with the install directory read-write', () => {
    const b = svc('bootstrap');
    expect(b.image).toBe(svc('jumpmaster').image);
    expect(b.command).toEqual(['bootstrap']);
    expect(b.user).toBe(USER);
    expect(b.restart).toBe('no');
    expect(b.read_only).toBe(true);
    expect(b.cap_drop).toEqual(['ALL']);
    expect(b.security_opt).toEqual(['no-new-privileges:true']);
    expect(b.volumes).toEqual(['.:/install']);
    expect(b.environment).toEqual({ JM_INSTALL_DIR: '/install' });
    expect(b.ports).toBeUndefined();
    expect(b.profiles).toBeUndefined();
    const done = { condition: 'service_completed_successfully' };
    expect(svc('jumpmaster').depends_on).toEqual({ bootstrap: done });
    expect(svc('stick').depends_on).toEqual({
      bootstrap: done,
      jumpmaster: { condition: 'service_healthy' },
    });
    expect(svc('jumpmaster').user).toBe(USER);
  });

  test('JM_UID and JM_GID default to 1000 in the template, and .env.example says the M4 init block is unused', () => {
    for (const name of ['jumpmaster', 'bootstrap', 'init']) expect(svc(name).user).toBe(USER);
    expect(TEMPLATE).not.toContain('JM_UID:?');
    const env = read('deploy/.env.example');
    // Optional: commented out, with the default named.
    expect(env).toMatch(/^#JM_UID=1000$/m);
    expect(env).toMatch(/^#JM_GID=1000$/m);
    expect(env).not.toMatch(/^JM_UID=/m);
    expect(env).toMatch(/optional/i);
    expect(env).toMatch(/jumpmaster init: begin/);
    expect(env).toMatch(/unused/);
    expect(env).toMatch(/may be deleted/);
    for (const v of ['DOCKER_SOCKET', 'JM_SLOTS', 'JM_DROP_SUBNET_POOL', 'JM_ALLOWED_IMAGES'])
      expect(env).toContain(v);
    // Nothing secret belongs in .env.
    expect(env).not.toMatch(/^JM_[A-Z_]*TOKEN/m);
  });

  test('the template needs no override file and no Compose YAML tags', () => {
    expect(TEMPLATE).not.toMatch(/!override|!reset/);
    expect(TEMPLATE).not.toMatch(/compose\.override/);
  });

  test('only the stick service mounts a docker socket', () => {
    const socket = Object.entries(compose.services)
      .filter(([, s]) => (s.volumes ?? []).some((v) => /docker\.sock|DOCKER_SOCKET/.test(v)))
      .map(([n]) => n);
    expect(socket).toEqual(['stick']);
  });

  test('the jumpmaster service publishes 127.0.0.1 only, is read_only, healthchecked and has tmpfs /tmp', () => {
    const j = svc('jumpmaster');
    expect(j.ports).toEqual(['127.0.0.1:7420:7420']);
    expect(j.read_only).toBe(true);
    expect(j.tmpfs).toEqual(['/tmp']);
    expect(j.cap_drop).toEqual(['ALL']);
    expect(j.security_opt).toEqual(['no-new-privileges:true']);
    // Health is an HTTP answer on the loopback the image listens on, with the image's own node.
    expect(j.healthcheck?.test.join(' ')).toMatch(/fetch\('http:\/\/127\.0\.0\.1:7420\/login'/);
    for (const s of Object.values(compose.services))
      for (const p of s.ports ?? []) expect(p).toMatch(/^127\.0\.0\.1:/);
  });

  test('init runs as the host user with the install directory read-write, never started by up', () => {
    const init = svc('init');
    expect(init.profiles).toEqual(['init']);
    expect(init.entrypoint).toEqual(['jumpmaster', 'init']);
    expect(init.volumes).toEqual(['.:/install']);
    expect(init.environment?.JM_INSTALL_DIR).toBe('/install');
    expect(init.image).toBe(svc('jumpmaster').image);
    expect(init.read_only).toBe(true);
    expect(init.cap_drop).toEqual(['ALL']);
  });

  test('the stick service sets JM_IMAGE_POLICY=signed and keeps state on a volume', () => {
    const s = svc('stick');
    expect(s.environment).toMatchObject({
      JM_SERVER_URL: 'http://jumpmaster:7420',
      JM_IMAGE_POLICY: 'signed',
      JM_STATE_DIR: '/state',
      JM_SLOTS: '${JM_SLOTS:-1}',
      JM_DROP_SUBNET_POOL: '${JM_DROP_SUBNET_POOL:-}',
      JM_EGRESS_IMAGE: `ghcr.io/x-a-n-d-e-r-k/jumpmaster-egress@${LOCK.images['jumpmaster-egress']}`,
    });
    expect(s.volumes).toContain('jm-stick:/state');
    expect(compose.volumes).toHaveProperty('jm-stick');
    expect(s.read_only).toBe(true);
    expect(s.tmpfs).toEqual(['/tmp']);
  });

  test('every image is the release image by digest, bootstrap and init alike', () => {
    const server = `ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@${LOCK.images['jumpmaster-server']}`;
    for (const name of ['jumpmaster', 'bootstrap', 'init']) expect(svc(name).image).toBe(server);
    expect(svc('stick').image).toBe(
      `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@${LOCK.images['jumpmaster-stick']}`,
    );
  });

  test.skipIf(!hasCompose)('docker compose accepts it in an empty directory, with no .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-compose-'));
    writeFileSync(join(dir, 'compose.yaml'), rendered);
    const r = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv(),
    });
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      services: Record<string, { user?: string; environment?: Record<string, string | null> }>;
      secrets?: unknown;
    };
    expect(doc.secrets).toBeUndefined();
    expect(doc.services.jumpmaster?.user).toBe('1000:1000');
    expect(doc.services.bootstrap?.user).toBe('1000:1000');
    expect(doc.services.jumpmaster?.environment?.JM_VAULT_KEY_FILE).toBe('/secrets/vault_key');
    // An M4 .env (its uid and init's block) is accepted, and the block changes nothing.
    writeFileSync(
      join(dir, '.env'),
      'JM_UID=1234\nJM_GID=1234\n# jumpmaster init: begin (rerun init to change these lines)\nJM_REVIEWER_TOKEN_FILE=\nJM_REVIEWER_TOKEN_SRC=/dev/null\n# jumpmaster init: end\n',
    );
    const m4 = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv(),
    });
    expect(m4.status, m4.stderr).toBe(0);
    const up = JSON.parse(m4.stdout) as typeof doc;
    expect(up.services.jumpmaster?.user).toBe('1234:1234');
    expect(up.services.jumpmaster?.environment).toEqual(doc.services.jumpmaster?.environment);
  });
});

describe('the from-source override', () => {
  const build = load(read('deploy/compose.build.yaml')) as Compose;

  test('builds the server and stick from this checkout, and runs local images unsigned', () => {
    for (const name of ['jumpmaster', 'stick', 'init', 'bootstrap'])
      expect(build.services[name]?.image, name).toMatch(/^jumpmaster-(server|stick):dev$/);
    expect(build.services.bootstrap?.image).toBe('jumpmaster-server:dev');
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
      { encoding: 'utf8', env: { ...cleanEnv(), JM_SOURCE: ROOT } },
    );
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as { services: Record<string, { image: string }> };
    expect(doc.services.jumpmaster?.image).toBe('jumpmaster-server:dev');
    expect(doc.services.bootstrap?.image).toBe('jumpmaster-server:dev');
    expect(doc.services.stick?.image).toBe('jumpmaster-stick:dev');
  });
});

/**
 * The smoke cases, live: each runs `deploy/smoke.sh --case <name>` against the :dev images
 * (`docker build` as images.yml does). They need Docker and minutes, so they run only with
 * JM_SMOKE=1 and are skipped by name otherwise; CI's image job runs the script itself.
 */
const SMOKE = process.env.JM_SMOKE === '1';
const smoke = (name: string) => {
  const r = spawnSync(join(ROOT, 'deploy/smoke.sh'), ['--case', name], {
    encoding: 'utf8',
    timeout: 15 * 60_000,
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return r.stdout;
};

/** A smoke case spends minutes on images and waits: each gets its own limit (tests in a file run in order). */
const LIVE = { timeout: 15 * 60_000 };

describe('the compose smoke, live (JM_SMOKE=1)', () => {
  test.skipIf(!SMOKE)(
    'from a directory holding only .env, compose up reaches the setup page',
    LIVE,
    () => {
      expect(smoke('env-only')).toMatch(/case env-only: pass/);
    },
  );

  test.skipIf(!SMOKE)('from an empty directory, compose up reaches the setup page', LIVE, () => {
    expect(smoke('empty')).toMatch(/case empty: pass/);
  });

  test.skipIf(!SMOKE)(
    'with root-owned bind directories the first up prints the chown line and the second reaches the setup page',
    LIVE,
    () => {
      expect(smoke('root-owned')).toMatch(/case root-owned: (pass|skipped)/);
    },
  );

  test.skipIf(!SMOKE)(
    'an init-written M4 directory upgrades by replacing compose.yaml: every credential resolves as file and no zone is parked',
    LIVE,
    () => {
      expect(smoke('upgrade')).toMatch(/case upgrade: pass/);
    },
  );

  test.skipIf(!SMOKE)(
    'the host export line and mode file round-trip on the upgraded install',
    LIVE,
    () => {
      expect(smoke('roundtrip')).toMatch(/case roundtrip: pass/);
    },
  );
});
