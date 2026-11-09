// Static checks on the shipped Dockerfiles and the image workflow. The runtime behaviour (uid,
// read-only root, file secrets, enrollment) is checked by images/smoke.sh, which images.yml runs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { type Instruction, instructions, LOCAL_IMAGE_FILES, walk } from '../scripts/repo-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** The instructions of the last stage (from its FROM on). */
const finalStage = (all: Instruction[]): Instruction[] =>
  all.slice(all.map((i) => i.op).lastIndexOf('FROM'));

const SHIPPED = [
  'images/server/Dockerfile',
  'images/stick/Dockerfile',
  'images/trooper/Dockerfile',
  'images/egress/Dockerfile',
];
const dockerfiles = () =>
  walk(ROOT, ['images']).filter((f) => /(^|\/)Dockerfile(\.[^/]*)?$|\.Dockerfile$/.test(f));

describe('Dockerfiles', () => {
  test('the shipped Dockerfiles exist', () => {
    for (const file of SHIPPED) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  test('the server image ends with a non-root USER and installs no docker client', () => {
    const text = read('images/server/Dockerfile');
    const users = finalStage(instructions(text)).filter((i) => i.op === 'USER');
    const last = users.at(-1)?.args ?? '';
    expect(last).toMatch(/^\d+(:\d+)?$/);
    expect(last.split(':')[0]).not.toBe('0');
    // No Docker CLI, engine or API client in any stage of the server image.
    expect(text).not.toMatch(/docker(\.io|-ce|-cli)|\bdockerode\b|@jumpmaster\/stick|apps\/stick/);
    const final = finalStage(instructions(text));
    expect(final).toContainEqual(expect.objectContaining({ op: 'WORKDIR', args: '/app' }));
    expect(final.some((i) => i.op === 'ENV' && /\bJM_CONTAINER=1\b/.test(i.args))).toBe(true);
    expect(final.some((i) => i.op === 'ENV' && /\bTMPDIR=\/tmp\b/.test(i.args))).toBe(true);
  });

  test('the server image carries the files the server reads at runtime', () => {
    // payloads.ts reads ../../trooper/prompts/<role>.md and migrations.ts reads ./schema.sql,
    // both relative to the compiled module; /app keeps the repository layout.
    const text = read('images/server/Dockerfile');
    expect(text).toMatch(/apps\/trooper\/prompts/);
    expect(text).toMatch(/schema\.sql apps\/server\/dist\/db\/schema\.sql/);
    expect(read('apps/server/src/payloads.ts')).toContain('../../trooper/prompts/');
  });

  test('the stick image runs as root with its writable state under /state', () => {
    const final = finalStage(instructions(read('images/stick/Dockerfile')));
    expect(final.filter((i) => i.op === 'USER').at(-1)?.args).toBe('root');
    const env = final
      .filter((i) => i.op === 'ENV')
      .map((i) => i.args)
      .join(' ');
    expect(env).toMatch(/\bJM_STATE_DIR=\/state\b/);
    expect(env).toMatch(/\bTUF_ROOT=\/state\/sigstore\b/);
    expect(env).toMatch(/\bJM_CONTAINER=1\b/);
  });

  test('the egress proxy image runs as a non-root user with no npm install in its final stage', () => {
    const final = finalStage(instructions(read('images/egress/Dockerfile')));
    const user = final.filter((i) => i.op === 'USER').at(-1)?.args ?? '';
    expect(user).toMatch(/^\d+:\d+$/);
    expect(user.split(':')[0]).not.toBe('0');
    expect(final.some((i) => i.op === 'RUN' && /\bnpm\b/.test(i.args))).toBe(false);
    expect(final.some((i) => i.op === 'RUN' && SETUID_SWEEP.test(i.args))).toBe(true);
    // Only the stdlib egress module of the protocol package loads: it must not import zod.
    expect(read('packages/protocol/src/egress.ts')).not.toMatch(/from '(zod|\.\/index\.js)'/);
    expect(read('apps/egress/package.json')).not.toMatch(/"zod"/);
  });

  test('no Dockerfile passes a JM_ secret as ARG or ENV', () => {
    const secretish = /\bJM_\w*(TOKEN|SECRET|PASSWORD|KEY)\w*/;
    const offenders = dockerfiles().flatMap((file) =>
      instructions(read(file))
        .filter((i) => (i.op === 'ARG' || i.op === 'ENV') && secretish.test(i.args))
        .map((i) => `${file}: ${i.op} ${i.args}`),
    );
    expect(offenders).toEqual([]);
    // The check itself sees a secret through a continuation line.
    const planted = instructions('ENV JM_CONTAINER=1 \\\n    JM_CLAUDE_TOKEN_FILE=/x\n');
    expect(planted.filter((i) => secretish.test(i.args))).toHaveLength(1);
  });

  test('every Dockerfile sets the org.opencontainers.image.source label from a build argument', () => {
    const files = dockerfiles().filter((f) => !(f in LOCAL_IMAGE_FILES));
    expect(files).toEqual(expect.arrayContaining(SHIPPED));
    for (const file of files) {
      const final = finalStage(instructions(read(file)));
      const label = final.find(
        (i) => i.op === 'LABEL' && i.args.includes('org.opencontainers.image.source='),
      );
      expect(label?.args, file).toMatch(
        /org\.opencontainers\.image\.source="?\$\{?SOURCE_URL\}?"?/,
      );
      // The ARG must be declared in the final stage, or the label is empty.
      expect(
        final.some((i) => i.op === 'ARG' && /^SOURCE_URL(=|$)/.test(i.args)),
        file,
      ).toBe(true);
    }
  });
});

const PRESET_FILES = {
  python: 'images/trooper/presets/python/Dockerfile',
  go: 'images/trooper/presets/go/Dockerfile',
  jvm: 'images/trooper/presets/jvm/Dockerfile',
} as const;
const SETUID_SWEEP = /find \/ -xdev -type f -perm \/6000 -exec chmod a-s \{\} \+/;
const IS_DIGEST_REF = /@sha256:[0-9a-f]{64}$/;

describe('stack presets', () => {
  test('preset Dockerfiles take a digest ARG BASE, keep the setuid sweep and set no USER', () => {
    for (const file of Object.values(PRESET_FILES)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      const all = instructions(read(file));
      const first = all.findIndex((i) => i.op === 'FROM');
      const base = all.slice(0, first).find((i) => i.op === 'ARG' && i.args.startsWith('BASE='));
      expect(base?.args.slice(5), file).toMatch(IS_DIGEST_REF);
      const final = finalStage(all);
      expect(final[0]?.args, file).toMatch(/^\$\{?BASE\}?$/);
      expect(
        all.filter((i) => i.op === 'USER'),
        file,
      ).toEqual([]);
      // The sweep is the final stage's last RUN, so nothing added after it keeps a setuid bit.
      const runs = final.filter((i) => i.op === 'RUN');
      expect(runs.at(-1)?.args, file).toMatch(SETUID_SWEEP);
      // Every toolchain directory the preset adds loses group and world write, so the agent
      // (uid 10001) can't change a binary the gate (uid 10002) runs.
      const added = final
        .filter((i) => i.op === 'COPY' && i.args.startsWith('--from='))
        .map((i) => i.args.split(/\s+/).at(-1) as string)
        .filter((dst) => dst !== '/usr/local/bin/');
      const writeSweep = runs.map((r) => r.args).join('\n');
      for (const dir of [...added, ...(file.includes('python') ? ['/opt/uv'] : [])]) {
        const sweep = writeSweep
          .split(/&&|\n/)
          .find((cmd) => /chmod -R \S*go-w/.test(cmd) && cmd.split(/\s+/).includes(dir));
        expect(sweep, `${file} ${dir}`).toBeDefined();
      }
      // Image pins live on named FROM stages (which Dependabot bumps), never inline in COPY.
      for (const c of final.filter((i) => i.op === 'COPY'))
        expect(c.args, file).not.toMatch(/--from=\S*@sha256:/);
      // A build from the wrong base (the default is the plain Node image) fails loudly.
      expect(
        final.some((i) => i.op === 'RUN' && i.args.includes('test -f /opt/trooper/main.js')),
        file,
      ).toBe(true);
    }
    // The base trooper (the node preset) keeps its own sweep after the Claude CLI install.
    const trooper = finalStage(instructions(read('images/trooper/Dockerfile')));
    const sweep = trooper.findIndex((i) => i.op === 'RUN' && SETUID_SWEEP.test(i.args));
    const install = trooper.findIndex((i) => i.op === 'RUN' && /\bnpm ci\b/.test(i.args));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(sweep).toBeGreaterThan(install);
  });

  test('the trooper installs the Claude CLI with npm ci from a lockfile with an integrity hash', () => {
    const text = read('images/trooper/Dockerfile');
    expect(text).not.toMatch(/npm (i|install)\b[^\n]*claude-code/);
    expect(text).toMatch(
      /COPY images\/trooper\/claude\/package\.json images\/trooper\/claude\/package-lock\.json /,
    );
    expect(text).toMatch(/\bnpm ci\b/);
    const manifest = JSON.parse(read('images/trooper/claude/package.json')) as {
      dependencies: Record<string, string>;
    };
    const version = manifest.dependencies['@anthropic-ai/claude-code'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(read('images/trooper/claude/package-lock.json')) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; integrity?: string; resolved?: string }>;
    };
    expect(lock.lockfileVersion).toBe(3);
    const cli = lock.packages['node_modules/@anthropic-ai/claude-code'];
    expect(cli?.version).toBe(version);
    expect(cli?.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    // Every locked package (the platform binaries too) carries its own integrity hash.
    for (const [name, p] of Object.entries(lock.packages)) {
      if (name === '') continue;
      expect(p.integrity, name).toMatch(/^sha512-/);
      expect(p.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
    expect(Object.keys(lock.packages)).toEqual(
      expect.arrayContaining([
        'node_modules/@anthropic-ai/claude-code-linux-x64',
        'node_modules/@anthropic-ai/claude-code-linux-arm64',
      ]),
    );
  });

  test("the trooper's Corepack shims sit on PATH after /usr/local/bin, so a global npm install wins", () => {
    // Shims in /usr/local/bin made `npm i -g pnpm` in a zone image fail with EEXIST; in their own
    // directory, last on PATH, they still serve `packageManager` repos and detected gates.
    const final = finalStage(instructions(read('images/trooper/Dockerfile')));
    const runs = final.filter((i) => i.op === 'RUN').map((i) => i.args);
    const enable = runs.flatMap((r) => r.split(/&&/)).find((c) => /\bcorepack enable\b/.test(c));
    expect(enable).toMatch(/--install-directory[= ]\/opt\/corepack\/bin\b/);
    expect(enable).toMatch(/\bpnpm\b/);
    expect(enable).toMatch(/\byarn\b/);
    const path = final
      .filter((i) => i.op === 'ENV')
      .map((i) => /(?:^|\s)PATH=(\S+)/.exec(i.args)?.[1])
      .filter((p) => p !== undefined)
      .at(-1);
    expect(path).toMatch(/^\$\{?PATH\}?:\/opt\/corepack\/bin$/);
    // A login shell resets PATH from /etc/profile; the profile.d snippet puts the shims back.
    expect(runs.join('\n')).toMatch(/\/etc\/profile\.d\/\S*corepack\S*\.sh/);
    // The Node image's bundled Yarn 1 would shadow Corepack's yarn (and block `npm i -g yarn`).
    expect(runs.join('\n')).toMatch(/\brm -rf [^&\n]*\/usr\/local\/bin\/yarn\b/);
  });

  test('the python preset ships 3.11 and a uv-installed 3.12 every user can find', () => {
    const final = finalStage(instructions(read(PRESET_FILES.python)));
    const env = final
      .filter((i) => i.op === 'ENV')
      .map((i) => i.args)
      .join(' ');
    expect(env).toMatch(/\bUV_PYTHON_DOWNLOADS=automatic\b/);
    // The shipped 3.12 goes to a world-readable root-owned directory, but the variable is not
    // left set: a run-time download into that shared directory fails (or, if it were writable,
    // would let the agent swap the gate's interpreter). Each user's uv downloads into its home.
    expect(env).not.toMatch(/UV_PYTHON_INSTALL_DIR/);
    const runs = final.filter((i) => i.op === 'RUN').map((i) => i.args);
    expect(runs.join('\n')).toMatch(/python3-venv/);
    expect(runs.join('\n')).toMatch(
      /UV_PYTHON_INSTALL_DIR=\/opt\/uv\/python uv python install --no-bin 3\.12\.\d+/,
    );
    expect(runs.join('\n')).toMatch(/ln -s[^\n]*\/usr\/local\/bin\/python3\.12/);
    // uv is copied from a stage that checked its checksum.
    const text = read(PRESET_FILES.python);
    expect(text).toMatch(/uv-\$\{?\w+\}?-unknown-linux-gnu\.tar\.gz/);
    expect(text).toMatch(/sha256sum -c/);
  });

  test('the go preset copies Go from a digest-pinned image; jvm a JDK and a checked Maven', () => {
    const go = read(PRESET_FILES.go);
    expect(go).toMatch(/^FROM golang:[\w.-]+@sha256:[0-9a-f]{64} AS go$/m);
    // The shipped toolchain only: go never downloads another one (that would need an egress host).
    const goEnv = finalStage(instructions(go))
      .filter((i) => i.op === 'ENV')
      .map((i) => i.args)
      .join(' ');
    expect(goEnv).toMatch(/\bGOTOOLCHAIN=local\b/);
    expect(go).toMatch(/COPY --from=go \/usr\/local\/go \/usr\/local\/go/);
    expect(go).toMatch(/ENV [^\n]*PATH=\/usr\/local\/go\/bin:/);
    const jvm = read(PRESET_FILES.jvm);
    expect(jvm).toMatch(/^FROM eclipse-temurin:21[\w.-]*@sha256:[0-9a-f]{64} AS jdk$/m);
    expect(jvm).toMatch(/COPY --from=jdk \/opt\/java\/openjdk \/opt\/java\/openjdk/);
    expect(jvm).toMatch(/apache-maven-[\d.]+-bin\.tar\.gz/);
    expect(jvm).toMatch(/sha512sum -c/);
    expect(jvm).toMatch(/JAVA_HOME=\/opt\/java\/openjdk/);
  });

  test('the image e2e builds every preset and runs its toolchain as the agent and gate users', () => {
    const e2e = read('images/trooper/e2e/presets.sh');
    for (const [preset, file] of Object.entries(PRESET_FILES))
      expect(e2e, preset).toMatch(
        new RegExp(`-t jumpmaster-trooper-${preset}:dev -f ${file.replace(/\//g, '\\/')}`),
      );
    expect(e2e).toMatch(/--build-arg BASE=jumpmaster-trooper:dev/);
    for (const probe of [
      'python3 --version && python3.12 --version && uv --version',
      'uv python find 3.12',
      'python3.12 -V',
      'go version',
      'java -version && mvn -v',
    ])
      expect(e2e).toContain(probe);
    // The agent can't write any toolchain directory the gate runs from.
    for (const dir of ['/opt/uv', '/usr/local/go', '/opt/java/openjdk', '/opt/maven'])
      expect(e2e).toContain(dir);
    expect(e2e).toMatch(/-writable/);
    // The agent user runs the probes directly, and the gate user runs them as a drop's gate.
    expect(e2e).toMatch(/--user 10001:10001/);
    expect(e2e).toMatch(/gates: \[\{ name: "toolchain", run/);
    // The node preset: a zone image with a global npm pnpm builds, and that pnpm wins for both
    // users, while Corepack still serves a repository's `packageManager`.
    expect(e2e).toMatch(
      /-t jumpmaster-trooper-globalpnpm:dev -f images\/trooper\/e2e\/global-pnpm\.Dockerfile/,
    );
    for (const probe of ['pnpm@10.18.3+sha512.', 'yarn@1.22.22+sha512.', '/opt/corepack/bin/'])
      expect(e2e).toContain(probe);
    expect(e2e).toMatch(/'node as agent'/);
    expect(e2e).toMatch(/'node as gate'/);
    expect(e2e).toMatch(/'global pnpm as agent'/);
    expect(e2e).toMatch(/'global pnpm as gate'/);
  });
});

test('dependabot watches the preset Dockerfiles and the Claude CLI lockfile', () => {
  type Update = { 'package-ecosystem': string; directory?: string; directories?: string[] };
  const updates = (load(read('.github/dependabot.yml')) as { updates: Update[] }).updates;
  const dirs = (eco: string) =>
    updates
      .filter((u) => u['package-ecosystem'] === eco)
      .flatMap((u) => [...(u.directories ?? []), ...(u.directory ? [u.directory] : [])]);
  expect(dirs('docker')).toContain('/images/trooper/presets/*');
  expect(dirs('npm')).toContain('/images/trooper/claude');
});

type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      'runs-on': string;
      'timeout-minutes'?: number;
      steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
    }
  >;
};

describe('images.yml', () => {
  const workflow = () => load(read('.github/workflows/images.yml')) as Workflow;

  test('runs on pull requests and main, read-only', () => {
    const w = workflow();
    expect(Object.keys(w.on).sort()).toEqual(['pull_request', 'push']);
    expect(w.on.push).toEqual({ branches: ['main'] });
    expect(w.permissions).toEqual({ contents: 'read' });
  });

  test('images.yml runs the trooper e2e and records docker version', () => {
    const jobs = Object.values(workflow().jobs);
    expect(jobs.every((j) => /^ubuntu-/.test(j['runs-on']))).toBe(true);
    const runs = jobs.flatMap((j) => j.steps.map((s) => s.run ?? ''));
    const summary = runs.find((r) => /docker version/.test(r));
    expect(summary).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(runs.some((r) => /images\/trooper\/e2e\/run\.sh/.test(r))).toBe(true);
    expect(runs.some((r) => /images\/smoke\.sh/.test(r))).toBe(true);
  });

  test('images.yml runs the egress e2e after building the egress image, in the job that records the Engine', () => {
    const jobs = Object.values(workflow().jobs);
    const job = jobs.find((j) =>
      j.steps.some((s) => /images\/trooper\/e2e\/egress\.sh/.test(s.run ?? '')),
    );
    expect(job).toBeDefined();
    const runs = job?.steps.map((s) => s.run ?? '') ?? [];
    expect(runs.find((r) => /docker version/.test(r))).toMatch(/GITHUB_STEP_SUMMARY/);
    const build = runs.findIndex((r) =>
      /-t jumpmaster-egress:dev -f images\/egress\/Dockerfile/.test(r),
    );
    const e2e = runs.findIndex((r) => /egress\.sh/.test(r));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(e2e);
    // The e2e builds the proxy locally (pulling by digest arrives with image verification).
    expect(read('images/trooper/e2e/egress.sh')).toMatch(
      /-t jumpmaster-egress:dev -f images\/egress\/Dockerfile/,
    );
  });

  test('images.yml runs the preset e2e in its own job, recording the Engine there too', () => {
    const jobs = Object.values(workflow().jobs);
    const job = jobs.find((j) =>
      j.steps.some((s) => /images\/trooper\/e2e\/presets\.sh/.test(s.run ?? '')),
    );
    expect(job).toBeDefined();
    const runs = job?.steps.map((s) => s.run ?? '') ?? [];
    expect(runs.find((r) => /docker version/.test(r))).toMatch(/GITHUB_STEP_SUMMARY/);
  });

  test('builds each shipped image by name and never pushes or logs in', () => {
    const text = read('.github/workflows/images.yml');
    const builds = Object.values(workflow().jobs)
      .flatMap((j) => j.steps.map((s) => s.run ?? ''))
      .flatMap((run) => run.split('\n'))
      .filter((line) => /^\s*docker build /.test(line));
    for (const file of SHIPPED) {
      const name = file.split('/')[1] as string;
      const build = builds.find((line) => line.includes(` -f ${file} `));
      expect(build, file).toMatch(new RegExp(` -t jumpmaster-${name}:dev -f ${file} \\.$`));
      expect(build, file).toMatch(/--build-arg SOURCE_URL="\$SOURCE_URL"/);
    }
    expect(builds).toHaveLength(SHIPPED.length);
    expect(text).not.toMatch(/--push|docker push|docker login|login-action|packages: write/);
  });

  test('checkout keeps no credentials and every job has a timeout', () => {
    for (const job of Object.values(workflow().jobs)) {
      expect(job['timeout-minutes']).toBe(30);
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@')))
        expect(step.with?.['persist-credentials']).toBe(false);
    }
  });
});
