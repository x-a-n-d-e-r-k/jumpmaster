/**
 * The doctor's read forge (spec docs/superpowers/specs/2026-11-13-github-app-auth.md, §4.4 and §13
 * Task 7): reads only, never handed a write.
 *
 * App-first (§4.4, issue #237): an app-reviewer zone (`isAppReviewerZone`) reads with the reviewer
 * app's `drop-read-reviewer` token even when `githubReadToken` is set, because its review, crew and
 * doctor drops clone with that app's token minted per drop: the doctor tests what the drops use.
 * Every other zone reads with `githubReadToken`, and has no read forge without it.
 */
import type { Config } from '../config.js';
import { isAppReviewerZone, type ResolvedApps } from '../vault/resolution.js';
import type { AppTokenSource } from './app-tokens.js';
import { type Forge, GitHubForge } from './github.js';
import { forgeKind } from './kind.js';

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
    // Issue #667: no GitLab forge yet, and never a GitHub one for a GitLab zone.
    if (forgeKind(zone) === 'gitlab') return undefined;
    const [owner = '', name = ''] = zone.repo.split('/');
    const opts = { requestTimeoutMs: TIMED_REQUEST_MS };
    if (appTokens && isAppReviewerZone(zone, live.resolvedApps()))
      return new GitHubForge(
        owner,
        name,
        appTokens.provider(zone.id, 'reviewer', 'drop-read-reviewer'),
        opts,
      );
    const readToken = config.secrets.githubReadToken;
    return readToken ? new GitHubForge(owner, name, readToken, opts) : undefined;
  };
}
