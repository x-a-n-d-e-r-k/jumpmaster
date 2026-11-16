/**
 * The server's GitHub App token source (spec docs/superpowers/specs/2026-11-13-github-app-auth.md,
 * §4.2, §4.4 and §13 Task 7). For a zone, a role and a use it gives a `TokenProvider` whose tokens
 * are minted by that role's app on the zone's owner, narrowed to the zone's repository and the use's
 * permissions, and held in one process-wide `TokenCache`.
 *
 * - One broker per owner and role, built from the `resolvedApps()` entry and rebuilt when the
 *   entry's fingerprint changes (key rotation).
 * - The server never trusts an installation id it is handed (§4.2): before the first mint for a
 *   zone and role, `installationFor` must find the repository installed under the recorded id.
 *   A passed check is remembered until the recorded ids or the entry's fingerprint change.
 * - A changed fingerprint or recorded installation id drops that owner and role's cached tokens.
 * - No PAT fallback, ever: a starter zone, an undecryptable entry or a missing installation
 *   rejects (an identity swap is what `credentialFor` refuses too).
 *
 * Every JWT and token goes to `add` (the scrub set) before it is used, the PEM with the broker.
 * No error raised here quotes a secret: messages name the zone's repository and the role only.
 */
import type { DropZoneConfig } from '../config.js';
import type { AppRole } from '../vault/github-app-entries.js';
import { appInstallationFor, credentialFor, type ResolvedApps } from '../vault/resolution.js';
import type { TokenProvider } from './github.js';
import { createGitHubAppBroker, type GitHubAppBroker, type Use } from './github-app.js';
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

export interface AppTokenSource {
  /** A provider of the zone's `use` tokens from its `role` app; nothing is called until `token()`. */
  provider(zoneId: string, role: AppRole, use: Use): TokenProvider;
}

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

interface Check {
  /** The owner and role's slot id the check was made with. */
  slot: string;
  installationId: number;
  repositoryId: number;
  fingerprint: string;
  /** Settles once the check passed; a failed check is forgotten, so the next call retries it. */
  passed: Promise<void>;
}

const slotId = (owner: string, role: AppRole) => JSON.stringify([owner, role]);
const tokenKeyId = (k: TokenKey) => JSON.stringify([k.owner, k.role, k.repositoryId, k.use]);

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
      if (!slot || installationId === undefined)
        throw new AppTokenError(`no checked ${role} installation to mint from`);
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

  /** The zone's verified key for the use, or a secret-free rejection. */
  async function keyFor(zoneId: string, role: AppRole, use: Use): Promise<TokenKey> {
    const zone = deps.zones().find((z) => z.id === zoneId);
    if (!zone) throw new AppTokenError(`unknown drop zone ${zoneId}`);
    const where = `${zone.repo} (${role})`;
    if (ROLE_OF_USE[use] !== role)
      throw new AppTokenError(`a ${use} token is not minted by the ${role} app (${zone.repo})`);
    if ((zone.identity ?? 'two-bot') !== 'two-bot')
      throw new AppTokenError(`${where}: a starter zone uses personal access tokens, not an app`);
    const resolution = credentialFor(zone, role, deps.resolvedApps());
    if (resolution.ref.kind !== 'github-app')
      throw new AppTokenError(`${where}: the owner has no ${role} GitHub App`);
    if (resolution.problem === 'undecryptable')
      throw new AppTokenError(`${where}: the ${role} GitHub App entry can't be decrypted`);
    const owner = resolution.ref.owner;
    const recorded = appInstallationFor(zone, role);
    if (!recorded)
      throw new AppTokenError(`${where}: the zone records no ${role} app installation`);

    const slot = brokerFor(owner, role);
    const id = slotId(owner, role);
    const checkId = JSON.stringify([zone.id, role]);
    let check = checks.get(checkId);
    const same =
      check !== undefined &&
      check.slot === id &&
      check.installationId === recorded.installationId &&
      check.repositoryId === recorded.repositoryId &&
      check.fingerprint === slot.fingerprint;
    if (!same) {
      // A changed recorded id: tokens minted under the old one are not handed out again.
      // (A rotated key's were dropped by `brokerFor` already.)
      if (check) forget(check.slot);
      const [repoOwner = '', repoName = ''] = zone.repo.split('/');
      const passed = (async () => {
        let found: Awaited<ReturnType<GitHubAppBroker['installationFor']>>;
        try {
          found = await slot.broker.installationFor(repoOwner, repoName);
        } catch (err) {
          throw new AppTokenError(`${where}: could not check the ${role} app installation`, {
            cause: err,
          });
        }
        if (!found.installed)
          throw new AppTokenError(`${where}: the ${role} GitHub App is not installed`);
        if (found.installationId !== recorded.installationId)
          throw new AppTokenError(
            `${where}: the ${role} app's installation does not match the one the zone records`,
          );
        const ids = installationOf.get(id) ?? new Map<number, number>();
        ids.set(recorded.repositoryId, recorded.installationId);
        installationOf.set(id, ids);
      })();
      check = { slot: id, ...recorded, fingerprint: slot.fingerprint, passed };
      checks.set(checkId, check);
      const mine = check;
      passed.catch(() => {
        if (checks.get(checkId) === mine) checks.delete(checkId);
      });
    }
    await check!.passed;

    const key: TokenKey = { owner, role, repositoryId: recorded.repositoryId, use };
    const keys = issued.get(id) ?? new Map<string, TokenKey>();
    keys.set(tokenKeyId(key), key);
    issued.set(id, keys);
    return key;
  }

  return {
    provider(zoneId, role, use) {
      let last: TokenKey | undefined;
      return {
        async token() {
          const key = await keyFor(zoneId, role, use);
          last = key;
          return cache.token(key);
        },
        invalidate() {
          if (last) cache.invalidate(last);
        },
      };
    },
  };
}
