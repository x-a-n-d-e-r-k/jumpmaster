/**
 * The doctor's read forge (spec docs/superpowers/specs/2026-11-13-github-app-auth.md, §4.4 and §13
 * Task 7): reads only, never handed a write.
 *
 * The read token wins while it is set. Drops still clone with `githubReadToken` until the per-drop
 * read-token hookup (Task 5, Ruling 39), so testing the app's token in its place would let a broken
 * read token pass the doctor. The reviewer app's `drop-read-reviewer` token is used only when no
 * read token is configured; app-first switches on with the drop clone token in Task 5.
 */
import type { Config } from '../config.js';
import { appInstallationFor, credentialFor, type ResolvedApps } from '../vault/resolution.js';
import type { AppTokenSource } from './app-tokens.js';
import { type Forge, GitHubForge } from './github.js';

/** How long one request on the timed forges (doctor reads, intake writes) may take. */
export const TIMED_REQUEST_MS = 30_000;

/** The config fields the read forge reads. */
export type ReadForgeConfig = Pick<Config, 'dropZones' | 'secrets'>;

export function makeReadForgeFor(
  live: { current(): ReadForgeConfig; resolvedApps(): ResolvedApps },
  appTokens?: Pick<AppTokenSource, 'provider'>,
): (zoneId: string) => Forge | undefined {
  return (zoneId) => {
    const config = live.current();
    const zone = config.dropZones.find((z) => z.id === zoneId);
    if (!zone) return undefined;
    const [owner = '', name = ''] = zone.repo.split('/');
    const opts = { requestTimeoutMs: TIMED_REQUEST_MS };
    const readToken = config.secrets.githubReadToken;
    if (readToken) return new GitHubForge(owner, name, readToken, opts);
    if (!appTokens) return undefined;
    const reviewer = credentialFor(zone, 'reviewer', live.resolvedApps());
    if (reviewer.ref.kind !== 'github-app' || reviewer.problem) return undefined;
    if (!appInstallationFor(zone, 'reviewer')) return undefined;
    return new GitHubForge(
      owner,
      name,
      appTokens.provider(zone.id, 'reviewer', 'drop-read-reviewer'),
      opts,
    );
  };
}
