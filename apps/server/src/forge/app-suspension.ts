/**
 * The kill switch's installation suspension (spec docs/superpowers/specs/2026-11-13-github-app-auth.md,
 * §4.2 "Kill switch", and the spike's F22): engaging suspends every GitHub App installation a
 * zone records, which kills live tokens and refuses new mints; releasing unsuspends them.
 *
 * Each call has its own deadline and fails on its own: one stalled or refusing installation never
 * stops the others. A result names only the owner, role, installation id and HTTP status (0 for a
 * network error, a timeout or a missing broker), never GitHub's message, a JWT or a key.
 */
import { APP_ROLES, type AppRole } from '../vault/github-app-entries.js';
import {
  appInstallationFor,
  credentialFor,
  type ResolvedApps,
  type ZoneForAppInstallation,
  type ZoneForCredentials,
} from '../vault/resolution.js';
import { type GitHubAppBroker, GitHubAppError } from './github-app.js';

export type AppInstallation = { owner: string; role: AppRole; installationId: number };

export type SuspensionFailure = AppInstallation & { status: number };

export type SuspensionResult = { ok: number; failed: SuspensionFailure[] };

export type BrokerFor = (owner: string, role: AppRole) => GitHubAppBroker | undefined;

export const SUSPENSION_TIMEOUT_MS = 10_000;

/**
 * Every distinct recorded installation of a two-bot zone's role that resolves to an app, once per
 * installation id, in zone then role order.
 */
export function appInstallationsOf(
  zones: readonly (ZoneForCredentials & ZoneForAppInstallation)[],
  apps: ResolvedApps,
): AppInstallation[] {
  const out: AppInstallation[] = [];
  const seen = new Set<number>();
  for (const zone of zones) {
    for (const role of APP_ROLES) {
      const { ref } = credentialFor(zone, role, apps);
      if (ref.kind !== 'github-app') continue;
      const recorded = appInstallationFor(zone, role);
      if (!recorded || seen.has(recorded.installationId)) continue;
      seen.add(recorded.installationId);
      out.push({ owner: ref.owner, role, installationId: recorded.installationId });
    }
  }
  return out;
}

const TIMED_OUT = Symbol('timed out');

/** The status a failed call reports: GitHub's HTTP status, else 0. */
const statusOf = (e: unknown): number => (e instanceof GitHubAppError ? e.status : 0);

async function each(
  list: readonly AppInstallation[],
  brokerFor: BrokerFor,
  act: (b: GitHubAppBroker, id: number) => Promise<void>,
  timeoutMs: number,
): Promise<SuspensionResult> {
  const outcomes = await Promise.all(
    list.map(async (inst): Promise<SuspensionFailure | null> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const broker = brokerFor(inst.owner, inst.role);
        if (!broker) return { ...inst, status: 0 };
        const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        });
        const r = await Promise.race([act(broker, inst.installationId), deadline]);
        return r === TIMED_OUT ? { ...inst, status: 0 } : null;
      } catch (e) {
        return { ...inst, status: statusOf(e) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  const failed = outcomes.filter((o): o is SuspensionFailure => o !== null);
  return { ok: list.length - failed.length, failed };
}

/** Suspends each listed installation, concurrently, each within the deadline. */
export function suspendAll(
  list: readonly AppInstallation[],
  brokerFor: BrokerFor,
  o: { timeoutMs?: number } = {},
): Promise<SuspensionResult> {
  return each(list, brokerFor, (b, id) => b.suspend(id), o.timeoutMs ?? SUSPENSION_TIMEOUT_MS);
}

/** Unsuspends each listed installation, concurrently, each within the deadline. */
export function unsuspendAll(
  list: readonly AppInstallation[],
  brokerFor: BrokerFor,
  o: { timeoutMs?: number } = {},
): Promise<SuspensionResult> {
  return each(list, brokerFor, (b, id) => b.unsuspend(id), o.timeoutMs ?? SUSPENSION_TIMEOUT_MS);
}
