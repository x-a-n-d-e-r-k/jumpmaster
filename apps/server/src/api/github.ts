import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConfigStore } from '../config/store.js';
import { type Config, DEFAULT_PROTECTED_PATHS, type DropZoneConfig } from '../config.js';
import type { AppTokenSource } from '../forge/app-tokens.js';
import { type Forge, GitHubForge } from '../forge/github.js';
import {
  collaboratorChecklist,
  type GuidanceApps,
  type GuidanceZone,
  PAT_EXPIRATION_DAYS,
  patTemplateUrl,
  type Recommendation,
  recommendIdentity,
  starterRecommendation,
  type ZoneGuidance,
  zoneGuidance,
} from '../github/guidance.js';
import { ownerOfRepo } from '../vault/github-app-entries.js';
import { isAppAuthorZone, isAppReviewerZone, type ResolvedApps } from '../vault/resolution.js';
import { fingerprintOf } from '../vault/vault.js';
import {
  detectFailure,
  detectGuidance,
  NO_AUTHOR,
  REPO,
  RepoNameError,
  zoneIdOf,
} from '../zones/detect.js';

/**
 * The GitHub guidance routes (§10.3, M4.5 Task 7): reads only, never audited, never a forge
 * write. `GET …/zones/:id/github` assembles the five for a zone; `POST …/github/recommend` serves
 * the wizard before a zone exists, and before any token: without one it reads the repository
 * anonymously, and when GitHub hides it (a private repository, or none) the owner's type alone.
 */

/** What guidance reads through: GETs on the repository, its owner and the token's account. */
export type GuidanceForge = Pick<
  Forge,
  'repoAccess' | 'listDir' | 'getFileAt' | 'ownerType' | 'viewerLogin'
>;

const GUIDANCE_REQUEST_MS = 30_000;

/** GitHub with a deadline; an empty token reads anonymously. */
export const githubGuidanceForge = (repo: string, token: string): GuidanceForge => {
  const [owner = '', name = ''] = repo.split('/');
  return new GitHubForge(owner, name, token, { requestTimeoutMs: GUIDANCE_REQUEST_MS });
};

const LOGIN = /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$|^@?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const Reviewers = z.array(z.string().max(80).regex(LOGIN)).max(20);

/** A login GitHub gives for a token: the stored one when it was tested on entry, else a GET. */
async function loginOf(
  stored: string | undefined,
  token: string | undefined,
  forge: (token: string) => GuidanceForge,
): Promise<string | undefined> {
  if (stored) return stored;
  if (!token) return undefined;
  try {
    return await forge(token).viewerLogin();
  } catch {
    return undefined;
  }
}

type Logins = { author?: string; reviewer?: string };

/** The reviewer PAT's login, as far as the token resolves it. */
async function reviewerPatLogin(
  store: ConfigStore,
  config: Config,
  repo: string,
  forgeOf: (repo: string, token: string) => GuidanceForge,
): Promise<string | undefined> {
  return loginOf(
    store.resolved().githubReviewerToken.login,
    config.secrets.githubReviewerToken,
    (t) => forgeOf(repo, t),
  );
}

/** The bot logins, as far as the tokens resolve them. */
async function loginsOf(
  store: ConfigStore,
  config: Config,
  repo: string,
  forgeOf: (repo: string, token: string) => GuidanceForge,
): Promise<Logins> {
  const r = store.resolved();
  const forge = (t: string) => forgeOf(repo, t);
  const author = await loginOf(r.githubAuthorToken.login, config.secrets.githubAuthorToken, forge);
  const reviewer = await reviewerPatLogin(store, config, repo, forgeOf);
  return { ...(author ? { author } : {}), ...(reviewer ? { reviewer } : {}) };
}

type GuidanceRead = Awaited<ReturnType<typeof detectGuidance>>;

/** What one read of a repository found: the repository (null: GitHub answered 404), and the logins. */
type ReadEntry =
  | {
      ok: true;
      read: GuidanceRead | null;
      ownerType: 'User' | 'Organization';
      logins: Logins;
    }
  | { ok: false; error: string };

/**
 * How one read is made: its cache key, the token it reads with (asked for only on a cache miss),
 * whether that is a token read (an empty PAT reads anonymously), and the logins.
 */
type ReadPlan = {
  key: string;
  token: () => Promise<string>;
  authed: boolean;
  logins: () => Promise<Logins>;
};

/** A mint refused or failed: the repository and the author app only, never the error's text. */
const mintFailure = (repo: string): string =>
  `could not get a token from the author GitHub App for ${repo}; check the app's installation on the repository`;

/** Today's read: the author PAT (its snapshot's), or anonymous without one. */
function patPlan(
  store: ConfigStore,
  config: Config,
  repo: string,
  forgeOf: (repo: string, token: string) => GuidanceForge,
): ReadPlan {
  const token = config.secrets.githubAuthorToken ?? '';
  // The token this request read with (its snapshot), never the live store's: a read and its key
  // are always the same token's.
  return {
    key: `${repo}\u0000${token ? fingerprintOf(token) : 'anonymous'}`,
    token: async () => token,
    authed: token !== '',
    logins: () => loginsOf(store, config, repo, forgeOf),
  };
}

/**
 * The zone's apps for its guidance (§5.2, issue #482), resolved as the doctor does
 * (`isAppAuthorZone` / `isAppReviewerZone`): only each app's public id and slug, never a key, a
 * client secret or a token. Read whether or not a token source is wired, since nothing here mints.
 * An author entry whose id is not a positive integer (the vault takes `'0'`) is left out, so the
 * zone gets the guidance without a merge ruleset rather than a ruleset that names no app.
 */
export function guidanceAppsFor(zone: DropZoneConfig, apps: ResolvedApps): GuidanceApps {
  const reads = apps.get(ownerOfRepo(zone.repo));
  const out: GuidanceApps = {};
  const author = reads?.author;
  if (author && author.source !== 'missing' && isAppAuthorZone(zone, apps)) {
    const appId = Number(author.entry.appId);
    if (Number.isSafeInteger(appId) && appId > 0) out.author = { appId, slug: author.entry.slug };
  }
  const reviewer = reads?.reviewer;
  if (reviewer && reviewer.source !== 'missing' && isAppReviewerZone(zone, apps))
    out.reviewer = { slug: reviewer.entry.slug };
  return out;
}

/**
 * An app-author zone's read (§4.4): on a server-author token from the owner's author app. The key
 * is built from the resolved entries, never the token, so a re-mint hits it, and a different app,
 * a rotated key or a changed reviewer credential never shares one (app changes don't clear the
 * cache). The logins are the apps' bot logins; a PAT reviewer's is read as today.
 */
function appPlan(
  store: ConfigStore,
  config: Config,
  zone: DropZoneConfig,
  appTokens: Pick<AppTokenSource, 'provider'>,
  forgeOf: (repo: string, token: string) => GuidanceForge,
): ReadPlan | undefined {
  const apps = store.resolvedApps();
  const owner = ownerOfRepo(zone.repo);
  const reads = apps.get(owner);
  const author = reads?.author;
  if (!reads || !author || author.source === 'missing') return undefined;
  const reviewerApp = isAppReviewerZone(zone, apps) ? reads.reviewer : undefined;
  const reviewerPat = config.secrets.githubReviewerToken;
  const reviewerKey =
    reviewerApp && reviewerApp.source !== 'missing'
      ? `app:${reviewerApp.fingerprint}`
      : reviewerPat
        ? `pat:${fingerprintOf(reviewerPat)}`
        : 'none';
  return {
    key: [zone.repo, 'app', owner, author.entry.appId, author.fingerprint, reviewerKey].join(
      '\u0000',
    ),
    token: () => appTokens.provider(zone.id, 'author', 'server-author').token(),
    authed: true,
    logins: async () => {
      const reviewer =
        reviewerApp && reviewerApp.source !== 'missing'
          ? `${reviewerApp.entry.slug}[bot]`
          : await reviewerPatLogin(store, config, zone.repo, forgeOf);
      return { author: `${author.entry.slug}[bot]`, ...(reviewer ? { reviewer } : {}) };
    },
  };
}

const READ_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 60_000;
const READ_ENTRIES = 50;

/**
 * Reads of a repository for the guidance, kept a few minutes in this process: the wizard's steps
 * and the zone page ask again on every view, and without a token GitHub allows an address 60
 * requests an hour. Keyed by the repository and the author token's fingerprint ("anonymous"
 * without one), or for an app-author zone by the repository and the resolved app entries (never
 * the minted token); a 404 is kept a minute; at most fifty entries, the oldest dropped first; emptied
 * whenever the config or the secrets change. Nothing is persisted.
 */
class ReadCache {
  private readonly entries = new Map<string, { until: number; value: ReadEntry }>();
  get(key: string, now: number): ReadEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (now >= e.until) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: ReadEntry, ttlMs: number, now: number): void {
    this.entries.delete(key);
    while (this.entries.size >= READ_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { until: now + ttlMs, value });
  }
  clear(): void {
    this.entries.clear();
  }
}

const caches = new WeakMap<ConfigStore, ReadCache>();
function cacheOf(store: ConfigStore): ReadCache {
  let c = caches.get(store);
  if (!c) {
    const cache = new ReadCache();
    caches.set(store, cache);
    store.subscribe(() => cache.clear());
    c = cache;
  }
  return c;
}

/** The repository as the guidance needs it, through the cache; a refused name throws. */
async function readRepo(
  store: ConfigStore,
  repo: string,
  plan: ReadPlan,
  forgeOf: (repo: string, token: string) => GuidanceForge,
  now: () => Date,
): Promise<ReadEntry> {
  if (!REPO.test(repo)) throw new RepoNameError();
  const { key, authed } = plan;
  const cache = cacheOf(store);
  const t = now().getTime();
  const hit = cache.get(key, t);
  if (hit) return hit;
  let token: string;
  try {
    token = await plan.token();
  } catch {
    // Never cached: the next view asks again.
    return { ok: false, error: mintFailure(repo) };
  }
  const forge = forgeOf(repo, token);
  try {
    const read = await detectGuidance(forge, repo, { workflows: authed });
    const entry: ReadEntry = {
      ok: true,
      read,
      ownerType: read.ownerType,
      logins: await plan.logins(),
    };
    cache.set(key, entry, READ_TTL_MS, t);
    return entry;
  } catch (e) {
    if (e instanceof RepoNameError) throw e;
    if ((e as { status?: unknown }).status !== 404)
      return { ok: false, error: detectFailure(e, repo) };
    // A token that cannot see it is an answer to keep a minute.
    if (authed) {
      const entry: ReadEntry = { ok: false, error: detectFailure(e, repo) };
      cache.set(key, entry, MISSING_TTL_MS, t);
      return entry;
    }
    // Without a token GitHub answers 404 for a private repository: the owner is still public.
    try {
      const entry: ReadEntry = {
        ok: true,
        read: null,
        ownerType: await forge.ownerType(),
        logins: {},
      };
      cache.set(key, entry, MISSING_TTL_MS, t);
      return entry;
    } catch (e2) {
      return { ok: false, error: detectFailure(e2, repo) };
    }
  }
}

export type GuidanceResult =
  | { ok: true; guidance: ZoneGuidance; logins: Logins }
  | { ok: false; status: 400 | 409 | 502; error: string };

const systemNow = () => new Date();

/**
 * The five for `zone`, read app-first (§4.4): an app-author zone through its author app when a
 * token source is given (whether or not an author PAT is set), else the author PAT.
 */
export async function guidanceFor(
  store: ConfigStore,
  config: Config,
  zone: DropZoneConfig,
  forgeOf: (repo: string, token: string) => GuidanceForge,
  opts: {
    reviewers?: string[];
    paidPlan?: boolean;
    now?: () => Date;
    appTokens?: Pick<AppTokenSource, 'provider'>;
  } = {},
): Promise<GuidanceResult> {
  // A name the config allows but GitHub's does not (owner/name only): said as such, not as a
  // network failure.
  if (!REPO.test(zone.repo)) return { ok: false, status: 400, error: new RepoNameError().message };
  const app =
    opts.appTokens && isAppAuthorZone(zone, store.resolvedApps())
      ? appPlan(store, config, zone, opts.appTokens, forgeOf)
      : undefined;
  if (!app && !config.secrets.githubAuthorToken)
    return { ok: false, status: 409, error: NO_AUTHOR };
  const plan = app ?? patPlan(store, config, zone.repo, forgeOf);
  const entry = await readRepo(store, zone.repo, plan, forgeOf, opts.now ?? systemNow);
  if (!entry.ok) return { ok: false, status: 502, error: entry.error };
  const detection = entry.read;
  if (!detection)
    return { ok: false, status: 502, error: detectFailure({ status: 404 }, zone.repo) };
  const logins = entry.logins;
  return {
    ok: true,
    guidance: zoneGuidance(
      zone,
      detection,
      { ...logins, codeowners: opts.reviewers ?? [] },
      opts.paidPlan === undefined ? {} : { paidPlan: opts.paidPlan },
      guidanceAppsFor(zone, store.resolvedApps()),
    ),
    logins,
  };
}

// Unknown keys (a pasted link's `utm_source`) are ignored.
const GuideQuery = z.object({
  reviewer: z.string().max(400).optional(),
  paidPlan: z.enum(['true', 'false']).optional(),
});
const RecommendBody = z.strictObject({
  repo: z.string().max(200),
  paidPlan: z.boolean().optional(),
  identity: z.enum(['two-bot', 'starter']).optional(),
  reviewers: Reviewers.optional(),
});

/** What the wizard's GitHub steps read before a zone exists. */
export type RecommendAnswer = {
  repo: string;
  ownerType: 'User' | 'Organization';
  visibility: 'public' | 'private';
  /** Whether the repository could be read: false means private, or not there at all. */
  visible: boolean;
  recommendation: Recommendation;
  pat: ZoneGuidance['pat'];
  checklist: ZoneGuidance['checklist'];
  /** The bot logins the tokens resolve to (logins are not secrets). */
  logins: { author?: string; reviewer?: string };
  /** The ruleset and CODEOWNERS for the zone as proposed, once the author token reads the repository. */
  guidance?: ZoneGuidance;
};

export type RecommendInput = {
  repo: string;
  paidPlan?: boolean;
  identity?: 'two-bot' | 'starter';
  reviewers?: string[];
};

/**
 * What the wizard's GitHub steps show before a zone exists: the recommendation and token links
 * from the owner type and visibility (read without a token when there is none), the checklist as
 * far as the logins resolve, and, once the author token reads the repository, the ruleset and
 * CODEOWNERS for the zone as proposed.
 */
export async function recommendFor(
  store: ConfigStore,
  config: Config,
  input: RecommendInput,
  forgeOf: (repo: string, token: string) => GuidanceForge,
  now: () => Date = systemNow,
): Promise<
  { ok: true; answer: RecommendAnswer } | { ok: false; status: 400 | 502; error: string }
> {
  const { repo, paidPlan, identity, reviewers } = input;
  if (!REPO.test(repo))
    return { ok: false, status: 400, error: 'the repository must be owner/name' };
  const token = config.secrets.githubAuthorToken ?? '';
  const entry = await readRepo(store, repo, patPlan(store, config, repo, forgeOf), forgeOf, now);
  if (!entry.ok) return { ok: false, status: 502, error: entry.error };
  const { read, ownerType } = entry;
  const visibility = read?.visibility ?? 'private';
  const [owner = '', name = ''] = repo.split('/');
  const facts = { ownerType, visibility, owner, ...(paidPlan === undefined ? {} : { paidPlan }) };
  // The operator's choice of one account is starter on tokens; otherwise the recommendation.
  const recommendation =
    identity === 'starter' ? starterRecommendation(facts) : recommendIdentity(facts);
  const zone: GuidanceZone = {
    id: zoneIdOf(repo),
    repo,
    identity: identity ?? recommendation.identity,
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    reviewReadToken: visibility === 'private',
  };
  const logins = entry.logins;
  const days = { expirationDays: PAT_EXPIRATION_DAYS };
  return {
    ok: true,
    answer: {
      repo,
      ownerType,
      visibility,
      visible: read !== null,
      recommendation,
      pat: {
        author: patTemplateUrl('author', { owner, name }, days),
        reviewer: patTemplateUrl('reviewer', { owner, name }, days),
        read: patTemplateUrl('read', { owner, name }, days),
      },
      checklist: collaboratorChecklist(zone, logins),
      logins,
      ...(read && token !== ''
        ? {
            guidance: zoneGuidance(
              zone,
              read,
              { ...logins, codeowners: reviewers ?? [] },
              paidPlan === undefined ? {} : { paidPlan },
            ),
          }
        : {}),
    },
  };
}

export function registerGuidanceRoutes(
  scope: FastifyInstance,
  deps: {
    store: ConfigStore;
    now(): Date;
    guidanceForge?: (repo: string, token: string) => GuidanceForge;
    /** The app token source: an app-author zone's guidance reads on its author app (§4.4). */
    appTokens?: Pick<AppTokenSource, 'provider'>;
  },
): void {
  const { store, now } = deps;
  const forgeOf = deps.guidanceForge ?? githubGuidanceForge;

  scope.get<{ Params: { id: string } }>('/api/control/zones/:id/github', async (req, reply) => {
    const config = req.jmConfig ?? store.current();
    const zone = config.dropZones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).send({ error: 'unknown zone' });
    const q = GuideQuery.safeParse(req.query ?? {});
    const reviewers = q.success
      ? Reviewers.safeParse(
          (q.data.reviewer ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : null;
    if (!q.success || !reviewers?.success)
      return reply.code(400).send({ error: 'reviewer is a comma-separated list of GitHub logins' });
    const r = await guidanceFor(store, config, zone, forgeOf, {
      now,
      ...(deps.appTokens ? { appTokens: deps.appTokens } : {}),
      reviewers: reviewers.data,
      ...(q.data.paidPlan ? { paidPlan: q.data.paidPlan === 'true' } : {}),
    });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.guidance;
  });

  scope.post('/api/control/github/recommend', async (req, reply) => {
    const body = RecommendBody.safeParse(req.body ?? {});
    if (!body.success || !REPO.test(body.data.repo))
      return reply.code(400).send({ error: 'the repository must be owner/name' });
    const r = await recommendFor(store, req.jmConfig ?? store.current(), body.data, forgeOf, now);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.answer;
  });
}
