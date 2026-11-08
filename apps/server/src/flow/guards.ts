import { basename, matchesGlob } from 'node:path';
import type { GateSpec } from '@jumpmaster/protocol';
import { pathMatches } from '@jumpmaster/protocol';
import yaml from 'js-yaml';
import type { DropZoneConfig } from '../config.js';
import type { BranchRulesRead, PullFiles } from '../forge/github.js';

// ---- protected paths ---------------------------------------------------------------------------

/** Segment-leading dots made plain, so `**` and `*` also cover dotfiles (`node_modules/.bin`). */
const undot = (s: string): string => s.replace(/(^|\/)\./g, '$1\u0001');

const protectedMatch = (p: string, glob: string): boolean =>
  pathMatches(p, glob) || pathMatches(undot(p), undot(glob));

/** Changed paths, and rename sources, that match any protected glob (each reported once). */
export function protectedPathHits(files: PullFiles['files'], globs: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const p of [f.path, f.previousPath]) {
      if (p && !hits.includes(p) && globs.some((g) => protectedMatch(p, g))) hits.push(p);
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

/** First words of the scripts the gates invoke, in either package.json. */
function scriptBins(gates: GateSpec[], base: Pkg, head: Pkg): Set<string> {
  const names = invokedNames(gates, base, head);
  const bins = new Set<string>();
  for (const p of [base, head]) {
    for (const n of names) {
      const first = p.scripts?.[n]?.trim().split(/\s+/)[0];
      if (first) bins.add(first);
    }
  }
  return bins;
}

/**
 * Executables the gates run from node_modules: the first word of each invoked script (base or
 * head package.json) and each `npx` target in a gate command.
 */
export function gateBins(
  gates: GateSpec[],
  basePkg: string | null,
  headPkg?: string | null,
): string[] {
  const bins = scriptBins(gates, parsePkg(basePkg), parsePkg(headPkg ?? basePkg));
  for (const g of gates) {
    for (const seg of g.run.split(/&&|\|\||;|\|/)) {
      const [tool, ...rest] = seg.trim().split(/\s+/);
      const target = rest.find((a) => !a.startsWith('-'));
      if ((tool === 'npx' || tool === 'pnpx') && target) bins.add(target);
    }
  }
  return [...bins];
}

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

  const bins = scriptBins(gates, base, head);
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

type NpmEntry = {
  /** The real package name of an alias (`node_modules/<alias>`). */
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  bin?: unknown;
};
type NpmPackages = Record<string, NpmEntry>;

function parseNpmLock(text: string): NpmPackages | null {
  try {
    const v = JSON.parse(text) as { packages?: NpmPackages };
    return v.packages && typeof v.packages === 'object' ? v.packages : null;
  } catch {
    return null;
  }
}

const npmName = (key: string): string => key.slice(key.lastIndexOf('node_modules/') + 13);

const NPM_REGISTRY = 'registry.npmjs.org';

/** The host of an http(s) `resolved` URL; null for git, file and anything else. */
function httpHost(resolved: string): string | null {
  try {
    const u = new URL(resolved);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null;
  } catch {
    return null;
  }
}

/**
 * Whether a registry URL is the tarball of `pkg@version`: its path ends
 * `/<pkg>/-/<unscoped name>-<version>.tgz` (`/@scope/name/-/name-1.0.0.tgz` when scoped).
 */
function ownTarball(resolved: string, pkg: string, version: string | undefined): boolean {
  if (!version) return false;
  const file = pkg.slice(pkg.lastIndexOf('/') + 1);
  return new URL(resolved).pathname.endsWith(`/${pkg}/-/${file}-${version}.tgz`);
}

function npmLockChanges(
  baseText: string | null,
  headText: string,
  gateBinNames: string[],
): string[] {
  const head = parseNpmLock(headText);
  const base = baseText === null ? {} : parseNpmLock(baseText);
  if (!head || !base) return [UNREADABLE];
  // The registry is npm's, or the one the base lockfile already resolves from.
  const hosts = new Set([NPM_REGISTRY]);
  for (const e of Object.values(base)) {
    const h = typeof e.resolved === 'string' && !e.link ? httpHost(e.resolved) : null;
    if (h) hosts.add(h);
  }
  const out: string[] = [];
  for (const [key, entry] of Object.entries(head)) {
    if (!key) continue;
    const before = base[key];
    const moved = !before || before.version !== entry.version || before.resolved !== entry.resolved;
    if (!moved && before.integrity === entry.integrity && before.link === entry.link) continue;
    const name = npmName(key);
    if (entry.link) {
      out.push(`${name}: linked to ${entry.resolved ?? '?'}`);
    } else if (typeof entry.resolved === 'string') {
      const host = httpHost(entry.resolved);
      if (!host || !hosts.has(host)) out.push(`${name}: non-registry resolved ${entry.resolved}`);
      else if (!ownTarball(entry.resolved, entry.name ?? name, entry.version)) {
        out.push(
          `${name}: resolved ${entry.resolved} is not ${entry.name ?? name}@${entry.version}`,
        );
      }
    }
    if (entry.hasInstallScript && moved) out.push(`install script: ${name}`);
    const bins = entry.bin && typeof entry.bin === 'object' ? Object.keys(entry.bin) : [];
    if (moved && [name, ...bins].some((b) => gateBinNames.includes(b))) {
      out.push(`${name} version changed in lockfile`);
    }
  }
  return out;
}

type YamlMap = Record<string, unknown>;

/** A parsed pnpm lockfile: the whole tree, and each `packages:` / `snapshots:` entry by key. */
export type PnpmLock = {
  major: number;
  doc: YamlMap;
  packages: Map<string, YamlMap>;
  snapshots: Map<string, YamlMap>;
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

const isMap = (v: unknown): v is YamlMap =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** One line with its quoted scalars blanked, so their contents can't look like YAML syntax. */
function unquoted(line: string): string {
  let out = '';
  // A quote opens a quoted scalar only where a node starts: an apostrophe inside a plain scalar
  // (`a'b`) is just a character.
  let atNode = true;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (atNode && (c === "'" || c === '"')) {
      let j = i + 1;
      for (; j < line.length; j++) {
        if (c === '"' && line[j] === '\\') j++;
        else if (line[j] === c) {
          if (c === "'" && line[j + 1] === "'") j++;
          else break;
        }
      }
      out += '""';
      i = j;
      atNode = false;
      continue;
    }
    out += c;
    if (c === ' ') continue;
    const next = line[i + 1];
    atNode =
      c === '[' ||
      c === '{' ||
      c === ',' ||
      ((c === ':' || c === '-') && (next === undefined || next === ' '));
  }
  return out;
}

/** Only what JSON can hold: a Date, Buffer or other typed value means a schema-specific read. */
function plainTree(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(plainTree);
  if (typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v as object).every(plainTree);
}

/**
 * YAML features pnpm never writes and a reader could disagree on: a lone CR, tabs, document
 * markers, comments, anchors (`&`), aliases (`*`), tags (`!`) and merge keys (`<<`).
 */
function unexpectedSyntax(text: string): boolean {
  if (/\r(?!\n)/.test(text) || text.includes('\t')) return true;
  for (const raw of text.split(/\r?\n/)) {
    const line = unquoted(raw);
    if (/^(---|\.\.\.)(\s|$)/.test(line) || /^\s*#/.test(line)) return true;
    // A node starts at the line start, after `key:`, `- ` or a flow `[`, `{` or `,`.
    if (/(^\s*|:\s+|-\s+|[[{,]\s*)[&*!]/.test(line)) return true;
    if (/(^|[\s{,])<<\s*:/.test(line)) return true;
  }
  return false;
}

/**
 * Reads a pnpm lockfile v6–v9 with js-yaml's default schema (as pnpm does), after refusing
 * syntax pnpm never writes. null on anything unexpected: a parse error (duplicate keys included), an unknown
 * top-level key, an entry that is not a mapping, or another lockfile version.
 */
export function parsePnpmLock(text: string): PnpmLock | null {
  if (unexpectedSyntax(text)) return null;
  // The text check above is hygiene; this is the boundary. pnpm reads with js-yaml's default
  // schema (merge keys, timestamps, binary): the tree must be plain and the same under the core
  // schema, so no schema-specific feature can mean something the checks below don't see.
  let doc: unknown;
  try {
    doc = yaml.load(text);
    const core = yaml.load(text, { schema: yaml.CORE_SCHEMA });
    if (!plainTree(doc) || JSON.stringify(doc) !== JSON.stringify(core)) return null;
  } catch {
    return null;
  }
  if (!isMap(doc) || Object.keys(doc).some((k) => !PNPM_TOP.has(k))) return null;
  const version = String(doc.lockfileVersion ?? '');
  if (!/^\d+(\.\d+)?$/.test(version)) return null;
  const major = Math.floor(Number(version));
  if (major < 6 || major > 9) return null;
  const entries = (v: unknown): Map<string, YamlMap> | null => {
    if (v === undefined || v === null) return new Map();
    if (!isMap(v)) return null;
    const out = new Map<string, YamlMap>();
    for (const [k, e] of Object.entries(v)) {
      if (e !== null && !isMap(e)) return null;
      out.set(k, e ?? {});
    }
    return out;
  };
  const packages = entries(doc.packages);
  const snapshots = entries(doc.snapshots);
  if (!packages || !snapshots) return null;
  for (const key of PNPM_IMPORTERS) {
    if (doc[key] !== undefined && doc[key] !== null && !isMap(doc[key])) return null;
  }
  return { major, doc, packages, snapshots };
}

/** `name` and `version` of an entry key (`/` prefix of v6, peer and patch suffixes dropped). */
function pnpmKeyName(key: string): { name: string; version: string } {
  let k = key.startsWith('/') ? key.slice(1) : key;
  const paren = k.indexOf('(');
  if (paren >= 0) k = k.slice(0, paren);
  const at = k.lastIndexOf('@');
  return at > 0 ? { name: k.slice(0, at), version: k.slice(at + 1) } : { name: k, version: '' };
}

/** A registry tarball: a resolution that is exactly `{integrity: <string>}`. */
const plainResolution = (entry: YamlMap): boolean => {
  const r = entry.resolution;
  return isMap(r) && Object.keys(r).length === 1 && typeof r.integrity === 'string';
};

/**
 * Dependencies of one entry whose value is not a plain version (an alias, link or file); a
 * dependency map that is not a mapping of scalars is null (unreadable).
 */
function nonRegistryDeps(entry: YamlMap): string[] | null {
  const out: string[] = [];
  for (const field of ['dependencies', 'optionalDependencies']) {
    const deps = entry[field];
    if (deps === undefined || deps === null) continue;
    if (!isMap(deps)) return null;
    for (const [dep, value] of Object.entries(deps)) {
      if (typeof value !== 'string' && typeof value !== 'number') return null;
      if (!/^\d\S*$/.test(String(value))) out.push(dep);
    }
  }
  return out;
}

/** Every `version:` value under an importers-like block, by the path of keys above it. */
function depVersions(block: unknown): Map<string, { dep: string; version: string }> {
  const out = new Map<string, { dep: string; version: string }>();
  const walk = (node: unknown, path: string[]) => {
    if (!isMap(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'version' && (typeof v === 'string' || typeof v === 'number')) {
        out.set(path.join('\0'), { dep: path.at(-1) ?? '', version: String(v) });
      } else {
        walk(v, [...path, k]);
      }
    }
  };
  walk(block, []);
  return out;
}

/** Which packages pnpm 10 still lets build: read from package.json and pnpm-workspace.yaml. */
export type PnpmBuildPolicy = { allowAll: boolean; allowed: string[] };

type LockOptions = {
  /** New registry packages pass: the zone trusts pnpm >= 10's build blocking and it is pinned. */
  pnpmBlocksBuilds: boolean;
  allowAllBuilds?: boolean;
  allowedBuilds?: string[];
  gateBins?: string[];
};

/**
 * The union of build allow-lists over the given package.json and pnpm-workspace.yaml texts (base
 * and head). An allow-list file, an allow-all setting or an unreadable workspace file allow all.
 */
export function pnpmBuildPolicy(
  pkgTexts: (string | null)[],
  workspaceTexts: (string | null)[],
): PnpmBuildPolicy {
  const allowed = new Set<string>();
  let allowAll = false;
  const read = (settings: YamlMap) => {
    if (settings.dangerouslyAllowAllBuilds || settings.onlyBuiltDependenciesFile) allowAll = true;
    const only = settings.onlyBuiltDependencies;
    if (Array.isArray(only)) for (const n of only) allowed.add(String(n));
    else if (only !== undefined && only !== null) allowAll = true;
    const builds = settings.allowBuilds;
    if (Array.isArray(builds)) for (const n of builds) allowed.add(String(n));
    else if (isMap(builds)) {
      for (const [n, v] of Object.entries(builds)) if (v) allowed.add(n);
    } else if (builds !== undefined && builds !== null) allowAll = true;
  };
  for (const t of pkgTexts) {
    const pnpm = parsePkg(t).pnpm;
    if (isMap(pnpm)) read(pnpm);
  }
  for (const t of workspaceTexts) {
    if (t === null) continue;
    let doc: unknown;
    try {
      doc = yaml.load(t, { schema: yaml.CORE_SCHEMA }); // read as pnpm reads it
    } catch {
      doc = undefined;
    }
    if (isMap(doc)) read(doc);
    else if (t.trim() !== '') allowAll = true;
  }
  return { allowAll, allowed: [...allowed] };
}

function pnpmLockChanges(baseText: string | null, headText: string, opts: LockOptions): string[] {
  const head = parsePnpmLock(headText);
  const base: PnpmLock | null =
    baseText === null
      ? { major: head?.major ?? 9, doc: {}, packages: new Map(), snapshots: new Map() }
      : parsePnpmLock(baseText);
  if (!head || !base) return [UNREADABLE];
  const out: string[] = [];
  for (const key of PNPM_DIFFED) {
    if (!same(base.doc[key], head.doc[key])) out.push(`${key} changed`);
  }
  for (const key of PNPM_IMPORTERS) {
    const before = depVersions(base.doc[key]);
    for (const [path, { dep, version }] of depVersions(head.doc[key])) {
      if (before.get(path)?.version !== version && !/^\d\S*$/.test(version)) {
        out.push(`${dep}: non-registry version ${version}`);
      }
    }
  }
  for (const section of ['packages', 'snapshots'] as const) {
    for (const [key, entry] of head[section]) {
      const before = base[section].get(key);
      if (before !== undefined && same(before, entry)) continue;
      const { name, version } = pnpmKeyName(key);
      const deps = nonRegistryDeps(entry);
      if (deps === null) return [UNREADABLE];
      if (section === 'packages' && !plainResolution(entry)) {
        out.push(`${name}: non-registry resolution`);
        continue;
      }
      if (before !== undefined) {
        out.push(`lockfile entry changed: ${key}`);
        continue;
      }
      for (const dep of deps) out.push(`${name}: non-registry dependency ${dep}`);
      if (section !== 'packages') continue;
      const added = `dependency added: ${name}@${version}`;
      if (entry.requiresBuild) out.push(`install script: ${name}`);
      else if (opts.pnpmBlocksBuilds && opts.allowAllBuilds) {
        out.push(`${added} (all builds allowed: its install script runs)`);
      } else if (opts.pnpmBlocksBuilds && opts.allowedBuilds?.includes(name)) {
        out.push(`${added} (in the build allow-list: its install script runs)`);
      } else if (!opts.pnpmBlocksBuilds) {
        out.push(
          `dependency added: ${name}@${version} (verified: registry integrity only; install scripts may run)`,
        );
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
  opts: LockOptions = { pnpmBlocksBuilds: false },
): string[] {
  const file = basename(path);
  if (file !== 'package-lock.json' && file !== 'npm-shrinkwrap.json' && file !== 'pnpm-lock.yaml') {
    return [`lockfile format not supported: ${file}`];
  }
  if (headText === null || headText === '' || baseText === '') return [UNREADABLE];
  return file === 'pnpm-lock.yaml'
    ? pnpmLockChanges(baseText, headText, opts)
    : npmLockChanges(baseText, headText, opts.gateBins ?? []);
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
