import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { DropZoneObject, EditableSchema, IDENTITIES } from '../config.js';
import {
  FLAGS,
  type FlagEntry,
  type FlagGroup,
  type FlagKind,
  type FlagRow,
  flagRows,
} from './catalog.js';
import { GUARDED_PATHS, NOT_GUARDED, REFUSED_PATHS, SESSION_FORBIDDEN } from './guarded.js';
import { defOf, schemaLeaves } from './schema-leaves.js';

const ZONE = 'dropZones[].';
const minimalZone = { id: 'z', repo: 'o/r', gates: [] };
const GROUP_ORDER: FlagGroup[] = [
  'crew',
  'retries',
  'pace',
  'labels',
  'models',
  'transcripts',
  'safety',
  'other',
];

const zoneRows = (doc: Record<string, unknown> = minimalZone, install = {}) =>
  flagRows('zone', doc, install);
const installRows = (doc: Record<string, unknown> = {}) => flagRows('install', doc, doc);
const row = (rows: FlagRow[], key: string): FlagRow => {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no row for ${key}`);
  return r;
};
const scopeOf = (path: string) => (path.startsWith(ZONE) ? 'zone' : 'install');
const keyOf = (path: string) => (path.startsWith(ZONE) ? path.slice(ZONE.length) : path);
/** The row of an entry, from a minimal document of its scope. */
const rowOf = (e: FlagEntry): FlagRow =>
  row(scopeOf(e.path) === 'zone' ? zoneRows() : installRows(), keyOf(e.path));

/** The control a leaf schema allows, derived here independently of the catalog's entries. */
function derivedKind(s: z.ZodType): FlagKind {
  const def = defOf(s);
  switch (def.type) {
    case 'boolean':
      return 'bool';
    case 'number':
      return 'number';
    case 'string':
      return 'text';
    case 'enum':
    case 'literal':
      return 'select';
    case 'array':
      return defOf(def.element as z.ZodType).type === 'string' ? 'list' : 'elsewhere';
    default:
      return 'elsewhere';
  }
}

/** The table that names a path, as a guard. */
function tableGuard(path: string): string[] {
  return [
    ...GUARDED_PATHS.filter((g) => g.path === path).map(() => 'guarded'),
    ...SESSION_FORBIDDEN.filter((g) => g.path === path).map(() => 'browser-forbidden'),
    ...REFUSED_PATHS.filter((g) => g.path === path).map(() => 'refused'),
    ...NOT_GUARDED.filter((g) => g.path === path).map(() => 'free'),
  ];
}

const completeness = (flags: readonly FlagEntry[]) => {
  const paths = flags.map((f) => f.path);
  expect(new Set(paths).size).toBe(paths.length);
  expect([...paths].sort()).toEqual([...schemaLeaves().keys()]);
};

describe('completeness', () => {
  test('every schema leaf has exactly one entry, and every entry is a leaf', () => {
    completeness(FLAGS);
  });

  test('the comparison fails when an entry is missing', () => {
    expect(() => completeness(FLAGS.slice(1))).toThrow();
    expect(() => completeness([...FLAGS, FLAGS[0] as FlagEntry])).toThrow();
  });

  test('flagRows gives one row per entry of its scope', () => {
    const zone = FLAGS.filter((f) => f.path.startsWith(ZONE)).length;
    expect(zoneRows()).toHaveLength(zone);
    expect(installRows()).toHaveLength(FLAGS.length - zone);
  });
});

describe('kinds, options and bounds from the schema', () => {
  const leaves = schemaLeaves();

  test("every entry's kind is the schema's; only id and server.publicUrl choose elsewhere", () => {
    for (const e of FLAGS) {
      const derived = derivedKind(leaves.get(e.path) as z.ZodType);
      if (['dropZones[].id', 'server.publicUrl'].includes(e.path)) {
        expect(e.kind, e.path).toBe('elsewhere');
        expect(derived, e.path).not.toBe('elsewhere');
      } else expect(e.kind, e.path).toBe(derived);
      if (e.kind === 'elsewhere') expect(e.elsewhere ?? '', e.path).toMatch(/^.{10,}\.$/);
      else expect(e.elsewhere, e.path).toBeUndefined();
    }
    expect(FLAGS.find((f) => f.path === 'dropZones[].id')?.elsewhere).toBe(
      'Fixed once the zone exists: remove the zone and add it again to change it.',
    );
    expect(FLAGS.find((f) => f.path === 'server.publicUrl')?.elsewhere).toBe(
      'Changed under Other machines, on System, Server.',
    );
    expect(FLAGS.find((f) => f.path === 'usage.probeJitterSeconds')?.elsewhere).toBe(
      'Changed with jumpmaster ctl settings set or in the config file.',
    );
  });

  test('select rows carry the enum values; other rows carry none', () => {
    for (const e of FLAGS) {
      const r = rowOf(e);
      if (e.kind !== 'select') {
        expect(r.options, e.path).toBeUndefined();
        continue;
      }
      const def = defOf(leaves.get(e.path) as z.ZodType);
      const values =
        def.type === 'literal'
          ? (def.values as unknown[])
          : Object.values(def.entries as Record<string, string>);
      expect(r.options, e.path).toEqual(values);
    }
    expect(row(zoneRows(), 'identity').options).toEqual([...IDENTITIES]);
    expect(row(zoneRows(), 'mergeMethod').options).toEqual(['squash']);
  });

  test('a number has its bounds and integrality, and a positive bound is exclusive', () => {
    const rows = zoneRows();
    expect(row(rows, 'crew.cycleMinutes')).toMatchObject({ min: 0 });
    expect(row(rows, 'crew.cycleMinutes').integer).toBeFalsy();
    expect(row(rows, 'crew.maxDropsPerDay')).toMatchObject({ min: 0, integer: true });
    expect(row(rows, 'maxConcurrentImplement')).toMatchObject({ min: 1, integer: true });
    expect(row(rows, 'maxOpenPrs')).toMatchObject({ min: 1, max: 50, integer: true });
    expect(row(rows, 'mergeReservationMinutes')).toMatchObject({ min: 0, max: 240 });
    const install = installRows();
    expect(row(install, 'usage.throttleUtilization')).toMatchObject({ min: 0, max: 1 });
    expect(row(install, 'pollSeconds').integer).toBe(true);
    // Only number rows carry bounds.
    for (const e of FLAGS)
      if (e.kind !== 'number') {
        const r = rowOf(e);
        expect([r.min, r.max, r.integer], e.path).toEqual([undefined, undefined, undefined]);
      }
  });

  test('a number row accepts its bounds and the schema refuses just outside them', () => {
    for (const e of FLAGS.filter((f) => f.kind === 'number')) {
      const r = rowOf(e);
      const s = leaves.get(e.path) as z.ZodType;
      if (r.min !== undefined) {
        // A non-integer's exclusive bound is the control's floor; the server refuses the bound.
        const lowest = r.integer ? r.min : r.min + 0.001;
        expect(s.safeParse(lowest).success, `${e.path} min`).toBe(true);
        expect(s.safeParse(r.min - (r.integer ? 1 : 0.5)).success, `${e.path} below`).toBe(false);
      }
      if (r.max !== undefined) expect(s.safeParse(r.max).success, `${e.path} max`).toBe(true);
    }
  });
});

describe('values and defaults', () => {
  test('a raw zone runs with the schema defaults', () => {
    const rows = zoneRows();
    const refute = row(rows, 'crew.refutePromotes');
    expect(refute.value).not.toBeUndefined();
    expect(refute.value).toBe(DropZoneObject.parse(minimalZone).crew.refutePromotes);
    expect(refute).toMatchObject({ explicit: false, guard: 'guarded' });
    expect(refute.entry).toMatchObject({ group: 'crew', kind: 'bool' });
    expect(refute.value).toEqual(refute.defaultValue);
    expect(row(rows, 'egress.mode')).toMatchObject({ value: 'off', defaultValue: 'off' });
    expect(row(rows, 'egress.allow')).toMatchObject({ value: [], defaultValue: [] });
  });

  test('a set value is what the zone runs with', () => {
    const r = row(
      zoneRows({ ...minimalZone, crew: { refutePromotes: true } }),
      'crew.refutePromotes',
    );
    expect(r).toMatchObject({ explicit: true, value: true });
  });

  test('defaults are read from the schema, not copied', () => {
    const parsed = DropZoneObject.parse(minimalZone);
    const rows = zoneRows({ ...minimalZone, crew: { maxDropsPerDay: 7 } });
    expect(row(rows, 'crew.maxDropsPerDay')).toMatchObject({
      value: 7,
      defaultValue: parsed.crew.maxDropsPerDay,
    });
    expect(row(rows, 'budgets.maxHeal').defaultValue).toBe(parsed.budgets.maxHeal);
    const install = EditableSchema.parse({});
    expect(row(installRows({ pollSeconds: 120 }), 'pollSeconds').defaultValue).toBe(
      install.pollSeconds,
    );
  });

  test('id, repo and gates have no default', () => {
    const rows = zoneRows();
    for (const k of ['id', 'repo', 'gates']) expect(row(rows, k).defaultValue, k).toBeUndefined();
    expect(row(rows, 'repo').value).toBe('o/r');
  });

  test("a zone's requireSignedImages falls back to the install's, value and default alike", () => {
    const r = row(zoneRows(minimalZone, { requireSignedImages: true }), 'requireSignedImages');
    expect(r).toMatchObject({ value: true, defaultValue: true, explicit: false });
  });

  test('install values come from the install document', () => {
    const doc = { pollSeconds: 90, usage: { stopOnOverage: false } };
    const rows = installRows(doc);
    expect(row(rows, 'pollSeconds')).toMatchObject({ value: 90, explicit: true, scope: 'install' });
    expect(row(rows, 'usage.stopOnOverage')).toMatchObject({ value: false, explicit: true });
    expect(row(rows, 'usage.throttleUtilization')).toMatchObject({ explicit: false });
    expect(row(rows, 'server.publicUrl')).toMatchObject({
      value: undefined,
      defaultValue: undefined,
    });
  });
});

describe('explicit', () => {
  test('an absent key is not explicit; one set to its default value is, with the same value', () => {
    const absent = row(zoneRows(), 'crew.maxDropsPerDay');
    expect(absent.explicit).toBe(false);
    const same = row(
      zoneRows({ ...minimalZone, crew: { maxDropsPerDay: absent.defaultValue } }),
      'crew.maxDropsPerDay',
    );
    expect(same).toMatchObject({ explicit: true, value: absent.value });
    // A parent present without the key is not the key.
    expect(row(zoneRows({ ...minimalZone, crew: {} }), 'crew.maxDropsPerDay').explicit).toBe(false);
    expect(row(zoneRows(), 'id').explicit).toBe(true);
  });
});

describe('guards from the tables', () => {
  test("every entry's guard is the one table that names its path", () => {
    for (const e of FLAGS) {
      const guards = tableGuard(e.path);
      expect(guards, e.path).toHaveLength(1);
      expect(rowOf(e).guard, e.path).toBe(guards[0]);
    }
  });

  test('spot checks', () => {
    const rows = zoneRows();
    expect(row(rows, 'crew.refutePromotes').guard).toBe('guarded');
    expect(row(rows, 'crew.maxDropsPerDay').guard).toBe('free');
    expect(row(rows, 'repo').guard).toBe('refused');
    const first = SESSION_FORBIDDEN[0]?.path as string;
    const firstRows = first.startsWith(ZONE) ? rows : installRows();
    expect(row(firstRows, keyOf(first)).guard).toBe('browser-forbidden');
  });

  test('claude.fableMaxUtilization is free, in models, a share from 0 to 1 (#381)', () => {
    const r = row(installRows(), 'claude.fableMaxUtilization');
    expect(r.guard).toBe('free');
    expect(r.entry.group).toBe('models');
    expect(r.entry.kind).toBe('number');
    expect(r).toMatchObject({ min: 0, max: 1 });
    expect(r.integer).toBeFalsy();
  });
});

describe('reviews on Fable (#605)', () => {
  test('claude.fableReview is a free switch in models; fableReviewMaxUtilization a share from 0 to 1', () => {
    const on = row(installRows(), 'claude.fableReview');
    expect(on.guard).toBe('free');
    expect(on.entry.group).toBe('models');
    expect(on.entry.kind).toBe('bool');
    expect(on.entry.help).toBe(
      "Run pull request reviews on Fable while its weekly budget has room. Reviews use the zone's model otherwise.",
    );
    const r = row(installRows(), 'claude.fableReviewMaxUtilization');
    expect(r.guard).toBe('free');
    expect(r.entry.group).toBe('models');
    expect(r.entry.kind).toBe('number');
    expect(r).toMatchObject({ min: 0, max: 1 });
    expect(r.integer).toBeFalsy();
    expect(r.entry.help).toBe(
      'Reviews stop using Fable once its weekly usage reaches this share, so the audit, diagnose and arbitrate drops keep Fable.',
    );
  });
});

describe('words', () => {
  test('every label is plain words and every help says enough', () => {
    for (const e of FLAGS) {
      expect(e.label.length, e.path).toBeGreaterThan(0);
      expect(e.label.length, e.path).toBeLessThanOrEqual(60);
      expect(e.label, e.path).toContain(' ');
      expect(e.label, e.path).not.toBe(keyOf(e.path));
      expect(e.label, e.path).not.toBe(e.path);
      expect(e.help.length, e.path).toBeGreaterThanOrEqual(30);
    }
  });
});

describe('groups and order', () => {
  test('groups follow the rules', () => {
    const rows = zoneRows();
    expect(row(rows, 'crew.stagedLabel').entry.group).toBe('labels');
    expect(row(rows, 'readyLabel').entry.group).toBe('labels');
    expect(row(rows, 'crew.enabled').entry.group).toBe('crew');
    expect(row(rows, 'budgets.maxHeal').entry.group).toBe('retries');
    expect(row(rows, 'transcripts.archive').entry.group).toBe('transcripts');
    expect(row(rows, 'models').entry.group).toBe('models');
    expect(row(rows, 'maxOpenPrs').entry.group).toBe('pace');
    expect(row(rows, 'egress.mode').entry.group).toBe('safety');
    expect(row(rows, 'image').entry.group).toBe('safety');
    expect(row(rows, 'repo').entry.group).toBe('other');
    expect(row(rows, 'gates').entry.group).toBe('other');
    const install = installRows();
    expect(row(install, 'pollSeconds').entry.group).toBe('pace');
    expect(row(install, 'usage.probeJitterSeconds').entry.group).toBe('pace');
    expect(row(install, 'claude.plan').entry.group).toBe('models');
    expect(row(install, 'requireSignedImages').entry.group).toBe('safety');
    expect(row(install, 'mcp.maxBodyBytes').entry.group).toBe('other');
  });

  test('rows come in group order, then by label', () => {
    for (const rows of [zoneRows(), installRows()]) {
      const sorted = [...rows].sort(
        (a, b) =>
          GROUP_ORDER.indexOf(a.entry.group) - GROUP_ORDER.indexOf(b.entry.group) ||
          a.entry.label.localeCompare(b.entry.label),
      );
      expect(rows.map((r) => r.key)).toEqual(sorted.map((r) => r.key));
      const groups = rows.map((r) => GROUP_ORDER.indexOf(r.entry.group));
      expect(groups).toEqual([...groups].sort((a, b) => a - b));
    }
  });
});

describe('a GitLab zone (issue #667)', () => {
  const gitlabZone = {
    id: 'z',
    repo: 'group/sub/project',
    gates: [],
    forge: 'gitlab',
    gitlab: { baseUrl: 'https://gitlab.example.com' },
  };

  test('flagRows reads a GitLab zone document with a nested path', () => {
    const rows = zoneRows(gitlabZone);
    expect(row(rows, 'repo').value).toBe('group/sub/project');
    expect(row(rows, 'forge')).toMatchObject({
      value: 'gitlab',
      defaultValue: undefined,
      explicit: true,
      guard: 'refused',
      options: ['github', 'gitlab'],
    });
    expect(row(rows, 'gitlab.baseUrl')).toMatchObject({
      value: 'https://gitlab.example.com',
      explicit: true,
      guard: 'refused',
    });
    expect(row(rows, 'forge').entry.kind).toBe('select');
    expect(row(rows, 'gitlab.baseUrl').entry.kind).toBe('text');
  });

  test('a GitHub zone has forge and gitlab.baseUrl unset, and a nested path is refused', () => {
    const rows = zoneRows();
    expect(row(rows, 'forge')).toMatchObject({ value: undefined, explicit: false });
    expect(row(rows, 'gitlab.baseUrl')).toMatchObject({ value: undefined, explicit: false });
    expect(() => zoneRows({ ...minimalZone, repo: 'group/sub/project' })).toThrow();
  });
});
