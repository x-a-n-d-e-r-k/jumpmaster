import type { CrewLeadOutput } from '@jumpmaster/protocol';
import { protectedPathMatches } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  listBriefings,
  raiseBriefing,
  ruleBriefing,
  withdrawBriefing,
} from '../briefings.js';
import { setKilled, setZoneMode } from '../db/repo.js';
import { refreshGoals } from '../goals.js';
import { makeZone, type ZoneWorld, zoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import {
  applyCrewActions,
  type CrewSource,
  crewIssueSlots,
  normaliseTitle,
  protectedPathsNamed,
  validateIssueSpec,
} from './actions.js';
import { flushCrewOps } from './flush.js';
import { getCrewIssue, listCrewIssues, setCrewIssue } from './store.js';

const GOAL = `# Goals

## Lighthouse

Every endpoint is documented.

## Objectives

### Document every endpoint

### Ship the CLI
`;

const BODY = `## Context

The API has no docs.

## Acceptance criteria

- [ ] every endpoint has a page

## Required tests

- a test that lists the pages
`;

type Issue = CrewLeadOutput['fileIssues'][number];
const issue = (o: Partial<Issue> = {}): Issue => ({
  key: 'add-docs',
  objective: 'document-every-endpoint',
  title: 'Add docs',
  body: BODY,
  ...o,
});

const crewOn = { ...makeZone().crew, enabled: true };
const DROP: CrewSource = { kind: 'drop', dropId: 'drop-1' };

let w: ZoneWorld;
beforeEach(async () => {
  w = zoneWorld({ crew: crewOn });
  w.f.state.files.set('main:GOAL.md', GOAL);
  await refreshGoals(w.db, w.f.author, w.zone, 'main', t0);
});

const apply = (input: Parameters<typeof applyCrewActions>[2], at = t0, source = DROP) =>
  applyCrewActions(w.db, w.zone, input, source, at);

describe('validateIssueSpec', () => {
  test('an issue missing acceptance criteria or required tests is refused with the reason', () => {
    expect(validateIssueSpec('Add docs', BODY)).toEqual([]);
    expect(
      validateIssueSpec('Add docs', BODY.replace('## Acceptance criteria', '## Notes')),
    ).toEqual(['no "## Acceptance criteria" checklist']);
    expect(validateIssueSpec('Add docs', BODY.replace('- [ ] every', 'every'))).toEqual([
      'no "## Acceptance criteria" checklist',
    ]);
    expect(validateIssueSpec('Add docs', BODY.replace('## Required tests', '## Later'))).toEqual([
      'no "## Tests" or "## Required tests" list',
    ]);
    expect(validateIssueSpec('Add docs', BODY.replace('## Required tests', '## Tests'))).toEqual(
      [],
    );
    expect(validateIssueSpec('Add\ndocs', BODY)).toEqual(['the title has a line break']);
    expect(validateIssueSpec('Add docs', `${BODY}\n<!-- jm:op:issue:x -->`)).toEqual([
      'contains "jm:op:"',
    ]);
  });

  test('normaliseTitle folds case, punctuation and repeated whitespace', () => {
    expect(normaliseTitle('  Add   DOCS!! (now) ')).toBe('add docs now');
  });
});

describe('protectedPathsNamed (#247)', () => {
  const PROTECTED = ['GOAL.md', 'examples/**', '.github/**'];
  const named = (body: string) => protectedPathsNamed(body, PROTECTED);

  test('a wording list naming a protected file in backticks', () => {
    expect(named('- `README.md`, `examples/jumpmaster.config.json` and the skills')).toEqual([
      'examples/**',
    ]);
  });

  test('a line saying the paths are protected and not changed', () => {
    expect(
      named(
        '- `GOAL.md` and `examples/jumpmaster.config.json` are protected paths and are not changed here',
      ),
    ).toEqual([]);
  });

  test('a line saying the paths are unchanged', () => {
    expect(named('- [ ] `docs/superpowers/`, `GOAL.md` and `examples/` are unchanged.')).toEqual(
      [],
    );
  });

  test('a path inside a fenced block', () => {
    expect(
      named('Run this:\n\n```\n`.github/workflows/ci.yml`\n.github/workflows/ci.yml\n```\n'),
    ).toEqual([]);
    expect(named('~~~yaml\n`.github/workflows/ci.yml`\n~~~\n')).toEqual([]);
  });

  test('a leading ./ is stripped before matching', () => {
    expect(named('Change `./.github/workflows/ci.yml`')).toEqual(['.github/**']);
  });

  test('a path under ## Out of scope', () => {
    expect(named('## Out of scope\n\nChange `GOAL.md`\n')).toEqual([]);
    // The next section is in scope again.
    expect(named('## Out of scope\n\n- nothing\n\n## Placement\n\nChange `GOAL.md`\n')).toEqual([
      'GOAL.md',
    ]);
  });

  test('sorted and de-duplicated; whitespace inside a span or no backticks is not a path', () => {
    expect(named('Edit `GOAL.md`, `.github/a.yml`, `.github/b.yml` and `GOAL.md` again')).toEqual([
      '.github/**',
      'GOAL.md',
    ]);
    expect(named('Edit GOAL.md and `GOAL .md`')).toEqual([]);
  });

  test('D4: padded forms agree with protectedPathMatches on the normalized token', () => {
    expect(named('Change `./GOAL.md`')).toEqual(['GOAL.md']);
    const dir = protectedPathMatches('examples/', 'examples/**');
    expect(named('Add a file under `examples/`')).toEqual(dir ? ['examples/**'] : []);
  });
});

describe('applyCrewActions', () => {
  test('a valid issue becomes a filing intent tagged with its objective and source', () => {
    const r = apply({ fileIssues: [issue({ priority: 'high' })] });
    expect(r.refused).toEqual([]);
    expect(r.filed).toHaveLength(1);
    expect(getCrewIssue(w.db, r.filed[0] ?? -1)).toMatchObject({
      state: 'filing',
      key: 'add-docs',
      objective: 'document-every-endpoint',
      source: 'drop',
      sourceRef: 'drop-1',
      title: 'Add docs',
      priority: 'high',
    });
    const mcp = apply({ fileIssues: [issue({ key: 'cli', title: 'Ship it' })] }, t0, {
      kind: 'mcp',
      tokenId: 7,
    });
    expect(getCrewIssue(w.db, mcp.filed[0] ?? -1)).toMatchObject({ source: 'mcp', sourceRef: '7' });
  });

  test('an issue missing acceptance criteria or required tests is refused with the reason', () => {
    const r = apply({ fileIssues: [issue({ body: 'just do it' })] });
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual([
      'add-docs: no "## Acceptance criteria" checklist; no "## Tests" or "## Required tests" list',
    ]);
    expect(r.refused.join()).not.toContain('just do it');
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
  });

  test('a lead issue naming a protected path is refused with the glob, and no crew issue row', () => {
    const zone = { ...w.zone, protectedPaths: ['examples/**', '.github/**'] };
    const body = BODY.replace('The API has no docs.', 'Update `examples/x.json` too.');
    const r = applyCrewActions(w.db, zone, { fileIssues: [issue({ body })] }, DROP, t0);
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual(['add-docs: names protected path examples/**']);
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
  });

  test('issues beyond crewIssueSlots are refused, in order, as "no free slot"', () => {
    expect(crewIssueSlots(w.db, w.zone)).toBe(3);
    const issues = ['a', 'b', 'c', 'd', 'e'].map((k) => issue({ key: k, title: `Task ${k}` }));
    const r = apply({ fileIssues: issues });
    expect(r.filed).toHaveLength(3);
    expect(r.refused).toEqual(['d: no free slot', 'e: no free slot']);
    expect(crewIssueSlots(w.db, w.zone)).toBe(0);
    // A rejected issue frees its slot.
    setCrewIssue(w.db, r.filed[0] ?? -1, { state: 'rejected' }, t0);
    expect(crewIssueSlots(w.db, w.zone)).toBe(1);
  });

  test('an objective key not on the current ladder is refused', () => {
    const r = apply({ fileIssues: [issue({ objective: 'take-over-the-world' })] });
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual(['add-docs: objective "take-over-the-world" is not on the ladder']);
  });

  test('a retried result with the same keys files nothing twice', () => {
    const first = apply({ fileIssues: [issue()] });
    const again = apply({ fileIssues: [issue()] }, plus(t0, 1000));
    expect(first.filed).toHaveLength(1);
    expect(again.filed).toEqual([]);
    expect(again.refused).toEqual(['add-docs: key already used']);
    expect(listCrewIssues(w.db, 'main')).toHaveLength(1);
  });

  test('the next cycle proposing the same title under a new key is refused as a duplicate', () => {
    apply({ fileIssues: [issue()] });
    const next = apply({ fileIssues: [issue({ key: 'docs-2', title: 'add  DOCS.' })] });
    expect(next.refused).toEqual(['docs-2: duplicate of an open crew issue']);
    // The same title under another objective is not a duplicate.
    const other = apply({
      fileIssues: [issue({ key: 'docs-3', title: 'Add docs', objective: 'ship-the-cli' })],
    });
    expect(other.filed).toHaveLength(1);
    // Nor is one whose earlier proposal was rejected.
    const [first] = listCrewIssues(w.db, 'main');
    setCrewIssue(w.db, first?.id ?? -1, { state: 'rejected' }, t0);
    expect(
      apply({ fileIssues: [issue({ key: 'docs-4' })] }, plus(t0, 8 * 24 * 3600_000)).filed,
    ).toHaveLength(1);
  });

  test('a title rejected in the last 7 days is refused as a duplicate, then allowed', () => {
    const [first] = apply({ fileIssues: [issue()] }).filed;
    setCrewIssue(w.db, first ?? -1, { state: 'rejected' }, t0);
    const soon = apply({ fileIssues: [issue({ key: 'again' })] }, plus(t0, 6 * 24 * 3600_000));
    expect(soon.refused).toEqual(['again: duplicate of a crew issue rejected in the last 7 days']);
    const later = apply({ fileIssues: [issue({ key: 'later' })] }, plus(t0, 8 * 24 * 3600_000));
    expect(later.filed).toHaveLength(1);
  });

  test('crew briefings get server ids and options with effect none', () => {
    const r = apply({
      briefings: [
        {
          subject: 'item:1',
          decision: 'Split the CLI objective?',
          why: 'It is two drops of work.',
          options: ['Split it', 'Keep it'],
          recommendation: 'Split it',
          onHold: 'The CLI objective',
        },
      ],
    });
    expect(r.briefings).toHaveLength(1);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b).toMatchObject({
      id: r.briefings[0],
      kind: 'crew',
      source: 'crew',
      sourceRef: 'drop-1',
      decision: 'Split the CLI objective?',
      options: [
        { id: 'o1', label: 'Split it', effect: 'none' },
        { id: 'o2', label: 'Keep it', effect: 'none' },
      ],
    });
    // A crew subject never lands on a server subject such as item:<id>.
    expect(b?.subject).toBe('crew:document-every-endpoint:item:1');
  });

  describe('one open crew briefing per objective (#246)', () => {
    type Brief = CrewLeadOutput['briefings'][number];
    const brief = (subject: string, decision = 'Which first?'): Brief => ({
      subject,
      decision,
      why: 'w',
      options: ['A', 'B'],
      recommendation: '',
      onHold: '',
    });
    const open = () => listBriefings(w.db, { zoneId: 'main', state: 'open' });
    const A = 'document-every-endpoint';
    const moveToB = async () => {
      const [id] = apply({ objectiveDone: { key: A, why: 'merged' } }).briefings;
      expect(ruleBriefing(w.db, id ?? -1, 'done', '', t0).ok).toBe(true);
      await applyPendingRulings(w.db, { forges: () => w.forges, zone: () => w.zone }, 'main', t0);
    };

    test('a lead briefing is stored under the current objective, or none', async () => {
      apply({ briefings: [brief('Order the author token')] });
      expect(open().map((b) => b.subject)).toEqual([`crew:${A}:Order the author token`]);
      w.f.state.files.set('main:GOAL.md', GOAL.replace(/^(### .+)$/gm, '$1 (done)'));
      await refreshGoals(w.db, w.f.author, w.zone, 'main', plus(t0, 1000));
      apply({ briefings: [brief('Anything left?')] });
      expect(open().map((b) => b.subject)).toContain('crew:none:Anything left?');
    });

    test('a differently worded second briefing for the same objective is refused', () => {
      const [first] = apply({ briefings: [brief('Order the author token')] }).briefings;
      const r = apply({ briefings: [brief('Where next?', 'Where?')] }, plus(t0, 3600_000));
      expect(r.briefings).toEqual([]);
      expect(r.refused).toEqual([`briefing 1: briefing ${first} is open for objective ${A}`]);
      expect(open()).toHaveLength(1);
      expect(open()[0]).toMatchObject({ id: first, decision: 'Which first?' });
    });

    test('the same subject twice updates the open briefing', () => {
      const [first] = apply({ briefings: [brief('Order it')] }).briefings;
      const r = apply({ briefings: [brief('Order it', 'New facts: which first?')] });
      expect(r).toMatchObject({ briefings: [first], refused: [] });
      expect(open()).toHaveLength(1);
      expect(open()[0]?.decision).toBe('New facts: which first?');
    });

    test('once the open briefing is ruled or withdrawn, a new one is raised', () => {
      const [first] = apply({ briefings: [brief('Order it')] }).briefings;
      expect(ruleBriefing(w.db, first ?? -1, 'o1', '', t0).ok).toBe(true);
      const [second] = apply({ briefings: [brief('Where next?')] }).briefings;
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      withdrawBriefing(w.db, 'main', `crew:${A}:Where next?`, t0);
      expect(apply({ briefings: [brief('And now?')] }).briefings).toHaveLength(1);
      expect(listBriefings(w.db, { zoneId: 'main' })).toHaveLength(3);
    });

    test('an open briefing for objective A does not block one for objective B', async () => {
      apply({ briefings: [brief('Order it')] });
      await moveToB();
      const r = apply({ briefings: [brief('Where next?')] });
      expect(r.refused).toEqual([]);
      expect(open().map((b) => b.subject)).toEqual([
        `crew:${A}:Order it`,
        'crew:ship-the-cli:Where next?',
      ]);
    });

    test('MCP and server briefings neither block nor are touched by a crew one (D5)', () => {
      const mcp = apply({ briefings: [brief('Order it', 'mcp')] }, t0, { kind: 'mcp', tokenId: 7 });
      const server = raiseBriefing(
        w.db,
        {
          zoneId: 'main',
          kind: 'parked',
          subject: 'item:1',
          decision: 'server',
          why: 'w',
          options: [{ id: 'x', label: 'X', effect: 'none' }],
          source: 'server',
        },
        t0,
      );
      const crew = apply({ briefings: [brief('Order it', 'crew')] });
      expect(crew.refused).toEqual([]);
      const again = apply({ briefings: [brief('Other', 'mcp2')] }, t0, { kind: 'mcp', tokenId: 7 });
      expect(again.refused).toEqual([]);
      const byId = new Map(open().map((b) => [b.id, b]));
      expect(byId.get(mcp.briefings[0] ?? -1)).toMatchObject({
        subject: 'mcp:Order it',
        decision: 'mcp',
      });
      expect(byId.get(server)).toMatchObject({ subject: 'item:1', decision: 'server' });
      expect(byId.get(crew.briefings[0] ?? -1)).toMatchObject({
        subject: `crew:${A}:Order it`,
        decision: 'crew',
      });
      expect(open()).toHaveLength(4);
    });

    test("a subject naming another objective's key stays under the current one (D4)", async () => {
      apply({ briefings: [brief('Order it')] });
      await moveToB();
      // Objective B is current: this cannot update or be blocked by A's open briefing.
      const r = apply({ briefings: [brief(`${A}:Order it`, 'sneaky')] });
      expect(r.refused).toEqual([]);
      const subjects = open().map((b) => [b.subject, b.decision]);
      expect(subjects).toEqual([
        [`crew:${A}:Order it`, 'Which first?'],
        [`crew:ship-the-cli:${A}:Order it`, 'sneaky'],
      ]);
      // And with B's briefing open, another B one is refused, A's still untouched.
      const blocked = apply({ briefings: [brief('x:y')] });
      expect(blocked.refused[0]).toMatch(/is open for objective ship-the-cli$/);
    });
  });

  describe('objectiveDone', () => {
    const DONE = {
      key: 'document-every-endpoint',
      why: 'Every endpoint page has merged (#3, #4).',
    };
    const OPTIONS = [
      { id: 'done', label: 'Mark it done', effect: 'advance_objective' },
      { id: 'keep', label: 'Keep it open', effect: 'none' },
    ];

    test('for the current objective it raises one server briefing; a second report updates it', () => {
      const r = apply({ objectiveDone: DONE });
      expect(r).toEqual({ filed: [], briefings: [expect.any(Number)], refused: [] });
      const again = apply({ objectiveDone: { ...DONE, why: 'Still all merged.' } }, plus(t0, 1));
      expect(again.briefings).toEqual(r.briefings);
      const all = listBriefings(w.db, { zoneId: 'main' });
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: r.briefings[0],
        kind: 'objective_done',
        source: 'server',
        subject: 'objective:document-every-endpoint',
        decision: 'Mark objective "Document every endpoint" done?',
        why: 'Still all merged.',
        options: OPTIONS,
        onHold: 'All crew filing for the next objective',
        state: 'open',
      });
    });

    test('any key but the current objective is refused with the reason, and nothing is raised', () => {
      for (const key of ['ship-the-cli', 'not-on-the-ladder']) {
        expect(apply({ objectiveDone: { key, why: 'w' } })).toEqual({
          filed: [],
          briefings: [],
          refused: [`objectiveDone ${key}: not the current objective`],
        });
      }
      expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
    });

    test('an objective already done by ruling is no longer current, so it is refused', async () => {
      const [id] = apply({ objectiveDone: DONE }).briefings;
      expect(ruleBriefing(w.db, id ?? -1, 'done', '', t0).ok).toBe(true);
      await applyPendingRulings(w.db, { forges: () => w.forges, zone: () => w.zone }, 'main', t0);
      expect(apply({ objectiveDone: DONE }).refused).toEqual([
        'objectiveDone document-every-endpoint: not the current objective',
      ]);
      expect(apply({ objectiveDone: { key: 'ship-the-cli', why: 'w' } }).briefings).toHaveLength(1);
    });

    test('an MCP source can never report an objective done (D1)', () => {
      const r = apply({ objectiveDone: DONE }, t0, { kind: 'mcp', tokenId: 7 });
      expect(r).toEqual({
        filed: [],
        briefings: [],
        refused: ['objectiveDone document-every-endpoint: an MCP source cannot report it'],
      });
      expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
    });

    test('in observe it is refused with the mode', () => {
      setZoneMode(w.db, 'main', 'observe', t0);
      expect(apply({ objectiveDone: DONE }).refused).toEqual([
        'objectiveDone document-every-endpoint: zone is observe',
      ]);
      expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
    });
  });

  test('in observe, paused or killed nothing is recorded and every action is refused with the mode', () => {
    const input = {
      fileIssues: [issue()],
      briefings: [
        {
          subject: 's',
          decision: 'd',
          why: 'w',
          options: ['a', 'b'],
          recommendation: '',
          onHold: '',
        },
      ],
    };
    for (const mode of ['observe', 'paused'] as const) {
      setZoneMode(w.db, 'main', mode, t0);
      expect(apply(input)).toEqual({
        filed: [],
        briefings: [],
        refused: [`add-docs: zone is ${mode}`, `briefing 1: zone is ${mode}`],
      });
    }
    setZoneMode(w.db, 'main', 'active', t0);
    setKilled(w.db, true, t0);
    expect(apply(input).refused).toEqual([
      'add-docs: kill switch is engaged',
      'briefing 1: kill switch is engaged',
    ]);
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
  });

  test('intents recorded before a switch to observe stay unflushed until resume', async () => {
    const r = apply({ fileIssues: [issue()] });
    setZoneMode(w.db, 'main', 'observe', t0);
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, 1000));
    expect(w.f.author.calls.filter((c) => c.method === 'createIssue')).toHaveLength(0);
    expect(getCrewIssue(w.db, r.filed[0] ?? -1)?.state).toBe('filing');
    setZoneMode(w.db, 'main', 'active', t0);
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, 2000));
    expect(w.f.author.calls.filter((c) => c.method === 'createIssue')).toHaveLength(1);
    expect(getCrewIssue(w.db, r.filed[0] ?? -1)?.state).toBe('staged');
  });
});
