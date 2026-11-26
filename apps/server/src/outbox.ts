import { createHash, randomUUID } from 'node:crypto';
import { redactTokenShapes } from '@jumpmaster/protocol';
import type { Db } from './db/open.js';
import {
  claimOutboxResend,
  countOutboxCleanRead,
  getOutbox,
  insertOutbox,
  isKilled,
  listOutbox,
  listResentIssueFilings,
  type OutboxRow,
  type OutboxState,
  resetDoneOutbox,
  resetOutboxCleanReads,
  setOutboxResult,
  updateOutbox,
} from './db/repo.js';
import type { AppTokenSource } from './forge/app-tokens.js';
import {
  type AppForgeIdentity,
  type BranchUpdate,
  type Forge,
  type ForgeError,
  GitHubForge,
  isRateLimited,
  type PullFacts,
  type TokenProvider,
} from './forge/github.js';
import { GitLabForge } from './forge/gitlab.js';
import { gitlabCaDigest, gitlabFetchFor } from './forge/gitlab-ca.js';
import { type ForgeKind, forgeKind, GITLAB_UNSUPPORTED } from './forge/kind.js';
import { log } from './log.js';
import { credentialFingerprint, type Resolved } from './vault/credentials.js';
import type { AppRole, CredentialRef } from './vault/github-app-entries.js';
import {
  appInstallationFor,
  credentialFor,
  type ResolvedApps,
  type ResolvedGitlabPats,
  type ZoneForAppInstallation,
} from './vault/resolution.js';

/**
 * One zone's forge identities: `author` creates PRs and merges, `reviewer` only posts reviews.
 * `reviewer` is null in starter mode: nothing is posted, and every reader uses the author alone.
 */
export type ForgePair = {
  author: Forge;
  reviewer: Forge | null;
  /** Performs merges instead of the author, when the author's account is a repository admin. */
  merger?: Forge;
  /**
   * The zone's push grant as a forge, for the server's one write to an agent branch (a branch
   * update): the author token in PAT mode, and in app mode a `contents: write` token narrowed to
   * the repository and minted for this write alone, as for a push container. Never a wider token:
   * absent, or when the mint fails, the branch update falls back to a resolve drop.
   */
  pusher?: () => Promise<PushForge>;
};

/**
 * The app-mode push token a pair's `pusher` mints from (`PairOptions.pushToken`): the author app's
 * `push` use (`contents: write`, narrowed to the zone's repository), minted fresh for each write,
 * exactly as the push containers' grant is, and revoked after it.
 */
export const appPushToken =
  (source: Pick<AppTokenSource, 'fresh'>, zoneId: string) => (): Promise<PushToken> =>
    source.fresh(zoneId, 'author', 'push');

/** A forge on the push grant, and how to give its token up once the write is done. */
export type PushForge = { forge: Forge; release(): Promise<void> };

/** A token minted for one write (`AppTokenSource.fresh(zone, 'author', 'push')`). */
export type PushToken = { token: string; revoke(): Promise<void> };

/** Each role's resolved credential (spec §4.4): its owner's app, or an install-wide PAT. */
export type PairRefs = { author: CredentialRef; reviewer: CredentialRef };

/**
 * How a pair is built beyond its zone and tokens. `refs` absent, or naming tokens only, builds the
 * same pair as before. An app ref builds that role's forge on `appTokens(owner, role)`, acting as
 * the app `appIdentity(owner, role)` names (spec §4.3).
 */
export type PairOptions = {
  requestTimeoutMs?: number;
  refs?: PairRefs;
  appTokens?: (owner: string, role: AppRole) => TokenProvider;
  appIdentity?: (owner: string, role: AppRole) => { slug: string; appId: string };
  /**
   * The installation grant an app forge's `repoAccess()` reads (spec §4.3; `AppTokenSource.grant`
   * for the zone and role). Absent, an app forge's `repoAccess()` rejects rather than guess.
   */
  appGrant?: (owner: string, role: AppRole) => NonNullable<AppForgeIdentity['grant']>;
  /**
   * In app mode, the author app's push token for this zone (`AppTokenSource.fresh(zone.id,
   * 'author', 'push')`), minted per branch update. Absent, an app author zone has no `pusher`.
   */
  pushToken?: () => Promise<PushToken>;
  /**
   * The zone's author credential resolves to an app (`credentialFor(zone, 'author', apps)`), even
   * when `refs` are absent and its forges still run on the PAT. Its push grant is then the app's
   * narrowed `push` token: the pusher mints from `pushToken`, or there is none. Never the PAT.
   */
  authorUsesApp?: boolean;
  /**
   * The credentials as they resolved (`ConfigStore.resolved()` and `resolvedApps()`), for the pair
   * cache's key. `ForgePairs.for` requires them when a role uses an app, so a replaced app entry
   * gets a new pair (issue #266); token refs never read them.
   */
  credentials?: { resolved: Resolved; apps: ResolvedApps };
  /**
   * A GitLab zone's tokens (its `gitlab-pat` entries, issue #718): the author's, and in two-bot
   * mode the reviewer's. Absent, a GitLab zone is refused with GITLAB_UNSUPPORTED. Ignored for a
   * GitHub zone, as the GitHub options are for a GitLab zone.
   */
  gitlabTokens?: GitLabTokens;
};

/** A GitLab zone's tokens, by role. */
export type GitLabTokens = { author: string; reviewer?: string };

/** Said when a GitLab zone has tokens but no instance. Never the project path. */
export const GITLAB_NO_BASE_URL = 'a GitLab zone needs gitlab.baseUrl';
/** Said when a two-bot GitLab zone has no reviewer token. Never a token, URL or project path. */
export const GITLAB_NO_REVIEWER = 'a GitLab reviewer token is required for a two-bot zone';

/** The PAT the push containers are granted: the author forge itself. */
const patPusher = (forge: Forge) => async (): Promise<PushForge> => ({
  forge,
  release: async () => {},
});

/**
 * A GitLab zone's pair, from the tokens passed in (issue #718). App refs and app options are
 * GitHub's: none is read or called. As in the PAT path, an admin author's merges go to the
 * reviewer, and the pusher is the author forge.
 */
function gitlabPair(
  zone: { repo: string; authorMayBeAdmin: boolean; identity?: 'two-bot' | 'starter' },
  gitlab: { baseUrl: string; caCert?: string | undefined } | undefined,
  tokens: GitLabTokens,
  requestTimeoutMs: number | undefined,
): ForgePair {
  const baseUrl = gitlab?.baseUrl;
  if (!baseUrl) throw new Error(GITLAB_NO_BASE_URL);
  // Both forges trust the zone's private CA, if it has one, besides the system roots (issue #919).
  const forgeOpts = {
    fetch: gitlabFetchFor(gitlab?.caCert),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
  if (zone.identity !== 'starter' && !tokens.reviewer) throw new Error(GITLAB_NO_REVIEWER);
  const author = new GitLabForge(baseUrl, zone.repo, tokens.author, forgeOpts);
  const pusher = patPusher(author);
  if (zone.identity === 'starter' || !tokens.reviewer) return { author, reviewer: null, pusher };
  const reviewer = new GitLabForge(baseUrl, zone.repo, tokens.reviewer, forgeOpts);
  return zone.authorMayBeAdmin
    ? { author, reviewer, merger: reviewer, pusher }
    : { author, reviewer, pusher };
}

/**
 * The forges for a zone. An admin author must not be the identity that merges, but an app author
 * never gets a merger: apps are offered only in two-bot mode, so `authorMayBeAdmin` there is a
 * stale flag, and the reviewer it would route merges to may be unable to merge (spec §4.4).
 */
export function pairFor(
  zone: {
    repo: string;
    authorMayBeAdmin: boolean;
    identity?: 'two-bot' | 'starter';
    forge?: ForgeKind | undefined;
    gitlab?: { baseUrl: string; caCert?: string | undefined } | undefined;
  },
  secrets: { githubAuthorToken: string; githubReviewerToken?: string },
  opts: PairOptions = {},
): ForgePair {
  // Issue #667: a GitLab zone never gets a GitHub forge, so nothing is sent to GitHub on its
  // behalf; without its GitLab tokens (issue #718) it gets no forge at all. The messages are
  // fixed: never a token, the base URL or the project path.
  if (forgeKind(zone) === 'gitlab') {
    if (!opts.gitlabTokens) throw new Error(GITLAB_UNSUPPORTED);
    return gitlabPair(zone, zone.gitlab, opts.gitlabTokens, opts.requestTimeoutMs);
  }
  const [owner = '', name = ''] = zone.repo.split('/');
  const forgeOpts =
    opts.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: opts.requestTimeoutMs };
  // Starter has no second identity, so the author merges (an admin author included: see
  // authorMayBeAdmin, and the per-pass Administration probe that guards it). It always uses the
  // author token, whatever the refs say.
  if (zone.identity === 'starter') {
    const author = new GitHubForge(owner, name, secrets.githubAuthorToken, forgeOpts);
    return { author, reviewer: null, pusher: patPusher(author) };
  }
  const appRef = (role: AppRole) => {
    const ref = opts.refs?.[role];
    return ref?.kind === 'github-app' ? ref : undefined;
  };
  const appForge = (role: AppRole, ref: { owner: string }): Forge => {
    const where = redactTokenShapes(zone.repo);
    if (!opts.appTokens)
      throw new Error(
        `the ${role} of ${where} uses a GitHub App, but no app token provider was given`,
      );
    let provider: TokenProvider;
    try {
      provider = opts.appTokens(ref.owner, role);
    } catch {
      // The factory's error may quote a key or a token: drop it, and keep no `cause`.
      throw new Error(`could not get a GitHub App token provider for the ${role} of ${where}`);
    }
    // Without its identity an app forge would ask GET /user for its login, which an installation
    // is refused: a missing or failing identity stops the pair here instead.
    const noIdentity = `could not get the GitHub App identity for the ${role} of ${where}`;
    if (!opts.appIdentity) throw new Error(noIdentity);
    let identity: AppForgeIdentity;
    try {
      const { slug, appId } = opts.appIdentity(ref.owner, role);
      identity = { kind: 'app', slug, appId };
    } catch {
      // The lookup's error may quote a key or a token: drop it, and keep no `cause`.
      throw new Error(noIdentity);
    }
    if (opts.appGrant) {
      try {
        identity.grant = opts.appGrant(ref.owner, role);
      } catch {
        // The factory's error may quote a key or a token: drop it, and keep no `cause`.
        throw new Error(
          `could not get the GitHub App installation grant for the ${role} of ${where}`,
        );
      }
    }
    return new GitHubForge(owner, name, provider, { ...forgeOpts, identity });
  };
  const authorApp = appRef('author');
  const reviewerApp = appRef('reviewer');
  const author = authorApp
    ? appForge('author', authorApp)
    : new GitHubForge(owner, name, secrets.githubAuthorToken, forgeOpts);
  let pusher: ForgePair['pusher'];
  if (!authorApp && !opts.authorUsesApp) pusher = patPusher(author);
  else if (opts.pushToken) {
    const mint = opts.pushToken;
    const identity = author instanceof GitHubForge ? author.appIdentity() : null;
    pusher = async () => {
      let minted: PushToken;
      try {
        minted = await mint();
      } catch {
        // The source's error may quote a key or a token: drop it, and keep no `cause`.
        throw new Error(`could not mint a push token for ${redactTokenShapes(zone.repo)}`);
      }
      return {
        forge: new GitHubForge(owner, name, minted.token, {
          ...forgeOpts,
          ...(identity ? { identity: { kind: 'app', ...identity } } : {}),
        }),
        release: () => minted.revoke(),
      };
    };
  }
  let reviewer: Forge;
  if (reviewerApp) reviewer = appForge('reviewer', reviewerApp);
  else if (!secrets.githubReviewerToken)
    throw new Error('JM_GITHUB_REVIEWER_TOKEN is required for a two-bot zone');
  else reviewer = new GitHubForge(owner, name, secrets.githubReviewerToken, forgeOpts);
  const withPusher = pusher ? { pusher } : {};
  return zone.authorMayBeAdmin && !authorApp
    ? { author, reviewer, merger: reviewer, ...withPusher }
    : { author, reviewer, ...withPusher };
}

type PairTokens = {
  githubAuthorToken: string;
  githubReviewerToken?: string;
  githubReadToken?: string;
};

/**
 * A short SHA-256 over the forge tokens, for caching what was built from them. Never shown: it
 * names no token, and a 64-bit prefix of a hash over high-entropy tokens reveals nothing.
 */
export function forgeTokenFingerprint(secrets: PairTokens): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        secrets.githubAuthorToken,
        secrets.githubReviewerToken ?? null,
        secrets.githubReadToken ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

type PairZone = Parameters<typeof pairFor>[0] & { id: string } & Pick<
    ZoneForAppInstallation,
    'githubApp'
  >;

type KeyPart = string | number | null;

/**
 * What the refs add to a pair's cache key. Token refs (or none) add nothing, so their key is the
 * one before apps (PR 146); a starter zone ignores refs, so they add nothing there either. With an
 * app role it adds each role's owner; the credential fingerprint over every PAT and app entry
 * (`credentialFingerprint`), so a replaced or swapped app entry gets a new pair; and each app
 * role's recorded installation id and the zone's repository id (issue #266).
 */
function refsKey(zone: PairZone, opts: PairOptions): KeyPart[][] {
  const refs = opts.refs;
  if (zone.identity === 'starter') return [];
  // An app author's push grant differs from the PAT pair's, so it keys a pair of its own.
  const push: KeyPart[][] = opts.authorUsesApp ? [['push:app']] : [];
  if (!refs) return push;
  const owners = [refs.author, refs.reviewer].map((r) =>
    r.kind === 'github-app' ? r.owner : null,
  );
  if (owners.every((o) => o === null)) return push;
  if (!opts.credentials)
    throw new Error(
      `the pair of ${redactTokenShapes(zone.repo)} uses a GitHub App, but no resolved credentials were given for its key`,
    );
  const { resolved, apps } = opts.credentials;
  const ids = (['author', 'reviewer'] as const).map((role) => {
    if (refs[role].kind !== 'github-app') return null;
    const at = appInstallationFor(zone, role);
    return at ? `${at.installationId}@${at.repositoryId}` : null;
  });
  return [owners, [credentialFingerprint(resolved, apps)], ids, ...push];
}

/**
 * The push-grant options (issue #292, D1 and D5): a zone whose author resolves to an app pushes,
 * and updates its branch, only with that app's `push` token minted from `source`; any other zone
 * with the author PAT, as its push containers do. Part of `pairOptionsFor`.
 */
export function pushOptionsFor(
  zone: Parameters<typeof credentialFor>[0] & { id: string },
  apps: ResolvedApps,
  source: Pick<AppTokenSource, 'fresh'>,
): PairOptions {
  if (credentialFor(zone, 'author', apps).ref.kind !== 'github-app') return {};
  return { authorUsesApp: true, pushToken: appPushToken(source, zone.id) };
}

/** The use the server's own forge for each role acts with (§4.2's table). */
const SERVER_USE = { author: 'server-author', reviewer: 'server-reviewer' } as const;

/**
 * The options the live server builds every pair with (spec §4.3, §4.4): in a two-bot zone where
 * either role resolves to an app, each role's ref, the server-use token providers, each app's
 * identity and installation grant from `source`, and the credentials for the pair cache's key,
 * besides the push options. Any other zone (PAT roles, or starter) gets the push options alone,
 * so its pair key is the one before apps. An app role whose entry is missing or undecryptable
 * keeps the app (§4.4): its identity throws, so the pair is refused rather than built on the PAT.
 * A GitLab zone gets its `gitlab-pat` tokens from `gitlabPats` (`ConfigStore.resolvedGitlabPats()`)
 * and nothing else (issue #764).
 */
export function pairOptionsFor(
  zone: Parameters<typeof credentialFor>[0] & { id: string; forge?: ForgeKind | undefined },
  credentials: { resolved: Resolved; apps: ResolvedApps },
  source: Pick<AppTokenSource, 'fresh' | 'provider' | 'grant'>,
  gitlabPats: ResolvedGitlabPats = new Map(),
): PairOptions {
  if (forgeKind(zone) === 'gitlab') return gitlabOptionsFor(zone, gitlabPats);
  const { apps } = credentials;
  const push = pushOptionsFor(zone, apps, source);
  const refs: PairRefs = {
    author: credentialFor(zone, 'author', apps).ref,
    reviewer: credentialFor(zone, 'reviewer', apps).ref,
  };
  if (refs.author.kind !== 'github-app' && refs.reviewer.kind !== 'github-app') return push;
  return {
    ...push,
    refs,
    credentials,
    appTokens: (_owner, role) => source.provider(zone.id, role, SERVER_USE[role]),
    appIdentity: (owner, role) => {
      const read = apps.get(owner)?.[role];
      if (!read || read.source === 'missing')
        throw new Error(
          `no readable GitHub App entry for the ${role} of ${redactTokenShapes(zone.repo)}`,
        );
      return { slug: read.entry.slug, appId: read.entry.appId };
    },
    appGrant: (_owner, role) => source.grant(zone.id, role),
  };
}

/**
 * A GitLab zone's options (issue #764): its `gitlab-pat` tokens, the reviewer's only when it
 * resolved. With no author token there are none, so `pairFor` refuses the zone with
 * GITLAB_UNSUPPORTED rather than building it on a GitHub token. App options never apply.
 */
function gitlabOptionsFor(zone: { id: string }, gitlabPats: ResolvedGitlabPats): PairOptions {
  const pats = gitlabPats.get(zone.id);
  if (!pats?.author) return {};
  return {
    gitlabTokens: { author: pats.author, ...(pats.reviewer ? { reviewer: pats.reviewer } : {}) },
  };
}

/**
 * The pair cache's key for a zone, its tokens and options (without the timeout, which picks the
 * slot). Exported so the PAT-mode key can be pinned (PR 146's guarantee).
 */
export function pairKey(zone: PairZone, secrets: PairTokens, opts: PairOptions = {}): string {
  if (forgeKind(zone) === 'gitlab') return gitlabPairKey(zone, secrets, opts);
  return JSON.stringify([
    zone.repo,
    zone.identity ?? 'two-bot',
    zone.authorMayBeAdmin,
    forgeTokenFingerprint(secrets),
    ...refsKey(zone, opts),
  ]);
}

/**
 * A GitLab zone's key (issue #718): a GitHub zone's head, then a marker no GitHub key has, the
 * zone's instance and a fingerprint over its GitLab tokens, so a rotated token or a zone moved to
 * another instance gets a new pair. A zone with `gitlab.caCert` adds a digest of it, so adding,
 * changing or removing the CA does too. App refs are ignored, as `pairFor` ignores them.
 */
function gitlabPairKey(zone: PairZone, secrets: PairTokens, opts: PairOptions): string {
  const tokens = opts.gitlabTokens;
  const fingerprint = tokens
    ? createHash('sha256')
        .update(JSON.stringify([tokens.author, tokens.reviewer ?? null]))
        .digest('hex')
        .slice(0, 16)
    : null;
  // A digest of the zone's CA bundle, never its PEM (issue #919); a zone without one keeps its key.
  const ca = gitlabCaDigest(zone.gitlab?.caCert);
  const caKey = ca === null ? [] : [`ca:${ca}`];
  return JSON.stringify([
    zone.repo,
    zone.identity ?? 'two-bot',
    zone.authorMayBeAdmin,
    forgeTokenFingerprint(secrets),
    ['forge:gitlab', zone.gitlab?.baseUrl ?? null, fingerprint, ...caKey],
  ]);
}

/**
 * The forge pairs, built on first use and rebuilt only when what they were built from changes:
 * the zone's repository, identity and admin setting, the forge tokens' fingerprint, and each
 * role's credential kind (and, for an app, its owner, the app entries' fingerprint and the
 * recorded installation and repository ids: issue #266). A config revision that leaves those alone keeps the
 * pair (and its connections); a rotated token, or a role switched between token and app, gets a
 * new one at the next pass. Only the latest pair per zone (timed or not) is kept.
 */
export class ForgePairs {
  private readonly cache = new Map<string, { key: string; pair: ForgePair }>();

  for(zone: PairZone, secrets: PairTokens, opts: PairOptions = {}): ForgePair {
    const slot = `${zone.id}\n${opts.requestTimeoutMs ?? ''}`;
    const key = pairKey(zone, secrets, opts);
    const hit = this.cache.get(slot);
    if (hit && hit.key === key) return hit.pair;
    const pair = pairFor(zone, secrets, opts);
    this.cache.set(slot, { key, pair });
    return pair;
  }

  /** Drops the pairs of zones not in `zoneIds` (removed from the config; drained first, T3). */
  retain(zoneIds: readonly string[]): void {
    const keep = new Set(zoneIds);
    for (const slot of this.cache.keys())
      if (!keep.has(slot.slice(0, slot.indexOf('\n')))) this.cache.delete(slot);
  }

  size(): number {
    return this.cache.size;
  }
}

export type OpKind = OutboxRow['kind'];
export type OpResult = { state: OutboxState; result?: unknown; error?: string };

export type CreatePrPayload = {
  head: string;
  base: string;
  title: string;
  body: string;
  /** Open PRs on this head to accept without the server's marker. */
  adoptPulls?: number[];
  /**
   * Logins besides the author's whose listed PR on this head is ours (spec §4.3): the zone's
   * `authorLoginAliases`, set only when it has some. Ops queued before it have none.
   */
  authorLoginAliases?: string[];
};
export type PostReviewPayload = {
  pr: number;
  event: 'APPROVE' | 'REQUEST_CHANGES';
  body: string;
  commitId: string;
};
/** The labels a zone's config names, to create where missing (the doctor's label action). */
export type CreateLabelsPayload = {
  labels: { name: string; color: string; description: string }[];
};
export type MergePayload = { pr: number; sha: string; title: string; message: string };
/** GitHub merging the base into PR `pr`, only while its head is `headSha` (`baseSha` is the key's). */
export type UpdateBranchPayload = { pr: number; headSha: string; baseSha: string };
/**
 * A branch update's result: the forge's answer, or `no_token` when the push grant gave no token
 * (no request was sent, and no wider token is ever tried).
 */
export type UpdateBranchResult = BranchUpdate | { kind: 'no_token' };
/** `since`: the crew intent's creation time; the marker search looks at issues updated after it. */
export type CreateIssuePayload = { title: string; body: string; labels: string[]; since: string };
/**
 * A body update (the op marker is appended) or, with `state`, a close or a reopen (a chat Undo):
 * a state change alone carries no text.
 */
export type UpdateIssuePayload = {
  number: number;
  title?: string;
  body?: string;
  state?: 'closed' | 'open';
  /** With `state: 'closed'`: why it closed (GitHub's `state_reason`). */
  stateReason?: 'completed';
};
/** A "blocked by" link: `issue` blocked by `blocker`, both in `repo` (the zone's repository). */
export type AddBlockedByPayload = { issue: number; blocker: number; repo: string };
export type SetLabelsPayload = { number: number; add: string[]; remove: string[] };
/** A comment on an issue, found again by `marker` (from `commentMarker`), which ends the body. */
export type CommentIssuePayload = { number: number; body: string; marker: string };

/** The longest comment body accepted at enqueue (GitHub refuses past 65536, marker included). */
export const COMMENT_BODY_MAX = 60_000;

const COMMENT_KEY = /^[a-z0-9:-]{1,80}$/;
const COMMENT_MARKER = /^<!-- jm:comment:[^\s<>]+:[a-z0-9:-]{1,80} -->$/;

/**
 * The marker ending a Jumpmaster comment: `<!-- jm:comment:<zoneId>:<key> -->`. `key` is
 * `[a-z0-9:-]{1,80}`; anything else throws, as does a zone id that could break the comment.
 */
export function commentMarker(zoneId: string, key: string): string {
  if (!COMMENT_KEY.test(key)) throw new Error('comment marker key must match [a-z0-9:-]{1,80}');
  if (!/^[^\s<>]+$/.test(zoneId)) throw new Error('comment marker zone id is not usable');
  return `<!-- jm:comment:${zoneId}:${key} -->`;
}

/** Refuses a comment op before anything is recorded or sent: no row, no forge call. */
function checkCommentPayload(p: CommentIssuePayload): void {
  if (!COMMENT_MARKER.test(p.marker)) throw new Error('comment_issue refused: bad marker');
  if (p.body.length > COMMENT_BODY_MAX)
    throw new Error(
      `comment_issue refused: body is ${p.body.length} characters (at most ${COMMENT_BODY_MAX})`,
    );
}

/** `itemId` is null for a zone-level op; `zoneId` decides the mode check and the outbox row. */
export type Op = {
  kind: OpKind;
  opKey: string;
  zoneId: string;
  itemId: number | null;
  payload: unknown;
};

export const opKeys = {
  pr: (itemId: number, headSha: string) => `pr:${itemId}:${headSha}`,
  review: (itemId: number, headSha: string, dropId: string) =>
    `review:${itemId}:${headSha}:${dropId}`,
  merge: (itemId: number, headSha: string) => `merge:${itemId}:${headSha}`,
  /** A goal change's merge (#363): never an item's key, whose id is a bare number. */
  goalMerge: (changeId: number, sha: string) => `merge:goal-${changeId}:${sha}`,
  /** The reviewer's approval of a goal change at the SHA the owner confirmed. */
  goalReview: (changeId: number, sha: string) => `review:goal-${changeId}:${sha}`,
  updateBranch: (itemId: number, headSha: string, baseSha: string) =>
    `update_branch:${itemId}:${headSha}:${baseSha}`,
  issue: (zoneId: string, objective: string, outputKey: string) =>
    `issue:${zoneId}:${objective}:${outputKey}`,
  update: (crewIssueId: number, sha12: string) => `update:${crewIssueId}:${sha12}`,
  close: (crewIssueId: number) => `close:${crewIssueId}`,
  promote: (crewIssueId: number) => `labels:${crewIssueId}:promote`,
};

/** How far back the last marker search before failing a create looks, for forge clock skew. */
const WIDE_SEARCH_MS = 24 * 60 * 60_000;

/** The final line of every body Jumpmaster writes to a forge. */
export const opMarker = (opKey: string): string => `<!-- jm:op:${opKey} -->`;

/** Whether a PR body ends with the marker the server writes when it opens this item's PR. */
export const isServerPrBody = (body: string, itemId: number): boolean => {
  const last = body.trimEnd().split('\n').pop() ?? '';
  return last.startsWith(`<!-- jm:op:pr:${itemId}:`) && last.endsWith(' -->');
};

const lastLine = (body: string): string => body.trimEnd().split('\n').pop() ?? '';

/**
 * Whether an issue body ends with a marker Jumpmaster writes on issues it files (`issue:`) or
 * rewrites (`update:`). Such an issue is crew-filed whatever its author.
 */
export const isJmIssueBody = (body: string): boolean => {
  const last = lastLine(body).trim();
  return (
    (last.startsWith('<!-- jm:op:issue:') || last.startsWith('<!-- jm:op:update:')) &&
    last.endsWith(' -->')
  );
};

/** The body without its final Jumpmaster marker line, as `body_sha` is computed. */
export const bodyWithoutMarker = (body: string): string => {
  const lines = body.trimEnd().split('\n');
  const last = lines.at(-1)?.trim() ?? '';
  if (last.startsWith('<!-- jm:op:') && last.endsWith(' -->')) lines.pop();
  return lines.join('\n').trimEnd();
};

const withMarker = (body: string, opKey: string): string =>
  `${body.trimEnd()}\n\n${opMarker(opKey)}`;

const isOwnPr = (body: string, opKey: string): boolean =>
  isServerPrBody(body, Number(opKey.split(':')[1]));

/** Marked by the server, or listed by the operator and written by the author or an alias. */
async function ours(
  forges: ForgePair,
  pr: PullFacts,
  opKey: string,
  p: CreatePrPayload,
): Promise<boolean> {
  if (isOwnPr(pr.body, opKey)) return true;
  if (!(p.adoptPulls ?? []).includes(pr.number)) return false;
  const logins = [await forges.author.viewerLogin(), ...(p.authorLoginAliases ?? [])];
  const author = pr.author.toLowerCase();
  return logins.some((l) => l.toLowerCase() === author);
}

/** Read-back: the op's result if its effect is visible on the forge, else `null`. */
async function lookup(forges: ForgePair, kind: OpKind, opKey: string, payload: unknown) {
  switch (kind) {
    case 'create_pr': {
      const p = payload as CreatePrPayload;
      const pr = await forges.author.findOpenPullByHead(p.head);
      return pr && (await ours(forges, pr, opKey, p))
        ? { number: pr.number, created: false }
        : null;
    }
    case 'post_review': {
      const p = payload as PostReviewPayload;
      if (!forges.reviewer) throw new Error('no reviewer identity (starter mode) to post a review');
      return forges.reviewer.findReviewByMarker(p.pr, opMarker(opKey));
    }
    case 'merge': {
      const p = payload as MergePayload;
      const pr = await forges.author.getPull(p.pr);
      return pr?.merged ? { merged: true } : null;
    }
    case 'update_branch': {
      // A head that moved off `headSha` is the update's effect (GitHub answers 202 before the
      // merge lands) only when it holds both the old head and the base, as the forge's merge
      // does. Any other move (an agent push) is `head_moved`: no update made, nothing charged.
      // Either way sending again would only be refused as head_moved.
      const p = payload as UpdateBranchPayload;
      const pr = await forges.author.getPull(p.pr);
      if (pr === null || pr.headSha === null || pr.headSha === p.headSha) return null;
      const [fromHead, fromBase] = await Promise.all([
        forges.author.compare(p.headSha, pr.headSha),
        forges.author.compare(p.baseSha, pr.headSha),
      ]);
      const merged = fromHead.behindBy === 0 && fromBase.behindBy === 0;
      return { kind: merged ? 'updated' : 'head_moved' } satisfies UpdateBranchResult;
    }
    case 'create_issue': {
      const p = payload as CreateIssuePayload;
      return forges.author.findIssueByMarker(opMarker(opKey), p.since);
    }
    case 'update_issue': {
      const p = payload as UpdateIssuePayload;
      const issue = await forges.author.getIssue(p.number);
      if (!issue) return null;
      if (p.state) return issue.state === p.state ? { number: p.number } : null;
      return lastLine(issue.body) === opMarker(opKey) ? { number: p.number } : null;
    }
    case 'create_labels': {
      // Read-back: done when every label exists (by name, as GitHub compares them).
      const p = payload as CreateLabelsPayload;
      const have = new Set((await forges.author.listLabels()).map((l) => l.toLowerCase()));
      return p.labels.every((l) => have.has(l.name.toLowerCase())) ? { created: [] } : null;
    }
    case 'set_labels': {
      const p = payload as SetLabelsPayload;
      const issue = await forges.author.getIssue(p.number);
      if (!issue) return null;
      const has = new Set(issue.labels);
      const matches = p.add.every((l) => has.has(l)) && !p.remove.some((l) => has.has(l));
      return matches ? { number: p.number } : null;
    }
    case 'comment_issue': {
      const p = payload as CommentIssuePayload;
      return forges.author.findIssueCommentByMarker(p.number, p.marker);
    }
    case 'add_blocked_by': {
      const p = payload as AddBlockedByPayload;
      const { blockers } = await forges.author.listBlockedBy(p.issue);
      const linked = blockers.some(
        (b) => b.number === p.blocker && b.repo.toLowerCase() === p.repo.toLowerCase(),
      );
      return linked ? { issue: p.issue, blocker: p.blocker } : null;
    }
  }
}

/**
 * The last look before a `create_issue` row is failed, and before one is sent again: a day wider
 * than the normal search. A failed search throws here.
 */
async function searchWide(
  forges: ForgePair,
  row: Pick<OutboxRow, 'kind' | 'opKey' | 'payloadJson'>,
): Promise<{ number: number } | null> {
  if (row.kind !== 'create_issue') return null;
  const p = JSON.parse(row.payloadJson) as CreateIssuePayload;
  const since = new Date(Date.parse(p.since) - WIDE_SEARCH_MS).toISOString();
  return forges.author.findIssueByMarker(opMarker(row.opKey), since);
}

/** `searchWide`, with a failed search read as nothing found. */
async function wideIssueSearch(
  forges: ForgePair,
  row: Pick<OutboxRow, 'kind' | 'opKey' | 'payloadJson'>,
): Promise<{ number: number } | null> {
  try {
    return await searchWide(forges, row);
  } catch {
    return null;
  }
}

/** The forge write. Returns `null` when the forge answered but did not perform the effect. */
async function write(forges: ForgePair, kind: OpKind, opKey: string, payload: unknown) {
  switch (kind) {
    case 'create_pr': {
      const p = payload as CreatePrPayload;
      // Never take over a PR someone opened by hand on the agent branch: it would get merged.
      const open = await forges.author.findOpenPullByHead(p.head);
      if (open && !(await ours(forges, open, opKey, p))) {
        // A 4xx status makes this a failed op, so the item parks with a reason instead of waiting.
        throw Object.assign(new Error(`hand-opened PR on agent branch: #${open.number}`), {
          status: 409,
        });
      }
      const { adoptPulls: _listed, authorLoginAliases: _aliases, ...input } = p;
      return forges.author.findOrCreatePullRequest({ ...input, body: withMarker(p.body, opKey) });
    }
    case 'post_review': {
      const p = payload as PostReviewPayload;
      if (!forges.reviewer) throw new Error('no reviewer identity (starter mode) to post a review');
      return forges.reviewer.createReview(p.pr, {
        event: p.event,
        commitId: p.commitId,
        body: withMarker(p.body, opKey),
      });
    }
    case 'merge': {
      const p = payload as MergePayload;
      const r = await (forges.merger ?? forges.author).merge(p.pr, {
        sha: p.sha,
        method: 'squash',
        title: p.title,
        message: p.message,
      });
      return r.merged ? r : null;
    }
    case 'update_branch': {
      const p = payload as UpdateBranchPayload;
      const noToken: UpdateBranchResult = { kind: 'no_token' };
      if (!forges.pusher) return noToken;
      let held: PushForge;
      try {
        held = await forges.pusher();
      } catch {
        return noToken; // refused, never widened to another token
      }
      try {
        return (await held.forge.updateBranch(p.pr, p.headSha)) satisfies UpdateBranchResult;
      } finally {
        await held.release().catch(() => {});
      }
    }
    case 'create_issue': {
      const p = payload as CreateIssuePayload;
      const r = await forges.author.createIssue({
        title: p.title,
        body: withMarker(p.body, opKey),
        labels: p.labels,
      });
      return { number: r.number, created: true };
    }
    case 'update_issue': {
      const p = payload as UpdateIssuePayload;
      await forges.author.updateIssue(p.number, {
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.body !== undefined ? { body: withMarker(p.body, opKey) } : {}),
        ...(p.state ? { state: p.state } : {}),
        ...(p.stateReason ? { stateReason: p.stateReason } : {}),
      });
      return { number: p.number };
    }
    case 'set_labels': {
      const p = payload as SetLabelsPayload;
      await forges.author.setLabels(p.number, { add: p.add, remove: p.remove });
      return { number: p.number };
    }
    case 'create_labels': {
      // GET, then create only what is missing, as the author bot: idempotent by name.
      const p = payload as CreateLabelsPayload;
      const have = new Set((await forges.author.listLabels()).map((l) => l.toLowerCase()));
      const created: string[] = [];
      for (const l of p.labels) {
        if (have.has(l.name.toLowerCase())) continue;
        const r = await forges.author.createLabel(l.name, l.color, l.description);
        if (r.created) created.push(l.name);
      }
      return { created };
    }
    case 'comment_issue': {
      const p = payload as CommentIssuePayload;
      return forges.author.createIssueComment(p.number, `${p.body}\n\n${p.marker}`);
    }
    case 'add_blocked_by': {
      const p = payload as AddBlockedByPayload;
      await forges.author.addBlockedBy(p.issue, p.blocker);
      return { issue: p.issue, blocker: p.blocker };
    }
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function markDone(db: Db, opKey: string, result: unknown, now: Date): OpResult {
  db.transaction(() => {
    updateOutbox(db, opKey, { state: 'done', resultJson: JSON.stringify(result) }, now);
    recordFiledNumber(db, opKey, result, now);
  })();
  return { state: 'done', result };
}

/**
 * A crew issue's create resolved: its row learns the issue number now, wherever the op resolved
 * (written, read back, or found by `resolveUnknown`), so intake knows the issue as crew even while
 * the flush that moves the row on is not running (zone paused, crew disabled, a crash between).
 */
export function recordFiledNumber(db: Db, opKey: string, result: unknown, now: Date): void {
  if (!opKey.startsWith('issue:')) return;
  const number = (result as { number?: unknown } | undefined)?.number;
  if (typeof number !== 'number') return;
  db.prepare(
    `UPDATE crew_issues SET number = ?, updated_at = ?
       WHERE number IS NULL AND 'issue:' || zone_id || ':' || objective || ':' || key = ?`,
  ).run(number, now.toISOString(), opKey);
}

/** Lookup only; never writes to the forge. Visible → `done`, otherwise the row is `unknown`. */
async function readBack(db: Db, forges: ForgePair, row: OutboxRow, now: Date): Promise<OpResult> {
  const payload: unknown = JSON.parse(row.payloadJson);
  let found: unknown;
  try {
    found = await lookup(forges, row.kind, row.opKey, payload);
  } catch (err) {
    if (row.state !== 'unknown') updateOutbox(db, row.opKey, { state: 'unknown' }, now);
    return { state: 'unknown', error: errorMessage(err) };
  }
  if (found) return markDone(db, row.opKey, found, now);
  if (row.state !== 'unknown') updateOutbox(db, row.opKey, { state: 'unknown' }, now);
  return { state: 'unknown' };
}

/** Lookup, then write if the effect is absent. The row must be `pending`. */
async function execute(db: Db, forges: ForgePair, op: Op, now: Date): Promise<OpResult> {
  let found: unknown;
  try {
    found = await lookup(forges, op.kind, op.opKey, op.payload);
  } catch (err) {
    updateOutbox(db, op.opKey, { state: 'unknown', error: errorMessage(err) }, now);
    return { state: 'unknown', error: errorMessage(err) };
  }
  if (found) return markDone(db, op.opKey, found, now);
  try {
    const result = await write(forges, op.kind, op.opKey, op.payload);
    if (result) return markDone(db, op.opKey, result, now);
    const error = `${op.kind} not performed`;
    updateOutbox(db, op.opKey, { state: 'unknown', error }, now);
    return { state: 'unknown', error };
  } catch (err) {
    const status = (err as ForgeError | null)?.status;
    const error = errorMessage(err);
    // A rate limit (403/429) says nothing about the write: leave it to read-back like a 5xx. A
    // branch update is pinned to its head (expected_head_sha) and read back before each send, so
    // any error fails it, and the caller may send it again.
    const state: OutboxState =
      op.kind === 'update_branch' ||
      (status !== undefined && status >= 400 && status < 500 && !isRateLimited(err))
        ? 'failed'
        : 'unknown';
    if (state === 'failed') {
      const found = await wideIssueSearch(forges, {
        kind: op.kind,
        opKey: op.opKey,
        payloadJson: JSON.stringify(op.payload),
      });
      if (found) return markDone(db, op.opKey, found, now);
    }
    updateOutbox(db, op.opKey, { state, error }, now);
    return { state, error };
  }
}

async function fromExisting(
  db: Db,
  forges: ForgePair,
  op: Op,
  row: OutboxRow,
  now: Date,
): Promise<OpResult> {
  switch (row.state) {
    case 'done': {
      const result: unknown = row.resultJson == null ? undefined : JSON.parse(row.resultJson);
      if (row.kind !== 'create_pr') return { state: 'done', result };
      // A PR op stays done while its PR is open or merged; a closed one is opened again.
      const head = (JSON.parse(row.payloadJson) as CreatePrPayload).head;
      if (await forges.author.findOpenPullByHead(head)) return { state: 'done', result };
      const stored = (result as { number?: number } | undefined)?.number;
      if (stored !== undefined && (await forges.author.getPull(stored))?.merged) {
        return { state: 'done', result };
      }
      if (resetDoneOutbox(db, row.opKey, now)) return execute(db, forges, op, now);
      const current = getOutbox(db, row.opKey);
      if (!current) throw new Error(`outbox row ${row.opKey} vanished`);
      return fromExisting(db, forges, op, current, now);
    }
    case 'failed':
      return { state: 'failed', ...(row.error != null ? { error: row.error } : {}) };
    case 'pending':
    case 'unknown':
      return readBack(db, forges, row, now);
  }
}

function zoneMode(db: Db, zoneId: string): string | undefined {
  const row = db.prepare('SELECT mode FROM zone_controls WHERE zone_id = ?').get(zoneId) as
    | { mode: string }
    | undefined;
  return row?.mode;
}

/** Runs one forge write at most once per `opKey` (§5.2). */
export async function runOp(
  db: Db,
  forges: ForgePair,
  op: Op,
  now: Date,
  /**
   * `allowInObserve`: the operator's own label action from the doctor (Task 8), and nothing
   * else: any other kind is still suppressed in observe whatever the caller asks.
   */
  opts: { allowInObserve?: boolean } = {},
): Promise<OpResult> {
  const result = await runOpIf(db, forges, op, now, () => true, opts);
  if (result === null) throw new Error(`outbox row ${op.opKey} refused by an open check`);
  return result;
}

/**
 * `runOp`, with a check that must hold for a write not yet recorded: `may` runs in the same
 * transaction that records the write, so two passes cannot both pass it (#843). Null when it does
 * not hold, and nothing is recorded. A write already recorded goes on without the check.
 */
export async function runOpIf(
  db: Db,
  forges: ForgePair,
  op: Op,
  now: Date,
  may: () => boolean,
  opts: { allowInObserve?: boolean } = {},
): Promise<OpResult | null> {
  if (isKilled(db)) throw new Error(`kill switch engaged: forge write ${op.kind} refused`);
  // Before any insert: a row left behind would later become `unknown` and park the item.
  const exempt = opts.allowInObserve === true && op.kind === 'create_labels';
  if (!exempt && zoneMode(db, op.zoneId) === 'observe') {
    throw new Error(`observe mode: forge write ${op.kind} suppressed`);
  }
  if (op.kind === 'comment_issue') checkCommentPayload(op.payload as CommentIssuePayload);
  const existing = getOutbox(db, op.opKey);
  if (existing) return fromExisting(db, forges, op, existing, now);
  const inserted = db.transaction((): boolean | null => {
    if (!may()) return null;
    return insertOutbox(db, {
      id: randomUUID(),
      opKey: op.opKey,
      kind: op.kind,
      workItemId: op.itemId,
      zoneId: op.zoneId,
      payloadJson: JSON.stringify(op.payload),
      state: 'pending',
      createdAt: now.toISOString(),
    });
  })();
  if (inserted === null) return null;
  if (!inserted) {
    const raced = getOutbox(db, op.opKey);
    if (!raced) throw new Error(`outbox row ${op.opKey} vanished`);
    return fromExisting(db, forges, op, raced, now);
  }
  return execute(db, forges, op, now);
}

/**
 * Kinds whose effect reads back exactly and that the forge refuses or ignores a second time, so a
 * write lost to a dropped connection may be sent again (#787). Not here: `create_issue` and
 * `post_review`, where a late first write could leave two (they are `STRICT_RESEND_KINDS`),
 * `comment_issue`, never sent again, and `update_branch`, which its caller sends again.
 */
export const RESENDABLE_KINDS: ReadonlySet<OpKind> = new Set<OpKind>([
  'create_pr',
  'merge',
  'set_labels',
  'update_issue',
  'create_labels',
  'add_blocked_by',
]);
/** The least time between two sends of one write, counted from the last (`updated_at`). */
export const RESEND_AFTER_MS = 2 * 60_000;
/** The most times one write is sent again. */
export const MAX_RESENDS = 3;

/**
 * Kinds sent again under stricter rules (#900), since a late first write could leave two: only
 * after `CLEAN_READS` clean read-backs in a row (for a filing, the last also the wide search), at
 * most `MAX_STRICT_RESENDS` times, and a review only on its open PR at its commit.
 */
export const STRICT_RESEND_KINDS: ReadonlySet<OpKind> = new Set<OpKind>([
  'create_issue',
  'post_review',
]);
/** The most times an issue filing or a review is sent again. */
export const MAX_STRICT_RESENDS = 2;
/** Clean read-backs in a row before an issue filing or a review is sent again. */
export const CLEAN_READS = 3;
/** The least time between two clean reads that both count. */
export const CLEAN_READ_GAP_MS = 60_000;
/** How long after a resent filing is done the passes look for a second issue with its marker. */
export const DUPLICATE_WINDOW_MS = 30 * 60_000;

/**
 * Whether an `unknown` row whose read-back came back clean and empty may be sent again now: a
 * resendable kind, under the cap, 2 minutes after its last send, kill switch off, zone active, and
 * for a PR, its branch still at the head SHA the op is keyed by (a failed read of it proves
 * nothing, so it holds the resend too).
 */
async function mayResend(db: Db, forges: ForgePair, row: OutboxRow, now: Date): Promise<boolean> {
  const strict = STRICT_RESEND_KINDS.has(row.kind);
  if (!strict && !RESENDABLE_KINDS.has(row.kind)) return false;
  if (row.resends >= (strict ? MAX_STRICT_RESENDS : MAX_RESENDS)) return false;
  if (now.getTime() - Date.parse(row.updatedAt) < RESEND_AFTER_MS) return false;
  if (isKilled(db) || zoneMode(db, row.zoneId) !== 'active') return false;
  if (row.kind === 'post_review') {
    // Only while the PR is open at the review's commit: otherwise it goes on to its deadline.
    const p = JSON.parse(row.payloadJson) as PostReviewPayload;
    try {
      const pr = await forges.author.getPull(p.pr);
      return pr !== null && pr.state === 'open' && !pr.merged && pr.headSha === p.commitId;
    } catch {
      return false;
    }
  }
  if (row.kind !== 'create_pr') return true;
  const keySha = row.opKey.split(':').at(-1);
  const p = JSON.parse(row.payloadJson) as CreatePrPayload;
  try {
    return keySha !== undefined && (await forges.author.branchSha(p.head)) === keySha;
  } catch {
    return false;
  }
}

/**
 * Sends an `unknown` write again, once this pass has claimed it (one sender of two passes), through
 * `execute`, which looks once more before it writes. Null when the claim was lost.
 */
async function resend(
  db: Db,
  forges: ForgePair,
  row: OutboxRow,
  now: Date,
): Promise<OpResult | null> {
  if (!claimOutboxResend(db, row.opKey, row.resends, now)) return null;
  const op: Op = {
    kind: row.kind,
    opKey: row.opKey,
    zoneId: row.zoneId,
    itemId: row.workItemId,
    payload: JSON.parse(row.payloadJson),
  };
  return execute(db, forges, op, now);
}

/**
 * An issue filing's or a review's turn after its read-back (#900): a failed read starts the clean
 * reads again; a clean one counts when it is 2 minutes after the last send and a minute after the
 * last that counted. At `CLEAN_READS`, a filing is looked for once more by the wide search (which
 * must be clean too), then the write may be sent again (`mayResend`). Returns whether it is done.
 */
async function strictResend(
  db: Db,
  forges: ForgePair,
  row: OutboxRow,
  read: OpResult,
  now: Date,
): Promise<boolean> {
  if (read.error !== undefined) {
    resetOutboxCleanReads(db, row.opKey);
    return false;
  }
  if (now.getTime() - Date.parse(row.updatedAt) < RESEND_AFTER_MS) return false;
  const count = countOutboxCleanRead(db, row.opKey, now, CLEAN_READ_GAP_MS);
  if (count === null || count < CLEAN_READS) return false;
  if (row.kind === 'create_issue') {
    let found: { number: number } | null;
    try {
      found = await searchWide(forges, row);
    } catch {
      resetOutboxCleanReads(db, row.opKey);
      return false;
    }
    if (found) {
      markDone(db, row.opKey, found, now);
      return true;
    }
  }
  if (!(await mayResend(db, forges, row, now))) return false;
  return (await resend(db, forges, row, now))?.state === 'done';
}

/** The outbox key of closing issue `n`, a duplicate of the filing `opKey` (#900). */
const duplicateCloseKey = (opKey: string, n: number): string => `dup:${opKey}:${n}`;

/**
 * For `DUPLICATE_WINDOW_MS` after a resent issue filing is done, looks for issues with its marker
 * (#900). Of two or more, the lowest number is kept, and the record (the row's result and the crew
 * issue) names it; each other one is closed through the outbox, once, with one log line. Only
 * issues this identity filed with this row's own marker are ever closed, and nothing is under the
 * kill switch or in a zone that is not active.
 */
async function closeDuplicateIssues(
  db: Db,
  forges: ForgePair,
  zoneId: string,
  now: Date,
): Promise<void> {
  if (isKilled(db) || zoneMode(db, zoneId) !== 'active') return;
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_MS);
  for (const row of listResentIssueFilings(db, zoneId, since)) {
    const p = JSON.parse(row.payloadJson) as CreateIssuePayload;
    let found: { number: number }[];
    try {
      found = await forges.author.findIssuesByMarker(opMarker(row.opKey), p.since);
    } catch {
      continue; // looked for again on the next pass
    }
    const [keep, ...rest] = [...new Set(found.map((i) => i.number))].sort((a, b) => a - b);
    if (keep === undefined || rest.length === 0) continue;
    const result = (row.resultJson == null ? {} : JSON.parse(row.resultJson)) as {
      number?: number;
    };
    if (result.number !== keep) {
      db.transaction(() => {
        setOutboxResult(db, row.opKey, JSON.stringify({ ...result, number: keep }));
        repointFiledNumber(db, row.opKey, result.number, keep, now);
      })();
    }
    // At most one issue per send of the row: the first and each resend.
    for (const n of rest.slice(0, MAX_STRICT_RESENDS)) {
      const opKey = duplicateCloseKey(row.opKey, n);
      const first = getOutbox(db, opKey) === undefined;
      try {
        const r = await runOp(
          db,
          forges,
          {
            kind: 'update_issue',
            opKey,
            zoneId,
            itemId: null,
            payload: { number: n, state: 'closed' },
          },
          now,
        );
        if (first && r.state === 'done')
          log(`outbox: closed issue #${n}, a duplicate of #${keep} (${row.opKey})`);
      } catch {
        // Refused (kill switch or observe since the check): tried again on the next pass.
      }
    }
  }
}

/** The crew issue filed by `opKey` now names `to`, the kept one of two (#900), not `from`. */
function repointFiledNumber(
  db: Db,
  opKey: string,
  from: number | undefined,
  to: number,
  now: Date,
): void {
  if (!opKey.startsWith('issue:') || from === undefined) return;
  db.prepare(
    `UPDATE crew_issues SET number = ?, updated_at = ?
       WHERE number = ? AND 'issue:' || zone_id || ':' || objective || ':' || key = ?`,
  ).run(to, now.toISOString(), from, opKey);
}

/**
 * Read-back for every `unknown` row of one zone; returns how many became `done`. A row still
 * unresolved `maxAgeMinutes` after it was created becomes `failed`. Before that, a resendable
 * write the read-back cleanly did not find is sent again (`mayResend`, #787); an issue filing or a
 * review only after three clean reads (`strictResend`, #900). Then a resent filing's duplicates
 * are closed (`closeDuplicateIssues`).
 */
export async function resolveUnknown(
  db: Db,
  forges: ForgePair,
  zoneId: string,
  now: Date,
  maxAgeMinutes: number,
): Promise<number> {
  let resolved = 0;
  for (const row of listOutbox(db, ['unknown'], zoneId)) {
    const r = await readBack(db, forges, row, now);
    if (r.state === 'done') {
      resolved++;
      continue;
    }
    if (now.getTime() - Date.parse(row.createdAt) >= maxAgeMinutes * 60_000) {
      const found = await wideIssueSearch(forges, row);
      if (found) {
        markDone(db, row.opKey, found, now);
        resolved++;
        continue;
      }
      updateOutbox(
        db,
        row.opKey,
        { state: 'failed', error: `unresolved after ${maxAgeMinutes} min` },
        now,
      );
      continue;
    }
    if (STRICT_RESEND_KINDS.has(row.kind)) {
      if (await strictResend(db, forges, row, r, now)) resolved++;
      continue;
    }
    // A read that failed proves nothing: only a clean, empty read-back may lead to a resend.
    if (r.error !== undefined || !(await mayResend(db, forges, row, now))) continue;
    if ((await resend(db, forges, row, now))?.state === 'done') resolved++;
  }
  await closeDuplicateIssues(db, forges, zoneId, now);
  return resolved;
}

/** Startup: a `pending` row may have reached the forge before a crash, so it becomes `unknown`. */
export function markPendingUnknown(db: Db, now: Date): number {
  const rows = listOutbox(db, ['pending']);
  for (const row of rows) updateOutbox(db, row.opKey, { state: 'unknown' }, now);
  return rows.length;
}

const ZWJ = '\u200d';

/** Cuts `text` to `maxLen` without leaving a code span open. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const runs = [...cut.matchAll(/`+/g)];
  const last = runs.at(-1);
  return runs.length % 2 === 1 && last ? cut.slice(0, last.index) : cut;
}

/**
 * Makes untrusted text safe to post: redacts secrets, escapes HTML comment markers (so no text can
 * forge a `jm:op:` marker), breaks `@mentions` and autolinks with a zero-width joiner everywhere
 * (code spans included, so no span boundary can revive one), and truncates without splitting a
 * code span.
 */
/**
 * `sanitizeForgeText` for crew-written issue text, which also breaks `#N` and `owner/repo#N`
 * references so a crew issue cannot link, close or notify other issues.
 */
export function sanitizeCrewText(text: string, secrets: string[]): string {
  return sanitizeForgeText(text, secrets)
    .replace(/#(?=\d)/g, `#${ZWJ}`)
    .replace(/\b(gh-)(?=\d)/gi, `$1${ZWJ}`);
}

export function sanitizeForgeText(text: string, secrets: string[], maxLen = 60_000): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  // Token shapes too: a token pasted into a body (an MCP caller's, say) is never configured.
  out = redactTokenShapes(out, '[redacted]');
  out = out.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
  out = out.replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, `$1@${ZWJ}`);
  out = out.replaceAll('://', `:${ZWJ}//`);
  out = out.replace(/(^|[^\w])(www)\./gi, `$1$2${ZWJ}.`);
  return truncate(out, maxLen);
}

/**
 * Undoes the joiners `sanitizeForgeText` and `sanitizeCrewText` insert, so a value quoted in an
 * issue (a URL, an `@scope/pkg` import, `#12`) reaches an agent as written. For drop input only:
 * never apply it to text posted to the forge, where the joiners keep mentions and links dead. Any
 * other zero-width joiner (an emoji sequence, say) is kept.
 */
export function unsanitizeForgeText(text: string): string {
  return text
    .replace(/@\u200d(?=[A-Za-z0-9])/g, '@')
    .replaceAll(':\u200d//', '://')
    .replace(/(www)\u200d\./gi, '$1.')
    .replace(/#\u200d(?=\d)/g, '#')
    .replace(/(gh-)\u200d(?=\d)/gi, '$1');
}
