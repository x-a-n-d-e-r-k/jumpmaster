/**
 * The server's GitHub App token source (spec docs/superpowers/specs/2026-11-13-github-app-auth.md,
 * §4.2, §4.4 and §13 Task 7). For a zone, a role and a use it gives a `TokenProvider` whose tokens
 * are minted by that role's app on the zone's owner, narrowed to the zone's repository and the use's
 * permissions, and held in one process-wide `TokenCache`.
 *
 * - One broker per owner and role, built from the `resolvedApps()` entry and rebuilt when the
 *   entry's fingerprint changes (key rotation).
 * - The server never trusts an installation id it is handed (§4.2): every mint for a zone and role
 *   first passes `verifiedInstallation` (issue #267), which checks both recorded ids against
 *   `zone.repo` on GitHub and remembers a pass until the ids or the entry's fingerprint change.
 * - A changed fingerprint or recorded installation id drops that owner and role's cached tokens,
 *   and the cache key carries both (issue #266), so the old token is never served under the new ones.
 * - `clear` (the kill switch, or a revision whose app entries changed) drops every cached token.
 * - No PAT fallback, ever: a starter zone, an undecryptable entry or a missing installation
 *   rejects (an identity swap is what `credentialFor` refuses too).
 *
 * Every JWT and token goes to `add` (the scrub set) before it is used, the PEM with the broker.
 * No error raised here quotes a secret: messages name the zone's repository and the role only.
 */
import type { DropZoneConfig } from '../config.js';
import type { AppRole } from '../vault/github-app-entries.js';
import { appInstallationFor, type ResolvedApps } from '../vault/resolution.js';
import type { TokenProvider } from './github.js';
import { createGitHubAppBroker, type GitHubAppBroker, type Use } from './github-app.js';
import {
  createInstallationVerifier,
  type InstallationVerifier,
  type VerifiedInstallation,
} from './installation-verifier.js';
import { createTokenCache, type TokenKey } from './token-cache.js';

/** The zone fields the source reads. */
export type AppTokenZone = Pick<DropZoneConfig, 'id' | 'repo' | 'identity' | 'githubApp'>;

export interface AppTokenSourceDeps {
  /** The app entries as they resolved now (`ConfigStore.resolvedApps`). */
  resolvedApps: () => ResolvedApps;
  /** The zones as they are now. */
  zones: () => readonly AppTokenZone[];
  apiBase?: string;
  /** The clock in epoch milliseconds. */
  now?: () => number;
  /** Adds a secret to the server scrub set. */
  add: (secret: string) => void;
}

/** A token minted for one holder alone (issue #237): never cached, never shared. */
export interface FreshToken {
  token: string;
  expiresAt: Date;
  /** The owner whose app minted it. */
  owner: string;
  /** Revokes this token with the broker that minted it. */
  revoke(): Promise<void>;
}

export interface AppTokenSource extends InstallationVerifier {
  /** A provider of the zone's `use` tokens from its `role` app; nothing is called until `token()`. */
  provider(zoneId: string, role: AppRole, use: Use): TokenProvider;
  /**
   * A token minted now for one holder (a drop): checked against the installation as the cached
   * tokens are, but never taken from or put in the cache. The caller holds and revokes it.
   */
  fresh(zoneId: string, role: AppRole, use: Use): Promise<FreshToken>;
  /**
   * The installation grant of the zone's `role` app on its repository (spec §4.3): the permissions
   * `GET /repos/{o}/{r}/installation` reports under the verified owner's app JWT, and the expiry of
   * the cached server-use token for that zone and role (null when none is cached). Nothing is
   * called until the returned function is. It never mints a server-use token and never fills the
   * cache. Every rejection names the repository and role only, and has no `cause`.
   */
  grant(zoneId: string, role: AppRole): () => Promise<AppGrant>;
  /**
   * Drops every cached token and detaches every mint in progress (the kill switch, or a revision
   * whose app entries changed): a later `token()` mints afresh.
   */
  clear(): void;
}

/** What an installation grants a role's app on a zone's repository (`AppTokenSource.grant`). */
export interface AppGrant {
  permissions: Record<string, string>;
  /** The cached server-use token's expiry as an ISO string, or null when none is cached. */
  tokenExpiresAt: string | null;
}

/** The use the server's own forge for each role acts with. */
const SERVER_USE: Record<AppRole, Use> = { author: 'server-author', reviewer: 'server-reviewer' };

/** A token the source would not mint. Its message names the repository and role, never a secret. */
export class AppTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppTokenError';
  }
}

/** Which role's app mints each use (§4.2's table). */
const ROLE_OF_USE: Record<Use, AppRole> = {
  'server-author': 'author',
  'drop-read-author': 'author',
  push: 'author',
  'server-reviewer': 'reviewer',
  'drop-read-reviewer': 'reviewer',
};

interface BrokerSlot {
  fingerprint: string;
  broker: GitHubAppBroker;
}

/** The ids a zone and role last minted under, so a change drops the tokens minted before it. */
interface Check {
  /** The owner and role's slot id. */
  slot: string;
  installationId: number;
  repositoryId: number;
}

const slotId = (owner: string, role: AppRole) => JSON.stringify([owner, role]);
const tokenKeyId = (k: TokenKey) =>
  JSON.stringify([k.owner, k.role, k.repositoryId, k.use, k.appFingerprint, k.installationId]);

export function createAppTokenSource(deps: AppTokenSourceDeps): AppTokenSource {
  const now = deps.now ?? Date.now;
  const brokers = new Map<string, BrokerSlot>();
  /** The last check per zone and role. */
  const checks = new Map<string, Check>();
  /** Per owner and role: the installation each checked repository mints from. */
  const installationOf = new Map<string, Map<number, number>>();
  /** Every key handed to the cache, per owner and role, so they can be dropped together. */
  const issued = new Map<string, Map<string, TokenKey>>();

  const cache = createTokenCache({
    register: deps.add,
    now,
    async mint(key) {
      const role = key.role;
      const slot = brokers.get(slotId(key.owner, role));
      const installationId = installationOf.get(slotId(key.owner, role))?.get(key.repositoryId);
      // Mint only from the entry and installation the key names, so a token never sits under a
      // key for another app entry or installation (D1).
      if (!slot || installationId === undefined || installationId !== key.installationId)
        throw new AppTokenError(`no checked ${role} installation to mint from`);
      if (slot.fingerprint !== key.appFingerprint)
        throw new AppTokenError(`the ${role} GitHub App entry changed; try again`);
      return slot.broker.mint({
        installationId,
        repositoryId: key.repositoryId,
        use: key.use as Use,
      });
    },
  });

  /** Drops every cached token and check of an owner and role (by slot id). */
  function forget(id: string): void {
    for (const key of issued.get(id)?.values() ?? []) cache.invalidate(key);
    issued.delete(id);
    installationOf.delete(id);
    for (const [k, c] of checks) if (c.slot === id) checks.delete(k);
  }

  function brokerFor(owner: string, role: AppRole): BrokerSlot {
    const read = deps.resolvedApps().get(owner)?.[role];
    if (!read || read.source === 'missing')
      throw new AppTokenError(`no ${role} GitHub App entry for ${owner}`);
    const id = slotId(owner, role);
    const slot = brokers.get(id);
    if (slot && slot.fingerprint === read.fingerprint) return slot;
    // A new or rotated key: the old key's tokens and checks go with it.
    if (slot) forget(id);
    const fresh: BrokerSlot = {
      fingerprint: read.fingerprint,
      broker: createGitHubAppBroker({
        appId: read.entry.appId,
        privateKey: read.entry.pem,
        now,
        onSecret: deps.add,
        ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      }),
    };
    brokers.set(id, fresh);
    return fresh;
  }

  // The one check every mint for a zone goes through (issue #267), over this source's brokers.
  const verifier = createInstallationVerifier({
    resolvedApps: deps.resolvedApps,
    brokerFor(owner, role) {
      try {
        return brokerFor(owner, role);
      } catch {
        return undefined;
      }
    },
  });

  /** The zone's verified key for the use, or a secret-free rejection. */
  async function keyFor(zoneId: string, role: AppRole, use: Use): Promise<TokenKey> {
    const zone = deps.zones().find((z) => z.id === zoneId);
    if (!zone) throw new AppTokenError(`unknown drop zone ${zoneId}`);
    if (ROLE_OF_USE[use] !== role)
      throw new AppTokenError(`a ${use} token is not minted by the ${role} app (${zone.repo})`);
    const checkId = JSON.stringify([zone.id, role]);
    const recorded = appInstallationFor(zone, role);
    const was = checks.get(checkId);
    let verified: VerifiedInstallation;
    try {
      verified = await verifier.verifiedInstallation(zone, role);
    } catch (err) {
      // Neither a refusal nor an error is a pass: what was cached for the old ids goes.
      if (
        was &&
        (!recorded ||
          was.installationId !== recorded.installationId ||
          was.repositoryId !== recorded.repositoryId)
      )
        forget(was.slot);
      throw new AppTokenError(err instanceof Error ? err.message : String(err), { cause: err });
    }
    const id = slotId(verified.owner, role);
    // A changed recorded id: tokens minted under the old one are not handed out again.
    // (A rotated key's were dropped by `brokerFor` already.)
    if (
      was &&
      (was.slot !== id ||
        was.installationId !== verified.installationId ||
        was.repositoryId !== verified.repositoryId)
    )
      forget(was.slot);
    checks.set(checkId, {
      slot: id,
      installationId: verified.installationId,
      repositoryId: verified.repositoryId,
    });
    const ids = installationOf.get(id) ?? new Map<number, number>();
    ids.set(verified.repositoryId, verified.installationId);
    installationOf.set(id, ids);
    return {
      owner: verified.owner,
      role,
      repositoryId: verified.repositoryId,
      use,
      appFingerprint: verified.fingerprint,
      installationId: verified.installationId,
    };
  }

  /** Records a key handed to the cache, so a rotation or changed id drops its token. */
  function issue(key: TokenKey): void {
    const id = slotId(key.owner, key.role as AppRole);
    const keys = issued.get(id) ?? new Map<string, TokenKey>();
    keys.set(tokenKeyId(key), key);
    issued.set(id, keys);
  }

  return {
    verifiedInstallation: (zone, role) => verifier.verifiedInstallation(zone, role),

    provider(zoneId, role, use) {
      let last: TokenKey | undefined;
      return {
        async token() {
          const key = await keyFor(zoneId, role, use);
          issue(key);
          last = key;
          return cache.token(key);
        },
        invalidate() {
          if (last) cache.invalidate(last);
        },
      };
    },

    async fresh(zoneId, role, use) {
      const key = await keyFor(zoneId, role, use);
      const id = slotId(key.owner, role);
      const slot = brokers.get(id);
      const installationId = installationOf.get(id)?.get(key.repositoryId);
      if (!slot || installationId === undefined)
        throw new AppTokenError(`no checked ${role} installation to mint from`);
      // The broker gives the token to `add` before it returns it.
      const minted = await slot.broker.mint({
        installationId,
        repositoryId: key.repositoryId,
        use,
      });
      const { broker } = slot;
      return { ...minted, owner: key.owner, revoke: () => broker.revoke(minted.token) };
    },

    grant(zoneId, role) {
      return async () => {
        const zone = deps.zones().find((z) => z.id === zoneId);
        if (!zone) throw new AppTokenError(`unknown drop zone ${zoneId}`);
        // Every failure past here may quote GitHub's answer: none is passed on, and no `cause`.
        const refused = () =>
          new AppTokenError(
            `could not read the ${role} GitHub App's installation grant on ${zone.repo}`,
          );
        let read: AppGrant;
        try {
          const key = await keyFor(zoneId, role, SERVER_USE[role]);
          const slot = brokers.get(slotId(key.owner, role));
          if (!slot || slot.fingerprint !== key.appFingerprint) throw refused();
          const [owner = '', repo = ''] = zone.repo.split('/');
          const installation = await slot.broker.installationFor(owner, repo);
          if (!installation.installed || installation.installationId !== key.installationId)
            throw refused();
          const expiresAt = cache.expiresAt(key);
          read = {
            permissions: { ...installation.permissions },
            tokenExpiresAt: expiresAt ? expiresAt.toISOString() : null,
          };
        } catch {
          throw refused();
        }
        return read;
      };
    },

    clear() {
      cache.clear();
    },
  };
}
