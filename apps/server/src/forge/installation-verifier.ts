/**
 * `verifiedInstallation(zone, role)` (issue #267, spec §4.2): the one check every path that mints
 * for a zone goes through. A zone's recorded GitHub App ids are guarded config, not proof: before
 * anything mints, GitHub must say that
 *
 * - the role's app is installed on `zone.repo`, under the installation id the zone records, and
 * - `zone.repo`'s repository id is the one the zone records (`githubApp.repositoryId`), read under
 *   that installation with a token narrowed to `zone.repo` by name and to `metadata: read`.
 *
 * Without both, a confirmed config change could point a zone's write tokens at another repository
 * the same app is installed on, while the UI and logs name `zone.repo`.
 *
 * A pass is remembered per `(zone.repo, role, app fingerprint, installation id, repository id)` and
 * re-verified when any of them changes; the memory is in-process, so every server start verifies
 * again. A refusal and an error are both forgotten, so the next pass checks again; neither is ever
 * a pass. Absence is not proof: a zone with no ids recorded is refused.
 *
 * Errors name the zone, its repository and the role; never a secret.
 */
import type { DropZoneConfig } from '../config.js';
import { APP_ROLES, type AppRole } from '../vault/github-app-entries.js';
import { appInstallationFor, credentialFor, type ResolvedApps } from '../vault/resolution.js';
import type { GitHubAppBroker } from './github-app.js';

/** The zone fields the check reads. */
export type VerifiableZone = Pick<DropZoneConfig, 'id' | 'repo' | 'identity' | 'githubApp'>;

/** Ids GitHub confirmed for the zone's repository and role, with the broker that checked them. */
export interface VerifiedInstallation {
  /** The lowercased owner whose app this is. */
  owner: string;
  installationId: number;
  repositoryId: number;
  /** The app entry's fingerprint the check was made with. */
  fingerprint: string;
  broker: GitHubAppBroker;
}

/**
 * The zone was not verified. `refused`: GitHub (or the config) says no, so the zone parks until the
 * config changes. Otherwise the check could not run (network, 5xx) and is retried on the next pass.
 */
export class InstallationCheckError extends Error {
  readonly refused: boolean;
  constructor(message: string, refused: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InstallationCheckError';
    this.refused = refused;
  }
}

export interface InstallationVerifier {
  verifiedInstallation(zone: VerifiableZone, role: AppRole): Promise<VerifiedInstallation>;
}

export interface InstallationVerifierDeps {
  /** The app entries as they resolved now. */
  resolvedApps: () => ResolvedApps;
  /** The role's broker on the owner, built from the current entry; undefined without one. */
  brokerFor(
    owner: string,
    role: AppRole,
  ): { broker: GitHubAppBroker; fingerprint: string } | undefined;
}

interface Pass {
  key: string;
  verified: Promise<VerifiedInstallation>;
}

export function createInstallationVerifier(deps: InstallationVerifierDeps): InstallationVerifier {
  /** The last check per repository and role. */
  const passes = new Map<string, Pass>();

  async function check(
    zone: VerifiableZone,
    role: AppRole,
    owner: string,
    recorded: { installationId: number; repositoryId: number },
    slot: { broker: GitHubAppBroker; fingerprint: string },
  ): Promise<VerifiedInstallation> {
    const [repoOwner = '', repoName = ''] = zone.repo.split('/');
    const unverified = (cause: unknown) =>
      new InstallationCheckError(
        `${zone.id}: could not verify the ${role} app installation on ${zone.repo}; it is checked again on the next pass`,
        false,
        { cause },
      );
    let found: Awaited<ReturnType<GitHubAppBroker['installationFor']>>;
    try {
      found = await slot.broker.installationFor(repoOwner, repoName);
    } catch (err) {
      throw unverified(err);
    }
    if (!found.installed)
      throw new InstallationCheckError(
        `${zone.id}: the ${role} app is not installed on ${zone.repo}`,
        true,
      );
    if (found.installationId !== recorded.installationId)
      throw new InstallationCheckError(
        `${zone.id}: the recorded ${role} installation id does not match ${zone.repo}`,
        true,
      );
    let repositoryId: number;
    try {
      repositoryId = await slot.broker.repositoryIdOf(found.installationId, repoOwner, repoName);
    } catch (err) {
      throw unverified(err);
    }
    if (repositoryId !== recorded.repositoryId)
      throw new InstallationCheckError(
        `${zone.id}: the recorded ${role} repository id does not match ${zone.repo}`,
        true,
      );
    return { owner, ...recorded, fingerprint: slot.fingerprint, broker: slot.broker };
  }

  return {
    async verifiedInstallation(zone, role) {
      const refuse = (why: string) => new InstallationCheckError(`${zone.id}: ${why}`, true);
      if ((zone.identity ?? 'two-bot') !== 'two-bot')
        throw refuse(`${zone.repo} is a starter zone: it uses personal access tokens, not an app`);
      const apps = deps.resolvedApps();
      const resolution = credentialFor(zone, role, apps);
      if (resolution.ref.kind !== 'github-app')
        throw refuse(`the owner of ${zone.repo} has no ${role} GitHub App`);
      if (resolution.problem === 'undecryptable')
        throw refuse(`the ${role} GitHub App entry for ${zone.repo} can't be decrypted`);
      const owner = resolution.ref.owner;
      // Absence is not proof: nothing recorded is nothing verified.
      const recorded = appInstallationFor(zone, role);
      if (!recorded) throw refuse(`the zone records no ${role} app installation for ${zone.repo}`);
      const slot = deps.brokerFor(owner, role);
      if (!slot) throw refuse(`the owner of ${zone.repo} has no ${role} GitHub App`);

      const slotKey = JSON.stringify([zone.repo, role]);
      const key = JSON.stringify([
        zone.repo,
        role,
        slot.fingerprint,
        recorded.installationId,
        recorded.repositoryId,
      ]);
      const last = passes.get(slotKey);
      if (last && last.key === key) return last.verified;
      const pass: Pass = { key, verified: check(zone, role, owner, recorded, slot) };
      passes.set(slotKey, pass);
      // Only a pass is remembered: a refusal or an error is checked again next time.
      pass.verified.catch(() => {
        if (passes.get(slotKey) === pass) passes.delete(slotKey);
      });
      return pass.verified;
    },
  };
}

/**
 * Why the zone parks (issue #267): the first refusal of a role the zone uses its owner's app for.
 * Undefined when every such role verifies, or a check could not run (it runs again next pass and
 * nothing mints meanwhile). A starter zone, a role on the PAT and an undecryptable entry (a
 * credential problem of its own) are not asked about.
 */
export async function appRefusal(
  verifier: InstallationVerifier,
  zone: VerifiableZone,
  apps: ResolvedApps,
): Promise<string | undefined> {
  for (const role of APP_ROLES) {
    const r = credentialFor(zone, role, apps);
    if (r.ref.kind !== 'github-app' || r.problem) continue;
    try {
      await verifier.verifiedInstallation(zone, role);
    } catch (e) {
      if (e instanceof InstallationCheckError && e.refused) return e.message;
    }
  }
  return undefined;
}
