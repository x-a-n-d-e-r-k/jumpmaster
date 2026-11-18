import type { z } from 'zod';
import { EditableSchema } from '../config.js';

type Def = Record<string, unknown> & { type: string };

/** A schema's internal definition (zod 4). */
export const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** The schema under its default, optional, nullable and prefault wrappers. */
export function unwrapLeaf(s: z.ZodType): z.ZodType {
  let cur = s;
  for (;;) {
    const def = defOf(cur);
    if (
      def.type === 'default' ||
      def.type === 'optional' ||
      def.type === 'nullable' ||
      def.type === 'prefault'
    )
      cur = def.innerType as z.ZodType;
    else return cur;
  }
}

/**
 * Every leaf of the editable schema, as the guard tables name paths (`dropZones[].crew.enabled`,
 * `pollSeconds`), with its unwrapped schema. Objects are descended; the `dropZones` array is
 * descended as `dropZones[]`; anything else (a scalar, another array, a tuple, a record) is a leaf.
 * Sorted by path.
 */
export function schemaLeaves(): Map<string, z.ZodType> {
  const out: [string, z.ZodType][] = [];
  const walk = (s: z.ZodType, path: string): void => {
    const leaf = unwrapLeaf(s);
    const def = defOf(leaf);
    if (def.type === 'object') {
      for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>))
        walk(v, path ? `${path}.${k}` : k);
      return;
    }
    if (def.type === 'array' && path === 'dropZones')
      return walk(def.element as z.ZodType, 'dropZones[]');
    out.push([path, leaf]);
  };
  walk(EditableSchema, '');
  return new Map(out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
