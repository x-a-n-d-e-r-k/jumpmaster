import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConfigStore } from '../config/store.js';
import { type Config, DEFAULT_PROTECTED_PATHS, type DropZoneConfig } from '../config.js';
import { type Forge, GitHubForge } from '../forge/github.js';
import {
  collaboratorChecklist,
  type GuidanceZone,
  PAT_EXPIRATION_DAYS,
  patTemplateUrl,
  type Recommendation,
  recommendIdentity,
  type ZoneGuidance,
  zoneGuidance,
} from '../github/guidance.js';
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

/** The bot logins, as far as the tokens resolve them. */
async function loginsOf(
  store: ConfigStore,
  config: Config,
  repo: string,
  forgeOf: (repo: string, token: string) => GuidanceForge,
): Promise<{ author?: string; reviewer?: string }> {
  const r = store.resolved();
  const forge = (t: string) => forgeOf(repo, t);
  const author = await loginOf(r.githubAuthorToken.login, config.secrets.githubAuthorToken, forge);
  const reviewer = await loginOf(
    r.githubReviewerToken.login,
    config.secrets.githubReviewerToken,
    forge,
  );
  return { ...(author ? { author } : {}), ...(reviewer ? { reviewer } : {}) };
}

type GuidanceRead = Awaited<ReturnType<typeof detectGuidance>>;

/** What one read of a repository found: the repository (null: GitHub answered 404), and the logins. */
type ReadEntry =
  | {
      ok: true;
      read: GuidanceRead | null;
      ownerType: 'User' | 'Organization';
      logins: { author?: string; reviewer?: string };
    }
  | { ok: false; error: string };

const READ_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 60_000;
const READ_ENTRIES = 50;

/**
 * Reads of a repository for the guidance, kept a few minutes in this process: the wizard's steps
 * and the zone page ask again on every view, and without a token GitHub allows an address 60
 * requests an hour. Keyed by the repository and the author token's fingerprint ("anonymous"
 * without one); a 404 is kept a minute; at most fifty entries, the oldest dropped first; emptied
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
  config: Config,
  repo: string,
  forgeOf: (repo: string, token: string) => GuidanceForge,
  now: () => Date,
): Promise<ReadEntry> {
  if (!REPO.test(repo)) throw new RepoNameError(repo);
  const token = config.secrets.githubAuthorToken ?? '';
  // The token this request read with (its snapshot), never the live store's: a read and its key
  // are always the same token's.
  const key = `${repo}\u0000${token ? fingerprintOf(token) : 'anonymous'}`;
  const cache = cacheOf(store);
  const t = now().getTime();
  const hit = cache.get(key, t);
  if (hit) return hit;
  const forge = forgeOf(repo, token);
  try {
    const read = await detectGuidance(forge, repo, { workflows: token !== '' });
    const entry: ReadEntry = {
      ok: true,
      read,
      ownerType: read.ownerType,
      logins: await loginsOf(store, config, repo, forgeOf),
    };
    cache.set(key, entry, READ_TTL_MS, t);
    return entry;
  } catch (e) {
    if (e instanceof RepoNameError) throw e;
    if ((e as { status?: unknown }).status !== 404)
      return { ok: false, error: detectFailure(e, repo) };
    // A token that cannot see it is an answer to keep a minute.
    if (token !== '') {
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
  | { ok: true; guidance: ZoneGuidance }
  | { ok: false; status: 400 | 409 | 502; error: string };

const systemNow = () => new Date();

/** The five for `zone`, read through the author token. */
export async function guidanceFor(
  store: ConfigStore,
  config: Config,
  zone: DropZoneConfig,
  forgeOf: (repo: string, token: string) => GuidanceForge,
  opts: { reviewers?: string[]; paidPlan?: boolean; now?: () => Date } = {},
): Promise<GuidanceResult> {
  // A name the config allows but GitHub's does not (owner/name only): said as such, not as a
  // network failure.
  if (!REPO.test(zone.repo))
    return { ok: false, status: 400, error: new RepoNameError(zone.repo).message };
  const token = config.secrets.githubAuthorToken;
  if (!token) return { ok: false, status: 409, error: NO_AUTHOR };
  const entry = await readRepo(store, config, zone.repo, forgeOf, opts.now ?? systemNow);
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
    ),
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
  const entry = await readRepo(store, config, repo, forgeOf, now);
  if (!entry.ok) return { ok: false, status: 502, error: entry.error };
  const { read, ownerType } = entry;
  const visibility = read?.visibility ?? 'private';
  const [owner = '', name = ''] = repo.split('/');
  const recommendation = recommendIdentity({
    ownerType,
    visibility,
    owner,
    ...(paidPlan === undefined ? {} : { paidPlan }),
  });
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
