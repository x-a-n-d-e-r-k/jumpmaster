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
import { detectFailure, detectGuidance, NO_AUTHOR, REPO, zoneIdOf } from '../zones/detect.js';

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

export type GuidanceResult =
  | { ok: true; guidance: ZoneGuidance }
  | { ok: false; status: 409 | 502; error: string };

/** The five for `zone`, read through the author token. */
export async function guidanceFor(
  store: ConfigStore,
  config: Config,
  zone: DropZoneConfig,
  forgeOf: (repo: string, token: string) => GuidanceForge,
  opts: { reviewers?: string[]; paidPlan?: boolean } = {},
): Promise<GuidanceResult> {
  const token = config.secrets.githubAuthorToken;
  if (!token) return { ok: false, status: 409, error: NO_AUTHOR };
  let detection: Awaited<ReturnType<typeof detectGuidance>>;
  try {
    detection = await detectGuidance(forgeOf(zone.repo, token), zone.repo);
  } catch (e) {
    return { ok: false, status: 502, error: detectFailure(e, zone.repo) };
  }
  const logins = await loginsOf(store, config, zone.repo, forgeOf);
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

const GuideQuery = z.strictObject({
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
): Promise<
  { ok: true; answer: RecommendAnswer } | { ok: false; status: 400 | 502; error: string }
> {
  const { repo, paidPlan, identity, reviewers } = input;
  if (!REPO.test(repo))
    return { ok: false, status: 400, error: 'the repository must be owner/name' };
  const token = config.secrets.githubAuthorToken ?? '';
  const forge = forgeOf(repo, token);
  let read: Awaited<ReturnType<typeof detectGuidance>> | null = null;
  let ownerType: 'User' | 'Organization';
  try {
    read = await detectGuidance(forge, repo);
    ownerType = read.ownerType;
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    // Without a token GitHub answers 404 for a private repository: the owner is still public.
    if (token !== '' || status !== 404)
      return { ok: false, status: 502, error: detectFailure(e, repo) };
    try {
      ownerType = await forge.ownerType();
    } catch (e2) {
      return { ok: false, status: 502, error: detectFailure(e2, repo) };
    }
  }
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
  const logins = await loginsOf(store, config, repo, forgeOf);
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
  deps: { store: ConfigStore; guidanceForge?: (repo: string, token: string) => GuidanceForge },
): void {
  const { store } = deps;
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
    const r = await recommendFor(store, req.jmConfig ?? store.current(), body.data, forgeOf);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.answer;
  });
}
