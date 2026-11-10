import type { z } from 'zod';
import { DropZoneObject, EditableSchema, STARTER_WARNING } from '../config.js';
import { PRESET_EGRESS } from '../presets.js';
import { canonicalJson } from './revisions.js';

/**
 * Guarded paths (§7.5). A change that lets more code run, lets a drop reach more, hands a drop a
 * credential or weakens a merge guard is **guarded**: from a browser session it needs the
 * confirmation page; from the operator token or the file it is the operator's business. Two
 * changes are **session-forbidden** whatever is confirmed (weakening `requireSignedImages`, a
 * zone's `image`), and one is **refused** for every principal (`repo` on an existing zone).
 *
 * The classifier judges documents, not raw diffs: values are parsed with the schema (defaults
 * filled, so a removed key is its default) and normalized to their effective value (a zone's
 * `requireSignedImages` falls back to the install's; an absent `egress` is mode `off`); an added
 * zone is judged against `ADD_BASELINE`; list paths are set differences. It fails closed: a changed
 * path that no table names is guarded, and a test walks the schema so a new field can't be
 * missing from every table.
 *
 * An added zone's `repo` is itself guarded (review I1): a new project's code runs in drops with
 * the Claude token, and any public repository's owner is a trusted author of their own issues
 * (§7.1). On an existing zone `repo` is refused, so changing a repository is remove-and-re-add,
 * and the re-add asks.
 *
 * Known residual of "a rename is a removal plus an add": a zone-level `requireSignedImages: true`
 * under an install-level `false` is not carried to the renamed zone, since the add baseline takes
 * the install's level by definition. It is bounded: the removal needs the old zone drained in
 * observe; the added zone's `repo` is guarded (the confirmation names it); an explicit `image` on
 * it is session-forbidden, so it can only run a preset's image, pinned by digest in the release
 * lock; and the generated install sets the top-level `requireSignedImages: true`, where a zone
 * cannot be weaker and the case cannot arise. Matching an add to a removal to forbid it would be a
 * guess (an unrelated add and remove in one change look the same) and is split into two applies
 * anyway.
 */

/** A document as the schema parses it: defaults filled, `image` as the operator wrote it. */
export type EditableDoc = z.output<typeof EditableSchema>;
export type ZoneDoc = z.output<typeof DropZoneObject>;

export type GuardCtx = {
  zoneId?: string;
  /** The install-wide document after the change (its fallbacks decide effective values). */
  install: Partial<EditableDoc>;
  /** The zone is new in this change: it is judged against the add baseline. */
  added: boolean;
};

export type GuardedPath = {
  /** `dropZones[].x` for a zone setting, else the install-wide path. */
  path: string;
  kind: 'scalar' | 'set';
  /** Whether `from → to` (effective values) is a weakening. */
  weakens: (from: unknown, to: unknown, ctx: GuardCtx) => boolean;
  /** One sentence naming the zone and the value; a set path gives one per item it adds or drops. */
  consequence: (from: unknown, to: unknown, ctx: GuardCtx) => string | string[];
};

export type ForbiddenPath = {
  path: string;
  applies: (from: unknown, to: unknown, ctx: GuardCtx) => boolean;
};

export type RefusedPath = ForbiddenPath & {
  message: string;
  /** What the same path means on an added zone, where it is not refused but guarded. */
  onAdd?: (to: unknown, ctx: GuardCtx) => string;
};

export type FreePath = {
  path: string;
  /** Why changing it lets nothing more run, reach or merge. */
  reason: string;
  /** Said on the page beside the change, without asking. */
  note?: string;
};

export type Classification = {
  guarded: { path: string; consequence: string }[];
  sessionForbidden: string[];
  refused: { path: string; message: string }[];
  notes: { path: string; note: string }[];
  /** Zone ids only in `after` (judged against the add baseline), and only in `before`. */
  added: string[];
  removed: string[];
};

const EGRESS_RANK: Record<string, number> = { off: 0, monitor: 1, enforce: 2 };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const presetHosts = (p: unknown): string[] =>
  typeof p === 'string' ? (PRESET_EGRESS[p as keyof typeof PRESET_EGRESS] ?? []) : [];
const zoneOf = (ctx: GuardCtx) => ctx.zoneId ?? '(install)';

/** `to` minus `from` (an item is equal when its canonical JSON is). */
function added(from: unknown, to: unknown): unknown[] {
  const had = new Set(list(from).map((x) => canonicalJson(x)));
  return list(to).filter((x) => !had.has(canonicalJson(x)));
}

/** A set path that weakens by additions or by removals, one sentence per item. */
function setRule(
  path: string,
  direction: 'additions' | 'removals',
  say: (item: string, ctx: GuardCtx) => string,
): GuardedPath {
  const items = (from: unknown, to: unknown) =>
    direction === 'additions' ? added(from, to) : added(to, from);
  return {
    path,
    kind: 'set',
    weakens: (from, to) => items(from, to).length > 0,
    consequence: (from, to, ctx) => items(from, to).map((i) => say(String(i), ctx)),
  };
}

/** A scalar path that weakens when it becomes `bad`. */
function becomes(path: string, bad: unknown, say: (ctx: GuardCtx) => string): GuardedPath {
  return {
    path,
    kind: 'scalar',
    weakens: (from, to) => to === bad && from !== bad,
    consequence: (_f, _t, ctx) => say(ctx),
  };
}

type Service = { name?: unknown; image?: unknown };
/**
 * Services keyed by name: new names and changed images, as `name → image`. A service's `env`,
 * `port` and `readyTimeoutSeconds` change freely on the same image: the image is what decides
 * what runs beside the drop (bounded like any image the operator chose), `env` is plain config,
 * never a secret (secrets reach gate steps only through `gateSecrets`, which is guarded), and the
 * port and timeout only say where and how long to wait for it on the drop's private network.
 */
function servicesAdded(from: unknown, to: unknown): string[] {
  const was = new Map(list(from).map((s) => [(s as Service).name, (s as Service).image]));
  return list(to)
    .filter((s) => was.get((s as Service).name) !== (s as Service).image)
    .map((s) => String((s as Service).image));
}

export const GUARDED_PATHS: GuardedPath[] = [
  {
    path: 'dropZones[].egress.mode',
    kind: 'scalar',
    weakens: (from, to) => (EGRESS_RANK[String(to)] ?? 0) < (EGRESS_RANK[String(from)] ?? 0),
    consequence: (_f, to, ctx) =>
      to === 'off'
        ? `Drops in ${zoneOf(ctx)} will be able to reach any host on the internet`
        : `Drops in ${zoneOf(ctx)} will be able to reach hosts outside the allow list, with only a record of it`,
  },
  becomes(
    'dropZones[].authorMayBeAdmin',
    true,
    (ctx) =>
      `The author token for ${zoneOf(ctx)} may belong to an admin, who can bypass branch rules`,
  ),
  becomes('dropZones[].identity', 'starter', (ctx) => `zone ${zoneOf(ctx)}: ${STARTER_WARNING}`),
  becomes(
    'dropZones[].ciRequired',
    false,
    (ctx) => `Agent PRs in ${zoneOf(ctx)} will merge without CI`,
  ),
  becomes(
    'dropZones[].requireBranchProtection',
    false,
    (ctx) => `Agent PRs in ${zoneOf(ctx)} will merge without branch protection`,
  ),
  becomes(
    'dropZones[].reviewReadToken',
    true,
    (ctx) => `The read token will reach review drops in ${zoneOf(ctx)}`,
  ),
  becomes(
    'dropZones[].trustPnpmBuildBlocking',
    true,
    (ctx) => `Gates in ${zoneOf(ctx)} will run package build scripts pnpm would otherwise block`,
  ),
  // Follow-up 26: CI=false lets a gate install resolve afresh, which weakens the lockfile review.
  becomes(
    'dropZones[].gateCi',
    false,
    (ctx) =>
      `Gates in ${zoneOf(ctx)} will run with CI=false, so an install may resolve afresh and run what it resolved`,
  ),
  // Beyond the plan's list: a refute that promotes turns agent-filed work into dispatched work.
  becomes(
    'dropZones[].crew.refutePromotes',
    true,
    (ctx) => `A crew refute in ${zoneOf(ctx)} will be able to promote a staged issue to ready`,
  ),
  {
    path: 'dropZones[].crew.goalPath',
    kind: 'scalar',
    weakens: (from, to) => from !== to,
    consequence: (_f, to, ctx) =>
      `The crew in ${zoneOf(ctx)} will read its objectives from ${String(to)}, which must be a protected path`,
  },
  {
    // A preset is an image bounded by the signed lock; what it adds is its egress hosts. On an
    // added zone the baseline carries the zone's own preset, so it never differs there.
    path: 'dropZones[].preset',
    kind: 'scalar',
    weakens: (from, to, ctx) => !ctx.added && added(presetHosts(from), presetHosts(to)).length > 0,
    consequence: (from, to, ctx) =>
      `Drops in ${zoneOf(ctx)} will be able to reach ${added(presetHosts(from), presetHosts(to)).join(', ')}`,
  },
  becomes(
    'usage.stopOnOverage',
    false,
    () => 'Dispatch will continue on usage credits; only a briefing is raised',
  ),
  becomes(
    'mcp.enabled',
    true,
    () => "Command's MCP server will accept tokens at /mcp after the next restart",
  ),
  setRule(
    'dropZones[].egress.allow',
    'additions',
    (h, ctx) => `Drops in ${zoneOf(ctx)} will be able to send data to ${h}`,
  ),
  {
    path: 'dropZones[].services',
    kind: 'set',
    weakens: (from, to) => servicesAdded(from, to).length > 0,
    consequence: (from, to, ctx) =>
      servicesAdded(from, to).map(
        (image) => `The stick will run ${image} beside every drop in ${zoneOf(ctx)}`,
      ),
  },
  setRule(
    'dropZones[].protectedPaths',
    'removals',
    (p, ctx) =>
      `Agents will be able to merge changes to ${p} in ${zoneOf(ctx)} without a human review`,
  ),
  setRule(
    'dropZones[].overrideApprovers',
    'additions',
    (l, ctx) => `${l} will be able to override branch-rule problems for ${zoneOf(ctx)}`,
  ),
  setRule(
    'dropZones[].gateSecrets',
    'additions',
    (n, ctx) =>
      `Gate steps in ${zoneOf(ctx)} will receive the secret ${n}; any PR's gate code can read it`,
  ),
  setRule(
    'dropZones[].botLogins',
    'removals',
    (l, ctx) => `Comments by ${l} in ${zoneOf(ctx)} will no longer be ignored as a bot's`,
  ),
  setRule(
    'dropZones[].adoptPulls',
    'additions',
    (n, ctx) => `Jumpmaster will take over PR #${n} in ${zoneOf(ctx)} and may merge it`,
  ),
];

/** Never a session's to change, confirmed or not: they decide what runs with the secrets. */
export const SESSION_FORBIDDEN: ForbiddenPath[] = [
  { path: 'requireSignedImages', applies: (from, to) => from === true && to === false },
  // Effective values: the zone's own setting, else the install's.
  { path: 'dropZones[].requireSignedImages', applies: (from, to) => from === true && to === false },
  // Set on an added zone (the baseline has none), or changed or removed on an existing one.
  { path: 'dropZones[].image', applies: (from, to) => from !== to },
];

/** Refused for every principal. */
export const REFUSED_PATHS: RefusedPath[] = [
  {
    path: 'dropZones[].repo',
    applies: (from, to, ctx) => !ctx.added && from !== to,
    message: "the repository of a zone can't change: remove the zone and add a new one",
    onAdd: (to) =>
      `A new project, ${String(to)}: its code will run in drops with your Claude credentials, and Jumpmaster will act on its issues and PRs with the forge tokens`,
  },
];

const free = (path: string, reason: string, note?: string): FreePath => ({
  path,
  reason,
  ...(note ? { note } : {}),
});
const BUDGET =
  'a retry budget: it bounds attempts, and every attempt still passes the merge guards';
const PACE = 'a pace or cap on work that still passes every guard';
const MCP_LIMIT = 'an MCP rate limit; the server is off unless mcp.enabled, which is guarded';

/** Settings that let nothing more run, reach or merge: changed freely, each with its reason. */
export const NOT_GUARDED: FreePath[] = [
  free('pollSeconds', PACE),
  free('usage.throttleUtilization', PACE),
  free('usage.probeJitterSeconds', PACE),
  free('claude.plan', 'the declared plan picks models and caps, never what may run or merge'),
  free(
    'claude.fableModel',
    'a model name for a role; drops run the same code under the same guards',
  ),
  free('claude.fableWeeklyDropCap', PACE),
  free('claude.tokenCreatedAt', 'a date the doctor reads for the expiry warning'),
  free('mcp.maxBodyBytes', MCP_LIMIT),
  free('mcp.writesPerHour', MCP_LIMIT),
  free('mcp.callsPerHour', MCP_LIMIT),
  free('mcp.maxOpenBriefings', MCP_LIMIT),
  free('dropZones[].id', 'the zone key: a different id is a removal plus an add, judged as such'),
  free(
    'dropZones[].readyLabel',
    'which label marks an issue ready; the author check still gates every issue (§7.1)',
    'renaming to a label already on many issues dispatches them all',
  ),
  free(
    'dropZones[].gates',
    'gate commands run credential-less inside drops (§7.2), and the repository they run from can already change its own scripts and code, the larger surface; CI and review still guard the merge',
  ),
  free('dropZones[].verification', 'reviewer verification steps, run inside drops like gates'),
  free('dropZones[].limits.pids', 'a container resource limit, not an access'),
  free('dropZones[].limits.memoryMb', 'a container resource limit, not an access'),
  free('dropZones[].limits.shmMb', 'a container resource limit, not an access'),
  free('dropZones[].maxConcurrentImplement', PACE),
  free('dropZones[].outboxDeadlineMinutes', 'how long a forge write may stay unknown'),
  free('dropZones[].mode', 'the starting mode, used only until an operator stores one'),
  free('dropZones[].model', 'the model a drop runs; the same guards hold'),
  free('dropZones[].maxTurns', PACE),
  free('dropZones[].models', 'per-role models; the same guards hold'),
  free('dropZones[].budgets.maxHeal', BUDGET),
  free('dropZones[].budgets.maxResolve', BUDGET),
  free('dropZones[].budgets.maxResolveTotal', BUDGET),
  free('dropZones[].budgets.maxResume', BUDGET),
  free('dropZones[].budgets.maxReviewRepeat', BUDGET),
  free('dropZones[].budgets.maxNoChange', BUDGET),
  free(
    'dropZones[].ciDeadlineMinutes',
    'how long to wait for CI; a missing CI is still a no-merge',
  ),
  free('dropZones[].retryLabel', 'the label that asks for a retry of parked work'),
  free('dropZones[].mergeMethod', 'squash is the only value the schema accepts'),
  free('dropZones[].attribution', 'whether PRs carry a co-author trailer'),
  free(
    'dropZones[].crew.enabled',
    'crew-filed issues wait under the staged label until Command promotes them',
  ),
  free('dropZones[].crew.cycleMinutes', PACE),
  free('dropZones[].crew.maxDropsPerDay', PACE),
  free(
    'dropZones[].crew.stagedLabel',
    'the label staged issues wait under (it must differ from readyLabel)',
  ),
  free('dropZones[].crew.maxStaged', PACE),
  free('dropZones[].crew.maxRefute', PACE),
];

/**
 * The value a setting runs with: the schema default for a removed key (the document is parsed
 * first), a zone's `requireSignedImages` falling back to the install's, and an absent `egress` as
 * mode `off` with no extra hosts. `doc` is a zone (for zone paths) or the install document.
 */
export function effective(
  doc: Record<string, unknown> | undefined,
  path: string,
  install: Partial<EditableDoc> | Record<string, unknown>,
): unknown {
  const egress = doc?.egress as { mode?: unknown; allow?: unknown } | undefined;
  if (path === 'egress.mode') return egress?.mode ?? 'off';
  if (path === 'egress.allow') return egress?.allow ?? [];
  if (path === 'requireSignedImages')
    return (
      doc?.requireSignedImages ??
      (install as { requireSignedImages?: boolean }).requireSignedImages ??
      false
    );
  let v: unknown = doc;
  for (const k of path.split('.')) v = isPlain(v) ? v[k] : undefined;
  return v;
}

/**
 * Where an added zone starts: the schema defaults with egress `monitor` (the generated install's
 * starting point) and the zone's own `preset`, so its base hosts are the starting point and the
 * preset itself is never guarded there.
 */
export function ADD_BASELINE(zone: { id?: unknown; repo?: unknown; preset?: unknown }): ZoneDoc {
  const base = DropZoneObject.parse({
    id: zone.id,
    repo: zone.repo,
    gates: [],
    ...(zone.preset === undefined ? {} : { preset: zone.preset }),
  });
  return { ...base, egress: { mode: 'monitor', allow: [] } };
}

/** The template prefix of a zone setting's path. */
const ZONE_PREFIX = 'dropZones[].';

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaf values by dotted path: plain objects are descended, arrays and scalars are leaves. */
function flatten(v: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (!isPlain(v)) {
    if (prefix !== '' && v !== undefined) out.set(prefix, v);
    return out;
  }
  for (const [k, child] of Object.entries(v)) flatten(child, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** A zone's leaves with the effective values the rules judge. */
function zoneLeaves(zone: Record<string, unknown>, install: Partial<EditableDoc>) {
  const out = flatten(zone, '', new Map());
  for (const p of ['egress.mode', 'egress.allow', 'requireSignedImages'])
    out.set(p, effective(zone, p, install));
  return out;
}

type AnyRule =
  | { t: 'guarded'; r: GuardedPath }
  | { t: 'forbidden'; r: ForbiddenPath }
  | { t: 'refused'; r: RefusedPath }
  | { t: 'free'; r: FreePath };

const RULES = new Map<string, AnyRule>([
  ...GUARDED_PATHS.map((r): [string, AnyRule] => [r.path, { t: 'guarded', r }]),
  ...SESSION_FORBIDDEN.map((r): [string, AnyRule] => [r.path, { t: 'forbidden', r }]),
  ...REFUSED_PATHS.map((r): [string, AnyRule] => [r.path, { t: 'refused', r }]),
  ...NOT_GUARDED.map((r): [string, AnyRule] => [r.path, { t: 'free', r }]),
]);

/** The rule for a template path; a record's own keys (`models.implement`) take the record's. */
function ruleFor(template: string): AnyRule | undefined {
  for (let p = template; p !== ''; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') {
    const r = RULES.get(p);
    if (r) return r;
    if (p === 'dropZones[]') break;
  }
  return undefined;
}

const short = (v: unknown): string => {
  const s = v === undefined ? '(unset)' : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

export type ClassifyOptions = {
  /** How a document is read (the schema by default); a test seam for a field with no rule. */
  parse?: (doc: unknown) => EditableDoc;
};

/**
 * Judges `before → after` (both validated documents). Zones are matched by `id`; a zone only in
 * `after` is judged against `ADD_BASELINE`; a zone only in `before` is a removal (the store's
 * drained rule); a rename is both. A changed path that no table names is guarded (fail closed).
 */
export function classify(
  before: unknown,
  after: unknown,
  opts: ClassifyOptions = {},
): Classification {
  const parse = opts.parse ?? ((d: unknown) => EditableSchema.parse(d ?? {}));
  const b = parse(before ?? {});
  const a = parse(after);
  const out: Classification = {
    guarded: [],
    sessionForbidden: [],
    refused: [],
    notes: [],
    added: [],
    removed: [],
  };

  const judge = (
    concrete: string,
    template: string,
    from: unknown,
    to: unknown,
    ctx: GuardCtx,
  ): void => {
    if (canonicalJson(from ?? null) === canonicalJson(to ?? null)) return;
    const rule = ruleFor(template);
    if (!rule) {
      out.guarded.push({
        path: concrete,
        consequence: `${concrete} changes from ${short(from)} to ${short(to)}: Jumpmaster can't tell whether that weakens a guard, so it asks`,
      });
      return;
    }
    switch (rule.t) {
      case 'free':
        if (rule.r.note) out.notes.push({ path: concrete, note: rule.r.note });
        return;
      case 'forbidden':
        if (rule.r.applies(from, to, ctx) && !out.sessionForbidden.includes(concrete))
          out.sessionForbidden.push(concrete);
        return;
      case 'refused':
        if (rule.r.applies(from, to, ctx))
          out.refused.push({ path: concrete, message: rule.r.message });
        return;
      case 'guarded': {
        if (!rule.r.weakens(from, to, ctx)) return;
        const c = rule.r.consequence(from, to, ctx);
        for (const consequence of Array.isArray(c) ? c : [c])
          out.guarded.push({ path: concrete, consequence });
      }
    }
  };

  // Install-wide settings.
  const { dropZones: _bz, ...bTop } = b;
  const { dropZones: _az, ...aTop } = a;
  const tb = flatten(bTop, '', new Map());
  const ta = flatten(aTop, '', new Map());
  const installCtx: GuardCtx = { install: a, added: false };
  for (const p of [...new Set([...tb.keys(), ...ta.keys()])].sort())
    judge(p, p, tb.get(p), ta.get(p), installCtx);

  // Zones, by id.
  const beforeZones = new Map(b.dropZones.map((z) => [z.id, z as Record<string, unknown>]));
  const afterIds = new Set(a.dropZones.map((z) => z.id));
  out.removed = [...beforeZones.keys()].filter((id) => !afterIds.has(id));
  for (const zone of a.dropZones as Record<string, unknown>[]) {
    const id = String(zone.id);
    const was = beforeZones.get(id);
    const isAdded = was === undefined;
    if (isAdded) {
      out.added.push(id);
      // The new project itself (review I1): its code runs with the Claude token.
      for (const r of REFUSED_PATHS)
        if (r.onAdd && r.path.startsWith(ZONE_PREFIX)) {
          const leaf = r.path.slice(ZONE_PREFIX.length);
          out.guarded.push({
            path: `dropZones[${id}].${leaf}`,
            consequence: r.onAdd(zone[leaf], { zoneId: id, install: a, added: true }),
          });
        }
    }
    const ctx: GuardCtx = { zoneId: id, install: a, added: isAdded };
    // The baseline's requireSignedImages falls back to the install as it will be.
    const from = zoneLeaves(
      was ?? (ADD_BASELINE(zone) as Record<string, unknown>),
      isAdded ? a : b,
    );
    const to = zoneLeaves(zone, a);
    for (const p of [...new Set([...from.keys(), ...to.keys()])].sort())
      judge(`dropZones[${id}].${p}`, `dropZones[].${p}`, from.get(p), to.get(p), ctx);
  }
  return out;
}
