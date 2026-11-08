import { basename, matchesGlob } from 'node:path';
import type { GateSpec } from '@jumpmaster/protocol';
import { pathMatches } from '@jumpmaster/protocol';
import type { DropZoneConfig } from '../config.js';
import type { BranchRulesRead, PullFiles } from '../forge/github.js';

// ---- protected paths ---------------------------------------------------------------------------

/** Changed paths, and rename sources, that match any protected glob (each reported once). */
export function protectedPathHits(files: PullFiles['files'], globs: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const p of [f.path, f.previousPath]) {
      if (p && !hits.includes(p) && globs.some((g) => pathMatches(p, g))) hits.push(p);
    }
  }
  return hits;
}

// ---- gate-invoked scripts ----------------------------------------------------------------------

const NPM_LIFECYCLE: Record<string, string> = {
  test: 'test',
  t: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};

/** The script name one gate command segment runs, or null if it cannot be classified. */
function classifySegment(segment: string): string | null {
  const w = segment.trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return '';
  const [tool, ...rest] = w;
  // Drop flags with values we know (`-w <ws>`, `--workspace <ws>`, `--prefix <dir>`) and bare flags.
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (['-w', '--workspace', '--prefix', '-C', '--dir', '--filter'].includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    args.push(a);
  }
  if (tool === 'npm') {
    const [cmd, name] = args;
    if (cmd === undefined) return null;
    if (cmd in NPM_LIFECYCLE) return NPM_LIFECYCLE[cmd] ?? null;
    if ((cmd === 'run' || cmd === 'run-script') && name) return name;
    return null;
  }
  if (tool === 'node') {
    const i = w.indexOf('--run');
    return i >= 0 && w[i + 1] ? (w[i + 1] as string) : null;
  }
  if (tool === 'pnpm' || tool === 'yarn') {
    const [first, second] = args;
    if (first === 'run' || first === 'run-script') return second ?? null;
    return first ?? null;
  }
  return null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Script names a body references: whole-word names and `run-p|run-s|npm-run-all` globs. */
function referencedScripts(body: string, names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (new RegExp(`(^|[^\\w:-])${escapeRe(n)}($|[^\\w:-])`).test(body)) out.add(n);
  }
  if (/\b(run-p|run-s|npm-run-all)\b/.test(body)) {
    for (const glob of body.match(/[\w:-]+\*/g) ?? []) {
      for (const n of names) if (matchesGlob(n, glob)) out.add(n);
    }
  }
  return [...out];
}

/**
 * Scripts the gates invoke: classified gate commands, closed transitively over script bodies,
 * plus each name's `pre`/`post` hooks. Any unclassifiable command gives `'all'` (fail closed).
 */
export function invokedScripts(
  gates: GateSpec[],
  pkg: Record<string, string>,
): Set<string> | 'all' {
  const roots: string[] = [];
  for (const g of gates) {
    for (const seg of g.run.split(/&&|\|\||;|\|/)) {
      const name = classifySegment(seg);
      if (name === null) return 'all';
      if (name) roots.push(name);
    }
  }
  const names = Object.keys(pkg);
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const n = queue.shift() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    const body = pkg[n];
    if (body !== undefined) queue.push(...referencedScripts(body, names));
  }
  for (const n of [...seen]) {
    seen.add(`pre${n}`);
    seen.add(`post${n}`);
  }
  return seen;
}

type Pkg = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: unknown;
  resolutions?: unknown;
  pnpm?: unknown;
  packageManager?: unknown;
  devEngines?: unknown;
  jest?: unknown;
  mocha?: unknown;
  vitest?: unknown;
};

function parsePkg(text: string | null): Pkg {
  if (text === null) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Pkg) : {};
  } catch {
    return {};
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function invokedNames(gates: GateSpec[], base: Pkg, head: Pkg): Set<string> {
  const all = new Set([...Object.keys(base.scripts ?? {}), ...Object.keys(head.scripts ?? {})]);
  const out = new Set<string>();
  for (const p of [base, head]) {
    const inv = invokedScripts(gates, p.scripts ?? {});
    if (inv === 'all') return all;
    for (const n of inv) out.add(n);
  }
  return out;
}

/**
 * Invoked scripts whose text differs between the merge-base and head `package.json` (added or
 * removed included), sorted.
 */
export function gateScriptChanges(
  gates: GateSpec[],
  basePkg: string | null,
  headPkg: string | null,
): string[] {
  const base = parsePkg(basePkg);
  const head = parsePkg(headPkg);
  const names = invokedNames(gates, base, head);
  return [...names].filter((n) => base.scripts?.[n] !== head.scripts?.[n]).sort();
}

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function allDeps(p: Pkg): Record<string, string> {
  return Object.assign({}, ...DEP_FIELDS.map((f) => p[f] ?? {}));
}

const NON_REGISTRY = /^(npm:|file:|link:|git|http|github:|workspace:|catalog:|portal:|jsr:)/;

/** Whether the dependency fields differ (the lockfile must then be checked). */
export function dependenciesChanged(basePkg: string | null, headPkg: string | null): boolean {
  return !same(allDeps(parsePkg(basePkg)), allDeps(parsePkg(headPkg)));
}

/**
 * Whether `packageManager` pins pnpm 10 or later, which runs no dependency install script unless
 * allow-listed (`pnpm.onlyBuiltDependencies`, itself guarded by `gateToolChanges`).
 */
export function pnpmBlocksBuilds(pkgText: string | null): boolean {
  const pm = parsePkg(pkgText).packageManager;
  const major = typeof pm === 'string' ? /^pnpm@(\d+)(?:[.+]|$)/.exec(pm)?.[1] : undefined;
  return major !== undefined && Number(major) >= 10;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * package.json changes that could swap or wrap the tools the gates run. Lockfile contents are
 * judged separately by `lockfileChanges`.
 */
export function gateToolChanges(
  gates: GateSpec[],
  basePkg: string | null,
  headPkg: string | null,
): string[] {
  const base = parsePkg(basePkg);
  const head = parsePkg(headPkg);
  const out: string[] = [];

  const baseDeps = allDeps(base);
  const headDeps = allDeps(head);
  const nonRegistry = new Set<string>();
  for (const [dep, spec] of Object.entries(headDeps)) {
    if (baseDeps[dep] !== spec && NON_REGISTRY.test(spec)) {
      nonRegistry.add(dep);
      out.push(`${dep}: ${spec}`);
    }
  }
  for (const key of ['overrides', 'resolutions'] as const) {
    if (!same(base[key], head[key])) out.push(`${key} changed`);
  }
  // pnpm reads overrides, build allow-lists, patches and more from here: any change counts.
  const basePnpm = asRecord(base.pnpm);
  const headPnpm = asRecord(head.pnpm);
  if (!same(base.pnpm, head.pnpm)) {
    const keys = [...new Set([...Object.keys(basePnpm), ...Object.keys(headPnpm)])];
    const changed = keys.filter((k) => !same(basePnpm[k], headPnpm[k]));
    if (changed.length === 0) out.push('pnpm changed');
    for (const k of changed) out.push(`pnpm.${k} changed`);
  }
  if (!same(base.packageManager, head.packageManager) || !same(base.devEngines, head.devEngines)) {
    out.push('package manager changed');
  }
  for (const key of ['jest', 'mocha', 'vitest'] as const) {
    if (!same(base[key], head[key])) out.push(`${key} config changed`);
  }

  const names = invokedNames(gates, base, head);
  const bins = new Set<string>();
  for (const p of [base, head]) {
    for (const n of names) {
      const first = p.scripts?.[n]?.trim().split(/\s+/)[0];
      if (first) bins.add(first);
    }
  }
  for (const bin of bins) {
    if (nonRegistry.has(bin)) continue;
    if (bin in baseDeps || bin in headDeps) {
      if (baseDeps[bin] !== headDeps[bin]) out.push(`${bin} version changed`);
    }
  }
  return out;
}

// ---- lockfiles ---------------------------------------------------------------------------------

/** Lockfile names, in the order a directory's lockfile is chosen. */
export const LOCKFILES = [
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

const UNREADABLE = 'lockfile unreadable';

type NpmPackages = Record<
  string,
  { version?: string; resolved?: string; hasInstallScript?: boolean }
>;

function parseNpmLock(text: string): NpmPackages | null {
  try {
    const v = JSON.parse(text) as { packages?: NpmPackages };
    return v.packages && typeof v.packages === 'object' ? v.packages : null;
  } catch {
    return null;
  }
}

const npmName = (key: string): string => key.slice(key.lastIndexOf('node_modules/') + 13);

function npmLockChanges(baseText: string | null, headText: string): string[] {
  const head = parseNpmLock(headText);
  const base = baseText === null ? {} : parseNpmLock(baseText);
  if (!head || !base) return [UNREADABLE];
  const out: string[] = [];
  for (const [key, entry] of Object.entries(head)) {
    if (!key || !entry.hasInstallScript) continue;
    const before = base[key];
    if (!before || before.version !== entry.version || before.resolved !== entry.resolved) {
      out.push(`install script: ${npmName(key)}`);
    }
  }
  return out;
}

/** A parsed pnpm lockfile: each top-level block's text, and each entry's text by key. */
export type PnpmLock = {
  major: number;
  blocks: Map<string, string[]>;
  packages: Map<string, string>;
  snapshots: Map<string, string>;
};

/** Blocks whose any change is reported as `<key> changed`. */
const PNPM_DIFFED = [
  'settings',
  'overrides',
  'patchedDependencies',
  'pnpmfileChecksum',
  'catalogs',
  'packageExtensionsChecksum',
  'ignoredOptionalDependencies',
];
/** Blocks holding dependency `version:` values: importers (v9) and a v6 single project's own. */
const PNPM_IMPORTERS = ['importers', 'dependencies', 'devDependencies', 'optionalDependencies'];
const PNPM_TOP = new Set([
  'lockfileVersion',
  'packages',
  'snapshots',
  ...PNPM_DIFFED,
  ...PNPM_IMPORTERS,
]);

/** A YAML mapping line's key (plain, single- or double-quoted) and inline value; null if odd. */
function splitKey(s: string): { key: string; value: string } | null {
  let key = '';
  let rest: string;
  if (s.startsWith("'")) {
    let i = 1;
    for (;;) {
      const j = s.indexOf("'", i);
      if (j < 0) return null;
      key += s.slice(i, j);
      if (s[j + 1] !== "'") {
        rest = s.slice(j + 1);
        break;
      }
      key += "'";
      i = j + 2;
    }
  } else if (s.startsWith('"')) {
    const j = s.indexOf('"', 1);
    if (j < 0 || s.slice(1, j).includes('\\')) return null;
    key = s.slice(1, j);
    rest = s.slice(j + 1);
  } else {
    const j = s.indexOf(': ');
    if (j >= 0) {
      key = s.slice(0, j);
      rest = s.slice(j);
    } else if (s.endsWith(':')) {
      key = s.slice(0, -1);
      rest = ':';
    } else {
      return null;
    }
  }
  if (key === '') return null;
  if (rest === ':') return { key, value: '' };
  return rest.startsWith(': ') ? { key, value: rest.slice(2) } : null;
}

/**
 * A line-oriented reader for pnpm lockfiles v6–v9 (no YAML dependency). It refuses (null) on
 * anything it does not expect: document markers, comments, tabs, odd or jumping indentation,
 * unknown top-level keys, duplicate keys or another lockfile version.
 */
export function parsePnpmLock(text: string): PnpmLock | null {
  if (text.includes('\t')) return null;
  const blocks = new Map<string, string[]>();
  const sections = {
    packages: new Map<string, string[]>(),
    snapshots: new Map<string, string[]>(),
  };
  let top: string | null = null;
  let topInline = false;
  let entry: string[] | null = null;
  let entryInline = false;
  let prev = 0;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') continue;
    const trimmed = line.trimStart();
    if (/^(---|\.\.\.)(\s|$)/.test(line) || trimmed.startsWith('#')) return null;
    const indent = line.length - trimmed.length;
    if (indent % 2 !== 0 || indent > prev + 2) return null;
    prev = indent;
    if (indent === 0) {
      const kv = splitKey(line);
      if (!kv || !PNPM_TOP.has(kv.key) || blocks.has(kv.key)) return null;
      top = kv.key;
      topInline = kv.value !== '';
      blocks.set(top, [kv.value]);
      entry = null;
      continue;
    }
    if (top === null || topInline) return null;
    blocks.get(top)?.push(line);
    if (top !== 'packages' && top !== 'snapshots') continue;
    const map = sections[top];
    if (indent === 2) {
      const kv = splitKey(trimmed);
      if (!kv || map.has(kv.key)) return null;
      entry = [kv.value];
      entryInline = kv.value !== '';
      map.set(kv.key, entry);
    } else {
      if (!entry || entryInline) return null;
      entry.push(line);
    }
  }
  const version = blocks.get('lockfileVersion')?.[0]?.replace(/^(['"])(.*)\1$/, '$2') ?? '';
  if (!/^\d+(\.\d+)?$/.test(version)) return null;
  const major = Math.floor(Number(version));
  if (major < 6 || major > 9) return null;
  const join = (m: Map<string, string[]>) => new Map([...m].map(([k, v]) => [k, v.join('\n')]));
  return { major, blocks, packages: join(sections.packages), snapshots: join(sections.snapshots) };
}

/** `name` and `version` of an entry key (`/` prefix of v6, peer and patch suffixes dropped). */
function pnpmKeyName(key: string): { name: string; version: string } {
  let k = key.startsWith('/') ? key.slice(1) : key;
  const paren = k.indexOf('(');
  if (paren >= 0) k = k.slice(0, paren);
  const at = k.lastIndexOf('@');
  return at > 0 ? { name: k.slice(0, at), version: k.slice(at + 1) } : { name: k, version: '' };
}

const PLAIN_RESOLUTION = /^ {4}resolution: \{integrity: [^,{}\s]+\}$/m;

/** Dependencies of one entry whose value is not a plain version (an alias, link or file). */
function nonRegistryDeps(text: string): string[] {
  const out: string[] = [];
  let inDeps = false;
  for (const line of text.split('\n')) {
    if (/^ {4}\S/.test(line)) inDeps = /^ {4}(dependencies|optionalDependencies):$/.test(line);
    else if (inDeps && /^ {6}\S/.test(line)) {
      const kv = splitKey(line.trimStart());
      if (!kv || !/^\d/.test(kv.value)) out.push(kv?.key ?? line.trim());
    }
  }
  return out;
}

/** Every `version:` value in an importers-like block, by the path of keys above it. */
function depVersions(lines: string[]): Map<string, { dep: string; version: string }> {
  const out = new Map<string, { dep: string; version: string }>();
  const stack: string[] = [];
  for (const line of lines.slice(1)) {
    const trimmed = line.trimStart();
    const level = (line.length - trimmed.length) / 2;
    const kv = splitKey(trimmed);
    if (!kv) continue;
    stack.length = level;
    stack[level] = kv.key;
    if (kv.key === 'version') {
      out.set(stack.slice(0, level).join('\0'), { dep: stack[level - 1] ?? '', version: kv.value });
    }
  }
  return out;
}

function pnpmLockChanges(
  baseText: string | null,
  headText: string,
  opts: { pnpmBlocksBuilds: boolean },
): string[] {
  const head = parsePnpmLock(headText);
  const base: PnpmLock | null =
    baseText === null
      ? { major: head?.major ?? 9, blocks: new Map(), packages: new Map(), snapshots: new Map() }
      : parsePnpmLock(baseText);
  if (!head || !base) return [UNREADABLE];
  const out: string[] = [];
  const text = (l: PnpmLock, key: string) => l.blocks.get(key)?.join('\n');
  for (const key of PNPM_DIFFED) {
    if (text(base, key) !== text(head, key)) out.push(`${key} changed`);
  }
  for (const key of PNPM_IMPORTERS) {
    const before = depVersions(base.blocks.get(key) ?? []);
    for (const [path, { dep, version }] of depVersions(head.blocks.get(key) ?? [])) {
      if (before.get(path)?.version !== version && !/^\d/.test(version)) {
        out.push(`${dep}: non-registry version ${version}`);
      }
    }
  }
  for (const section of ['packages', 'snapshots'] as const) {
    for (const [key, entry] of head[section]) {
      const before = base[section].get(key);
      if (before === entry) continue;
      const { name, version } = pnpmKeyName(key);
      if (section === 'packages' && !PLAIN_RESOLUTION.test(entry)) {
        out.push(`${name}: non-registry resolution`);
        continue;
      }
      if (before !== undefined) {
        out.push(`lockfile entry changed: ${key}`);
        continue;
      }
      for (const dep of nonRegistryDeps(entry)) out.push(`${name}: non-registry dependency ${dep}`);
      if (section !== 'packages') continue;
      if (/^ {4}requiresBuild: true$/m.test(entry)) out.push(`install script: ${name}`);
      else if (!opts.pnpmBlocksBuilds) {
        out.push(`dependency added: ${name}@${version} (install scripts may run)`);
      }
    }
  }
  return out;
}

/**
 * Lockfile changes that could swap or wrap the tools the gates run, judged by the file's name.
 * A missing head lockfile, an empty read or anything unparseable is `lockfile unreadable`, never
 * "everything added"; a missing base lockfile makes every entry new.
 */
export function lockfileChanges(
  path: string,
  baseText: string | null,
  headText: string | null,
  opts: { pnpmBlocksBuilds: boolean } = { pnpmBlocksBuilds: false },
): string[] {
  const file = basename(path);
  if (file !== 'package-lock.json' && file !== 'npm-shrinkwrap.json' && file !== 'pnpm-lock.yaml') {
    return [`lockfile format not supported: ${file}`];
  }
  if (headText === null || headText === '' || baseText === '') return [UNREADABLE];
  return file === 'pnpm-lock.yaml'
    ? pnpmLockChanges(baseText, headText, opts)
    : npmLockChanges(baseText, headText);
}

// ---- branch protection -------------------------------------------------------------------------

/**
 * Problems with the branch rules both bot identities see. `[]` when protection is not required;
 * null when either read is unavailable (judged on a later pass).
 */
export function branchProtectionProblems(
  rules: { author: BranchRulesRead; reviewer: BranchRulesRead },
  zone: DropZoneConfig,
): string[] | null {
  if (!zone.requireBranchProtection) return [];
  if (rules.author.kind === 'unavailable' || rules.reviewer.kind === 'unavailable') return null;
  const out = new Set<string>();
  for (const read of [rules.author, rules.reviewer]) {
    const adminAllowed = zone.authorMayBeAdmin && read === rules.author;
    if (read.kind === 'none') {
      out.add('no ruleset');
      continue;
    }
    const r = read.rules;
    if (r.requiredApprovals < 1) out.add('approvals < 1');
    if (!r.dismissStaleOnPush) out.add('stale approvals not dismissed');
    if (r.viewerCanBypass) out.add('bot can bypass');
    if (r.viewerIsAdmin && !adminAllowed) out.add('bot is admin');
    for (const c of r.unpinnedChecks) out.add(`required check not pinned: ${c}`);
    if (zone.ciRequired && r.requiredChecks.length === 0) out.add('no required checks');
    for (const t of r.unsupportedRules ?? []) out.add(`unsupported rule: ${t}`);
  }
  return [...out];
}
