// The release workflow, statically and by simulation (plan Task 9 and erratum 1). Its job `if:`
// conditions are evaluated with a small GitHub-expression evaluator, so the tests prove which jobs
// run for a tag push and for a workflow_dispatch dry run, not only that some text is present.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { walk } from './repo-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string> | string;
  outputs?: Record<string, string>;
  services?: Record<string, { image?: string }>;
  steps?: Step[];
};
type Workflow = {
  on: Record<string, unknown> | string | string[];
  permissions?: Record<string, string> | string;
  jobs: Record<string, Job>;
};

const RELEASE = '.github/workflows/release.yml';
const release = (): Workflow => load(read(RELEASE)) as Workflow;
const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
const steps = (job: Job | undefined): Step[] => job?.steps ?? [];

// ---- A GitHub Actions expression evaluator, for the subset the workflow uses -------------------

type Ctx = {
  github: Record<string, string>;
  needs: Record<string, { result: string }>;
};
type Value = string | boolean | number | null;

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*('(?:[^']|'')*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.-]*|\d+)/y;
  let m: RegExpExecArray | null;
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    m = re.exec(src);
    if (!m) break;
    out.push(m[1] as string);
    at = re.lastIndex;
  }
  if (src.slice(at).trim() !== '') throw new Error(`cannot parse expression at: ${src.slice(at)}`);
  return out;
}

const STATUS = ['success', 'failure', 'cancelled', 'always'];

function evaluate(raw: string, ctx: Ctx, needs: string[]): boolean {
  const src = raw
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .trim();
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++] as string;
  const truthy = (v: Value) => v !== false && v !== null && v !== '' && v !== 0;
  const results = needs.map((n) => ctx.needs[n]?.result ?? 'skipped');
  const fn = (name: string): boolean => {
    if (name === 'success') return results.every((r) => r === 'success');
    if (name === 'failure') return results.some((r) => r === 'failure');
    if (name === 'cancelled') return false;
    if (name === 'always') return true;
    throw new Error(`unknown function ${name}`);
  };
  const primary = (): Value => {
    const t = next();
    if (t === '(') {
      const v = or();
      if (next() !== ')') throw new Error('expected )');
      return v;
    }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === 'true' || t === 'false') return t === 'true';
    if (/^\d+$/.test(t)) return Number(t);
    if (peek() === '(') {
      next();
      if (next() !== ')') throw new Error('functions take no arguments here');
      return fn(t);
    }
    const parts = t.split('.');
    let v: unknown = ctx;
    for (const p of parts) v = (v as Record<string, unknown> | undefined)?.[p];
    return (v ?? null) as Value;
  };
  const cmp = (): Value => {
    let l = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = next();
      const r = primary();
      l = op === '==' ? l === r : l !== r;
    }
    return l;
  };
  const and = (): Value => {
    let l = cmp();
    while (peek() === '&&') {
      next();
      const r = cmp();
      l = truthy(l) && truthy(r);
    }
    return l;
  };
  const or = (): Value => {
    let l = and();
    while (peek() === '||') {
      next();
      const r = and();
      l = truthy(l) || truthy(r);
    }
    return l;
  };
  const value = truthy(or());
  if (i !== tokens.length) throw new Error(`trailing tokens in ${src}`);
  // Without a status function GitHub prefixes the condition with success().
  const hasStatus = tokens.some((t, k) => STATUS.includes(t) && tokens[k + 1] === '(');
  return hasStatus ? value : fn('success') && value;
}

/** Which jobs run (and with what result) for an event; `fail` forces a job's outcome to failure. */
function simulate(
  w: Workflow,
  github: Record<string, string>,
  fail: string[] = [],
): Record<string, string> {
  const ctx: Ctx = { github, needs: {} };
  const done: Record<string, string> = {};
  const pending = new Set(Object.keys(w.jobs));
  while (pending.size > 0) {
    const ready = [...pending].find((j) => needsOf(w.jobs[j] as Job).every((n) => n in done));
    if (!ready) throw new Error('a needs cycle');
    pending.delete(ready);
    const job = w.jobs[ready] as Job;
    const needs = needsOf(job);
    ctx.needs = Object.fromEntries(needs.map((n) => [n, { result: done[n] as string }]));
    const runs = evaluate(job.if ?? 'success()', ctx, needs);
    done[ready] = !runs ? 'skipped' : fail.includes(ready) ? 'failure' : 'success';
  }
  return done;
}

const TAG_PUSH = { event_name: 'push', ref_type: 'tag', ref_name: 'v0.4.0-rc.1' };
const DISPATCH = { event_name: 'workflow_dispatch', ref_type: 'branch', ref_name: 'feat/x' };
const DISPATCH_ON_TAG = { event_name: 'workflow_dispatch', ref_type: 'tag', ref_name: 'v1.0.0' };

describe('the expression evaluator', () => {
  test('evaluates the operators and the implicit success()', () => {
    const ctx: Ctx = { github: { ref_type: 'tag' }, needs: { a: { result: 'skipped' } } };
    expect(evaluate("github.ref_type == 'tag'", ctx, [])).toBe(true);
    expect(evaluate("${{ github.ref_type != 'tag' }}", ctx, [])).toBe(false);
    // A skipped need fails the implicit success(), and !cancelled() lifts it.
    expect(evaluate("github.ref_type == 'tag'", ctx, ['a'])).toBe(false);
    expect(evaluate("!cancelled() && needs.a.result == 'skipped'", ctx, ['a'])).toBe(true);
    expect(evaluate('(false || true) && !(1 == 2)', ctx, [])).toBe(true);
  });
});

describe('release.yml', () => {
  test('release.yml triggers only on push of version tags and workflow_dispatch', () => {
    const on = release().on as Record<string, unknown>;
    expect(Object.keys(on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(on.push).toEqual({
      tags: ['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+'],
    });
    // A dispatch takes no inputs: nothing a caller passes can steer it.
    expect(on.workflow_dispatch ?? null).toBeNull();
  });

  test('no workflow uses pull_request_target, workflow_run or issue_comment', () => {
    const files = walk(ROOT, ['.github/workflows']).filter((f) => /\.ya?ml$/.test(f));
    expect(files).toContain(RELEASE);
    for (const file of files) {
      const on = (load(read(file)) as Workflow).on;
      const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
      for (const bad of ['pull_request_target', 'workflow_run', 'issue_comment'])
        expect(events, file).not.toContain(bad);
    }
  });

  test('every job except guard needs guard, and guard runs merge-base --is-ancestor against origin/main', () => {
    const w = release();
    for (const [name, job] of Object.entries(w.jobs)) {
      if (name === 'guard') continue;
      expect(needsOf(job), name).toContain('guard');
    }
    const guard = w.jobs.guard as Job;
    expect(guard.if).toBe("github.ref_type == 'tag'");
    const checkout = steps(guard).find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    const script = steps(guard)
      .map((s) => s.run ?? '')
      .join('\n');
    expect(script).toMatch(/git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
    // The tag name itself is checked, not only the trigger's glob.
    expect(script).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$');
    // No job runs regardless of a failed guard.
    expect(read(RELEASE)).not.toMatch(/\balways\(\)/);
  });

  test('a tag push runs every job only after guard passes; a failed guard stops everything', () => {
    const w = release();
    const ok = simulate(w, TAG_PUSH);
    for (const job of Object.keys(w.jobs)) expect(ok[job], job).toBe('success');
    const failed = simulate(w, TAG_PUSH, ['guard']);
    for (const job of Object.keys(w.jobs))
      expect(failed[job], job).toBe(job === 'guard' ? 'failure' : 'skipped');
  });

  test('a dispatch run skips guard, sign and publish, and still builds', () => {
    const w = release();
    const run = simulate(w, DISPATCH);
    expect(run.guard).toBe('skipped');
    expect(run.sign).toBe('skipped');
    expect(run.publish).toBe('skipped');
    expect(run.troopers).toBe('success');
    expect(run.apps).toBe('success');
    // Dispatched on a tag ref, guard runs, and still nothing is signed or published.
    const onTag = simulate(w, DISPATCH_ON_TAG);
    expect(onTag.guard).toBe('success');
    expect(onTag.sign).toBe('skipped');
    expect(onTag.publish).toBe('skipped');
  });

  test('sign and publish run only if github.ref_type == tag; build jobs push only on tags', () => {
    const w = release();
    const isRelease = "github.event_name == 'push' && github.ref_type == 'tag'";
    expect(w.jobs.sign?.if).toBe(isRelease);
    expect(w.jobs.publish?.if).toBe(isRelease);
    for (const name of ['troopers', 'apps']) {
      const job = w.jobs[name] as Job;
      // The only registry login is to GHCR, and only for a release.
      const logins = steps(job).filter((s) =>
        /docker login|login-action/.test(`${s.run}${s.uses}`),
      );
      expect(logins.length, name).toBeGreaterThan(0);
      for (const s of logins) expect(s.if, name).toBe(isRelease);
      // Every image goes to the registry the target step chose.
      for (const s of steps(job).filter((s) => s.uses?.startsWith('docker/build-push-action@'))) {
        const outputs = String(s.with?.outputs ?? '');
        expect(outputs, `${name} ${s.id}`).toMatch(
          /^type=image,name=\$\{\{ (steps\.target|needs\.troopers)\.outputs\.registry \}\}\/jumpmaster-[a-z-]+,push-by-digest=true,name-canonical=true,push=true$/,
        );
        expect(s.with?.push, `${name} ${s.id}`).toBeUndefined();
        expect(s.with?.tags, `${name} ${s.id}`).toBeUndefined();
      }
    }
    // Run the target step's script: GHCR only for a release, a job-local registry otherwise.
    const target = steps(w.jobs.troopers).find((s) => s.id === 'target') as Step;
    const env = target.env ?? {};
    const runTarget = (github: Record<string, string>) => {
      const out = join(mkdtempSync(join(tmpdir(), 'jm-wf-')), 'out');
      const resolved = Object.fromEntries(
        Object.entries(env).map(([k, v]) => {
          const m = /^\$\{\{(.*)\}\}$/.exec(v.trim());
          if (!m) return [k, v];
          const expr = (m[1] as string).trim();
          if (/^github\.[\w.]+$/.test(expr)) return [k, github[expr.slice(7)] ?? ''];
          return [k, String(evaluate(expr, { github, needs: {} }, []))];
        }),
      );
      const r = spawnSync(
        'bash',
        ['--norc', '--noprofile', '-euo', 'pipefail', '-c', target.run as string],
        {
          env: { PATH: process.env.PATH, ...resolved, GITHUB_OUTPUT: out },
          encoding: 'utf8',
        },
      );
      expect(r.status, r.stderr).toBe(0);
      return Object.fromEntries(
        readFileSync(out, 'utf8')
          .trim()
          .split('\n')
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
    };
    const common = { repository_owner: 'Some-Owner', sha: 'c'.repeat(40) };
    expect(runTarget({ ...TAG_PUSH, ...common })).toEqual({
      registry: 'ghcr.io/some-owner',
      version: '0.4.0-rc.1',
    });
    const dry = runTarget({ ...DISPATCH, ...common });
    expect(dry.registry).toBe('localhost:5000/some-owner');
    expect(dry.version).toBe(`0.0.0-dryrun.${'c'.repeat(12)}`);
    expect(runTarget({ ...DISPATCH_ON_TAG, ...common }).registry).toBe('localhost:5000/some-owner');
    // The job-local registry is a pinned service container.
    expect(w.jobs.troopers?.services?.registry?.image).toMatch(
      /^registry:[\d.]+@sha256:[0-9a-f]{64}$/,
    );
  });

  test('id-token: write appears only on the sign job; top-level permissions are read-only', () => {
    const w = release();
    expect(w.permissions).toEqual({ contents: 'read' });
    const grants: Record<string, string[]> = {};
    for (const [name, job] of Object.entries(w.jobs)) {
      expect(typeof job.permissions, `${name} declares its permissions`).toBe('object');
      for (const [scope, level] of Object.entries(job.permissions as Record<string, string>))
        if (level === 'write') (grants[scope] ??= []).push(name);
    }
    expect(grants['id-token']).toEqual(['sign']);
    expect(grants.packages?.sort()).toEqual(['apps', 'sign', 'troopers']);
    expect(grants.contents).toEqual(['publish']);
    expect(Object.keys(grants).sort()).toEqual(['contents', 'id-token', 'packages']);
  });

  test('every image builds with provenance mode=max, sbom true and the source label', () => {
    const w = release();
    const builds = Object.values(w.jobs).flatMap((j) =>
      steps(j).filter((s) => s.uses?.startsWith('docker/build-push-action@')),
    );
    const files = builds.map((s) => s.with?.file).sort();
    expect(files).toEqual([
      'images/egress/Dockerfile',
      'images/server/Dockerfile',
      'images/stick/Dockerfile',
      'images/trooper/Dockerfile',
      'images/trooper/presets/go/Dockerfile',
      'images/trooper/presets/jvm/Dockerfile',
      'images/trooper/presets/python/Dockerfile',
    ]);
    for (const s of builds) {
      expect(s.with?.provenance, s.id).toBe('mode=max');
      expect(s.with?.sbom, s.id).toBe(true);
      expect(String(s.with?.['build-args']), s.id).toMatch(
        /^SOURCE_URL=\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}$/m,
      );
      expect(String(s.with?.labels), s.id).toMatch(
        /^org\.opencontainers\.image\.source=\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}$/m,
      );
    }
    // The presets build FROM the trooper this run built, by digest.
    for (const id of ['python', 'go', 'jvm']) {
      const s = builds.find((b) => b.id === id);
      expect(String(s?.with?.['build-args']), id).toContain(
        'BASE=${{ steps.target.outputs.registry }}/jumpmaster-trooper@${{ steps.trooper.outputs.digest }}',
      );
    }
  });

  test('every checkout drops its credentials, and every job has a timeout', () => {
    const w = release();
    for (const [name, job] of Object.entries(w.jobs)) {
      expect((job as { 'timeout-minutes'?: number })['timeout-minutes'], name).toBeGreaterThan(0);
      for (const s of steps(job).filter((s) => s.uses?.startsWith('actions/checkout@')))
        expect(s.with?.['persist-credentials'], name).toBe(false);
    }
  });

  test('publish attaches the compose file, the lock, SHA256SUMS and its bundle to the release', () => {
    const w = release();
    const sign = steps(w.jobs.sign)
      .map((s) => s.run ?? '')
      .join('\n');
    expect(sign).toMatch(/node scripts\/render-compose\.ts deploy\/compose\.yaml\.tmpl /);
    expect(sign).toMatch(/sha256sum compose\.yaml images\.lock\.json > SHA256SUMS/);
    const publish = steps(w.jobs.publish)
      .map((s) => s.run ?? '')
      .join('\n');
    expect(publish).toMatch(/gh release create "\$TAG"[^\n]*--verify-tag/);
    for (const f of ['compose.yaml', 'images.lock.json', 'SHA256SUMS', 'SHA256SUMS.sigstore.json'])
      expect(publish).toContain(f);
  });

  test('sign signs every image by digest and checks it with the identity the stick verifies', () => {
    const sign = release().jobs.sign as Job;
    const script = steps(sign)
      .map((s) => s.run ?? '')
      .join('\n');
    expect(script).toMatch(/cosign sign --yes "\$ref"/);
    expect(script).toContain('cosign verify');
    for (const flag of [
      '--certificate-identity-regexp "$IDENTITY"',
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
      '--certificate-github-workflow-trigger push',
      '--certificate-github-workflow-repository "$REPO"',
    ])
      expect(script).toContain(flag);
    expect(script).toMatch(/cosign sign-blob --yes --bundle SHA256SUMS\.sigstore\.json SHA256SUMS/);
    // Seven images, each by its index digest.
    const env = (sign as { env?: Record<string, string> }).env ?? {};
    for (const name of ['TROOPER', 'PYTHON', 'GO', 'JVM', 'EGRESS', 'SERVER', 'STICK'])
      expect(env[name], name).toMatch(/^\$\{\{ needs\.(troopers|apps)\.outputs\.[a-z]+ \}\}$/);
    for (const name of ['TROOPER', 'PYTHON', 'GO', 'JVM', 'EGRESS', 'SERVER', 'STICK'])
      expect(script, name).toContain(`@$${name}"`);
    // The identity the workflow checks is built the way the stick builds it.
    const bash = spawnSync(
      'bash',
      [
        '--norc',
        '--noprofile',
        '-c',
        `${/^repo_re=.*$/m.exec(script)?.[0]}\n${/^IDENTITY=.*$/m.exec(script)?.[0]}\nprintf '%s' "$IDENTITY"`,
      ],
      { env: { PATH: process.env.PATH, REPO: 'some-owner/jump.master' }, encoding: 'utf8' },
    );
    expect(bash.stdout).toBe(
      '^https://github\\.com/some-owner/jump\\.master/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$',
    );
  });
});

/** The repository's real name, as SECURITY.md names it: public docs use it so commands run as written. */
const PUBLIC_REPO = 'x-a-n-d-e-r-k/jumpmaster';
const PUBLIC_IDENTITY = `^https://github\\.com/${PUBLIC_REPO.replace(/\./g, '\\.')}/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$`;

describe('release docs', () => {
  test('SECURITY.md shows runnable cosign verify and verify-blob commands for this repository', () => {
    const doc = read('SECURITY.md');
    expect(doc).toContain(`[private vulnerability reporting](https://github.com/${PUBLIC_REPO}/`);
    const section = doc.slice(doc.indexOf('## Verifying a release'));
    expect(section.length).toBeLessThan(doc.length);
    for (const cmd of ['cosign verify ', 'cosign verify-blob ']) expect(section).toContain(cmd);
    expect(section).toContain(`--certificate-identity-regexp '${PUBLIC_IDENTITY}'`);
    expect(section).toContain(
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    );
    expect(section).toContain('--certificate-github-workflow-trigger push');
    expect(section).toContain(`--certificate-github-workflow-repository ${PUBLIC_REPO}`);
    expect(section).toContain('--bundle SHA256SUMS.sigstore.json');
    expect(section).toContain('sha256sum -c SHA256SUMS');
    // cosign without installing it: a digest-pinned image.
    expect(section).toMatch(
      /docker run --rm[^\n]*ghcr\.io\/sigstore\/cosign\/cosign:v[\d.]+@sha256:[0-9a-f]{64}/,
    );
  });

  test('the release runbook carries the owner steps, the exact identity and the image lock', () => {
    const doc = read('docs/runbooks/release.md');
    for (const s of [
      'refs/tags/v*', // the tag ruleset
      'id-token: write',
      'org.opencontainers.image.source',
      PUBLIC_IDENTITY,
      'https://token.actions.githubusercontent.com',
      'v0.4.0-rc.1',
      'workflow_dispatch',
      'images.lock.json',
      'JM_DEV_IMAGES=1',
      'images/published.json',
    ])
      expect(doc, s).toContain(s);
    // No private hostnames or paths in a public runbook.
    expect(doc).not.toMatch(/\/Users\/|\/home\/[a-z]+\/|\.local\b|\.internal\b/);
  });
});
