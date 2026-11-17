/**
 * One GitHub App broker per owner and role (spec docs/superpowers/specs/2026-11-13-github-app-auth.md,
 * §4.2 and §13 Task 5), built from the `resolvedApps()` entry and rebuilt when the entry's
 * fingerprint changes (key rotation). A missing or undecryptable entry has no broker.
 *
 * Every secret a broker holds or makes (the PEM, each JWT, each token) goes to `onSecret`, by
 * default the server scrub set, before it is used.
 */
import type { AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { createGitHubAppBroker, type GitHubAppBroker } from './github-app.js';
import { createInstallationVerifier, type InstallationVerifier } from './installation-verifier.js';
import { serverScrubSet } from './scrub-set.js';

export interface AppBrokers extends InstallationVerifier {
  brokerFor(owner: string, role: AppRole): GitHubAppBroker | undefined;
}

export function createAppBrokers(o: {
  apps: () => ResolvedApps;
  apiBase?: string;
  onSecret?: (s: string) => void;
  /**
   * The check every mint for a zone goes through (issue #267); main.ts passes the token source's,
   * so one cache serves both. Absent, one is built over these brokers.
   */
  verifier?: InstallationVerifier;
}): AppBrokers {
  const onSecret =
    o.onSecret ??
    ((s: string) => {
      if (s.includes('-----BEGIN')) serverScrubSet.addPem(s);
      else serverScrubSet.add(s);
    });
  const slots = new Map<string, { fingerprint: string; broker: GitHubAppBroker }>();

  function slotFor(owner: string, role: AppRole) {
    const read = o.apps().get(owner.toLowerCase())?.[role];
    if (!read || read.source === 'missing') return undefined;
    const id = JSON.stringify([owner.toLowerCase(), role]);
    const slot = slots.get(id);
    if (slot && slot.fingerprint === read.fingerprint) return slot;
    const fresh = {
      fingerprint: read.fingerprint,
      broker: createGitHubAppBroker({
        appId: read.entry.appId,
        privateKey: read.entry.pem,
        onSecret,
        ...(o.apiBase ? { apiBase: o.apiBase } : {}),
      }),
    };
    slots.set(id, fresh);
    return fresh;
  }
  const verifier =
    o.verifier ?? createInstallationVerifier({ resolvedApps: o.apps, brokerFor: slotFor });

  return {
    brokerFor: (owner, role) => slotFor(owner, role)?.broker,
    verifiedInstallation: (zone, role) => verifier.verifiedInstallation(zone, role),
  };
}
