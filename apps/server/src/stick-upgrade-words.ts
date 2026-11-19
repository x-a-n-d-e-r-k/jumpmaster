// A stick's upgrade in words (issue #428), for the sticks page and `ctl sticks`: no database or
// server import, so ctl reads it as it is.

export const NO_TARGET_REASON = 'the server has no release to offer';
export const REINSTALL_REASON =
  'this stick is older than in-place upgrades: reinstall it once with a new code';
export const SIGNED_POLICY_REASON = 'in-place upgrade needs the signed image policy';

/** A stick's upgrade as `GET /api/control/sticks` and the sticks page show it; null: no target. */
export type StickUpgradeView = {
  status: 'up-to-date' | 'available' | 'needs-reinstall' | 'upgrading' | 'failed' | 'refused';
  /** The version it is offered. */
  target: string;
  /** Why it failed, was refused, or cannot upgrade in place; else null. */
  reason: string | null;
  /** Who asked for the upgrade to the target, while there is such a request; else null. */
  requestedBy: 'auto' | 'command' | null;
} | null;

/** Where the stick stands, in words: "up to date", "update available: v0.6.0", and so on. */
export function upgradeWords(u: NonNullable<StickUpgradeView>): string {
  const v = `v${u.target}`;
  switch (u.status) {
    case 'up-to-date':
      return 'up to date';
    case 'available':
      return `update available: ${v}`;
    case 'needs-reinstall':
      // A capable stick under the allowlist policy is not old: say what it needs instead.
      return u.reason === null || u.reason === REINSTALL_REASON
        ? 'older than in-place upgrades: reinstall to upgrade'
        : u.reason;
    case 'upgrading':
      return `upgrading to ${v}`;
    case 'failed':
    case 'refused':
      return `upgrade to ${v} ${u.status}: ${u.reason ?? 'unknown'}`;
  }
}
