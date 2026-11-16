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
import { serverScrubSet } from './scrub-set.js';

export interface AppBrokers {
  brokerFor(owner: string, role: AppRole): GitHubAppBroker | undefined;
}

export function createAppBrokers(o: {
  apps: () => ResolvedApps;
  apiBase?: string;
  onSecret?: (s: string) => void;
}): AppBrokers {
  const onSecret =
    o.onSecret ??
    ((s: string) => {
      if (s.includes('-----BEGIN')) serverScrubSet.addPem(s);
      else serverScrubSet.add(s);
    });
  const slots = new Map<string, { fingerprint: string; broker: GitHubAppBroker }>();

  return {
    brokerFor(owner, role) {
      const read = o.apps().get(owner.toLowerCase())?.[role];
      if (!read || read.source === 'missing') return undefined;
      const id = JSON.stringify([owner.toLowerCase(), role]);
      const slot = slots.get(id);
      if (slot && slot.fingerprint === read.fingerprint) return slot.broker;
      const broker = createGitHubAppBroker({
        appId: read.entry.appId,
        privateKey: read.entry.pem,
        onSecret,
        ...(o.apiBase ? { apiBase: o.apiBase } : {}),
      });
      slots.set(id, { fingerprint: read.fingerprint, broker });
      return broker;
    },
  };
}
