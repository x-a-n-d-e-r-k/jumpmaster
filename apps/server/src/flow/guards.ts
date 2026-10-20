import { basename, matchesGlob } from 'node:path';
import type { GateSpec } from '@jumpmaster/protocol';
import type { DropZoneConfig } from '../config.js';
import type { BranchRulesRead, PullFiles } from '../forge/github.js';

// ---- protected paths ---------------------------------------------------------------------------

function pathMatches(p: string, glob: string): boolean {
  if (matchesGlob(p, glob)) return true;
  // `dir/**` also covers a bare `dir` entry (a file or symlink standing in for the directory).
  if (glob.endsWith('/**') && p === glob.slice(0, -3)) return true;
  return !glob.includes('/') && matchesGlob(basename(p), glob);
}

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

const NON_REGISTRY = /^(npm:|file:|link:|git|http|github:)/;

type LockPackages = Record<
  string,
  { version?: string; resolved?: string; hasInstallScript?: boolean }
>;

function parseLock(text: string | null): LockPackages | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as { packages?: LockPackages };
    return v.packages && typeof v.packages === 'object' ? v.packages : null;
  } catch {
    return null;
  }
}

const lockName = (key: string): string => key.slice(key.lastIndexOf('node_modules/') + 13);

/** Changes that could swap or wrap the tools the gates run (see the plan's report-string order). */
export function gateToolChanges(
  gates: GateSpec[],
  basePkg: string | null,
  headPkg: string | null,
  baseLock: string | null,
  headLock: string | null,
): string[] {
  const base = parsePkg(basePkg);
  const head = parsePkg(headPkg);
  const out: string[] = [];

  const headPackages = parseLock(headLock);
  const basePackages = parseLock(baseLock) ?? {};
  if (headPackages) {
    for (const [key, entry] of Object.entries(headPackages)) {
      if (!key || !entry.hasInstallScript) continue;
      const before = basePackages[key];
      if (!before || before.version !== entry.version || before.resolved !== entry.resolved) {
        out.push(`install script: ${lockName(key)}`);
      }
    }
  }

  const baseDeps = allDeps(base);
  const headDeps = allDeps(head);
  const depsChanged = !same(baseDeps, headDeps);
  if (depsChanged && headPackages === null) out.push('lockfile unreadable');

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
    if (read.kind === 'none') {
      out.add('no ruleset');
      continue;
    }
    const r = read.rules;
    if (r.requiredApprovals < 1) out.add('approvals < 1');
    if (!r.dismissStaleOnPush) out.add('stale approvals not dismissed');
    if (r.viewerCanBypass) out.add('bot can bypass');
    if (r.viewerIsAdmin) out.add('bot is admin');
    for (const c of r.unpinnedChecks) out.add(`required check not pinned: ${c}`);
    if (zone.ciRequired && r.requiredChecks.length === 0) out.add('no required checks');
  }
  return [...out];
}
