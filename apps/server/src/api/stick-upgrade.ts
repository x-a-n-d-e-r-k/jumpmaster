// What the server offers a stick and what Command may ask of it (issues #427, #428): the target
// the lease route offers, the reasons a hand-made request is refused, and a stick's upgrade as the
// read API and the sticks page show it.
import { isReleaseVersion, UpgradeOfferSchema } from '@jumpmaster/protocol';
import type { Db } from '../db/open.js';
import {
  getStickUpgrade,
  type Stick,
  stickUpgradeStatus,
  type UpgradeTarget,
  upgradeBehind,
} from '../db/repo.js';
import type { ImageMirror } from '../images/mirror.js';
import { digestName, STICK_IMAGE_NAME } from '../install/stick-sh.js';
import {
  NO_TARGET_REASON,
  REINSTALL_REASON,
  SIGNED_POLICY_REASON,
  type StickUpgradeView,
} from '../stick-upgrade-words.js';

export {
  NO_TARGET_REASON,
  REINSTALL_REASON,
  SIGNED_POLICY_REASON,
  type StickUpgradeView,
} from '../stick-upgrade-words.js';

/**
 * What sticks are offered (issue #427): the server's own release and the `jumpmaster-stick` image
 * of its current lock, once the mirror holds it complete. None when the version is no release, or
 * a lock or mirror read throws (fail closed).
 */
export function upgradeTargetOf(
  images: Pick<ImageMirror, 'lookup' | 'status'> | undefined,
  release: string,
): UpgradeTarget | null {
  if (!images || !isReleaseVersion(release)) return null;
  try {
    const image = images.status().images.find((i) => i.name === STICK_IMAGE_NAME && i.current);
    if (!image) return null;
    const held = images.lookup(image.name, image.digest);
    if (!held.listed || !held.complete) return null;
    // Only an offer the stick would accept: a release and a jumpmaster-stick digest reference.
    const offer = UpgradeOfferSchema.safeParse({
      version: release,
      image: digestName(image.ref, image.digest),
    });
    return offer.success ? offer.data : null;
  } catch {
    return null;
  }
}

type UpgradeFacts = Pick<Stick, 'capabilities' | 'imagePolicy' | 'version'>;

/** Why the stick cannot be upgraded in place to `target`, or null when it can. */
export function upgradeRefusal(stick: UpgradeFacts, target: UpgradeTarget | null): string | null {
  if (!target) return NO_TARGET_REASON;
  if (!upgradeBehind(stick.version, target)) return `already on v${stick.version ?? 'unknown'}`;
  return ineligibleReason(stick);
}

/** Why the stick cannot upgrade in place at all, or null when it can. */
function ineligibleReason(stick: Pick<Stick, 'capabilities' | 'imagePolicy'>): string | null {
  if (!stick.capabilities.includes('upgrade-v1')) return REINSTALL_REASON;
  if (stick.imagePolicy !== 'signed') return SIGNED_POLICY_REASON;
  return null;
}

export function stickUpgradeView(
  db: Db,
  stick: Pick<Stick, 'id' | 'capabilities' | 'imagePolicy' | 'version'>,
  target: UpgradeTarget | null,
): StickUpgradeView {
  const st = stickUpgradeStatus(db, stick, target);
  if (st.status === 'none' || !target) return null;
  const row = getStickUpgrade(db, stick.id);
  const requested =
    row && row.targetVersion === target.version && st.status !== 'up-to-date'
      ? row.requestedBy
      : null;
  const reason =
    'reason' in st ? st.reason : st.status === 'needs-reinstall' ? ineligibleReason(stick) : null;
  return { status: st.status, target: target.version, reason, requestedBy: requested };
}
