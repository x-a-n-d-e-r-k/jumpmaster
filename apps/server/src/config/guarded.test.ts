import { describe, expect, test } from 'vitest';
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
import { schemaLeaves } from './schema-leaves.js';

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
const newProject = (zone: string, repo: string) => ({
  path: `dropZones[${zone}].repo`,
  consequence: `A new project, ${repo}: its code will run in drops with your Claude credentials, and Jumpmaster will act on its issues and PRs with the forge tokens`,
});

describe('the schema walk', () => {
  test('every setting in the config schema is judged by exactly one table, and no table names a setting the schema lacks', () => {
    const tables = [
      ...GUARDED_PATHS.map((g) => g.path),
      ...SESSION_FORBIDDEN.map((g) => g.path),
      ...REFUSED_PATHS.map((g) => g.path),
      ...NOT_GUARDED.map((g) => g.path),
    ];
    // A path in two tables would be judged twice; a new schema field in none would go unjudged.
    expect(new Set(tables).size).toBe(tables.length);
    expect([...tables].sort()).toEqual([...schemaLeaves().keys()]);
    for (const n of NOT_GUARDED) expect(n.reason.length, n.path).toBeGreaterThan(10);
  });

  test('claude.fableMaxUtilization only picks the model, so it is free (#381)', () => {
    expect(NOT_GUARDED.map((n) => n.path)).toContain('claude.fableMaxUtilization');
  });

  test('claude.fableReview and fableReviewMaxUtilization only pick the review model, so they are free (#605)', () => {
    for (const path of ['claude.fableReview', 'claude.fableReviewMaxUtilization']) {
      const n = NOT_GUARDED.find((g) => g.path === path);
      expect(n?.reason, path).toBe('a pace or cap on work that still passes every guard');
    }
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
    ['identity', {}, { identity: 'starter' }, `project web: ${STARTER_WARNING}`],
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
      'transcripts.archive',
      {},
      { transcripts: { archive: false } },
      'Transcripts pruned in web will be deleted without an archive copy',
    ],
    [
      'crew.goalPath',
      {},
      { crew: { goalPath: 'docs/GOAL.md' }, protectedPaths: ['GOAL.md', 'docs/GOAL.md'] },
      'The crew in web will read its objectives from docs/GOAL.md, which must be a protected path',
    ],
    [
      'crew.refutePromotes',
      { crew: { refutePromotes: false } },
      { crew: { refutePromotes: true } },
      'A crew refute in web will be able to promote a staged issue to ready',
    ],
    [
      'crew.arbiter',
      { crew: { arbiter: false } },
      { crew: { arbiter: true } },
      'A Fable arbiter in web will settle crew disagreements without asking you',
    ],
    [
      'crew.autoRetry',
      { crew: { autoRetry: false } },
      { crew: { autoRetry: true } },
      'The crew in web will retry a failed implementation once on its own diagnosis, without asking you',
    ],
    [
      'crew.closeDone',
      { crew: { closeDone: false } },
      { crew: { closeDone: true } },
      'Crew triage in web will be able to close an issue it finds already done',
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

  test('crew.refutePromotes: false to true is guarded, true to false is not, and the default is true (#318)', () => {
    const at = 'dropZones[web].crew.refutePromotes';
    const off = { crew: { refutePromotes: false } };
    const on = { crew: { refutePromotes: true } };
    expect(paths(edit(off, on))).toEqual([at]);
    expect(paths(edit(on, off))).toEqual([]);
    // A config with no key already promotes: writing true over it, or the opt-out, asks nothing.
    expect(paths(edit({}, on))).toEqual([]);
    expect(paths(edit({}, off))).toEqual([]);
    // Opting back in from an explicit false is guarded, whether written or by dropping the key.
    expect(paths(edit(off, {}))).toEqual([at]);
  });

  test('crew.arbiter: false to true is guarded, true to false is not, and the default is true', () => {
    const at = 'dropZones[web].crew.arbiter';
    const off = { crew: { arbiter: false } };
    const on = { crew: { arbiter: true } };
    expect(paths(edit(off, on))).toEqual([at]);
    expect(paths(edit(on, off))).toEqual([]);
    // A config with no key already arbitrates: writing true over it, or the opt-out, asks nothing.
    expect(paths(edit({}, on))).toEqual([]);
    expect(paths(edit({}, off))).toEqual([]);
    // Opting back in from an explicit false is guarded, whether written or by dropping the key.
    expect(paths(edit(off, {}))).toEqual([at]);
  });

  test('crew.autoRetry: false to true is guarded, true to false is not, and the default is true', () => {
    const at = 'dropZones[web].crew.autoRetry';
    const off = { crew: { autoRetry: false } };
    const on = { crew: { autoRetry: true } };
    expect(paths(edit(off, on))).toEqual([at]);
    expect(paths(edit(on, off))).toEqual([]);
    expect(paths(edit({}, on))).toEqual([]);
    expect(paths(edit({}, off))).toEqual([]);
    expect(paths(edit(off, {}))).toEqual([at]);
  });

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

  // Issue #254: the address decides which script a new machine runs as root and where its
  // one-time code goes.
  test('server.publicUrl is guarded when it is set, changed or cleared', () => {
    const A = 'https://a.example.ts.net';
    const B = 'https://b.example.ts.net';
    const say = 'New machines will download and run the installer from this address as root';
    const at = (u?: string) => (u === undefined ? {} : { server: { publicUrl: u } });
    expect(classify(doc([]), doc([], at(A))).guarded).toEqual([
      { path: 'server.publicUrl', consequence: `${say}: ${A}` },
    ]);
    expect(classify(doc([], at(A)), doc([], at(B))).guarded).toEqual([
      { path: 'server.publicUrl', consequence: `${say}: ${B}` },
    ]);
    expect(classify(doc([], at(A)), doc([])).guarded).toEqual([
      {
        path: 'server.publicUrl',
        consequence: `${say}: it is cleared, so none can be added until it is set again`,
      },
    ]);
    expect(classify(doc([], at(A)), doc([], at(A))).guarded).toEqual([]);
    expect(NOT_GUARDED.map((n) => n.path)).not.toContain('server.publicUrl');
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
    expect(edit({}, { privateKeyPaths: ['test/fixtures/**'] }).guarded).toEqual([
      {
        path: 'dropZones[web].privateKeyPaths',
        consequence: 'Agents will be able to push private keys to test/fixtures/** in web',
      },
    ]);
    expect(paths(edit({ privateKeyPaths: ['test/fixtures/**'] }, {}))).toEqual([]);
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
    expect(edit({}, { authorLoginAliases: ['old-bot'] }).guarded).toEqual([
      {
        path: 'dropZones[web].authorLoginAliases',
        consequence: "PRs by old-bot on agent branches in web will be adopted as the author's",
      },
    ]);
    expect(paths(edit({ authorLoginAliases: ['old-bot'] }, {}))).toEqual([]);
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
    // As the wizard adds it: monitor, the preset's defaults. Only the new project itself is guarded:
    // its code runs with the Claude token (the reviewer's I1); the preset is not.
    const plain = classify(doc([]), doc([zone('new', { egress: { mode: 'monitor', allow: [] } })]));
    expect(plain).toMatchObject({
      guarded: [newProject('new', 'octo/new')],
      sessionForbidden: [],
      refused: [],
      added: ['new'],
    });
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
      'dropZones[new].repo',
      'dropZones[new].egress.mode',
      'dropZones[new].gateSecrets',
      ...Array(DEFAULT_PROTECTED_PATHS.length - 1).fill('dropZones[new].protectedPaths'),
    ]);
  });

  test('a removed zone is a removal, never a guarded change', () => {
    const c = classify(doc([zone('a'), zone('b')]), doc([zone('a')]));
    expect(c).toMatchObject({ guarded: [], sessionForbidden: [], removed: ['b'], added: [] });
  });

  test("an added zone's repository is guarded: the reviewer's probe of any public repository needs the confirmation", () => {
    const c = classify(
      doc([zone('web')]),
      doc([
        zone('web'),
        {
          id: 'new',
          repo: 'attacker/public-repo',
          gates: [{ name: 'x', run: 'bash ./exfil.sh' }],
          preset: 'node',
          egress: { mode: 'monitor' },
        },
      ]),
    );
    expect(c.guarded).toEqual([newProject('new', 'attacker/public-repo')]);
    expect(c.refused).toEqual([]);
    // An existing zone's repository is still refused, never guarded.
    expect(edit({}, { repo: 'octo/x' }).guarded).toEqual([]);
  });

  test('a rename is a removal plus an add, and the add is classified', () => {
    const c = classify(
      doc([zone('old', { egress: { mode: 'off', allow: [] } })]),
      doc([zone('new', { egress: { mode: 'off', allow: [] } })]),
    );
    expect(c.removed).toEqual(['old']);
    expect(c.added).toEqual(['new']);
    expect(c.guarded.map((g) => g.path)).toEqual([
      'dropZones[new].repo',
      'dropZones[new].egress.mode',
    ]);
  });

  test("repo on an existing zone is refused with the remove-and-re-add message; an added zone's repo is not refused (it is guarded)", () => {
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
      ).toEqual([newProject('new', 'octo/new')]);
  });
});

describe('githubApp ids (spec §4.2): not secret, but guarded', () => {
  const app = (repositoryId: number, installations: Record<string, number>) => ({
    githubApp: { repositoryId, installations },
  });

  test('GUARDED_PATHS names exactly the three leaves, each a scalar rule', () => {
    const rules = GUARDED_PATHS.filter((g) => g.path.startsWith('dropZones[].githubApp'));
    expect(rules.map((g) => [g.path, g.kind])).toEqual([
      ['dropZones[].githubApp.repositoryId', 'scalar'],
      ['dropZones[].githubApp.installations.author', 'scalar'],
      ['dropZones[].githubApp.installations.reviewer', 'scalar'],
    ]);
  });

  test('adding githubApp to an existing zone is guarded, naming the zone and each value', () => {
    expect(edit({}, app(123, { author: 11, reviewer: 22 })).guarded).toEqual([
      {
        path: 'dropZones[web].githubApp.installations.author',
        consequence: 'Author tokens for project web will be minted from installation id 11',
      },
      {
        path: 'dropZones[web].githubApp.installations.reviewer',
        consequence: 'Reviewer tokens for project web will be minted from installation id 22',
      },
      {
        path: 'dropZones[web].githubApp.repositoryId',
        consequence: 'Tokens for project web will be minted for repository id 123',
      },
    ]);
  });

  test('changing the repository id or an installation id is guarded', () => {
    expect(edit(app(123, { author: 11 }), app(456, { author: 11 })).guarded).toEqual([
      {
        path: 'dropZones[web].githubApp.repositoryId',
        consequence: 'Tokens for project web will be minted for repository id 456',
      },
    ]);
    expect(edit(app(123, { author: 11 }), app(123, { author: 12 })).guarded).toEqual([
      {
        path: 'dropZones[web].githubApp.installations.author',
        consequence: 'Author tokens for project web will be minted from installation id 12',
      },
    ]);
    // An installation id removed on its own.
    expect(edit(app(123, { author: 11, reviewer: 22 }), app(123, { author: 11 })).guarded).toEqual([
      {
        path: 'dropZones[web].githubApp.installations.reviewer',
        consequence:
          'Reviewer tokens for project web will no longer be minted from installation id 22: it is removed',
      },
    ]);
    // The same ids again: nothing to confirm.
    expect(edit(app(1, { author: 2 }), app(1, { author: 2 })).guarded).toEqual([]);
  });

  test('removing the field is guarded, each leaf saying it is removed', () => {
    expect(edit(app(123, { author: 11 }), { githubApp: undefined }).guarded).toEqual([
      {
        path: 'dropZones[web].githubApp.installations.author',
        consequence:
          'Author tokens for project web will no longer be minted from installation id 11: it is removed',
      },
      {
        path: 'dropZones[web].githubApp.repositoryId',
        consequence:
          'Tokens for project web will no longer be minted for repository id 123: it is removed',
      },
    ]);
  });

  test('an added zone carrying githubApp is guarded beside its repository', () => {
    const monitored = { egress: { mode: 'monitor', allow: [] } };
    const c = classify(doc([]), doc([zone('new', { ...monitored, ...app(7, { reviewer: 8 }) })]));
    expect(c.guarded.map((g) => g.path)).toEqual([
      'dropZones[new].repo',
      'dropZones[new].githubApp.installations.reviewer',
      'dropZones[new].githubApp.repositoryId',
    ]);
  });
});

describe('a zone forge (issue #667)', () => {
  const gitlab = (baseUrl = 'https://gitlab.example.com') => ({
    repo: 'group/sub/web',
    forge: 'gitlab',
    gitlab: { baseUrl },
  });

  test('changing forge on an existing zone is refused the way repo is', () => {
    const c = edit({}, { forge: 'gitlab', gitlab: { baseUrl: 'https://gitlab.example.com' } });
    expect(c.refused).toContainEqual({
      path: 'dropZones[web].forge',
      message: "the forge of a zone can't change: remove the zone and add a new one",
    });
    expect(c.refused.map((r) => r.path)).toContain('dropZones[web].gitlab.baseUrl');
    const back = edit({ ...gitlab(), repo: 'octo/web' }, { forge: undefined, gitlab: undefined });
    expect(back.refused).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'dropZones[web].forge' })]),
    );
  });

  test('changing gitlab.baseUrl on an existing zone is refused', () => {
    const c = edit(gitlab(), gitlab('https://other.example.com'));
    expect(c.refused).toEqual([
      {
        path: 'dropZones[web].gitlab.baseUrl',
        message: "the GitLab instance of a zone can't change: remove the zone and add a new one",
      },
    ]);
    expect(c.guarded).toEqual([]);
  });

  test('writing out forge: github on an existing GitHub zone changes nothing', () => {
    const c = edit({}, { forge: 'github' });
    expect(c).toMatchObject({ guarded: [], refused: [], sessionForbidden: [] });
  });

  test('an added GitLab zone with a nested path guards its repo, forge and base URL', () => {
    const added = zone('new', { egress: { mode: 'monitor', allow: [] }, ...gitlab() });
    expect(() => ADD_BASELINE(added)).not.toThrow();
    expect(ADD_BASELINE(added)).toMatchObject({
      repo: 'group/sub/web',
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.com' },
    });
    const c = classify(doc([]), doc([added]));
    expect(c.refused).toEqual([]);
    expect(c.guarded).toEqual([
      newProject('new', 'group/sub/web'),
      {
        path: 'dropZones[new].forge',
        consequence:
          'Project new lives on GitLab (forge: gitlab): Jumpmaster will act on its issues and merge requests there',
      },
      {
        path: 'dropZones[new].gitlab.baseUrl',
        consequence:
          'Project new will use the GitLab instance at https://gitlab.example.com (gitlab.baseUrl): the forge tokens will be sent there',
      },
    ]);
  });

  describe('egress.private (issue #890)', () => {
    const host = 'gitlab.example.com';
    const lab = (priv?: string[]) => ({
      ...gitlab(),
      egress: { mode: 'enforce', allow: [host], ...(priv ? { private: priv } : {}) },
    });

    test('an addition is a weakening naming the zone and the host', () => {
      expect(edit(lab(), lab([host])).guarded).toEqual([
        {
          path: 'dropZones[web].egress.private',
          consequence: `Drops in web will be able to reach ${host} at private-network addresses, agent containers included`,
        },
      ]);
      expect(edit(lab([]), lab([host])).guarded.map((g) => g.path)).toEqual([
        'dropZones[web].egress.private',
      ]);
    });

    test('a removal is not', () => {
      expect(edit(lab([host]), lab()).guarded).toEqual([]);
      expect(edit(lab([host]), lab([])).guarded).toEqual([]);
      // The form turning egress off with an empty list deletes egress, private included.
      expect(
        edit(lab([host]), { ...gitlab(), egress: undefined }).guarded.map((g) => g.path),
      ).not.toContain('dropZones[web].egress.private');
    });

    test('an absent value reads as []', () => {
      expect(effective(zone('web', lab()), 'egress.private', {})).toEqual([]);
      expect(effective(zone('web', { egress: undefined }), 'egress.private', {})).toEqual([]);
      expect(effective(zone('web', lab([host])), 'egress.private', {})).toEqual([host]);
      expect(edit(lab(), lab([])).guarded).toEqual([]);
    });

    test('adding a zone with egress.private set asks for confirmation', () => {
      const added = zone('new', {
        ...gitlab(),
        egress: { mode: 'monitor', allow: [host], private: [host] },
      });
      expect(ADD_BASELINE(added).egress).toEqual({ mode: 'monitor', allow: [] });
      const c = classify(doc([]), doc([added]));
      expect(c.guarded).toContainEqual({
        path: 'dropZones[new].egress.private',
        consequence: `Drops in new will be able to reach ${host} at private-network addresses, agent containers included`,
      });
      const without = zone('new', { ...gitlab(), egress: { mode: 'monitor', allow: [host] } });
      expect(classify(doc([]), doc([without])).guarded.map((g) => g.path)).not.toContain(
        'dropZones[new].egress.private',
      );
    });
  });

  describe('gitlab.caCert (issue #918)', () => {
    // Two self-signed EC CA certificates (valid to 2126), as in config.test.ts.
    const ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIBwzCCAWmgAwIBAgIUILMx4bVcG+WvdctPjeXv0Eu/YNowCgYIKoZIzj0EAwIw
NjEdMBsGA1UEAwwURXhhbXBsZSBDb3JwIFJvb3QgQ0ExFTATBgNVBAoMDEV4YW1w
bGUgQ29ycDAgFw0yNjExMjYwMjU4NDFaGA8yMTI2MTEwMjAyNTg0MVowNjEdMBsG
A1UEAwwURXhhbXBsZSBDb3JwIFJvb3QgQ0ExFTATBgNVBAoMDEV4YW1wbGUgQ29y
cDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABMD6pEjaSigANOJXH2RyquEdbgMv
peHIVW4M9Zv7iJZlZ/iYPDt19M4jh35B98KBtjlIwvS4nvte3YlPNvn60H+jUzBR
MB0GA1UdDgQWBBQbCzyPB/LpJ5XDnLfHkQ2OMHkHujAfBgNVHSMEGDAWgBQbCzyP
B/LpJ5XDnLfHkQ2OMHkHujAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gA
MEUCID860/NNCLvX0Z9lTyo95NzC1PxzWtxQrHpGa+0uaKQHAiEA1Se40cae7n4e
xiaS8DF4pg0jHIDpfqMNJ1+nX9Qrk7s=
-----END CERTIFICATE-----
`;
    const ISSUING_CA = `-----BEGIN CERTIFICATE-----
MIIByTCCAW+gAwIBAgIUV0hkn9d2AFVF+vKWxqtkv8dJq4EwCgYIKoZIzj0EAwIw
OTEgMB4GA1UEAwwXRXhhbXBsZSBDb3JwIElzc3VpbmcgQ0ExFTATBgNVBAoMDEV4
YW1wbGUgQ29ycDAgFw0yNjExMjYwMjU4NDFaGA8yMTI2MTEwMjAyNTg0MVowOTEg
MB4GA1UEAwwXRXhhbXBsZSBDb3JwIElzc3VpbmcgQ0ExFTATBgNVBAoMDEV4YW1w
bGUgQ29ycDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDQO/FDjSvPQopqSCBEV
UBYYJ70At8T5FnQRWDo8BLp5rHnEB9fu8EXZwm3fvKAtJlIPcJbtT2AX8wT//EdR
pzKjUzBRMB0GA1UdDgQWBBQTzvggIrxJS0RFdEd4T+WyS7aIqzAfBgNVHSMEGDAW
gBQTzvggIrxJS0RFdEd4T+WyS7aIqzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIQCnb6fEh/Shu7GUf+IrUztrfQVh41hgXEKN7ZIOaHSmcAIgGKja
h3hpG0eKKHYPr8jCPm51VKtVgFNDsRZvBe3SBBY=
-----END CERTIFICATE-----
`;
    const ROOT_FP =
      'D0:7D:6E:C4:94:B6:F2:7F:4E:F6:DE:6C:BF:BC:8B:81:22:97:2C:AB:F2:CA:B2:BD:89:D5:21:F7:1E:29:F9:6D';
    const ISSUING_FP =
      '7E:36:29:93:00:95:95:84:ED:0A:C7:56:6E:F1:E9:54:5E:DC:A2:67:15:29:35:B9:A3:1C:C2:4E:25:F0:31:01';
    const trusts = (zoneId: string, subject: string, fp: string) => ({
      path: `dropZones[${zoneId}].gitlab.caCert`,
      consequence: `Project ${zoneId} will trust certificates issued by ${subject} (SHA-256 ${fp}) for its GitLab host`,
    });
    const ROOT = 'CN=Example Corp Root CA, O=Example Corp';
    const ISSUING = 'CN=Example Corp Issuing CA, O=Example Corp';
    const withCa = (caCert?: string) => ({
      ...gitlab(),
      gitlab: { baseUrl: 'https://gitlab.example.com', ...(caCert ? { caCert } : {}) },
    });
    const noPem = (c: ReturnType<typeof classify>) => {
      for (const g of c.guarded) expect(g.consequence).not.toContain('BEGIN CERTIFICATE');
    };

    test('setting it on an existing zone is guarded, naming the subject and fingerprint', () => {
      const c = edit(withCa(), withCa(ROOT_CA));
      expect(c.refused).toEqual([]);
      expect(c.guarded).toEqual([trusts('web', ROOT, ROOT_FP)]);
      noPem(c);
    });

    test('adding a second certificate is guarded for it alone', () => {
      const c = edit(withCa(ROOT_CA), withCa(`${ROOT_CA}${ISSUING_CA}`));
      expect(c.guarded).toEqual([trusts('web', ISSUING, ISSUING_FP)]);
      noPem(c);
      // Reordering or reformatting the same certificates adds none.
      expect(
        edit(withCa(`${ROOT_CA}${ISSUING_CA}`), withCa(`${ISSUING_CA}\n${ROOT_CA}`)).guarded,
      ).toEqual([]);
    });

    test('removing certificates is not a weakening', () => {
      expect(edit(withCa(`${ROOT_CA}${ISSUING_CA}`), withCa(ROOT_CA)).guarded).toEqual([]);
      expect(edit(withCa(ROOT_CA), withCa()).guarded).toEqual([]);
    });

    test('replacing one certificate with another is guarded for the new one', () => {
      expect(edit(withCa(ROOT_CA), withCa(ISSUING_CA)).guarded).toEqual([
        trusts('web', ISSUING, ISSUING_FP),
      ]);
    });

    test('adding a zone with caCert is guarded: the baseline carries only gitlab.baseUrl', () => {
      const added = zone('new', {
        egress: { mode: 'monitor', allow: [] },
        ...withCa(`${ROOT_CA}${ISSUING_CA}`),
      });
      expect(ADD_BASELINE(added).gitlab).toEqual({ baseUrl: 'https://gitlab.example.com' });
      const c = classify(doc([]), doc([added]));
      expect(c.guarded).toEqual([
        newProject('new', 'group/sub/web'),
        {
          path: 'dropZones[new].forge',
          consequence:
            'Project new lives on GitLab (forge: gitlab): Jumpmaster will act on its issues and merge requests there',
        },
        {
          path: 'dropZones[new].gitlab.baseUrl',
          consequence:
            'Project new will use the GitLab instance at https://gitlab.example.com (gitlab.baseUrl): the forge tokens will be sent there',
        },
        trusts('new', ROOT, ROOT_FP),
        trusts('new', ISSUING, ISSUING_FP),
      ]);
      noPem(c);
    });
  });

  test('the add baseline refuses a nested path on a GitHub zone', () => {
    expect(() => ADD_BASELINE(zone('new', { repo: 'group/sub/web' }))).toThrow();
    expect(() => ADD_BASELINE(zone('new', { repo: 'group/sub/web', forge: 'github' }))).toThrow();
  });
});
