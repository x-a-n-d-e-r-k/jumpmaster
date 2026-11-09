/**
 * The readiness doctor's server-side checks (spec §8.0). Every check is a read: the database, the
 * config, this process, and GET requests to the forge. None writes anywhere, and none prints a
 * secret: tokens are named by their variable, never shown.
 *
 * A check that cannot run says so and why (`warn` when the cause is passing, such as a rate limit;
 * `fail` when the cause is a setting, such as a refused permission). It is never a `pass`.
 */
import { hostAllowed } from '@jumpmaster/protocol';
import type { Config, DropZoneConfig } from '../config.js';
import { creditsStopInForce } from '../credits.js';
import { crewDropsToday } from '../crew/schedule.js';
import type { Db } from '../db/open.js';
import {
  getDropZoneDefaultBranch,
  getUsageState,
  getZoneMode,
  isKilled,
  listSticks,
  type Stick,
} from '../db/repo.js';
import { FABLE_PLANS } from '../fable.js';
import { branchProtectionProblems } from '../flow/guards.js';
import {
  type BranchRulesRead,
  type Forge,
  isRateLimited,
  type ReadProbe,
} from '../forge/github.js';
import { getGoals } from '../goals.js';
import { missingFor, zoneRequirements } from '../leases.js';
import type { ForgePair } from '../outbox.js';
import { egressFor } from '../payloads.js';
import { DETECT_FILES, detectPreset } from '../presets.js';
import { dispatchGate } from '../usage.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** `doc` is an anchor in `docs/runbooks/install.md`. */
export type DoctorCheck = {
  id: string;
  zoneId: string | null;
  status: DoctorStatus;
  summary: string;
  fix?: string;
  doc?: string;
  /** The doctor drop a check reports on, if any. */
  dropId?: string;
};

/** What the doctor knows about the process it runs in. */
export type DoctorEnv = {
  /** `process.getuid()`, or null where there is none. */
  uid: number | null;
  /** Set in the server image (`JM_CONTAINER=1`). */
  inContainer: boolean;
  /** `/proc/self/uid_map`, or null off Linux: anything but the identity map is a user namespace. */
  uidMap: string | null;
};

export type DoctorDeps = {
  db: Db;
  config: Config;
  now(): Date;
  env: DoctorEnv;
  forges(zoneId: string): ForgePair;
  /** A forge on the read token (`JM_GITHUB_READ_TOKEN`), when one is configured. */
  readForge?(zoneId: string): Forge | undefined;
};

const DOC = 'docs/runbooks/install.md';
const doc = (anchor: string): string => `${DOC}#${anchor}`;

/** A stick is live when it asked for work this recently. */
export const STICK_LIVE_MS = 120_000;
const TOKEN_WARN_DAYS = 330;
const TOKEN_LIFE_DAYS = 365;
const TOKEN_EXPIRY_WARN_MS = 14 * 86_400_000;
const EGRESS_WINDOW_MS = 14 * 86_400_000;
const DAY_MS = 86_400_000;
const DIGEST_REF = /^[^\s@-][^\s@]*@sha256:[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** What a zone's token identities are called where the operator sets them. */
const TOKEN_VAR = {
  author: 'JM_GITHUB_AUTHOR_TOKEN',
  reviewer: 'JM_GITHUB_REVIEWER_TOKEN',
  read: 'JM_GITHUB_READ_TOKEN',
} as const;
type Identity = keyof typeof TOKEN_VAR;

const HONEST_LIMIT =
  "the token's own permissions can't be read — a missing Contents or Issues write shows at the first push or filing";

// ---------------------------------------------------------------------------------------------
// Reads that never throw

type Failed = {
  ok: false;
  status: number | null;
  message: string;
  accepted: string | null;
  rateLimited: boolean;
};
type Read<T> = { ok: true; value: T } | Failed;

async function attempt<T>(fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const e = err as {
      status?: unknown;
      message?: unknown;
      response?: { headers?: Record<string, unknown> };
    };
    const accepted = e.response?.headers?.['x-accepted-github-permissions'];
    return {
      ok: false,
      status: typeof e.status === 'number' ? e.status : null,
      message: String(e.message ?? err).split('\n')[0] ?? '',
      accepted: typeof accepted === 'string' ? accepted : null,
      rateLimited: isRateLimited(err),
    };
  }
}

const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => {
    p ??= fn();
    return p;
  };
};

/**
 * The check for a forge read that failed: a 401 is a bad token, a 403 or 404 a missing
 * permission (named), and anything else (rate limit, 5xx, no answer) a check that couldn't run.
 */
function readFailed(
  base: { id: string; zoneId: string | null },
  who: Identity,
  what: string,
  permission: string,
  r: Failed,
): DoctorCheck {
  const v = TOKEN_VAR[who];
  if (r.status === 401)
    return {
      ...base,
      status: 'fail',
      summary: `GitHub rejected the ${who} token (401) while trying to ${what}: it is expired, revoked or mistyped`,
      fix: `Create a new token, write it to the file ${v}_FILE names (or set ${v}), and restart the server.`,
      doc: doc('tokens'),
    };
  if (r.rateLimited)
    return {
      ...base,
      status: 'warn',
      summary: `could not ${what}: GitHub's rate limit refused the ${who} token's read (HTTP ${r.status}); the check did not run`,
      fix: 'Run the doctor again in a few minutes.',
    };
  if (r.status === 403 || r.status === 404) {
    const wants = r.accepted ? `; GitHub says this read needs ${r.accepted}` : '';
    return {
      ...base,
      status: 'fail',
      summary: `the ${who} token can't ${what} (HTTP ${r.status}): it needs ${permission}${wants}`,
      fix: `Give the ${who} token ${permission.replace(': read', ': Read-only')} on this repository (a fine-grained token: Settings → Developer settings → Fine-grained tokens → the token → Repository permissions), or check that the repository is in its repository access list.`,
      doc: doc('tokens'),
    };
  }
  return {
    ...base,
    status: 'warn',
    summary: `could not ${what} with the ${who} token: ${r.status === null ? 'no HTTP answer' : `HTTP ${r.status}`} (${r.message}); the check did not run`,
    fix: 'Check the server can reach api.github.com, then run the doctor again.',
  };
}

// ---------------------------------------------------------------------------------------------
// Global checks

function listenCheck(d: DoctorDeps): DoctorCheck {
  const { host, port } = d.config.listen;
  const base = { id: 'config.listen', zoneId: null };
  if (LOOPBACK.has(host))
    return {
      ...base,
      status: 'pass',
      summary: `the UI listens on ${host}:${port} (loopback only)`,
    };
  if (d.env.inContainer)
    return {
      ...base,
      status: 'pass',
      summary: `the UI listens on ${host}:${port} inside the container; what reaches it is the port compose publishes (127.0.0.1 in the generated compose file)`,
    };
  return {
    ...base,
    status: 'warn',
    summary: `the UI listens on ${host}:${port}, reachable from your network, and its pages have no login`,
    fix: 'Set listen.host to 127.0.0.1 in the config (and reach the UI over an SSH tunnel), unless you mean to expose it.',
    doc: doc('listen'),
  };
}

/** The identity map: no user namespace (a rootful engine, or no container). */
const identityMap = (map: string): boolean => {
  const rows = map
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/));
  return rows.length === 1 && rows[0]?.[0] === '0' && rows[0]?.[1] === '0';
};

function uidCheck(d: DoctorDeps): DoctorCheck {
  const base = { id: 'config.uid', zoneId: null };
  const { uid, uidMap } = d.env;
  if (uidMap !== null && !identityMap(uidMap))
    return {
      ...base,
      status: 'skip',
      summary:
        'rootless unsupported in this release: the server runs in a user namespace (rootless Docker), whose uid mapping the install does not support',
      fix: 'Install under a rootful Docker Engine as described in the install runbook.',
      doc: doc('prerequisites'),
    };
  if (uid === null)
    return {
      ...base,
      status: 'skip',
      summary: 'this platform has no uid, so the check cannot run',
    };
  if (uid === 0)
    return {
      ...base,
      status: 'warn',
      summary:
        'the server runs as root (uid 0): a bug in it would act with root on the data and secret files',
      fix: 'Run it as the host user who owns the 0600 secret files (JM_UID and JM_GID in the compose .env).',
      doc: doc('uid'),
    };
  return { ...base, status: 'pass', summary: `the server runs as uid ${uid}, not root` };
}

function tokenAgeCheck(d: DoctorDeps): DoctorCheck {
  const base = { id: 'claude.token-age', zoneId: null, doc: doc('claude-token') };
  const created = d.config.claude.tokenCreatedAt;
  if (!created)
    return {
      ...base,
      status: 'skip',
      summary: "claude.tokenCreatedAt is not set, so the Claude token's age is unknown",
      fix: 'Set claude.tokenCreatedAt (YYYY-MM-DD) to the day you ran claude setup-token: tokens last a year, and the doctor warns a month before.',
    };
  const t = Date.parse(created);
  if (!Number.isFinite(t))
    return {
      ...base,
      status: 'fail',
      summary: `claude.tokenCreatedAt ${JSON.stringify(created)} is not a date`,
      fix: 'Write it as YYYY-MM-DD.',
    };
  const days = Math.floor((d.now().getTime() - t) / DAY_MS);
  const renew =
    'Run claude setup-token, write the new token to the JM_CLAUDE_TOKEN file, set claude.tokenCreatedAt to today, and restart the server.';
  if (days >= TOKEN_LIFE_DAYS)
    return {
      ...base,
      status: 'fail',
      summary: `the Claude token is ${days} days old, past its one-year life: drops will fail to authenticate`,
      fix: renew,
    };
  if (days >= TOKEN_WARN_DAYS)
    return {
      ...base,
      status: 'warn',
      summary: `the Claude token is ${days} days old and expires around day ${TOKEN_LIFE_DAYS}`,
      fix: renew,
    };
  return {
    ...base,
    status: 'pass',
    summary: `the Claude token is ${days} days old (renew from day ${TOKEN_WARN_DAYS})`,
  };
}

function planCheck(d: DoctorDeps): DoctorCheck {
  const { plan, fableModel } = d.config.claude;
  const base = { id: 'claude.plan', zoneId: null };
  const hasFable = FABLE_PLANS.includes(plan);
  if (fableModel && !hasFable)
    return {
      ...base,
      status: 'warn',
      summary: `claude.fableModel is set, but the declared plan ${plan} doesn't include Fable, so Fable never runs`,
      fix: `Set claude.plan to the plan you pay for (${FABLE_PLANS.join(' or ')} include Fable), or remove claude.fableModel.`,
      doc: doc('claude-plan'),
    };
  return {
    ...base,
    status: 'pass',
    summary: `declared plan: ${plan} (declared, not detected)${fableModel ? `; Fable runs as ${fableModel}` : hasFable ? '; Fable is off (no claude.fableModel)' : ''}`,
  };
}

const liveSticks = (sticks: Stick[], now: Date): Stick[] =>
  sticks.filter(
    (s) => s.lastSeenAt !== null && now.getTime() - Date.parse(s.lastSeenAt) <= STICK_LIVE_MS,
  );

function stickSeenCheck(d: DoctorDeps, sticks: Stick[]): DoctorCheck {
  const base = { id: 'stick.seen', zoneId: null, doc: doc('stick') };
  const now = d.now();
  if (sticks.length === 0)
    return {
      ...base,
      status: 'fail',
      summary: 'No stick has enrolled, so no drop can run',
      fix: 'Start the stick (docker compose up -d stick) with the same join token as the server, then check docker compose logs stick.',
    };
  const live = liveSticks(sticks, now);
  const stale = sticks.filter((s) => !live.includes(s));
  const seen = (s: Stick) =>
    `${s.name} (last seen ${s.lastSeenAt === null ? 'never' : `${Math.round((now.getTime() - Date.parse(s.lastSeenAt)) / 1000)}s ago, ${s.lastSeenAt}`})`;
  if (live.length === 0)
    return {
      ...base,
      status: 'fail',
      summary: `no stick has asked for work in the last ${STICK_LIVE_MS / 60_000} minutes: ${stale.map(seen).join('; ')}`,
      fix: 'Check that the stick is running and can reach the server: docker compose ps, then docker compose logs stick.',
    };
  return {
    ...base,
    status: 'pass',
    summary: `live: ${live.map(seen).join('; ')}${stale.length > 0 ? `; not seen lately (ignored): ${stale.map((s) => s.name).join(', ')}` : ''}`,
  };
}

const LACK_FIX: Record<string, string> = {
  'egress-v1':
    "run a stick from a release with egress control: it advertises egress-v1 only once its egress self-check passes, and the stick log says why when it doesn't; or set the zone's egress.mode to off",
  'image-verify-v1': 'run a stick from a release that verifies image signatures (M4 or later)',
  'image-policy:signed':
    'set JM_IMAGE_POLICY=signed on the stick (the published stick image sets it), or drop requireSignedImages from the config',
};

function stickCapabilityCheck(d: DoctorDeps, zone: DropZoneConfig, sticks: Stick[]): DoctorCheck {
  const base = { id: 'stick.capabilities', zoneId: zone.id, doc: doc('stick') };
  const live = liveSticks(sticks, d.now());
  const need = zoneRequirements(zone, d.config);
  const needs = [...need.caps, ...(need.signed ? ['image-policy:signed'] : [])];
  if (live.length === 0)
    return {
      ...base,
      status: 'skip',
      summary: 'no live stick to judge (see stick.seen)',
    };
  const judged = live.map((s) => ({ s, missing: missingFor(s, need) }));
  const able = judged.filter((j) => j.missing.length === 0);
  const what = needs.length > 0 ? `needs ${needs.join(', ')}` : 'needs no stick capability';
  if (able.length > 0)
    return {
      ...base,
      status: 'pass',
      summary: `the zone ${what}; ${able.map((j) => j.s.name).join(', ')} can run it`,
    };
  const lacks = [...new Set(judged.flatMap((j) => j.missing))];
  return {
    ...base,
    status: 'fail',
    summary: `no live stick can run this zone, so its drops stay queued (the zone ${what}): ${judged.map((j) => `${j.s.name} lacks ${j.missing.join(', ')}`).join('; ')}`,
    fix: lacks.map((l) => `${l}: ${LACK_FIX[l] ?? 'upgrade the stick'}`).join('. '),
  };
}

function imagePolicyCheck(d: DoctorDeps, sticks: Stick[]): DoctorCheck {
  const base = { id: 'stick.image-policy', zoneId: null, doc: doc('image-trust') };
  const live = liveSticks(sticks, d.now());
  if (live.length === 0)
    return { ...base, status: 'skip', summary: 'no live stick to judge (see stick.seen)' };
  const loose = live.filter((s) => s.imagePolicy !== 'signed');
  if (loose.length === 0)
    return {
      ...base,
      status: 'pass',
      summary: `every live stick runs only signed or digest-pinned images (${live.map((s) => s.name).join(', ')})`,
    };
  const names = loose.map((s) => s.name).join(', ');
  if (d.config.requireSignedImages === true)
    return {
      ...base,
      status: 'fail',
      summary: `requireSignedImages is true, but ${names} runs images by allowlist, without verifying signatures`,
      fix: 'Set JM_IMAGE_POLICY=signed on the stick (the published stick image sets it) and restart it.',
    };
  return {
    ...base,
    status: 'warn',
    summary: `${names} runs images by allowlist: an image is trusted by name, not by a verified signature`,
    fix: 'Use the published stick image (JM_IMAGE_POLICY=signed) and set requireSignedImages: true.',
  };
}

function usageCheck(d: DoctorDeps): DoctorCheck {
  const base = { id: 'usage.gate', zoneId: null, doc: doc('usage') };
  const now = d.now();
  const gate = dispatchGate(d.db, d.config.usage, now);
  const u = getUsageState(d.db);
  switch (gate) {
    case 'open':
      return {
        ...base,
        status: 'pass',
        summary: 'dispatch is open: the usage limit allows new work',
      };
    case 'stopped':
      return {
        ...base,
        status: 'fail',
        summary: `dispatch is stopped: a drop ran on usage credits (extra usage) at ${u.overageStoppedAt}; nothing new runs${creditsStopInForce(u, now) && u.overageUntil ? ` until ${u.overageUntil}, when the window resets` : ''}`,
        fix: 'Open /briefings and rule on the credits briefing (Resume lets work run on credits), or wait for the reset. To be told without stopping, set usage.stopOnOverage: false.',
      };
    case 'closed':
      return {
        ...base,
        status: 'warn',
        summary: `dispatch is paused by the Claude usage limit until ${u.pausedUntil ?? u.probeNotBefore}`,
        fix: 'Nothing to do: it resumes by itself at that time.',
      };
    case 'probe':
      return {
        ...base,
        status: 'warn',
        summary:
          'the usage limit was hit: one probe drop at a time runs until a report says it cleared',
      };
    case 'finishing_only':
      return {
        ...base,
        status: 'warn',
        summary: `usage is above the throttle (${Math.round(d.config.usage.throttleUtilization * 100)}%): only finishing work (review, heal, resolve) dispatches`,
        fix: 'Nothing to do: new work resumes when usage falls or the window resets.',
      };
    case 'credits_resume':
      return {
        ...base,
        status: 'warn',
        summary: `Command resumed after a credits stop: one work item runs on credits until ${u.overageResumeUntil}`,
      };
    default:
      return { ...base, status: 'warn', summary: `unknown usage gate ${String(gate)}` };
  }
}

function killCheck(d: DoctorDeps): DoctorCheck {
  const base = { id: 'control.kill', zoneId: null };
  if (isKilled(d.db))
    return {
      ...base,
      status: 'fail',
      summary: 'the kill switch is engaged: no drop runs in any zone',
      fix: 'When it is safe: jumpmaster ctl unkill',
    };
  return { ...base, status: 'pass', summary: 'the kill switch is off' };
}

// ---------------------------------------------------------------------------------------------
// Per-zone checks

type ZoneReads = {
  pair: ForgePair;
  logins: Record<'author' | 'reviewer', () => Promise<Read<string>>>;
  access: Record<
    'author' | 'reviewer',
    () => Promise<Read<Awaited<ReturnType<Forge['repoAccess']>>>>
  >;
  branch: () => Promise<string>;
  rules: () => Promise<{ author: BranchRulesRead; reviewer: BranchRulesRead }>;
};

const tokenKind = (token: string | undefined): string =>
  token === undefined
    ? 'unset'
    : token.startsWith('github_pat_')
      ? 'fine-grained'
      : /^gh[pousr]_/.test(token)
        ? 'classic'
        : 'unrecognised';

/** The zone's reads, each made once per run. Nothing is called until a check asks. */
function zoneReads(d: DoctorDeps, zone: DropZoneConfig): ZoneReads {
  let made: ForgePair | undefined;
  // A getter, so a forge that can't be built fails the checks that need it, inside their guard.
  const reads = {
    get pair(): ForgePair {
      made ??= d.forges(zone.id);
      return made;
    },
  };
  const pair = () => reads.pair;
  const access = {
    author: once(() => attempt(() => pair().author.repoAccess())),
    reviewer: once(() => attempt(() => pair().reviewer.repoAccess())),
  };
  const branch = once(async () => {
    const a = await access.author();
    return a.ok ? a.value.defaultBranch : (getDropZoneDefaultBranch(d.db, zone.id) ?? 'main');
  });
  return Object.assign(reads, {
    logins: {
      author: once(() => attempt(() => pair().author.viewerLogin())),
      reviewer: once(() => attempt(() => pair().reviewer.viewerLogin())),
    },
    access,
    branch,
    rules: once(async () => {
      const b = await branch();
      const [author, reviewer] = await Promise.all([
        pair()
          .author.getBranchRules(b)
          .catch((): BranchRulesRead => ({ kind: 'unavailable' })),
        pair()
          .reviewer.getBranchRules(b)
          .catch((): BranchRulesRead => ({ kind: 'unavailable' })),
      ]);
      return { author, reviewer };
    }),
  });
}

/** The scope a classic token needs: `repo` for a private repository, else `public_repo` or `repo`. */
function classicScopeProblem(scopes: string[] | null, priv: boolean): string | null {
  if (scopes === null) return null;
  if (scopes.includes('repo')) return null;
  if (!priv && scopes.includes('public_repo')) return null;
  return priv ? 'repo' : 'public_repo';
}

function expiryNote(expiresAt: string | null, now: Date): { note: string; soon: boolean } {
  if (expiresAt === null) return { note: '', soon: false };
  const left = Date.parse(expiresAt) - now.getTime();
  return { note: `; the token expires ${expiresAt}`, soon: left < TOKEN_EXPIRY_WARN_MS };
}

async function identityCheck(
  d: DoctorDeps,
  zone: DropZoneConfig,
  r: ZoneReads,
  who: 'author' | 'reviewer',
): Promise<DoctorCheck> {
  const base = { id: `forge.${who}`, zoneId: zone.id, doc: doc('tokens') };
  const login = await r.logins[who]();
  if (!login.ok)
    return readFailed(base, who, 'read its own account (GET /user)', 'any valid token', login);
  const access = await r.access[who]();
  if (!access.ok)
    return readFailed(base, who, `read the repository ${zone.repo}`, 'Metadata: read', access);
  const a = access.value;
  const token =
    who === 'author' ? d.config.secrets.githubAuthorToken : d.config.secrets.githubReviewerToken;
  const kind = tokenKind(token);
  const role = a.permissions.admin
    ? 'admin'
    : a.permissions.maintain
      ? 'maintain'
      : a.permissions.push
        ? 'write'
        : a.permissions.pull
          ? 'read'
          : 'none';
  const v = TOKEN_VAR[who];
  if (who === 'reviewer') {
    const author = await r.logins.author();
    if (author.ok && author.value === login.value)
      return {
        ...base,
        status: 'fail',
        summary: `the reviewer token is the same account as the author (${login.value}): GitHub never lets an account approve its own pull request`,
        fix: `Put a token for a second account (the reviewer bot) in ${v}, give that account Write on ${zone.repo}, and restart.`,
      };
  }
  if (!a.permissions.push)
    return {
      ...base,
      status: 'fail',
      summary: `the ${who} account ${login.value} has ${role} access to ${zone.repo}, not write`,
      fix: `Invite ${login.value} to ${zone.repo} with the Write role (Settings → Collaborators), and accept the invitation as that account.`,
    };
  if (who === 'reviewer' && a.permissions.admin)
    return {
      ...base,
      status: 'fail',
      summary: `the reviewer account ${login.value} is a repository admin: an admin can change the rules its own approval is checked against`,
      fix: `Give ${login.value} the Write role instead of Admin on ${zone.repo}.`,
    };
  const scopeMissing = kind === 'classic' ? classicScopeProblem(a.scopes, a.private) : null;
  if (scopeMissing)
    return {
      ...base,
      status: 'fail',
      summary: `the ${who} token is a classic token without the ${scopeMissing} scope (it has: ${a.scopes?.join(', ') || 'none'})`,
      fix: `Create a fine-grained token for ${zone.repo} instead (preferred), or add the ${scopeMissing} scope.`,
    };
  const exp = expiryNote(a.tokenExpiresAt, d.now());
  const scopes = kind === 'classic' && a.scopes ? ` with scopes ${a.scopes.join(', ')}` : '';
  const summary = `${who} account ${login.value} has ${role} on ${zone.repo} (${kind} token${scopes})${exp.note}; account has push; ${HONEST_LIMIT}`;
  if (exp.soon)
    return {
      ...base,
      status: 'warn',
      summary,
      fix: `Create a replacement token before then, write it to the file ${v}_FILE names, and restart the server.`,
    };
  return { ...base, status: 'pass', summary };
}

async function adminCheck(zone: DropZoneConfig, r: ZoneReads): Promise<DoctorCheck> {
  const base = { id: 'forge.admin', zoneId: zone.id, doc: doc('tokens') };
  const [login, access] = await Promise.all([r.logins.author(), r.access.author()]);
  if (!access.ok)
    return readFailed(base, 'author', `read the repository ${zone.repo}`, 'Metadata: read', access);
  const who = login.ok ? login.value : 'the author account';
  const admin = access.value.permissions.admin;
  if (admin && !zone.authorMayBeAdmin)
    return {
      ...base,
      status: 'fail',
      summary: `${who} (the author) is a repository admin: an admin's token could edit the ruleset that guards merges`,
      fix: `Give ${who} the Write role, or (when the owner's own account authors) set authorMayBeAdmin: true with a fine-grained author token limited to ${zone.repo}; merges then go through the reviewer.`,
    };
  if (admin)
    return {
      ...base,
      status: 'warn',
      summary: `${who} (the author) is a repository admin, allowed by authorMayBeAdmin: true; merges go through the reviewer, and the fine-grained token is the only limit on what the author token can change`,
      fix: 'Keep the author token fine-grained, limited to this repository, with no Administration permission.',
    };
  if (zone.authorMayBeAdmin)
    return {
      ...base,
      status: 'warn',
      summary: `authorMayBeAdmin is true, but ${who} is not an admin: the setting relaxes a guard for nothing`,
      fix: 'Set authorMayBeAdmin: false in the zone.',
    };
  return { ...base, status: 'pass', summary: 'neither bot account is a repository admin' };
}

const PERMISSION_USE: Record<string, string> = {
  'Contents: read': 'compare branches and read files',
  'Issues: read': 'read ready issues and their labels',
  'Pull requests: read': 'read pull requests and reviews',
  'Commit statuses: read': 'read commit statuses (CI that reports statuses)',
};

async function readsCheck(
  zone: DropZoneConfig,
  r: ZoneReads,
  who: 'author' | 'reviewer',
): Promise<DoctorCheck> {
  const base = { id: `forge.${who}-reads`, zoneId: zone.id, doc: doc('tokens') };
  const branch = await r.branch();
  const probed = await attempt(() => r.pair[who].probeReads(branch));
  if (!probed.ok) return readFailed(base, who, 'try its reads', 'Metadata: read', probed);
  const probes = new Map(probed.value.map((p) => [p.permission, p]));
  // The reviewer only reads pull requests and the repository; the author reads everything.
  const wanted =
    who === 'reviewer'
      ? ['Contents: read', 'Pull requests: read']
      : ['Contents: read', 'Issues: read', 'Pull requests: read', 'Commit statuses: read'];
  const refused = (p: ReadProbe | undefined) => p?.status === 403 || p?.status === 404;
  const wants = (p: ReadProbe) => (p.accepted ? ` (GitHub says it needs ${p.accepted})` : '');
  const unknown = probed.value.filter(
    (p) =>
      p.status === 401 ||
      p.rateLimited ||
      p.status === null ||
      (p.status !== null && p.status >= 500),
  );
  const v = TOKEN_VAR[who];
  if (unknown.some((p) => p.status === 401))
    return {
      ...base,
      status: 'fail',
      summary: `GitHub rejected the ${who} token (401): it is expired, revoked or mistyped`,
      fix: `Create a new token, write it to the file ${v}_FILE names, and restart the server.`,
    };
  const problems: string[] = [];
  const fixes: string[] = [];
  for (const name of wanted) {
    const p = probes.get(name);
    if (!refused(p)) continue;
    problems.push(
      `${name} refused (HTTP ${p?.status})${p ? wants(p) : ''}: the server uses it to ${PERMISSION_USE[name]}`,
    );
    fixes.push(name.replace(': read', ': Read-only'));
  }
  let ci = '';
  if (who === 'author') {
    const checks = probes.get('Checks: read');
    const actions = probes.get('Actions: read');
    if (refused(checks) && refused(actions)) {
      problems.push(
        `the server can't read CI results: check runs refused (HTTP ${checks?.status}; fine-grained tokens never can) and Actions: read refused (HTTP ${actions?.status})${actions ? wants(actions) : ''}, which is how it reads CI jobs instead`,
      );
      fixes.push('Actions: Read-only');
    } else if (refused(checks)) {
      ci =
        '; CI is read through Actions jobs, since check runs are refused (fine-grained tokens never can read them; checks from apps other than GitHub Actions are not visible)';
    }
  }
  if (problems.length > 0)
    return {
      ...base,
      status: 'fail',
      summary: problems.join('; '),
      fix: `Give the ${who} token ${[...new Set(fixes)].join(', ')} on ${zone.repo} (Settings → Developer settings → Fine-grained tokens → the token → Repository permissions).`,
    };
  if (unknown.length > 0)
    return {
      ...base,
      status: 'warn',
      summary: `could not try ${unknown.map((p) => p.permission).join(', ')} (${unknown.map((p) => (p.rateLimited ? 'rate limit' : p.status === null ? 'no answer' : `HTTP ${p.status}`)).join(', ')}); the check did not finish`,
      fix: 'Run the doctor again in a few minutes.',
    };
  return {
    ...base,
    status: 'pass',
    summary: `the ${who} token can make every read the server relies on (${wanted.join(', ')})${ci}`,
  };
}

const RULE_FIX: [RegExp, (zone: DropZoneConfig, branch: string) => string][] = [
  [
    /^no ruleset$/,
    (_z, b) =>
      `Create a branch ruleset targeting ${b} (Settings → Rules → Rulesets → New branch ruleset), enforcement Active, with Require a pull request before merging (1 approval, dismiss stale approvals) and Require status checks to pass; leave the bypass list without the bot accounts.`,
  ],
  [/^approvals < 1$/, () => 'In the pull request rule, set Required approvals to 1 or more.'],
  [
    /^stale approvals not dismissed$/,
    () =>
      'In the pull request rule, turn on Dismiss stale pull request approvals when new commits are pushed.',
  ],
  [
    /^bot can bypass$/,
    () =>
      "Remove the bot accounts, and any role, team or app they hold, from the ruleset's bypass list.",
  ],
  [
    /^bot is admin$/,
    () => 'Give the bot accounts the Write role instead of Admin (see forge.admin).',
  ],
  [
    /^required check not pinned: /,
    () =>
      'Edit each unpinned required check in the ruleset and select GitHub Actions as the source, so no other app or status can satisfy it.',
  ],
  [
    /^no required checks$/,
    () =>
      'Add your CI job as a required status check in the ruleset (select GitHub Actions as the source), or set ciRequired: false in the zone until CI exists.',
  ],
  [
    /^unsupported rule: /,
    (_z, b) =>
      `Jumpmaster merges through the API, which a merge queue or required deployment blocks: remove those rules from the rulesets covering ${b}.`,
  ],
  [
    /^no pull request rule$/,
    () => 'Add the Require a pull request before merging rule to the ruleset.',
  ],
];

async function branchRulesCheck(zone: DropZoneConfig, r: ZoneReads): Promise<DoctorCheck> {
  const base = { id: 'forge.branch-rules', zoneId: zone.id, doc: doc('branch-rules') };
  const branch = await r.branch();
  if (!zone.requireBranchProtection)
    return {
      ...base,
      status: 'warn',
      summary: `branch-protection checks are off for ${branch} (requireBranchProtection: false): Jumpmaster merges whatever passes its own guards, and nothing on GitHub stops a direct push`,
      fix: 'Add a branch ruleset and set requireBranchProtection: true.',
    };
  const rules = await r.rules();
  const problems = branchProtectionProblems(rules, zone);
  if (problems === null)
    return {
      ...base,
      status: 'warn',
      summary: `could not read the branch rules for ${branch} (GitHub was rate-limited or unavailable); the check did not run`,
      fix: 'Run the doctor again in a few minutes.',
    };
  for (const read of [rules.author, rules.reviewer])
    if (read.kind === 'ok' && read.rules.requiresPullRequest === false)
      if (!problems.includes('no pull request rule')) problems.push('no pull request rule');
  if (problems.length === 0) {
    const ok = rules.author.kind === 'ok' ? rules.author.rules : null;
    return {
      ...base,
      status: 'pass',
      summary: `${branch} requires a pull request with ${ok?.requiredApprovals ?? 1}+ approval(s), dismisses stale approvals, pins its required checks (${ok?.requiredChecks.join(', ') || 'none'}), and neither bot can bypass`,
    };
  }
  const fixes = [
    ...new Set(
      problems.flatMap((p) =>
        RULE_FIX.filter(([re]) => re.test(p)).map(([, f]) => f(zone, branch)),
      ),
    ),
  ];
  return {
    ...base,
    status: 'fail',
    summary: `the rules on ${branch} are unsafe for unattended merges: ${problems.join('; ')}`,
    fix: fixes.join(' '),
  };
}

const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

async function codeownersCheck(zone: DropZoneConfig, r: ZoneReads): Promise<DoctorCheck> {
  const base = { id: 'forge.codeowners', zoneId: zone.id, doc: doc('branch-rules') };
  const rules = await r.rules();
  const required = [rules.author, rules.reviewer].some(
    (x) => x.kind === 'ok' && x.rules.requireCodeOwnerReview === true,
  );
  if (!required)
    return { ...base, status: 'pass', summary: 'the rules do not require a code owner review' };
  const branch = await r.branch();
  const reviewer = await r.logins.reviewer();
  if (!reviewer.ok)
    return readFailed(base, 'reviewer', 'read its own account', 'any valid token', reviewer);
  let text: string | null = null;
  for (const p of CODEOWNERS_PATHS) {
    const got = await attempt(() => r.pair.author.getFileAt(branch, p));
    if (!got.ok) return readFailed(base, 'author', `read ${p}`, 'Contents: read', got);
    if (got.value !== null) {
      text = got.value;
      break;
    }
  }
  const mention = new RegExp(
    `(^|\\s)@${reviewer.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`,
    'im',
  );
  if (text !== null && mention.test(text))
    return {
      ...base,
      status: 'pass',
      summary: `code owner review is required, and the reviewer ${reviewer.value} is named in CODEOWNERS`,
    };
  return {
    ...base,
    status: 'warn',
    summary: `the rules require a code owner's review, and the reviewer account ${reviewer.value} is ${text === null ? 'not a code owner (no CODEOWNERS file)' : 'not named in CODEOWNERS'}: a pull request touching owned paths waits for a human code owner`,
    fix: `Add @${reviewer.value} as an owner for the paths agents change, or turn off Require review from Code Owners, if a human review of those paths is not what you want.`,
  };
}

async function ciCheck(zone: DropZoneConfig, r: ZoneReads): Promise<DoctorCheck> {
  const base = { id: 'forge.ci', zoneId: zone.id, doc: doc('ci') };
  const branch = await r.branch();
  const dir = await attempt(() => r.pair.author.listDir(branch, '.github/workflows'));
  if (!dir.ok) return readFailed(base, 'author', 'list .github/workflows', 'Contents: read', dir);
  const workflows = (dir.value ?? []).filter((n) => /\.ya?ml$/.test(n));
  const rules = await r.rules();
  const required = [
    ...new Set(
      [rules.author, rules.reviewer].flatMap((x) =>
        x.kind === 'ok' ? x.rules.requiredChecks : [],
      ),
    ),
  ];
  const seen = `${workflows.length} workflow(s) on ${branch}${workflows.length ? ` (${workflows.join(', ')})` : ''}; required checks: ${required.join(', ') || 'none'}`;
  if (!zone.ciRequired)
    return {
      ...base,
      status: 'warn',
      summary: `the no-CI-yet path (ciRequired: false): the zone's gates are the only check before a merge; ${seen}`,
      fix: 'Once CI exists, require its check in the ruleset (select GitHub Actions as the source) and set ciRequired: true.',
    };
  if (required.length > 0) return { ...base, status: 'pass', summary: `CI is required: ${seen}` };
  return {
    ...base,
    status: 'fail',
    summary: `ciRequired is true, but ${workflows.length === 0 ? 'there is no CI workflow and no required check' : 'no check is required'}: ${seen}; every pull request would wait for a CI result that never comes`,
    fix: `${workflows.length === 0 ? 'Add a CI workflow under .github/workflows, then require' : 'Require'} its check in the branch ruleset (select GitHub Actions as the source); or, until CI exists, set ciRequired: false in the zone (the no-CI-yet path: the gates are the only check).`,
  };
}

const LABEL_SPEC: Record<string, { color: string; description: string }> = {
  ready: { color: '0E8A16', description: 'Ready for a Jumpmaster agent' },
  retry: { color: 'FBCA04', description: 'Ask Jumpmaster to retry a parked issue' },
  staged: { color: 'C5DEF5', description: 'Filed by the crew, waiting for Command' },
};

async function labelsCheck(zone: DropZoneConfig, r: ZoneReads): Promise<DoctorCheck> {
  const base = { id: 'forge.labels', zoneId: zone.id, doc: doc('labels') };
  const got = await attempt(() => r.pair.author.listLabels());
  if (!got.ok) return readFailed(base, 'author', 'list the labels', 'Issues: read', got);
  const want: [string, keyof typeof LABEL_SPEC][] = [
    [zone.readyLabel, 'ready'],
    [zone.retryLabel, 'retry'],
    ...(zone.crew.enabled ? ([[zone.crew.stagedLabel, 'staged']] as [string, 'staged'][]) : []),
  ];
  const have = new Set(got.value.map((l) => l.toLowerCase()));
  const missing = want.filter(([name]) => !have.has(name.toLowerCase()));
  if (missing.length === 0)
    return {
      ...base,
      status: 'pass',
      summary: `the labels exist: ${want.map(([n]) => n).join(', ')}`,
    };
  const q = (s: string) => (/^[\w.:-]+$/.test(s) ? s : JSON.stringify(s));
  return {
    ...base,
    status: 'fail',
    summary: `missing label(s) on ${zone.repo}: ${missing.map(([n]) => n).join(', ')}`,
    fix: `Create them (with the GitHub CLI, as an account with write access):\n${missing
      .map(
        ([name, kind]) =>
          `gh label create ${q(name)} --repo ${zone.repo} --color ${LABEL_SPEC[kind]?.color} --description ${JSON.stringify(LABEL_SPEC[kind]?.description)}`,
      )
      .join('\n')}`,
  };
}

async function privateCloneCheck(
  d: DoctorDeps,
  zone: DropZoneConfig,
  r: ZoneReads,
): Promise<DoctorCheck> {
  const base = { id: 'forge.private-clone', zoneId: zone.id, doc: doc('read-token') };
  const access = await r.access.author();
  if (!access.ok)
    return readFailed(base, 'author', `read the repository ${zone.repo}`, 'Metadata: read', access);
  const hasToken = d.config.secrets.githubReadToken !== undefined;
  const branch = await r.branch();
  if (!access.value.private) {
    return {
      ...base,
      status: 'pass',
      summary: `${zone.repo} is public: review, crew and doctor drops clone it ${zone.reviewReadToken && hasToken ? 'with the read token' : 'anonymously'}`,
    };
  }
  if (!zone.reviewReadToken || !hasToken)
    return {
      ...base,
      status: 'fail',
      summary: `${zone.repo} is private, and ${!hasToken ? 'no read token is configured' : 'the zone does not set reviewReadToken'}: review, crew and doctor drops can't clone it`,
      fix: `Create a fine-grained token for ${zone.repo} with Contents: Read-only (and Metadata), store it as JM_GITHUB_READ_TOKEN (or JM_GITHUB_READ_TOKEN_FILE), and set reviewReadToken: true in the zone.`,
    };
  const read = d.readForge?.(zone.id);
  if (!read)
    return {
      ...base,
      status: 'skip',
      summary:
        'the read token is configured, but the doctor has no forge for it; the check did not run',
    };
  const root = await attempt(() => read.listDir(branch, ''));
  if (!root.ok)
    return readFailed(base, 'read', `read ${zone.repo}'s files`, 'Contents: read', root);
  if (root.value === null)
    return {
      ...base,
      status: 'fail',
      summary: `the read token sees no files at the root of ${branch} in ${zone.repo}`,
      fix: `Check the token's repository access includes ${zone.repo}, with Contents: Read-only.`,
    };
  return {
    ...base,
    status: 'pass',
    summary: `${zone.repo} is private; the read token can read its files (review, crew and doctor drops clone with it)`,
  };
}

async function presetCheck(zone: DropZoneConfig, r: ZoneReads): Promise<DoctorCheck> {
  const base = { id: 'zone.preset', zoneId: zone.id, doc: doc('presets') };
  const notes: string[] = [];
  let status: DoctorStatus = 'pass';
  const fixes: string[] = [];
  if (zone.image.endsWith(':dev')) {
    status = 'warn';
    notes.push(
      `the zone runs ${zone.image}, a locally built image (JM_DEV_IMAGES=1 or an explicit :dev tag): a mutable tag, unsigned, that the stick refuses under the signed policy`,
    );
    fixes.push(
      'For a real install run the published server image, which carries the release image lock, or set image to a digest reference (name@sha256:…).',
    );
  } else if (!DIGEST_REF.test(zone.image)) {
    status = 'warn';
    notes.push(`the image ${zone.image} is a tag: whoever moves the tag changes what drops run`);
    fixes.push(
      `Pin it by digest: docker buildx imagetools inspect ${zone.image} prints the digest; set image to name@sha256:<digest>.`,
    );
  }
  if (!zone.preset) {
    notes.unshift(`explicit image ${zone.image} (no preset)`);
    return {
      ...base,
      status,
      summary: notes.join('; '),
      ...(fixes.length ? { fix: fixes.join(' ') } : {}),
    };
  }
  const branch = await r.branch();
  const root = await attempt(() => r.pair.author.listDir(branch, ''));
  if (!root.ok)
    return readFailed(base, 'author', 'list the repository root', 'Contents: read', root);
  const names = new Set(root.value ?? []);
  const wanted = [
    ...DETECT_FILES.filter((f) => names.has(f)),
    ...[...names].filter(
      (n) => /^requirements[\w.-]*\.txt$/.test(n) && !DETECT_FILES.includes(n as never),
    ),
  ];
  const files: Record<string, string | null> = {};
  for (const f of wanted) {
    const got = await attempt(() => r.pair.author.getFileAt(branch, f));
    if (!got.ok) return readFailed(base, 'author', `read ${f}`, 'Contents: read', got);
    files[f] = got.value;
  }
  const found = detectPreset(files);
  if (found.preset === null || found.preset !== zone.preset) {
    status = 'warn';
    notes.unshift(
      found.preset === null
        ? `preset ${zone.preset}; detection on ${branch} found no single stack (${found.problems.join('; ')})`
        : `preset ${zone.preset}, but ${branch} looks like ${found.preset} (${found.evidence.join(', ')})`,
    );
    fixes.unshift(
      "Check the zone uses the preset for the repository's stack, and that its gates run that stack's tests (an operator image FROM a preset is fine when the repository mixes stacks).",
    );
  } else {
    notes.unshift(
      `preset ${zone.preset} matches ${branch} (${found.evidence.join(', ')})${found.problems.length ? `; detection notes: ${found.problems.join('; ')}` : ''}`,
    );
  }
  return {
    ...base,
    status,
    summary: notes.join('; '),
    ...(fixes.length ? { fix: fixes.join(' ') } : {}),
  };
}

function servicesCheck(d: DoctorDeps, zone: DropZoneConfig, sticks: Stick[]): DoctorCheck {
  const base = { id: 'zone.services', zoneId: zone.id, doc: doc('services') };
  if (zone.services.length === 0)
    return { ...base, status: 'pass', summary: 'the zone declares no services' };
  const tagged = zone.services.filter((s) => !DIGEST_REF.test(s.image));
  if (tagged.length > 0)
    return {
      ...base,
      status: 'fail',
      summary: `service image(s) by tag, not digest: ${tagged.map((s) => `${s.name} (${s.image})`).join(', ')}`,
      fix: tagged
        .map(
          (s) =>
            `Run docker buildx imagetools inspect ${s.image}, and set ${s.name}'s image to ${s.image.replace(/:[^/:@]+$/, '')}@sha256:<the digest it prints>.`,
        )
        .join(' '),
    };
  const need = zoneRequirements(zone, d.config);
  if (!need.signed)
    return {
      ...base,
      status: 'pass',
      summary: `every service image is pinned by digest: ${zone.services.map((s) => s.name).join(', ')}`,
    };
  const capable = liveSticks(sticks, d.now()).filter((s) => missingFor(s, need).length === 0);
  if (capable.length === 0)
    return {
      ...base,
      status: 'skip',
      summary:
        'signed images are required, and no live stick can run this zone to check its pins against (see stick.capabilities)',
    };
  const unpinned = zone.services.filter(
    (s) => !capable.some((st) => st.pinnedImages.includes(s.image)),
  );
  if (unpinned.length === 0)
    return {
      ...base,
      status: 'pass',
      summary: `every service image is pinned by digest on ${capable.map((s) => s.name).join(', ')}`,
    };
  return {
    ...base,
    status: 'fail',
    summary: `under the signed policy a stick runs a service image only when it pins that exact digest, and no capable stick pins: ${unpinned.map((s) => `${s.name} (${s.image})`).join(', ')}`,
    fix: `Add ${unpinned.map((s) => s.image).join(',')} to the stick's JM_ALLOWED_IMAGES (comma-separated) and restart it.`,
  };
}

type HostSeen = { host: string; decision: string; count: number };

function egressSeen(db: Db, zoneId: string, since: Date): { drops: number; hosts: HostSeen[] } {
  const rows = db
    .prepare(
      `SELECT e.drop_id AS dropId, e.data_json AS data FROM drop_events e
         JOIN drops d ON d.id = e.drop_id
       WHERE d.drop_zone_id = ? AND e.kind = 'egress' AND d.created_at > ?`,
    )
    .all(zoneId, since.toISOString()) as { dropId: string; data: string }[];
  const totals = new Map<string, HostSeen>();
  for (const row of rows) {
    let data: { host?: unknown; decision?: unknown; count?: unknown };
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (typeof data.host !== 'string' || typeof data.decision !== 'string') continue;
    const key = `${data.decision}\u0000${data.host}`;
    const t = totals.get(key) ?? { host: data.host, decision: data.decision, count: 0 };
    t.count += typeof data.count === 'number' ? data.count : 0;
    totals.set(key, t);
  }
  return {
    drops: new Set(rows.map((r) => r.dropId)).size,
    hosts: [...totals.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
  };
}

function egressCheck(d: DoctorDeps, zone: DropZoneConfig): DoctorCheck {
  const base = { id: 'zone.egress', zoneId: zone.id, doc: doc('egress') };
  const mode = zone.egress?.mode ?? 'off';
  if (mode === 'off')
    return {
      ...base,
      status: 'warn',
      summary: 'egress is off: a drop can reach any host on the internet',
      fix: 'Set egress.mode to "monitor", run a doctor drop (jumpmaster ctl doctor <zone> --drop) to see the hosts it uses, add any it needs to egress.allow, then set "enforce".',
    };
  const allow = egressFor(zone)?.allow ?? [];
  const seen = egressSeen(d.db, zone.id, new Date(d.now().getTime() - EGRESS_WINDOW_MS));
  const window = `${seen.drops} drop(s) in the last ${EGRESS_WINDOW_MS / DAY_MS} days`;
  if (mode === 'monitor') {
    const unlisted = seen.hosts.filter(
      (h) => h.decision !== 'allow' && !hostAllowed(h.host, allow),
    );
    const names = [...new Set(unlisted.map((h) => h.host))];
    return {
      ...base,
      status: 'warn',
      summary:
        seen.drops === 0
          ? 'egress is in monitor mode, and no drop has run under it yet, so no host has been observed'
          : names.length > 0
            ? `egress is in monitor mode; observed hosts not in the allow list (${window}): ${names.join(', ')}`
            : `egress is in monitor mode, and every host observed in ${window} is in the allow list`,
      fix:
        names.length > 0
          ? `Add the hosts the drops need to egress.allow (leave out any you don't expect), run another doctor drop, and flip to enforce when this is empty.`
          : seen.drops === 0
            ? 'Run a doctor drop (jumpmaster ctl doctor <zone> --drop), then run the doctor again; flip to enforce when this is empty.'
            : 'Set egress.mode to "enforce": flip to enforce when this is empty, and it is.',
    };
  }
  const denied = [...new Set(seen.hosts.filter((h) => h.decision === 'deny').map((h) => h.host))];
  if (denied.length > 0)
    return {
      ...base,
      status: 'warn',
      summary: `egress is enforced; hosts denied in ${window}: ${denied.join(', ')}`,
      fix: 'If a gate or tool needs one of these, add it to egress.allow; otherwise nothing to do.',
    };
  return {
    ...base,
    status: 'pass',
    summary: `egress is enforced (${allow.length} allowed host entries); no host was denied in ${window}`,
  };
}

function goalsCheck(zone: DropZoneConfig, d: DoctorDeps): DoctorCheck {
  const base = { id: 'zone.goals', zoneId: zone.id, doc: doc('crew') };
  const g = getGoals(d.db, zone.id);
  if (!g)
    return {
      ...base,
      status: 'warn',
      summary: `${zone.crew.goalPath} has not been read yet: the crew reads it on its next pass`,
      fix: `Check ${zone.crew.goalPath} exists on the default branch, and the zone is active.`,
    };
  if (!g.parse.ok)
    return {
      ...base,
      status: 'fail',
      summary: `${zone.crew.goalPath} does not parse (read ${g.readAt}): ${g.parse.error}; the crew lead waits until it does`,
      fix: `Fix ${zone.crew.goalPath} on the default branch through a pull request (it is a protected path).`,
    };
  return {
    ...base,
    status: 'pass',
    summary: `${zone.crew.goalPath} parses: ${g.parse.objectives.length} objective(s) (read ${g.readAt})`,
  };
}

function crewCapCheck(zone: DropZoneConfig, d: DoctorDeps): DoctorCheck {
  const base = { id: 'zone.crew-cap', zoneId: zone.id, doc: doc('crew') };
  const now = d.now();
  const used = crewDropsToday(d.db, zone.id, now);
  const cap = zone.crew.maxDropsPerDay;
  if (used < cap)
    return {
      ...base,
      status: 'pass',
      summary: `crew drops in the last 24 hours: ${used}/${cap}`,
    };
  // The cap frees a slot when the oldest counted drop leaves the trailing day.
  const oldest = d.db
    .prepare(
      `SELECT created_at AS at FROM drops WHERE drop_zone_id = ? AND work_item_id IS NULL
         AND role IN ('crew-lead','refute','diagnose') AND created_at > ? AND state <> 'lost'
         AND COALESCE(json_extract(result_json, '$.status'), '') <> 'rate_limited'
       ORDER BY created_at LIMIT 1`,
    )
    .get(zone.id, new Date(now.getTime() - DAY_MS).toISOString()) as { at: string } | undefined;
  const until = oldest ? new Date(Date.parse(oldest.at) + DAY_MS).toISOString() : 'unknown';
  return {
    ...base,
    status: 'warn',
    summary: `crew paused: daily cap ${used}/${cap} until ${until}; parked briefings wait for diagnosis until then`,
    fix: `Nothing breaks: the crew resumes by itself. To allow more, raise crew.maxDropsPerDay (each crew drop spends usage).`,
  };
}

function modeCheck(zone: DropZoneConfig, d: DoctorDeps): DoctorCheck {
  const base = { id: 'zone.mode', zoneId: zone.id };
  const mode = getZoneMode(d.db, zone.id, zone.mode);
  if (mode === 'active') return { ...base, status: 'pass', summary: 'the zone is active' };
  return {
    ...base,
    status: 'warn',
    summary:
      mode === 'paused'
        ? 'the zone is paused: no new drop starts in it'
        : 'the zone is in observe mode: it records what it would do and changes nothing',
    fix: `When ready: jumpmaster ctl resume ${zone.id}`,
  };
}

/** Checks the later tasks fill in; until then they say they did not run. */
function pendingChecks(zone: DropZoneConfig): DoctorCheck[] {
  return [
    {
      id: 'zone.identity',
      zoneId: zone.id,
      status: 'skip',
      summary: 'the identity mode check is available after Task 13 (single-identity starter mode)',
    },
    {
      id: 'zone.doctor-drop',
      zoneId: zone.id,
      status: 'skip',
      summary: 'the live doctor drop (Claude token, clone, services, gates) arrives after Task 12',
    },
  ];
}

/** A thrown check becomes a `fail` naming what threw (the run redacts it before anyone sees it). */
async function guard(
  id: string,
  zoneId: string | null,
  fn: () => Promise<DoctorCheck> | DoctorCheck,
): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return {
      id,
      zoneId,
      status: 'fail',
      summary: `the check could not run: ${String((err as Error)?.message ?? err).split('\n')[0]}${typeof status === 'number' ? ` (HTTP ${status})` : ''}`,
      fix: 'Run the doctor again; if this repeats, the server log says more.',
    };
  }
}

export async function zoneChecks(
  d: DoctorDeps,
  zone: DropZoneConfig,
  sticks: Stick[],
): Promise<DoctorCheck[]> {
  const r = zoneReads(d, zone);
  const z = zone.id;
  const checks: Promise<DoctorCheck>[] = [
    guard('zone.mode', z, () => modeCheck(zone, d)),
    guard('stick.capabilities', z, () => stickCapabilityCheck(d, zone, sticks)),
    guard('forge.author', z, () => identityCheck(d, zone, r, 'author')),
    guard('forge.reviewer', z, () => identityCheck(d, zone, r, 'reviewer')),
    guard('forge.admin', z, () => adminCheck(zone, r)),
    guard('forge.author-reads', z, () => readsCheck(zone, r, 'author')),
    guard('forge.reviewer-reads', z, () => readsCheck(zone, r, 'reviewer')),
    guard('forge.branch-rules', z, () => branchRulesCheck(zone, r)),
    guard('forge.codeowners', z, () => codeownersCheck(zone, r)),
    guard('forge.ci', z, () => ciCheck(zone, r)),
    guard('forge.labels', z, () => labelsCheck(zone, r)),
    guard('forge.private-clone', z, () => privateCloneCheck(d, zone, r)),
    guard('zone.preset', z, () => presetCheck(zone, r)),
    guard('zone.services', z, () => servicesCheck(d, zone, sticks)),
    guard('zone.egress', z, () => egressCheck(d, zone)),
    ...(zone.crew.enabled
      ? [
          guard('zone.goals', z, () => goalsCheck(zone, d)),
          guard('zone.crew-cap', z, () => crewCapCheck(zone, d)),
        ]
      : []),
  ];
  return [...(await Promise.all(checks)), ...pendingChecks(zone)];
}

/** Every check, global ones first, then each zone's (zones in parallel). */
export async function runChecks(
  d: DoctorDeps,
  opts: { zoneId?: string } = {},
): Promise<DoctorCheck[]> {
  const sticks = listSticks(d.db);
  const global = await Promise.all([
    guard('config.listen', null, () => listenCheck(d)),
    guard('config.uid', null, () => uidCheck(d)),
    guard('claude.token-age', null, () => tokenAgeCheck(d)),
    guard('claude.plan', null, () => planCheck(d)),
    guard('control.kill', null, () => killCheck(d)),
    guard('usage.gate', null, () => usageCheck(d)),
    guard('stick.seen', null, () => stickSeenCheck(d, sticks)),
    guard('stick.image-policy', null, () => imagePolicyCheck(d, sticks)),
  ]);
  const zones = d.config.dropZones.filter((z) => opts.zoneId === undefined || z.id === opts.zoneId);
  const perZone = await Promise.all(zones.map((z) => zoneChecks(d, z, sticks)));
  return [...global, ...perZone.flat()];
}
