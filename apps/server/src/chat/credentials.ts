import type { Config, DropZoneConfig } from '../config.js';
import type { AppTokenSource } from '../forge/app-tokens.js';
import { isAppReviewerZone, type ResolvedApps } from '../vault/resolution.js';

/** A read credential one chat turn fetches a zone with, and how to give it back. */
export interface ChatReadCredential {
  token: string;
  /** Revokes a token minted for this turn; a no-op for the install's read PAT. Never rejects. */
  release(): Promise<void>;
}

const noRelease = async (): Promise<void> => {};

/**
 * The credential the chat service fetches a zone's code with (R3), or null when the zone chats
 * without its code:
 * - an app-reviewer zone gets a reviewer `contents: read` token minted for this turn alone, which
 *   `release` revokes; a failed mint (or no token source) is null, never a PAT fallback, as for a
 *   drop (`dropReadToken` in `api/sticks.ts`);
 * - any other zone gets the install's `githubReadToken`, or null without one. Never the author
 *   token: the chat service holds no GitHub write credential.
 */
export async function chatReadCredential(
  zone: DropZoneConfig,
  config: Pick<Config, 'secrets'>,
  apps: ResolvedApps,
  appTokens?: Pick<AppTokenSource, 'fresh'>,
): Promise<ChatReadCredential | null> {
  if (isAppReviewerZone(zone, apps)) {
    if (!appTokens) return null;
    try {
      const fresh = await appTokens.fresh(zone.id, 'reviewer', 'drop-read-reviewer');
      return {
        token: fresh.token,
        release: async () => {
          // A token not revoked expires within its hour.
          await fresh.revoke().catch(() => {});
        },
      };
    } catch {
      return null;
    }
  }
  const read = config.secrets.githubReadToken;
  return read ? { token: read, release: noRelease } : null;
}
