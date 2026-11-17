/**
 * The readyLabel pin (#198). The default ready label became `drop-ready`; a zone that existed
 * before the upgrade and relied on the old default gets the old label written explicitly, so its
 * ready issues keep starting. This module is the one non-test source that names the old label.
 */

/** The default ready label before #198. */
export const LEGACY_READY_LABEL = 'agent-ready';

/** The note on the config revision the pin records. */
export const READY_LABEL_PIN_NOTE = `readyLabel pinned to ${LEGACY_READY_LABEL} (the default became drop-ready)`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const zonesOf = (doc: Record<string, unknown>): unknown[] =>
  Array.isArray(doc.dropZones) ? doc.dropZones : [];

const unset = (z: unknown): z is Record<string, unknown> & { id: string } =>
  isObject(z) && typeof z.id === 'string' && !Object.hasOwn(z, 'readyLabel');

/** The ids of the zones in a config document that set no readyLabel. */
export function unpinnedZoneIds(doc: Record<string, unknown>): string[] {
  return zonesOf(doc)
    .filter(unset)
    .map((z) => z.id);
}

/**
 * The document with `readyLabel` set to the old default on each zone in `ids` that sets none, and
 * the ids it pinned. An explicit value is never touched; the input is not changed.
 */
export function pinReadyLabels(
  doc: Record<string, unknown>,
  ids: readonly string[],
): { doc: Record<string, unknown>; pinned: string[] } {
  const pinned: string[] = [];
  const zones = zonesOf(doc).map((z) => {
    if (!unset(z) || !ids.includes(z.id)) return z;
    pinned.push(z.id);
    return { ...z, readyLabel: LEGACY_READY_LABEL };
  });
  return pinned.length === 0 ? { doc, pinned } : { doc: { ...doc, dropZones: zones }, pinned };
}
