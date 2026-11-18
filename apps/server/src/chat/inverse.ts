import { FLAGS } from '../config/catalog.js';
import { canonicalJson } from '../config/revisions.js';

/**
 * A setting change from the chat and its Undo (#336, Task 15). The chat names settings by their
 * catalog path (`dropZones[].maxOpenPrs` with a zone, `pollSeconds` without); a change is a config
 * patch of just those keys, and its Undo is the inverse patch of just those keys, applied through
 * the config store like any other change, never a rollback of the whole revision.
 *
 * Document paths name one key in the editable document: `pollSeconds`, `usage.x`, or a zone's
 * `dropZones[<id>].crew.refutePromotes` (zones by id, as the store's `changed` list names them).
 */

const ZONE_PREFIX = 'dropZones[].';
const ZONE_PATH = /^dropZones\[([a-z0-9-]+)\]\.(.+)$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A setting the chat may name: one the catalog lists, in its scope, other than a zone's id. */
const SETTING_PATHS = new Set(FLAGS.map((f) => f.path).filter((p) => p !== `${ZONE_PREFIX}id`));

/** Why a change cannot be built; its message is the server's own, never naming the model's keys. */
export class SettingError extends Error {}

const zonesOf = (doc: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(doc.dropZones) ? doc.dropZones : []).filter(isRecord);

/** The value at a document path, or undefined where any level is missing. */
export function valueAt(doc: Record<string, unknown>, path: string): unknown {
  const m = ZONE_PATH.exec(path);
  let v: unknown = m ? zonesOf(doc).find((z) => z.id === m[1]) : doc;
  for (const k of (m ? (m[2] as string) : path).split('.')) {
    if (!isRecord(v) || !Object.hasOwn(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

/** Sets `a.b.c` in `into`, creating the levels on the way. */
function put(into: Record<string, unknown>, key: string, value: unknown): void {
  const keys = key.split('.');
  let at = into;
  for (const k of keys.slice(0, -1)) {
    const next = Object.hasOwn(at, k) ? at[k] : undefined;
    if (!isRecord(next)) {
      const fresh: Record<string, unknown> = {};
      Object.defineProperty(at, k, {
        value: fresh,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      at = fresh;
    } else at = next;
  }
  Object.defineProperty(at, keys.at(-1) as string, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * The config patch (zones by id, as `mergeConfigPatch` reads it) that sets each document path to
 * its value; `null` removes the key, so the setting runs with its default again.
 */
function patchOf(entries: [path: string, value: unknown][]): Record<string, unknown> {
  const install: Record<string, unknown> = {};
  const zones = new Map<string, Record<string, unknown>>();
  for (const [path, value] of entries) {
    const m = ZONE_PATH.exec(path);
    if (!m) {
      put(install, path, value);
      continue;
    }
    const id = m[1] as string;
    const zone = zones.get(id) ?? {};
    zones.set(id, zone);
    put(zone, m[2] as string, value);
  }
  // The id last: no key of the change can name another zone.
  const dropZones = [...zones].map(([id, z]) => ({ ...z, id }));
  return dropZones.length > 0 ? { ...install, dropZones } : install;
}

/** The document path a catalog path names in a zone (or the install when `zoneId` is absent). */
export function settingDocPath(zoneId: string | undefined, catalogPath: string): string {
  const zonePath = catalogPath.startsWith(ZONE_PREFIX);
  if (!SETTING_PATHS.has(catalogPath) || zonePath !== (zoneId !== undefined))
    throw new SettingError(
      zoneId === undefined
        ? 'not a setting of the install: name an install path from get_settings'
        : 'not a setting of a zone: name a zone path from get_settings',
    );
  return zonePath ? `dropZones[${zoneId}].${catalogPath.slice(ZONE_PREFIX.length)}` : catalogPath;
}

/**
 * The patch a chat's `change_setting` applies: each catalog path set to its value (`null` resets
 * it to its default), in the zone `zoneId` names or the install. Throws `SettingError` for a path
 * the catalog does not name in that scope, or a zone the document does not hold (a patch for an
 * absent id would add a zone).
 */
export function settingPatch(
  doc: Record<string, unknown>,
  zoneId: string | undefined,
  set: Record<string, unknown>,
): unknown {
  const keys = Object.keys(set);
  if (keys.length === 0) throw new SettingError('nothing to set');
  if (zoneId !== undefined && !zonesOf(doc).some((z) => z.id === zoneId))
    throw new SettingError('unknown zone');
  return patchOf(keys.map((k) => [settingDocPath(zoneId, k), set[k]]));
}

/**
 * The inverse of a change, for its Undo: the patch that puts each of `paths` back to its value in
 * `before` (removed where it was unset), and what each must still hold, as in `after`, for the Undo
 * to apply. Other paths are not touched, so a later change to them stays.
 */
export function inversePatch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  paths: string[],
): { patch: unknown; expect: Record<string, unknown> } {
  const patch = patchOf(paths.map((p) => [p, valueAt(before, p) ?? null]));
  const expect: Record<string, unknown> = {};
  for (const p of paths) expect[p] = valueAt(after, p) ?? null;
  return { patch, expect };
}

/** The paths whose value moved since the change (`expect`): an Undo of them is refused. */
export function changedSince(
  doc: Record<string, unknown>,
  expect: Record<string, unknown>,
): string[] {
  return Object.entries(expect)
    .filter(([p, v]) => canonicalJson(valueAt(doc, p) ?? null) !== canonicalJson(v))
    .map(([p]) => p);
}
