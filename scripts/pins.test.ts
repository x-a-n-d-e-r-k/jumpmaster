// The pin policy, as one generic scan of the repository (plan: Global Constraints, "Pinning").
// - Every image reference in images/**, deploy/**, scripts/** and .github/{workflows,actions}/**
//   (Dockerfiles, YAML and shell scripts, and any local action a workflow uses) is an @sha256
//   digest, after resolving ARG defaults and ${VAR:-default} placeholders.
// - Every `uses:` names a full 40-hex commit SHA.
// - Every downloaded binary in a Dockerfile has a checksum check within three lines.
// - Every npm dependency added after the pre-M4 snapshot is an exact version.
// The 14-day age rule is a PR checklist line, not a test.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { directives, instructions, LOCAL_IMAGE_FILES, walk } from './repo-files.js';

export type Finding = { file: string; line: number; message: string };

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const IS_DIGEST = /@sha256:[0-9a-f]{64}$/;
const IS_SHA = /@[0-9a-f]{40}$/;
const CHECKSUM = /sha256sum\s+-c|sha512sum\s+-c|--checksum/;
const HAS_URL = /https?:\/\//;
const unquote = (s: string): string => s.replace(/^['"]|['"]$/g, '');

/** Splits on whitespace outside quotes and removes the quotes. */
function words(s: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (current !== '' || quoted) out.push(current);
      current = '';
      quoted = false;
    } else current += ch;
  }
  if (current !== '' || quoted) out.push(current);
  return out;
}

type Resolved = { value: string } | { error: string };

/**
 * Substitutes `$V`, `${V}`, `${V:-word}` and `${V:+word}` from ARG defaults. A plain reference to
 * a variable that isn't declared, or is declared without a default, can't be resolved.
 */
function substitute(ref: string, vars: Map<string, string | undefined>): Resolved {
  let error: string | undefined;
  const value = ref.replace(
    /\$\{([A-Za-z_]\w*)(?:(:?[-+])([^}]*))?\}|\$([A-Za-z_]\w*)/g,
    (_m, braced: string | undefined, op: string | undefined, word: string | undefined, bare) => {
      const name = (braced ?? bare) as string;
      const set = vars.get(name);
      if (op !== undefined) {
        if ((word ?? '').includes('$')) error ??= `\${${name}${op}…} nests a variable`;
        if (op.endsWith('-')) return set ? set : (word ?? '');
        return set ? (word ?? '') : '';
      }
      if (!vars.has(name)) error ??= `${name} is not declared by an ARG before the first FROM`;
      else if (!set) error ??= `ARG ${name} has no default`;
      return set ?? '';
    },
  );
  return error ? { error } : { value };
}

/** ARG assignments (`NAME` or `NAME=default`, several per line). */
function argAssignments(args: string): [string, string | undefined][] {
  return words(args).map((w) => {
    const eq = w.indexOf('=');
    return eq < 0 ? [w, undefined] : [w.slice(0, eq), w.slice(eq + 1)];
  });
}

export function scanDockerfile(
  file: string,
  text: string,
  local: typeof LOCAL_IMAGE_FILES = LOCAL_IMAGE_FILES,
): Finding[] {
  const findings: Finding[] = [];
  const report = (line: number, message: string) => findings.push({ file, line, message });
  const lines = text.split('\n');
  for (const d of directives(text)) {
    if (d.key === 'syntax' && !IS_DIGEST.test(d.value))
      report(d.line, `# syntax=${d.value} is not pinned by @sha256 digest`);
    if (d.key === 'escape' && d.value !== '\\')
      report(d.line, `# escape=${d.value} is not supported: the scan joins lines on \\`);
  }
  const globals = new Map<string, string | undefined>();
  const all = new Map<string, string | undefined>();
  const stages = new Set<string>();
  let seenFrom = false;
  const isLocal = (ref: string) => local[file]?.images.includes(ref) ?? false;
  // A stage name, a stage index or a digest, after substituting every ARG default seen so far.
  const checkFromRef = (line: number, what: string, raw: string) => {
    if (/^\d+$/.test(raw) || stages.has(raw.toLowerCase())) return;
    const r = substitute(raw, all);
    if ('error' in r) return report(line, `${what}=${raw}: ${r.error}`);
    if (stages.has(r.value.toLowerCase()) || IS_DIGEST.test(r.value)) return;
    report(line, `${what}=${raw} is neither a build stage nor an @sha256 digest`);
  };
  const check = (op: string, args: string, at: { line: number; end: number }) => {
    if (op === 'ONBUILD') {
      const [inner = '', ...rest] = args.split(/\s+/);
      return check(inner.toUpperCase(), rest.join(' '), at);
    }
    if (op === 'ARG') {
      for (const [name, def] of argAssignments(args)) {
        if (!seenFrom) globals.set(name, def);
        all.set(name, def);
        if (
          (name === 'BASE' || name.endsWith('_IMAGE')) &&
          def !== undefined &&
          !IS_DIGEST.test(def)
        )
          report(at.line, `ARG ${name} default ${def} is not an @sha256 digest`);
      }
    }
    if (op === 'FROM') {
      seenFrom = true;
      const [raw = '', as, alias] = words(args).filter((w) => !w.startsWith('--'));
      const r = substitute(raw, globals);
      if ('error' in r) report(at.line, `FROM ${raw}: ${r.error}`);
      else if (
        r.value !== 'scratch' &&
        !stages.has(r.value.toLowerCase()) &&
        !IS_DIGEST.test(r.value) &&
        !isLocal(r.value)
      )
        report(
          at.line,
          `FROM ${raw}${raw === r.value ? '' : ` (${r.value})`} is not pinned by @sha256 digest`,
        );
      if (as?.toLowerCase() === 'as' && alias) stages.add(alias.toLowerCase());
    }
    if (op === 'COPY') {
      for (const w of words(args))
        if (w.startsWith('--from=')) checkFromRef(at.line, 'COPY --from', w.slice(7));
    }
    if (op === 'RUN') {
      for (const w of words(args)) {
        if (!w.startsWith('--mount=')) continue;
        for (const kv of w.slice(8).split(','))
          if (kv.startsWith('from=')) checkFromRef(at.line, 'RUN --mount from', kv.slice(5));
      }
    }
    if (op === 'ADD' && HAS_URL.test(args)) {
      // --checksum is a flag of this ADD; a later instruction's flag doesn't cover it.
      if (!/(^|\s)--checksum=sha(256|384|512):/.test(args))
        report(at.line, 'ADD of a URL without --checksum=sha256:… on the same instruction');
    } else if (/\b(curl|wget)\b/.test(args) && HAS_URL.test(args)) {
      const after = lines.slice(at.end, at.end + 3).join('\n');
      if (!CHECKSUM.test(args) && !CHECKSUM.test(after))
        report(
          at.line,
          'download without sha256sum -c, sha512sum -c or --checksum within three lines',
        );
    }
  };
  // Every instruction, continuation lines joined; heredoc bodies are checked as instructions too.
  for (const ins of instructions(text)) check(ins.op, ins.args, ins);
  return findings;
}

/** A YAML image value: a digest, or a lone ${VAR:-default} whose default is a digest. */
function yamlImage(key: string, raw: string): string | undefined {
  const ref = raw.startsWith('docker://') ? raw.slice(9) : raw;
  const placeholder = /^\$\{[A-Za-z_]\w*:?-([^}$]*)\}$/.exec(ref);
  if (placeholder) {
    const def = placeholder[1] as string;
    return IS_DIGEST.test(def)
      ? undefined
      : `${key}: ${raw} default ${def} is not an @sha256 digest`;
  }
  if (ref.includes('$')) return `${key}: ${raw} can't be resolved to an @sha256 digest`;
  return IS_DIGEST.test(ref) ? undefined : `${key}: ${raw} is not an @sha256 digest`;
}

type YamlRef = { key: 'uses' | 'image' | 'container'; value: string; path: string[]; line: number };

/** Every uses:, image: and container: string in a YAML file, block or flow style, with lines. */
function yamlRefs(text: string): YamlRef[] | { error: string; line: number } {
  let docs: unknown[];
  try {
    docs = loadAll(text);
  } catch (e) {
    const mark = (e as { mark?: { line?: number } }).mark;
    return {
      error: `YAML does not parse: ${(e as Error).message.split('\n')[0]}`,
      line: (mark?.line ?? 0) + 1,
    };
  }
  const lines = text.split('\n');
  const cursor = new Map<string, number>();
  // The value as a whole token, so `x@abc` doesn't match inside `x@abcdef…`.
  const whole = (value: string) =>
    new RegExp(`(?<![\\w./@:-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w./@:-])`);
  const lineOf = (value: string): number => {
    for (let i = cursor.get(value) ?? 0; i < lines.length; i++) {
      const l = lines[i] as string;
      if (l.trim().startsWith('#') || !whole(value).test(l)) continue;
      cursor.set(value, i + 1);
      return i + 1;
    }
    return 0;
  };
  const out: YamlRef[] = [];
  const visit = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, [...path, String(i)]));
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'uses' || key === 'image' || key === 'container') && typeof value === 'string')
        out.push({ key, value, path: [...path, key], line: lineOf(value) });
      else visit(value, [...path, key]);
    }
  };
  for (const doc of docs) visit(doc, []);
  return out.sort((a, b) => a.line - b.line);
}

export function scanYaml(file: string, text: string): Finding[] {
  const refs = yamlRefs(text);
  if (!Array.isArray(refs)) return [{ file, line: refs.line, message: refs.error }];
  const findings: Finding[] = [];
  for (const { key, value, path, line } of refs) {
    let message: string | undefined;
    if (key === 'uses') {
      if (value.startsWith('./')) continue; // scanned through its action file by scanRepo
      if (value.startsWith('docker://'))
        message = IS_DIGEST.test(value) ? undefined : `uses: ${value} is not an @sha256 digest`;
      else if (!IS_SHA.test(value)) message = `uses: ${value} is not a full 40-hex commit SHA`;
    } else if (key === 'image' && path.at(-2) === 'runs' && !value.startsWith('docker://')) {
      continue; // a Docker action's own Dockerfile, scanned as a Dockerfile
    } else message = yamlImage(key, value);
    if (message) findings.push({ file, line, message });
  }
  return findings;
}

/** The `uses: ./…` local action references in a YAML file, with lines. */
export function localUses(text: string): { target: string; line: number }[] {
  const refs = yamlRefs(text);
  if (!Array.isArray(refs)) return [];
  return refs
    .filter((r) => r.key === 'uses' && r.value.startsWith('./'))
    .map((r) => ({ target: r.value.slice(2).replace(/\/$/, ''), line: r.line }));
}

export type PackageFile = { file: string; json: Record<string, unknown> };

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export function scanPackages(
  packages: PackageFile[],
  snapshot: Record<string, string[]>,
): Finding[] {
  const workspace = new Set(packages.map((p) => p.json.name).filter((n) => typeof n === 'string'));
  const findings: Finding[] = [];
  for (const { file, json } of packages) {
    const before = new Set(snapshot[file] ?? []);
    for (const field of DEP_FIELDS) {
      const deps = (json[field] ?? {}) as Record<string, string>;
      for (const [name, version] of Object.entries(deps)) {
        if (before.has(name) || workspace.has(name) || EXACT.test(version)) continue;
        findings.push({
          file,
          line: 0,
          message: `${field}.${name} is "${version}"; a new dependency needs an exact version`,
        });
      }
    }
  }
  return findings;
}

/** Flags of docker run/create/pull that take no value. */
const BOOLEAN_FLAGS: Record<string, Set<string>> = {
  run: new Set([
    '--rm',
    '-d',
    '--detach',
    '-i',
    '--interactive',
    '-t',
    '--tty',
    '-it',
    '-ti',
    '-dit',
    '-itd',
    '--read-only',
    '--init',
    '--privileged',
    '-P',
    '--publish-all',
    '--no-healthcheck',
    '--oom-kill-disable',
    '-q',
    '--quiet',
  ]),
  pull: new Set(['-a', '--all-tags', '-q', '--quiet', '--disable-content-trust']),
};
BOOLEAN_FLAGS.create = BOOLEAN_FLAGS.run as Set<string>;

/** Text up to the end of the command: a `)`, `|`, `;` or `&` outside quotes and $(…). */
function commandText(s: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '$' && s[i + 1] === '(') depth++;
      else if (quote === '"' && ch === ')' && depth > 0) depth--;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '$' && s[i + 1] === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (depth === 0 && (ch === ')' || ch === '|' || ch === ';' || ch === '&'))
      return s.slice(0, i);
  }
  return s;
}

/** Shell lines with backslash continuations joined, each with its first line number. */
function shellLines(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let pending = '';
  let start = 0;
  text.split('\n').forEach((raw, i) => {
    if (pending === '') start = i + 1;
    pending += (pending ? ' ' : '') + raw.replace(/\\$/, '');
    if (raw.endsWith('\\')) return;
    out.push({ text: pending, line: start });
    pending = '';
  });
  if (pending) out.push({ text: pending, line: start });
  return out;
}

/**
 * Image references in a shell script: the image argument of `docker run|create|pull` and every
 * JSON `"image":"…"` field. Each must be an @sha256 digest, an image the script builds itself
 * (`docker build -t`), or one listed for the file in LOCAL_IMAGE_FILES. `$VAR` resolves through
 * the script's first `VAR=` assignment (and a `${X:-default}` there to its default).
 */
export function scanShell(
  file: string,
  text: string,
  local: typeof LOCAL_IMAGE_FILES = LOCAL_IMAGE_FILES,
): Finding[] {
  const findings: Finding[] = [];
  const logical = shellLines(text);
  const vars = new Map<string, string>();
  const allowed = new Set(local[file]?.images ?? []);
  for (const { text: l } of logical) {
    const m = /^\s*(?:export\s+|readonly\s+)?([A-Za-z_]\w*)=(\S*)/.exec(l);
    if (m && !vars.has(m[1] as string)) vars.set(m[1] as string, unquote(m[2] as string));
    for (const b of l.matchAll(/\bdocker\s+(?:buildx\s+)?build\b/g)) {
      const w = words(commandText(l.slice((b.index ?? 0) + b[0].length)));
      w.forEach((t, i) => {
        if ((t === '-t' || t === '--tag') && w[i + 1]) allowed.add(w[i + 1] as string);
        else if (t.startsWith('--tag=')) allowed.add(t.slice(6));
      });
    }
  }
  const resolve = (ref: string): Resolved => {
    let error: string | undefined;
    const value = ref.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_m, a, b) => {
      const v = vars.get((a ?? b) as string);
      if (v === undefined) {
        error ??= `$${a ?? b} is not assigned in the script`;
        return '';
      }
      const placeholder = /^\$\{[A-Za-z_]\w*:?-([^}$]*)\}$/.exec(v);
      return placeholder ? (placeholder[1] as string) : v;
    });
    if (!error && value.includes('$')) error = `${ref} can't be resolved`;
    return error ? { error } : { value };
  };
  const check = (line: number, what: string, ref: string) => {
    const r = resolve(ref);
    if ('error' in r) return findings.push({ file, line, message: `${what} ${ref}: ${r.error}` });
    if (!IS_DIGEST.test(r.value) && !allowed.has(r.value))
      findings.push({
        file,
        line,
        message: `${what} ${ref} (${r.value}) is not an @sha256 digest`,
      });
  };
  for (const { text: l, line } of logical) {
    for (const m of l.matchAll(/\bdocker\s+(run|create|pull)\b/g)) {
      const sub = m[1] as string;
      const bools = BOOLEAN_FLAGS[sub] as Set<string>;
      const tokens = words(commandText(l.slice((m.index ?? 0) + m[0].length)));
      let image: string | undefined;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i] as string;
        if (/^\$\{\w+\[@\]\}$/.test(t)) continue; // an array of options
        if (t.startsWith('-')) {
          if (!t.includes('=') && !bools.has(t)) i++;
          continue;
        }
        image = t;
        break;
      }
      if (image === undefined)
        findings.push({ file, line, message: `docker ${sub}: no image found` });
      else check(line, `docker ${sub}`, image);
    }
  }
  text.split('\n').forEach((raw, i) => {
    for (const m of raw.matchAll(/"image"\s*:\s*"([^"]+)"/g))
      check(i + 1, '"image":', m[1] as string);
  });
  return findings.sort((a, b) => a.line - b.line);
}

const isDockerfile = (path: string): boolean => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base === 'Dockerfile' || base.startsWith('Dockerfile.') || base.endsWith('.Dockerfile');
};

/** The roots the image and action scan walks. */
export const SCAN_ROOTS = ['images', 'deploy', 'scripts', '.github/workflows', '.github/actions'];

export function scanRepo(root: string): Finding[] {
  const findings: Finding[] = [];
  const scanned = new Set<string>();
  const exists = (file: string) => {
    try {
      return statSync(join(root, file)).isFile();
    } catch {
      return false;
    }
  };
  const scanFile = (file: string) => {
    if (scanned.has(file)) return;
    scanned.add(file);
    const text = readFileSync(join(root, file), 'utf8');
    if (isDockerfile(file)) findings.push(...scanDockerfile(file, text));
    else if (file.endsWith('.sh')) findings.push(...scanShell(file, text));
    else if (/\.ya?ml$/.test(file)) {
      findings.push(...scanYaml(file, text));
      // A local action is scanned wherever it lives, with everything in its directory.
      for (const { target, line } of localUses(text)) {
        const action = [`${target}/action.yml`, `${target}/action.yaml`].find(exists);
        if (!action) {
          findings.push({
            file,
            line,
            message: `uses: ./${target} has no action.yml or action.yaml`,
          });
          continue;
        }
        for (const f of walk(root, [target])) scanFile(f);
      }
    }
  };
  for (const file of walk(root, SCAN_ROOTS)) scanFile(file);
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const pkgFiles = ['package.json'];
  for (const pattern of rootPkg.workspaces ?? []) {
    const dir = pattern.replace(/\/\*$/, '');
    for (const name of readdirSync(join(root, dir))) {
      const file = `${dir}/${name}/package.json`;
      if (exists(file)) pkgFiles.push(file);
    }
  }
  const snapshot = JSON.parse(
    readFileSync(join(root, 'scripts/fixtures/pre-m4-deps.json'), 'utf8'),
  ) as Record<string, string[]>;
  findings.push(
    ...scanPackages(
      pkgFiles.map((file) => ({
        file,
        json: JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>,
      })),
      snapshot,
    ),
  );
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

const DIGEST = `node:24-bookworm-slim@sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(40);

describe('pin scan', () => {
  test('a FROM, COPY --from or ARG image default without @sha256 is reported with file and line', () => {
    const text = [
      `FROM ${DIGEST} AS build`,
      'FROM node:24-bookworm-slim',
      'COPY --from=build /out /opt/x',
      'COPY --from=alpine:3.20 /bin/sh /bin/sh',
      `COPY --from=${DIGEST} /x /x`,
      'ARG BASE=node:24',
      'ARG TOOL_IMAGE=ghcr.io/o/tool:1',
      `ARG BASE_IMAGE=${DIGEST}`,
      'FROM ${BASE}',
      'FROM jumpmaster-trooper:dev',
      'FROM --platform=linux/amd64 debian:12',
      '# FROM commented:out',
    ].join('\n');
    expect(scanDockerfile('images/x/Dockerfile', text)).toEqual([
      { file: 'images/x/Dockerfile', line: 2, message: expect.stringMatching(/FROM.*digest/) },
      {
        file: 'images/x/Dockerfile',
        line: 4,
        message: expect.stringMatching(/COPY --from.*digest/),
      },
      { file: 'images/x/Dockerfile', line: 6, message: expect.stringMatching(/ARG BASE.*digest/) },
      { file: 'images/x/Dockerfile', line: 7, message: expect.stringMatching(/ARG TOOL_IMAGE/) },
      // BASE is declared inside a stage, not before the first FROM, so FROM can't see it.
      { file: 'images/x/Dockerfile', line: 9, message: expect.stringMatching(/FROM.*BASE/) },
      { file: 'images/x/Dockerfile', line: 10, message: expect.stringMatching(/FROM.*digest/) },
      { file: 'images/x/Dockerfile', line: 11, message: expect.stringMatching(/FROM.*digest/) },
    ]);
  });

  test('a build-stage reference passes; an unlisted local tag fails; a listed file may use only its image', () => {
    const stage = `FROM ${DIGEST} AS Build\nCOPY --from=build /a /a\nCOPY --from=0 /b /b\n`;
    expect(scanDockerfile('images/a/Dockerfile', stage)).toEqual([]);
    // A stage name used before it is declared is not a stage yet.
    expect(
      scanDockerfile('images/a/Dockerfile', `COPY --from=later /a /a\nFROM ${DIGEST} AS later`),
    ).toHaveLength(1);
    const local = 'FROM jumpmaster-trooper:dev\n';
    expect(scanDockerfile('images/trooper/e2e/Dockerfile', local)).toEqual([]);
    expect(scanDockerfile('images/other/Dockerfile', local)).toHaveLength(1);
    expect(
      scanDockerfile('images/trooper/e2e/Dockerfile', 'FROM jumpmaster-stick:dev\n'),
    ).toHaveLength(1);
    for (const entry of Object.values(LOCAL_IMAGE_FILES))
      expect(entry.reason.length).toBeGreaterThan(10);
  });

  test('a uses: on a tag or short SHA is reported', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      `      - uses: actions/checkout@${SHA} # v7`,
      '      - uses: actions/checkout@v4',
      `      - uses: actions/checkout@${SHA.slice(0, 7)}`,
      '      - uses: ./.github/actions/local',
      `      - uses: docker://alpine:3.20`,
      `      - uses: 'actions/setup-node@${SHA}'`,
      '    container:',
      '      image: node:24',
      '    services:',
      '      db:',
      `        image: "postgres@sha256:${'c'.repeat(64)}"`,
      '      # uses: actions/checkout@v1',
    ].join('\n');
    expect(scanYaml('.github/workflows/x.yml', text)).toEqual([
      { file: '.github/workflows/x.yml', line: 5, message: expect.stringMatching(/uses:.*SHA/) },
      { file: '.github/workflows/x.yml', line: 6, message: expect.stringMatching(/uses:.*SHA/) },
      { file: '.github/workflows/x.yml', line: 8, message: expect.stringMatching(/digest/) },
      {
        file: '.github/workflows/x.yml',
        line: 11,
        message: expect.stringMatching(/image:.*digest/),
      },
    ]);
  });

  test('a compose image: outside a ${…} placeholder must be a digest', () => {
    const text = [
      'services:',
      '  jumpmaster:',
      '    image: ${JM_SERVER_IMAGE:-ghcr.io/o/server@sha256:' + 'd'.repeat(64) + '}',
      '  stick:',
      '    image: ghcr.io/o/stick:latest',
      '  egress:',
      `    image: ghcr.io/o/egress@sha256:${'e'.repeat(64)}`,
    ].join('\n');
    expect(scanYaml('deploy/compose.yml', text)).toEqual([
      { file: 'deploy/compose.yml', line: 5, message: expect.stringMatching(/image:.*digest/) },
    ]);
  });

  test('a download line without a checksum within three lines is reported', () => {
    const text = [
      `FROM ${DIGEST}`,
      'RUN curl -fsSLo /tmp/cosign https://example.test/cosign \\',
      ' && echo "abc  /tmp/cosign" | sha256sum -c - \\',
      ' && install /tmp/cosign /usr/local/bin/cosign',
      'RUN wget -q https://example.test/uv.tgz -O /tmp/uv.tgz',
      'RUN true',
      'RUN true',
      'RUN true',
      'RUN echo "x  /tmp/uv.tgz" | sha256sum -c -',
      'ADD https://example.test/a.tgz /tmp/a.tgz',
      'ADD --checksum=sha256:abc https://example.test/b.tgz /tmp/b.tgz',
      'RUN curl -fsSL https://example.test/c -o /tmp/c && sha512sum -c /tmp/c.sha512',
      'RUN curl --version',
    ].join('\n');
    expect(scanDockerfile('images/x/Dockerfile', text)).toEqual([
      { file: 'images/x/Dockerfile', line: 5, message: expect.stringMatching(/checksum/) },
      { file: 'images/x/Dockerfile', line: 10, message: expect.stringMatching(/checksum/) },
    ]);
  });

  test('a new npm dependency with ^ or ~ is reported; a pre-M4 caret dependency is not', () => {
    const packages: PackageFile[] = [
      {
        file: 'apps/server/package.json',
        json: {
          name: '@jumpmaster/server',
          dependencies: { fastify: '^5.12.7', 'left-pad': '^1.3.0', '@jumpmaster/protocol': '*' },
          devDependencies: { nock: '^14.0.17', tilde: '~2.0.0', exact: '1.2.3', pre: '1.0.0-rc.1' },
        },
      },
      {
        file: 'apps/egress/package.json',
        json: {
          name: '@jumpmaster/egress',
          dependencies: { fastify: '^5.12.7', '@jumpmaster/protocol': '*' },
          optionalDependencies: { star: '*', latest: 'latest' },
        },
      },
      { file: 'packages/protocol/package.json', json: { name: '@jumpmaster/protocol' } },
    ];
    const snapshot = { 'apps/server/package.json': ['fastify', 'nock', '@jumpmaster/protocol'] };
    expect(scanPackages(packages, snapshot).map((f) => [f.file, f.message])).toEqual([
      ['apps/server/package.json', expect.stringMatching(/left-pad.*exact/)],
      ['apps/server/package.json', expect.stringMatching(/tilde.*exact/)],
      // A pre-M4 name in another package is still new there.
      ['apps/egress/package.json', expect.stringMatching(/fastify.*exact/)],
      ['apps/egress/package.json', expect.stringMatching(/star.*exact/)],
      ['apps/egress/package.json', expect.stringMatching(/latest.*exact/)],
    ]);
  });

  test('the pre-M4 snapshot is frozen: any change to it fails unless this copy changes too', () => {
    // The dependency names of every package file at ff8dfb3, the commit M4 started from. Adding a
    // name to the fixture would exempt a new caret dependency, so the fixture must equal this copy
    // exactly; changing both in one diff makes the exemption visible in review.
    const FROZEN = {
      'package.json': ['@biomejs/biome', 'typescript', 'vitest'],
      'apps/server/package.json': [
        '@jumpmaster/protocol',
        '@modelcontextprotocol/sdk',
        '@octokit/rest',
        '@types/better-sqlite3',
        '@types/js-yaml',
        'better-sqlite3',
        'fastify',
        'js-yaml',
        'nock',
        'zod',
      ],
      'apps/stick/package.json': ['@jumpmaster/protocol', '@types/dockerode', 'dockerode'],
      'apps/trooper/package.json': [],
      'packages/protocol/package.json': ['zod'],
    };
    const raw = readFileSync(join(ROOT, 'scripts/fixtures/pre-m4-deps.json'), 'utf8');
    expect(JSON.parse(raw)).toStrictEqual(FROZEN);
  });

  test('dependabot watches the images and the PR template carries the age rule', () => {
    const dependabot = readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8');
    expect(dependabot).toMatch(/package-ecosystem: docker\n\s+directories:\n\s+- "\/images\/\*"/);
    const template = readFileSync(join(ROOT, '.github/pull_request_template.md'), 'utf8');
    expect(template).toContain(
      'new dependencies: exact pin, version and release date ≥14 days old recorded in the commit',
    );
  });

  test('the repository passes the scan', () => {
    const findings = scanRepo(ROOT);
    expect(findings).toEqual([]);
  });

  test('the repository scan reads the files it claims to', () => {
    // Guards against a scan that silently finds nothing: the shipped trooper Dockerfile and CI
    // workflow are in scope, and a planted bad line in either would be reported.
    const files = walk(ROOT, ['images', 'deploy', '.github/workflows']);
    expect(files).toContain('images/trooper/Dockerfile');
    expect(files).toContain('.github/workflows/ci.yml');
  });
});

// Crafted inputs from the review of the first scan. Each one passed the first scan.
describe('pin scan: review bypasses', () => {
  const F = 'images/x/Dockerfile';
  const D64 = `@sha256:${'a'.repeat(64)}`;
  const lines = (findings: Finding[]) => findings.map((f) => f.line);

  test('a download split by line continuations still needs a checksum', () => {
    const curl = [
      `FROM ${DIGEST}`,
      'RUN curl -fsSLo /x \\',
      '    https://evil.test/bin \\',
      '    && chmod +x /x',
    ].join('\n');
    expect(scanDockerfile(F, curl)).toEqual([
      { file: F, line: 2, message: expect.stringMatching(/checksum/) },
    ]);
    const add = [`FROM ${DIGEST}`, 'ADD \\', '  https://evil.test/a /a'].join('\n');
    expect(scanDockerfile(F, add)).toEqual([
      { file: F, line: 2, message: expect.stringMatching(/checksum/) },
    ]);
    // A checksum inside the same continued instruction still counts.
    const ok = [
      `FROM ${DIGEST}`,
      'RUN curl -fsSLo /x \\',
      '    https://example.test/bin \\',
      '    && echo "abc  /x" | sha256sum -c -',
    ].join('\n');
    expect(scanDockerfile(F, ok)).toEqual([]);
  });

  test('FROM refs are resolved through global ARG defaults and then need a digest', () => {
    const cases: [string, number[]][] = [
      [`ARG NODE=node:24\nFROM \${NODE}`, [2]],
      [`ARG V=24\nFROM node:\${V}`, [2]],
      [`arg BASE=node:24\nfrom \${BASE}`, [1, 2]],
      [`ARG BASE\nFROM \${BASE}`, [2]],
      [`ARG X=1 BASE=node:24\nFROM $BASE`, [1, 2]],
      [`ARG X=1 NODE="node:24"\nFROM \${NODE}`, [2]],
      [`FROM \${UNDECLARED}`, [1]],
      [`FROM \${UNDECLARED:-node:24}`, [1]],
      // Resolved to a digest: fine.
      [`ARG NODE=node:24${D64}\nFROM \${NODE}`, []],
      [`ARG X=1 NODE='node:24${D64}'\nFROM \${NODE} AS build\nCOPY --from=build /a /a`, []],
      [`ARG D=sha256:${'a'.repeat(64)}\nFROM node:24@\${D}`, []],
      [`FROM \${UNDECLARED:-node:24${D64}}`, []],
    ];
    for (const [text, want] of cases) expect(lines(scanDockerfile(F, text)), text).toEqual(want);
    expect(scanDockerfile(F, `ARG BASE\nFROM \${BASE}`)[0]?.message).toMatch(/BASE.*no default/);
  });

  test('a # syntax= parser directive must be digest-pinned', () => {
    expect(scanDockerfile(F, `# syntax=docker/dockerfile:1\nFROM ${DIGEST}`)).toEqual([
      { file: F, line: 1, message: expect.stringMatching(/syntax.*digest/) },
    ]);
    expect(lines(scanDockerfile(F, `#SYNTAX = docker/dockerfile:1.7\nFROM ${DIGEST}`))).toEqual([
      1,
    ]);
    expect(scanDockerfile(F, `# syntax=docker/dockerfile:1${D64}\nFROM ${DIGEST}`)).toEqual([]);
    // A non-default escape character would change how continuations join; refuse it.
    expect(lines(scanDockerfile(F, `# escape=\`\nFROM ${DIGEST}`))).toEqual([1]);
  });

  test('RUN --mount from= and ONBUILD instructions are checked', () => {
    const text = [
      `FROM ${DIGEST} AS build`,
      'RUN --mount=type=bind,from=alpine:3.20,target=/x true',
      'RUN --mount=type=bind,from=build,target=/y --mount=type=cache,target=/root/.npm true',
      `RUN --mount=type=bind,source=/,from=alpine${D64},target=/z true`,
      'ONBUILD COPY --from=alpine:3 /a /a',
      'ONBUILD ADD https://evil.test/a /a',
      'ONBUILD RUN --mount=from=busybox,target=/b true',
    ].join('\n');
    expect(lines(scanDockerfile(F, text))).toEqual([2, 5, 6, 7]);
  });

  test('workflow container:, interpolated image: and flow-style uses: are checked', () => {
    const text = [
      'jobs:',
      '  a:',
      '    container: node:24',
      '    services:',
      '      one:',
      '        image: ghcr.io/o/s:${TAG}',
      '      two:',
      '        image: ${{ matrix.image }}',
      '      three:',
      '        image: ${IMG:-ghcr.io/o/s:latest}',
      '      four:',
      `        image: \${IMG:-ghcr.io/o/s${D64}}`,
      '      five:',
      '        image: ${IMG}',
      `    steps: [{uses: x/y@v4}, {uses: "a/b@${SHA}"}]`,
      '  b:',
      `    container: node${D64}`,
    ].join('\n');
    expect(lines(scanYaml('.github/workflows/x.yml', text))).toEqual([3, 6, 8, 10, 14, 15]);
  });

  test('local uses: targets are scanned, including actions outside .github/actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'jm-pins-'));
    const put = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    put('package.json', '{"workspaces":[]}');
    put('scripts/fixtures/pre-m4-deps.json', '{}');
    put(
      '.github/workflows/w.yml',
      [
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: ./.github/actions/a',
        '      - uses: ./tools/b',
        '      - uses: ./missing',
        '      - uses: ./.github/actions/d',
      ].join('\n'),
    );
    put(
      '.github/actions/a/action.yml',
      'runs:\n  using: composite\n  steps:\n    - uses: foo/bar@v1\n',
    );
    put('tools/b/action.yaml', 'runs:\n  using: composite\n  steps: [{uses: foo/baz@v2}]\n');
    put('.github/actions/d/action.yml', 'runs:\n  using: docker\n  image: Dockerfile\n');
    put('.github/actions/d/Dockerfile', 'FROM alpine:3\n');
    expect(scanRepo(root).map((f) => `${f.file}:${f.line}`)).toEqual([
      '.github/actions/a/action.yml:4',
      '.github/actions/d/Dockerfile:1',
      '.github/workflows/w.yml:6',
      'tools/b/action.yaml:3',
    ]);
  });

  test('shell scripts that name images need digests (or images they build themselves)', () => {
    const S = 'images/x/run.sh';
    const text = [
      'IMG="alpine:3.20"',
      `PINNED="\${OVERRIDE:-alpine${D64}}"`,
      'docker build -q -t jumpmaster-trooper:e2e images/trooper/e2e',
      'docker run --rm alpine:3.20 true',
      `docker run -d --name x --network n -v a:b alpine${D64} sh`,
      'docker run --rm \\',
      '  -e A=b alpine:3.20 sh',
      'docker run "$IMG" true',
      'docker run "$PINNED" true',
      'docker run "$UNSET" true',
      'docker run --rm "${flags[@]}" busybox true',
      'docker pull busybox',
      'out="$(docker create -i --cap-drop ALL jumpmaster-trooper:e2e)"',
      `payload='{"image":"alpine:3.20","x":1}'`,
      `payload='{"image":"jumpmaster-trooper:e2e"}'`,
      'docker exec "$X" true; docker logs "$X"; docker network create n',
    ].join('\n');
    expect(lines(scanShell(S, text))).toEqual([4, 6, 8, 10, 11, 12, 14]);
  });

  test('the shell scan reads the repository scripts', () => {
    // run.sh names its sidecar and the payload's service image; both must be pinned.
    const run = readFileSync(join(ROOT, 'images/trooper/e2e/run.sh'), 'utf8');
    expect(scanShell('images/trooper/e2e/run.sh', run)).toEqual([]);
    expect(
      lines(scanShell('images/trooper/e2e/run.sh', run.replace(/@sha256:[0-9a-f]{64}/g, ''))),
    ).not.toEqual([]);
  });
});
