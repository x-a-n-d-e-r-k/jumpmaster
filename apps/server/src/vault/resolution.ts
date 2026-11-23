import { type ForgeKind, forgeKind } from '../forge/kind.js';
import { type ScrubSet, serverScrubSet } from '../forge/scrub-set.js';
import type { InstallCredential } from './credentials.js';
import {
  APP_ROLES,
  type AppEntryRead,
  type AppRole,
  type CredentialRef,
  ownerOfRepo,
  readAppEntry,
} from './github-app-entries.js';
import { GITLAB_PAT_ROLES, gitlabPatEntryName } from './gitlab-pat-entries.js';
import { type Vault, VaultKeyError } from './vault.js';

/**
 * App-first credential resolution (§4.4): per zone and role, a two-bot zone uses its repository
 * owner's GitHub App when the owner has an entry for the role, else the install-wide PAT; a
 * starter zone always uses the PAT. Each owner is read once; every loaded PEM goes to the scrub set
 * before resolution returns.
 */

/** Each read owner (lowercased) and its entry reads for both roles. */
export type ResolvedApps = ReadonlyMap<string, Readonly<Record<AppRole, AppEntryRead>>>;

/** The zone fields resolution reads; `identity` absent is the schema's default, two-bot. */
export type ZoneForCredentials = { repo: string; identity?: 'starter' | 'two-bot' };

export type CredentialResolution = { ref: CredentialRef; problem?: 'undecryptable' };

const PAT_OF: Record<AppRole, InstallCredential> = {
  author: 'githubAuthorToken',
  reviewer: 'githubReviewerToken',
};

/** The lowercased owner of a repository, or undefined when it is not a valid GitHub owner. */
function ownerOf(repo: string): string | undefined {
  try {
    return ownerOfRepo(repo);
  } catch {
    return undefined;
  }
}

const isTwoBot = (z: Pick<ZoneForCredentials, 'identity'>): boolean =>
  (z.identity ?? 'two-bot') === 'two-bot';

/**
 * The app entries of every two-bot zone's owner, both roles each. Starter zones and zones whose
 * owner is not a GitHub owner name are not read for. A malformed entry in use throws
 * `readAppEntry`'s secret-free error.
 */
export function resolveAppEntries(
  zones: readonly ZoneForCredentials[],
  o: {
    vault: Vault | 'disabled';
    secretsDir?: string;
    preferVault?: boolean;
    scrubSet?: ScrubSet;
    /** A test seam: the read of one owner's entry for a role. */
    read?: typeof readAppEntry;
  },
): ResolvedApps {
  const read = o.read ?? readAppEntry;
  const set = o.scrubSet ?? serverScrubSet;
  const opts = {
    vault: o.vault,
    ...(o.secretsDir ? { secretsDir: o.secretsDir } : {}),
    ...(o.preferVault !== undefined ? { preferVault: o.preferVault } : {}),
  };
  const out = new Map<string, Record<AppRole, AppEntryRead>>();
  for (const z of zones) {
    if (!isTwoBot(z)) continue;
    const owner = ownerOf(z.repo);
    if (owner === undefined || out.has(owner)) continue;
    const reads = {} as Record<AppRole, AppEntryRead>;
    for (const role of APP_ROLES) {
      const r = read(opts, owner, role);
      if (r.source !== 'missing') set.addPem(r.entry.pem);
      reads[role] = r;
    }
    out.set(owner, reads);
  }
  return out;
}

/** The credential a zone uses for a role: its owner's app when present, else the PAT. */
export function credentialFor(
  zone: ZoneForCredentials,
  role: AppRole,
  apps: ResolvedApps,
): CredentialResolution {
  const pat: CredentialResolution = { ref: { kind: 'github-pat', name: PAT_OF[role] } };
  if (!isTwoBot(zone)) return pat;
  const owner = ownerOf(zone.repo);
  const r = owner === undefined ? undefined : apps.get(owner)?.[role];
  if (!r || owner === undefined) return pat;
  if (r.source !== 'missing') return { ref: { kind: 'github-app', owner } };
  // An entry that exists but won't decrypt keeps the app: falling back to the PAT would change
  // which identity authors or merges.
  if (r.undecryptable) return { ref: { kind: 'github-app', owner }, problem: 'undecryptable' };
  return pat;
}

/** The zone fields `appInstallationFor` reads: the recorded ids, config not secret (§4.2). */
export type ZoneForAppInstallation = Pick<ZoneForCredentials, 'identity'> & {
  githubApp?: {
    repositoryId: number;
    installations: { author?: number; reviewer?: number };
  };
};

/**
 * The recorded installation and repository a role's app tokens are for, or undefined when the
 * zone is starter, has no `githubApp`, or records no installation for the role. Pure: it reads the
 * zone alone. Nothing mints from it until `verifiedInstallation` (forge/installation-verifier.ts,
 * issue #267) has checked both ids against `zone.repo` on GitHub, since the server never trusts an
 * id it is handed; the tests there prove it.
 */
export function appInstallationFor(
  zone: ZoneForAppInstallation,
  role: AppRole,
): { installationId: number; repositoryId: number } | undefined {
  if (!isTwoBot(zone) || !zone.githubApp) return undefined;
  const installationId = zone.githubApp.installations[role];
  if (installationId === undefined) return undefined;
  return { installationId, repositoryId: zone.githubApp.repositoryId };
}

/**
 * An app-reviewer zone (§4.2, §4.4, issue #237): a two-bot zone whose reviewer credential is its
 * owner's GitHub App, decryptable, with a recorded reviewer installation. Its review, crew and
 * doctor drops clone with a reviewer `contents: read` token minted per drop, not the read PAT.
 */
export function isAppReviewerZone(
  zone: ZoneForCredentials & ZoneForAppInstallation,
  apps: ResolvedApps,
): boolean {
  return isAppZoneFor(zone, 'reviewer', apps);
}

/**
 * An app-author zone (§4.2, issue #249): a two-bot zone whose author credential is its owner's
 * GitHub App, decryptable, with a recorded author installation. Its implement, heal and resolve
 * drops fetch with an author `contents: read` token minted per drop, not a PAT.
 */
export function isAppAuthorZone(
  zone: ZoneForCredentials & ZoneForAppInstallation,
  apps: ResolvedApps,
): boolean {
  return isAppZoneFor(zone, 'author', apps);
}

function isAppZoneFor(
  zone: ZoneForCredentials & ZoneForAppInstallation,
  role: AppRole,
  apps: ResolvedApps,
): boolean {
  const r = credentialFor(zone, role, apps);
  return (
    r.ref.kind === 'github-app' &&
    r.problem === undefined &&
    appInstallationFor(zone, role) !== undefined
  );
}

/** The zone fields `resolveGitlabPatEntries` reads. */
export type ZoneForGitlabPats = Pick<ZoneForCredentials, 'identity'> & {
  id: string;
  forge?: ForgeKind | undefined;
};

/** Each GitLab zone's present `gitlab-pat` values, by zone id; a missing role is absent. */
export type ResolvedGitlabPats = ReadonlyMap<
  string,
  Readonly<{ author?: string; reviewer?: string }>
>;

/**
 * The `gitlab-pat/<zoneId>/<role>` vault entries of every GitLab zone (§9): the author always, the
 * reviewer for a two-bot zone only. A disabled vault, an absent entry and one that won't decrypt
 * all read as missing, without a throw or a log line. Each present value is pinned in the scrub
 * set before resolution returns: configured, long-lived credentials are never evicted.
 */
export function resolveGitlabPatEntries(
  zones: readonly ZoneForGitlabPats[],
  o: { vault: Vault | 'disabled'; scrubSet?: ScrubSet },
): ResolvedGitlabPats {
  const set = o.scrubSet ?? serverScrubSet;
  const out = new Map<string, { author?: string; reviewer?: string }>();
  for (const z of zones) {
    if (forgeKind(z) !== 'gitlab' || out.has(z.id)) continue;
    const roles: { author?: string; reviewer?: string } = {};
    for (const role of GITLAB_PAT_ROLES) {
      if (role === 'reviewer' && !isTwoBot(z)) continue;
      const v = readGitlabPat(o.vault, gitlabPatEntryName(z.id, role));
      if (v === undefined) continue;
      set.pin(v);
      roles[role] = v;
    }
    out.set(z.id, roles);
  }
  return out;
}

function readGitlabPat(vault: Vault | 'disabled', name: string): string | undefined {
  if (vault === 'disabled') return undefined;
  try {
    return vault.get(name);
  } catch (e) {
    if (!(e instanceof VaultKeyError)) throw e;
    return undefined;
  }
}
