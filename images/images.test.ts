// Static checks on the shipped Dockerfiles and the image workflow. The runtime behaviour (uid,
// read-only root, file secrets, enrollment) is checked by images/smoke.sh, which images.yml runs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { LOCAL_IMAGE_FILES, walk } from '../scripts/repo-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

type Instruction = { op: string; args: string };

/** Dockerfile instructions with line continuations joined and comments dropped. */
export function instructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  let pending = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (pending === '' && (line === '' || line.startsWith('#'))) continue;
    if (line.startsWith('#')) continue;
    pending += (pending ? ' ' : '') + line.replace(/\\$/, '').trim();
    if (line.endsWith('\\')) continue;
    const [op = '', ...rest] = pending.split(/\s+/);
    out.push({ op: op.toUpperCase(), args: rest.join(' ') });
    pending = '';
  }
  return out;
}

/** The instructions of the last stage (from its FROM on). */
const finalStage = (all: Instruction[]): Instruction[] =>
  all.slice(all.map((i) => i.op).lastIndexOf('FROM'));

const SHIPPED = [
  'images/server/Dockerfile',
  'images/stick/Dockerfile',
  'images/trooper/Dockerfile',
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
    expect(final).toContainEqual({ op: 'WORKDIR', args: '/app' });
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

type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    { 'runs-on': string; steps: { run?: string; env?: Record<string, string> }[] }
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

  test('builds every shipped image and never pushes or logs in', () => {
    const text = read('.github/workflows/images.yml');
    for (const file of SHIPPED) expect(text).toContain(file.split('/')[1] as string);
    expect(text).toMatch(/docker build[^\n]*-f images\/\$\{?image\}?\/Dockerfile/);
    expect(text).toMatch(/SOURCE_URL=/);
    expect(text).not.toMatch(/--push|docker push|docker login|login-action|packages: write/);
  });
});
