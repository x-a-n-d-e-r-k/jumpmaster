/**
 * The difference between two editable documents, for the History page, an apply's `changed` list
 * and `subscribe`. Zones are matched by `id` (`dropZones[main].readyLabel`), so a reorder is no
 * change; every other array is matched by index (`gates.0.run`). A key or zone present on one side
 * only is one change carrying its whole value. Documents hold no secret, so neither does a diff.
 * The guarded-path classifier (Task 3) judges the documents themselves, not this list.
 */
export type Change = { path: string; from: unknown; to: unknown };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const join = (base: string, key: string): string => (base === '' ? key : `${base}.${key}`);

type Zoneish = { id: string };
const zoneList = (v: unknown): Zoneish[] | null =>
  Array.isArray(v) && v.every((z) => isObject(z) && typeof z.id === 'string')
    ? (v as Zoneish[])
    : null;

function walk(path: string, a: unknown, b: unknown, out: Change[]): void {
  // No zones and an absent list are the same document: zones are always named one by one.
  if (path === 'dropZones' && (a === undefined) !== (b === undefined)) {
    walk(path, a ?? [], b ?? [], out);
    return;
  }
  if (a === undefined && b === undefined) return;
  if (a === undefined || b === undefined) {
    out.push({ path, from: a, to: b });
    return;
  }
  if (path === 'dropZones') {
    const za = zoneList(a);
    const zb = zoneList(b);
    if (za && zb) {
      const ids = [...new Set([...za.map((z) => z.id), ...zb.map((z) => z.id)])];
      for (const id of ids)
        walk(
          `dropZones[${id}]`,
          za.find((z) => z.id === id),
          zb.find((z) => z.id === id),
          out,
        );
      return;
    }
  }
  if (isObject(a) && isObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])])
      walk(join(path, key), a[key], b[key], out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      walk(join(path, String(i)), a[i], b[i], out);
    return;
  }
  if (a !== b) out.push({ path, from: a, to: b });
}

/**
 * RFC 7396 JSON merge patch: objects merge key by key, `null` removes a key, and anything else
 * (arrays included) replaces. Returns a new value; `target` is unchanged.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    // Own properties only, read and written: `out[key] = …` with key `__proto__` would set the
    // prototype, and zod would then read values the stored document does not hold. The key stays
    // an own property, which validation refuses by name.
    const current = Object.hasOwn(out, key) ? out[key] : undefined;
    Object.defineProperty(out, key, {
      value: mergePatch(current, value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The config's PATCH: RFC 7396 everywhere except `dropZones`, whose elements are matched by `id`.
 * A zone element is a merge patch for the zone with that id (nulls remove its keys); an id not in
 * the document is appended, an add; zones the patch does not name are kept. A patch never removes
 * a zone: that is `DELETE /api/control/zones/:id`, with its drained rule. Anything that is not a
 * list of objects with string ids is passed on as given, for the schema to refuse by path.
 */
export function mergeConfigPatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch) || !Object.hasOwn(patch, 'dropZones')) return mergePatch(target, patch);
  const { dropZones: zonesPatch, ...rest } = patch;
  const out = mergePatch(target, rest) as Record<string, unknown>;
  const current = isObject(target) && Array.isArray(target.dropZones) ? target.dropZones : [];
  if (!Array.isArray(zonesPatch)) {
    out.dropZones = structuredClone(zonesPatch);
    return out;
  }
  const zones = structuredClone(current) as unknown[];
  for (const z of zonesPatch) {
    const id = isObject(z) && typeof z.id === 'string' ? z.id : undefined;
    const at = id === undefined ? -1 : zones.findIndex((x) => isObject(x) && x.id === id);
    if (at < 0) zones.push(mergePatch(undefined, z));
    else zones[at] = mergePatch(zones[at], z);
  }
  out.dropZones = zones;
  return out;
}

export function diff(a: unknown, b: unknown): Change[] {
  const out: Change[] = [];
  walk('', a, b, out);
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
