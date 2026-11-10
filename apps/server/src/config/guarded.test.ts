import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { DEFAULT_PROTECTED_PATHS, EditableSchema, STARTER_WARNING } from '../config.js';
import { PRESET_EGRESS } from '../presets.js';
import {
  ADD_BASELINE,
  classify,
  effective,
  GUARDED_PATHS,
  NOT_GUARDED,
  REFUSED_PATHS,
  SESSION_FORBIDDEN,
} from './guarded.js';

const zone = (id = 'web', extra: Record<string, unknown> = {}) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test' }],
  preset: 'node',
  egress: { mode: 'enforce', allow: ['example.org'] },
  ...extra,
});
const doc = (zones: unknown[], extra: Record<string, unknown> = {}) => ({
  dropZones: zones,
  ...extra,
});
/** The classification of one zone edit: the zone before, the zone after. */
const edit = (before: Record<string, unknown>, after: Record<string, unknown>, top = {}) =>
  classify(doc([zone('web', before)], top), doc([zone('web', after)], top));
const paths = (c: ReturnType<typeof classify>) => c.guarded.map((g) => g.path);

describe('the schema walk', () => {
  /** Every leaf of the editable schema, as the rule tables name paths. */
  function leaves(): string[] {
    const out: string[] = [];
    const walk = (s: z.ZodType, path: string): void => {
      const def = (s as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
      const t = def.type;
      if (t === 'default' || t === 'optional' || t === 'nullable' || t === 'prefault')
        return walk(def.innerType as z.ZodType, path);
      if (t === 'object') {
        for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>))
          walk(v, path ? `${path}.${k}` : k);
        return;
      }
      if (t === 'array' && path === 'dropZones')
        return walk(def.element as z.ZodType, 'dropZones[]');
      out.push(path);
    };
    walk(EditableSchema, '');
    return out.sort();
  }

  test('every setting in the config schema is judged by exactly one table, and no table names a setting the schema lacks', () => {
    const tables = [
      ...GUARDED_PATHS.map((g) => g.path),
      ...SESSION_FORBIDDEN.map((g) => g.path),
      ...REFUSED_PATHS.map((g) => g.path),
      ...NOT_GUARDED.map((g) => g.path),
    ];
    // A path in two tables would be judged twice; a new schema field in none would go unjudged.
    expect(new Set(tables).size).toBe(tables.length);
    expect([...tables].sort()).toEqual(leaves());
    for (const n of NOT_GUARDED) expect(n.reason.length, n.path).toBeGreaterThan(10);
  });

  test('a setting no table names is guarded with a consequence that says why (fail closed)', () => {
    // A field added to the schema without a rule: the parse seam lets it through as the schema
    // would, and classify meets a path no table names.
    const asSchemaWould = (d: unknown) => EditableSchema.parse(d) as never;
    const keepNew = (d: unknown) => {
      const parsed = EditableSchema.parse(d) as { dropZones: Record<string, unknown>[] };
      const raw = d as { dropZones: Record<string, unknown>[] };
      parsed.dropZones.forEach((z, i) => {
        z.brandNew = raw.dropZones[i]?.brandNew;
      });
      return parsed as never;
    };
    const before = doc([zone('web', { brandNew: 1 })]);
    const after = doc([zone('web', { brandNew: 2 })]);
    expect(classify(before, after, { parse: asSchemaWould }).guarded).toEqual([]);
    const u = classify(before, after, { parse: keepNew });
    expect(u.guarded).toEqual([
      {
        path: 'dropZones[web].brandNew',
        consequence:
          "dropZones[web].brandNew changes from 1 to 2: Jumpmaster can't tell whether that weakens a guard, so it asks",
      },
    ]);
  });
});

describe('session-forbidden paths', () => {
  test('requireSignedImages from effective true to false, at the top or on a zone, and never the other way', () => {
    const top = classify(doc([zone()], { requireSignedImages: true }), doc([zone()]));
    expect(top.sessionForbidden).toEqual([
      'requireSignedImages',
      'dropZones[web].requireSignedImages',
    ]);
    expect(
      classify(doc([zone()]), doc([zone()], { requireSignedImages: true })).sessionForbidden,
    ).toEqual([]);
    expect(
      edit({ requireSignedImages: true }, { requireSignedImages: false }).sessionForbidden,
    ).toEqual(['dropZones[web].requireSignedImages']);
    expect(
      edit({ requireSignedImages: false }, { requireSignedImages: true }).sessionForbidden,
    ).toEqual([]);
  });

  test("a zone's image set on an added zone or changed or removed on an existing one", () => {
    expect(edit({ image: 'a:1' }, { image: 'a:2' }).sessionForbidden).toEqual([
      'dropZones[web].image',
    ]);
    expect(edit({}, { image: 'a:1' }).sessionForbidden).toEqual(['dropZones[web].image']);
    expect(edit({ image: 'a:1' }, {}).sessionForbidden).toEqual(['dropZones[web].image']);
    expect(edit({ image: 'a:1' }, { image: 'a:1' }).sessionForbidden).toEqual([]);
    const added = classify(doc([]), doc([zone('new', { image: 'a:1' })]));
    expect(added.sessionForbidden).toEqual(['dropZones[new].image']);
    expect(classify(doc([]), doc([zone('new')])).sessionForbidden).toEqual([]);
  });
});

describe('guarded scalar paths', () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    [
      'egress.mode',
      { egress: { mode: 'enforce', allow: [] } },
      { egress: { mode: 'off', allow: [] } },
      'Drops in web will be able to reach any host on the internet',
    ],
    [
      'egress.mode',
      { egress: { mode: 'enforce', allow: [] } },
      { egress: { mode: 'monitor', allow: [] } },
      'Drops in web will be able to reach hosts outside the allow list, with only a record of it',
    ],
    [
      'authorMayBeAdmin',
      {},
      { authorMayBeAdmin: true },
      'The author token for web may belong to an admin, who can bypass branch rules',
    ],
    ['identity', {}, { identity: 'starter' }, `zone web: ${STARTER_WARNING}`],
    ['ciRequired', {}, { ciRequired: false }, 'Agent PRs in web will merge without CI'],
    [
      'requireBranchProtection',
      {},
      { requireBranchProtection: false },
      'Agent PRs in web will merge without branch protection',
    ],
    [
      'reviewReadToken',
      {},
      { reviewReadToken: true },
      'The read token will reach review drops in web',
    ],
    [
      'trustPnpmBuildBlocking',
      {},
      { trustPnpmBuildBlocking: true },
      'Gates in web will run package build scripts pnpm would otherwise block',
    ],
    [
      'gateCi',
      {},
      { gateCi: false },
      'Gates in web will run with CI=false, so an install may resolve afresh and run what it resolved',
    ],
    [
      'crew.goalPath',
      {},
      { crew: { goalPath: 'docs/GOAL.md' }, protectedPaths: ['GOAL.md', 'docs/GOAL.md'] },
      'The crew in web will read its objectives from docs/GOAL.md, which must be a protected path',
    ],
    [
      'crew.refutePromotes',
      {},
      { crew: { refutePromotes: true } },
      'A crew refute in web will be able to promote a staged issue to ready',
    ],
  ];

  test.each(cases)(
    '%s is guarded in its weakening direction, naming the zone and value',
    (path, from, to, consequence) => {
      const c = edit(from, to);
      expect(c.guarded.filter((g) => g.path === `dropZones[web].${path}`)).toEqual([
        { path: `dropZones[web].${path}`, consequence },
      ]);
      // The other direction weakens nothing (crew.goalPath is guarded both ways: any move).
      if (path !== 'crew.goalPath')
        expect(edit(to, from).guarded.filter((g) => g.path === `dropZones[web].${path}`)).toEqual(
          [],
        );
    },
  );

  test('egress.mode off to monitor or enforce, and monitor to enforce, are not guarded', () => {
    expect(
      paths(
        edit({ egress: { mode: 'off', allow: [] } }, { egress: { mode: 'monitor', allow: [] } }),
      ),
    ).toEqual([]);
    expect(
      paths(
        edit(
          { egress: { mode: 'monitor', allow: [] } },
          { egress: { mode: 'enforce', allow: [] } },
        ),
      ),
    ).toEqual([]);
  });

  test('install-wide: usage.stopOnOverage to false and mcp.enabled to true', () => {
    expect(classify(doc([]), doc([], { usage: { stopOnOverage: false } })).guarded).toEqual([
      {
        path: 'usage.stopOnOverage',
        consequence: 'Dispatch will continue on usage credits; only a briefing is raised',
      },
    ]);
    expect(classify(doc([]), doc([], { mcp: { enabled: true } })).guarded).toEqual([
      {
        path: 'mcp.enabled',
        consequence: "Command's MCP server will accept tokens at /mcp after the next restart",
      },
    ]);
    expect(classify(doc([], { mcp: { enabled: true } }), doc([])).guarded).toEqual([]);
  });

  test('not-guarded settings change freely, and readyLabel carries its note', () => {
    const c = edit({}, { model: 'other', maxTurns: 5, budgets: { maxHeal: 9 }, readyLabel: 'go' });
    expect(c.guarded).toEqual([]);
    expect(c.notes).toEqual([
      {
        path: 'dropZones[web].readyLabel',
        note: 'renaming to a label already on many issues dispatches them all',
      },
    ]);
    expect(classify(doc([]), doc([], { pollSeconds: 30 })).guarded).toEqual([]);
  });
});

describe('removed keys are judged on effective values', () => {
  test('requireSignedImages removed from a zone under an install at false is a weakening; under true it is not', () => {
    expect(edit({ requireSignedImages: true }, {}).sessionForbidden).toEqual([
      'dropZones[web].requireSignedImages',
    ]);
    const under = { requireSignedImages: true };
    expect(edit({ requireSignedImages: true }, {}, under).sessionForbidden).toEqual([]);
  });

  test('egress removed is mode off; ciRequired removed is its default true', () => {
    expect(paths(edit({ egress: { mode: 'enforce', allow: [] } }, { egress: undefined }))).toEqual([
      'dropZones[web].egress.mode',
    ]);
    expect(paths(edit({ ciRequired: false }, { ciRequired: undefined }))).toEqual([]);
    expect(paths(edit({ ciRequired: true }, { ciRequired: undefined }))).toEqual([]);
    expect(effective(zone('web', { egress: undefined }), 'egress.mode', {})).toBe('off');
    expect(effective(zone('web'), 'requireSignedImages', { requireSignedImages: true })).toBe(true);
  });
});

describe('set paths are judged as set differences', () => {
  test('a reorder is nothing, and a replacement is a removal plus an addition', () => {
    const allow = (list: string[]) => ({ egress: { mode: 'enforce', allow: list } });
    expect(paths(edit(allow(['a.org', 'b.org']), allow(['b.org', 'a.org'])))).toEqual([]);
    expect(edit(allow(['a.org']), allow(['c.org'])).guarded).toEqual([
      {
        path: 'dropZones[web].egress.allow',
        consequence: 'Drops in web will be able to send data to c.org',
      },
    ]);
    expect(paths(edit(allow(['a.org', 'c.org']), allow(['a.org'])))).toEqual([]);
  });

  test('each set path is guarded only in its weakening direction, one consequence per item', () => {
    const pp = (list: string[]) => ({ protectedPaths: ['GOAL.md', ...list] });
    expect(edit(pp(['.github/**', 'CODEOWNERS']), pp(['CODEOWNERS'])).guarded).toEqual([
      {
        path: 'dropZones[web].protectedPaths',
        consequence:
          'Agents will be able to merge changes to .github/** in web without a human review',
      },
    ]);
    expect(paths(edit(pp([]), pp(['x/**'])))).toEqual([]);
    expect(edit({}, { overrideApprovers: ['alice', 'bob'] }).guarded).toEqual([
      {
        path: 'dropZones[web].overrideApprovers',
        consequence: 'alice will be able to override branch-rule problems for web',
      },
      {
        path: 'dropZones[web].overrideApprovers',
        consequence: 'bob will be able to override branch-rule problems for web',
      },
    ]);
    expect(edit({}, { gateSecrets: ['NPM_TOKEN'] }).guarded).toEqual([
      {
        path: 'dropZones[web].gateSecrets',
        consequence:
          "Gate steps in web will receive the secret NPM_TOKEN; any PR's gate code can read it",
      },
    ]);
    expect(paths(edit({ gateSecrets: ['NPM_TOKEN'] }, {}))).toEqual([]);
    expect(edit({ botLogins: ['crew-bot'] }, {}).guarded).toEqual([
      {
        path: 'dropZones[web].botLogins',
        consequence: "Comments by crew-bot in web will no longer be ignored as a bot's",
      },
    ]);
    expect(paths(edit({}, { botLogins: ['crew-bot'] }))).toEqual([]);
    expect(edit({}, { adoptPulls: [12] }).guarded).toEqual([
      {
        path: 'dropZones[web].adoptPulls',
        consequence: 'Jumpmaster will take over PR #12 in web and may merge it',
      },
    ]);
  });

  test('services are keyed by name: an addition or a changed image is guarded, a reorder or a port change is not', () => {
    const pg = { name: 'pg', image: 'postgres:16', port: 5432 };
    const redis = { name: 'redis', image: 'redis:7', port: 6379 };
    expect(paths(edit({ services: [pg, redis] }, { services: [redis, pg] }))).toEqual([]);
    expect(paths(edit({ services: [pg] }, { services: [{ ...pg, port: 5433 }] }))).toEqual([]);
    expect(edit({ services: [pg] }, { services: [pg, redis] }).guarded).toEqual([
      {
        path: 'dropZones[web].services',
        consequence: 'The stick will run redis:7 beside every drop in web',
      },
    ]);
    expect(edit({ services: [pg] }, { services: [{ ...pg, image: 'evil:1' }] }).guarded).toEqual([
      {
        path: 'dropZones[web].services',
        consequence: 'The stick will run evil:1 beside every drop in web',
      },
    ]);
    expect(paths(edit({ services: [pg, redis] }, { services: [pg] }))).toEqual([]);
  });
});

describe('added, removed and renamed zones', () => {
  test('an added zone is judged against the add baseline: egress monitor and its own preset', () => {
    const base = ADD_BASELINE(zone('new', { preset: 'python' }));
    expect(base).toMatchObject({ preset: 'python', egress: { mode: 'monitor', allow: [] } });
    expect(base.image).toBeUndefined();
    // As the wizard adds it: monitor, the preset's defaults. Nothing guarded, the preset included.
    const plain = classify(doc([]), doc([zone('new', { egress: { mode: 'monitor', allow: [] } })]));
    expect(plain).toMatchObject({ guarded: [], sessionForbidden: [], refused: [], added: ['new'] });
    // With egress off, a hand-added protected-path removal and a gate secret: each guarded.
    const risky = classify(
      doc([]),
      doc([
        zone('new', {
          egress: { mode: 'off', allow: [] },
          protectedPaths: ['GOAL.md'],
          gateSecrets: ['TOKEN_X'],
        }),
      ]),
    );
    expect(risky.guarded.map((g) => g.path)).toEqual([
      'dropZones[new].egress.mode',
      'dropZones[new].gateSecrets',
      ...Array(DEFAULT_PROTECTED_PATHS.length - 1).fill('dropZones[new].protectedPaths'),
    ]);
  });

  test('a removed zone is a removal, never a guarded change', () => {
    const c = classify(doc([zone('a'), zone('b')]), doc([zone('a')]));
    expect(c).toMatchObject({ guarded: [], sessionForbidden: [], removed: ['b'], added: [] });
  });

  test('a rename is a removal plus an add, and the add is classified', () => {
    const c = classify(
      doc([zone('old', { egress: { mode: 'off', allow: [] } })]),
      doc([zone('new', { egress: { mode: 'off', allow: [] } })]),
    );
    expect(c.removed).toEqual(['old']);
    expect(c.added).toEqual(['new']);
    expect(c.guarded.map((g) => g.path)).toEqual(['dropZones[new].egress.mode']);
  });

  test("repo on an existing zone is refused with the remove-and-re-add message; an added zone's repo is free", () => {
    expect(edit({}, { repo: 'octo/other' }).refused).toEqual([
      {
        path: 'dropZones[web].repo',
        message: "the repository of a zone can't change: remove the zone and add a new one",
      },
    ]);
    expect(classify(doc([]), doc([zone('new', { repo: 'any/where' })])).refused).toEqual([]);
  });

  test("a preset change on an existing zone is free when the new base hosts are a subset, guarded otherwise; an added zone's preset never is", () => {
    // Every preset's hosts are a superset of none.
    const toNode = edit({ preset: undefined, image: 'a:1' }, { preset: 'node', image: 'a:1' });
    expect(toNode.guarded).toEqual([
      {
        path: 'dropZones[web].preset',
        consequence: `Drops in web will be able to reach ${(PRESET_EGRESS.node ?? []).join(', ')}`,
      },
    ]);
    expect(
      paths(edit({ preset: 'node', image: 'a:1' }, { preset: undefined, image: 'a:1' })),
    ).toEqual([]);
    expect(paths(edit({ preset: 'node' }, { preset: 'node' }))).toEqual([]);
    const go = edit({ preset: 'node' }, { preset: 'go' });
    const extra = (PRESET_EGRESS.go ?? []).filter((h) => !(PRESET_EGRESS.node ?? []).includes(h));
    expect(go.guarded).toEqual(
      extra.length > 0
        ? [
            {
              path: 'dropZones[web].preset',
              consequence: `Drops in web will be able to reach ${extra.join(', ')}`,
            },
          ]
        : [],
    );
    expect(go.sessionForbidden).toEqual([]);
    for (const preset of ['node', 'python', 'go', 'jvm'])
      expect(
        classify(doc([]), doc([zone('new', { preset, egress: { mode: 'monitor', allow: [] } })]))
          .guarded,
      ).toEqual([]);
  });
});
