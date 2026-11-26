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
import { getGoalChange, listGoalChanges } from '../goal-change.js';
import { refreshGoals } from '../goals.js';
import { makeZone, type ZoneWorld, zoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import {
  applyCrewActions,
  type CrewSource,
  crewIssueSlots,
  isSecurityTouching,
  normaliseTitle,
  protectedPathsNamed,
  validateIssueSpec,
} from './actions.js';
import { crewBodySha, flushCrewOps } from './flush.js';
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

describe('isSecurityTouching (#384)', () => {
  test('true for the section at any heading level and in any case', () => {
    expect(isSecurityTouching(`${BODY}\n## Security-touching checklist\n\n- D2\n`)).toBe(true);
    expect(isSecurityTouching(`${BODY}\n### Security-touching checklist\n`)).toBe(true);
    expect(isSecurityTouching(`### security-touching CHECKLIST ##\n- x`)).toBe(true);
  });

  test('false for the words outside a heading, and for an empty body', () => {
    expect(isSecurityTouching(`${BODY}\nSee the security-touching checklist.\n`)).toBe(false);
    expect(isSecurityTouching('- [ ] Security-touching checklist')).toBe(false);
    expect(isSecurityTouching(BODY)).toBe(false);
    expect(isSecurityTouching('')).toBe(false);
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

describe('goalChange', () => {
  const NEW_GOAL = GOAL.replace('### Ship the CLI', '### Ship the CLI\n\n### Write the guide');
  const CHANGE = { text: NEW_GOAL, why: 'The CLI needs a user guide.' };

  test("a crew drop's goalChange records a proposed change and raises a goal_change briefing", () => {
    const r = apply({ goalChange: CHANGE });
    expect(r).toEqual({ filed: [], briefings: [expect.any(Number)], refused: [] });
    const [change] = listGoalChanges(w.db, 'main');
    expect(change).toMatchObject({
      zoneId: 'main',
      source: 'crew',
      sourceRef: 'drop-1',
      text: NEW_GOAL,
      state: 'proposed',
    });
    const all = listBriefings(w.db, { zoneId: 'main' });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: r.briefings[0],
      kind: 'goal_change',
      source: 'server',
      sourceRef: 'drop-1',
      subject: `goal-change:${change?.id}`,
      why: 'The CLI needs a user guide.',
      options: [
        { id: 'open', label: 'Open the PR', effect: 'open_goal_change' },
        { id: 'no', label: 'Leave the goals as they are', effect: 'none' },
      ],
      state: 'open',
    });
    // One proposal waits for a ruling at a time.
    expect(apply({ goalChange: CHANGE }, plus(t0, 1)).refused).toEqual([
      `goalChange: goal change ${change?.id} is waiting for a ruling`,
    ]);
    expect(listGoalChanges(w.db, 'main')).toHaveLength(1);
  });

  test('D1 an MCP source cannot propose through applyCrewActions', () => {
    const r = apply({ goalChange: CHANGE }, t0, { kind: 'mcp', tokenId: 7 });
    expect(r).toEqual({
      filed: [],
      briefings: [],
      refused: ['goalChange: an MCP source cannot propose it'],
    });
    expect(listGoalChanges(w.db, 'main')).toEqual([]);
    expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
  });

  test('a text that does not parse as goals is refused in the server words, and nothing is recorded', () => {
    const r = apply({ goalChange: { text: 'no headings here', why: 'w' } });
    expect(r.briefings).toEqual([]);
    expect(r.refused).toEqual([expect.stringMatching(/^goalChange: the text does not parse/)]);
    expect(r.refused[0]).not.toContain('no headings here');
    expect(listGoalChanges(w.db, 'main')).toEqual([]);
    expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
  });

  test('in observe or under the kill switch it is refused, and nothing is recorded', () => {
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(apply({ goalChange: CHANGE }).refused).toEqual(['goalChange: zone is observe']);
    setZoneMode(w.db, 'main', 'active', t0);
    setKilled(w.db, true, t0);
    expect(apply({ goalChange: CHANGE }).refused).toEqual(['goalChange: kill switch is engaged']);
    expect(listGoalChanges(w.db, 'main')).toEqual([]);
    expect(getGoalChange(w.db, 1)).toBeUndefined();
  });
});

describe('refiling a rejected issue with `replaces` (#784)', () => {
  const DAY = 24 * 3600_000;
  const CORRECTED = `${BODY}\nThe arbiter's wording is applied.\n`;

  /** Files `o` and rejects it as a refute or the arbiter does, with no ruling of Command's. */
  const fileRejected = (o: Partial<Issue> = {}): number => {
    const r = apply({ fileIssues: [issue(o)] });
    const id = r.filed[0];
    if (id === undefined) throw new Error(`not filed: ${r.refused.join('; ')}`);
    setCrewIssue(w.db, id, { state: 'rejected', number: 700 + id }, t0);
    return id;
  };

  /** Command rules Reject on the issue's briefing, and the ruling is applied. */
  const commandRejects = async (id: number): Promise<void> => {
    setCrewIssue(w.db, id, { state: 'staged' }, t0);
    const b = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'refute_exhausted',
        subject: `issue:${id}`,
        decision: 'Promote or reject?',
        why: 'w',
        options: [
          { id: 'promote', label: 'Promote', effect: 'promote_issue' },
          { id: 'reject', label: 'Reject', effect: 'reject_issue' },
        ],
        source: 'server',
      },
      t0,
    );
    if (!ruleBriefing(w.db, b, 'reject', 'Not this way', t0).ok) throw new Error('not ruled');
    await applyPendingRulings(w.db, { forges: () => w.forges, zone: () => w.zone }, 'main', t0);
    setCrewIssue(w.db, id, { state: 'rejected' }, t0);
  };

  const soon = plus(t0, DAY);

  test('the same title with `replaces` is filed and stores what it replaces; without it, refused', () => {
    fileRejected({ key: 'gitlab-push-grant' });
    const without = apply(
      { fileIssues: [issue({ key: 'gitlab-push-grant-2', body: CORRECTED })] },
      soon,
    );
    expect(without.refused).toEqual([
      'gitlab-push-grant-2: duplicate of a crew issue rejected in the last 7 days',
    ]);
    const r = apply(
      {
        fileIssues: [
          issue({ key: 'gitlab-push-grant-2', body: CORRECTED, replaces: 'gitlab-push-grant' }),
        ],
      },
      soon,
    );
    expect(r.refused).toEqual([]);
    expect(r.filed).toHaveLength(1);
    expect(getCrewIssue(w.db, r.filed[0] ?? -1)).toMatchObject({
      key: 'gitlab-push-grant-2',
      replaces: 'gitlab-push-grant',
      state: 'filing',
    });
  });

  test('the new issue still needs its own key', () => {
    fileRejected({ key: 'grant' });
    const r = apply(
      { fileIssues: [issue({ key: 'grant', body: CORRECTED, replaces: 'grant' })] },
      soon,
    );
    expect(r.refused).toEqual(['grant: key already used']);
  });

  test('an unknown key, another zone’s, another objective’s or a promoted issue is refused', () => {
    // Another zone's rejected issue of the same key and objective.
    w.db
      .prepare(
        `INSERT INTO crew_issues (zone_id, key, source, objective, title, title_norm, body, state,
           created_at, updated_at)
         VALUES ('other', 'elsewhere', 'drop', 'document-every-endpoint', 'Add docs', 'add docs',
           'b', 'rejected', ?, ?)`,
      )
      .run(t0.toISOString(), t0.toISOString());
    fileRejected({ key: 'cli', objective: 'ship-the-cli' });
    const promoted = apply({ fileIssues: [issue({ key: 'live', title: 'Other' })] }).filed[0];
    setCrewIssue(w.db, promoted ?? -1, { state: 'promoted' }, t0);
    const r = apply(
      {
        fileIssues: [
          issue({ key: 'n1', body: CORRECTED, replaces: 'nope' }),
          issue({ key: 'n2', body: CORRECTED, replaces: 'elsewhere' }),
          issue({ key: 'n3', body: CORRECTED, replaces: 'cli' }),
          issue({ key: 'n4', body: CORRECTED, replaces: 'live' }),
        ],
      },
      soon,
    );
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual([
      'n1: replaces nope: no such crew issue',
      'n2: replaces elsewhere: no such crew issue',
      "n3: replaces cli: another objective's issue",
      'n4: replaces live: not a rejected issue',
    ]);
  });

  test('an issue Command rejected cannot be replaced, even with a corrected body', async () => {
    const id = fileRejected({ key: 'vetoed' });
    await commandRejects(id);
    const r = apply(
      { fileIssues: [issue({ key: 'vetoed-2', body: CORRECTED, replaces: 'vetoed' })] },
      soon,
    );
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual(['vetoed-2: replaces vetoed: Command rejected it']);
  });

  test('an identical body is refused', () => {
    fileRejected({ key: 'same' });
    const r = apply({ fileIssues: [issue({ key: 'same-2', replaces: 'same' })] }, soon);
    expect(r.refused).toEqual(['same-2: replaces same: the body is unchanged']);
  });

  test('an identical body as the server hashed it is refused too', () => {
    const id = fileRejected({ key: 'hashed' });
    const stored = getCrewIssue(w.db, id);
    // As the flush records it: the body sanitised, its sha stored; the raw body here differs only
    // in line endings and trailing space.
    setCrewIssue(w.db, id, { bodySha: crewBodySha(BODY) }, t0);
    expect(stored?.body).toBe(BODY);
    const crlf = `${BODY.replace(/\n/g, '\r\n')}   `;
    const r = apply(
      { fileIssues: [issue({ key: 'hashed-2', body: crlf, replaces: 'hashed' })] },
      soon,
    );
    expect(r.refused).toEqual(['hashed-2: replaces hashed: the body is unchanged']);
  });

  test('an issue already replaced cannot be replaced again', () => {
    fileRejected({ key: 'once' });
    const first = apply(
      { fileIssues: [issue({ key: 'once-2', body: CORRECTED, replaces: 'once' })] },
      soon,
    );
    expect(first.filed).toHaveLength(1);
    setCrewIssue(w.db, first.filed[0] ?? -1, { state: 'promoted' }, soon);
    const again = apply(
      {
        fileIssues: [
          issue({ key: 'once-3', title: 'Docs again', body: `${CORRECTED}x\n`, replaces: 'once' }),
        ],
      },
      soon,
    );
    expect(again.refused).toEqual(['once-3: replaces once: already replaced']);
  });

  test('two issues replacing the same key in one result: only the first is filed', () => {
    fileRejected({ key: 'twin' });
    const r = apply(
      {
        fileIssues: [
          issue({ key: 'twin-a', body: CORRECTED, replaces: 'twin' }),
          issue({ key: 'twin-b', title: 'Docs B', body: `${CORRECTED}b\n`, replaces: 'twin' }),
        ],
      },
      soon,
    );
    expect(r.filed).toHaveLength(1);
    expect(getCrewIssue(w.db, r.filed[0] ?? -1)?.key).toBe('twin-a');
    expect(r.refused).toEqual(['twin-b: replaces twin: already replaced']);
  });

  test('the database holds one replacement per key, whatever the caller', () => {
    fileRejected({ key: 'solo' });
    const insert = (key: string) =>
      w.db
        .prepare(
          `INSERT INTO crew_issues (zone_id, key, source, objective, title, title_norm, body,
             state, replaces, created_at, updated_at)
           VALUES ('main', ?, 'drop', 'document-every-endpoint', 't', 't', 'b', 'filing', 'solo',
             ?, ?)`,
        )
        .run(key, t0.toISOString(), t0.toISOString());
    insert('solo-a');
    expect(() => insert('solo-b')).toThrow(/UNIQUE/);
  });

  test('a chain ends after 2 replacements: the third is refused with the briefing message', () => {
    fileRejected({ key: 'v1' });
    let at = soon;
    for (const [key, prev] of [
      ['v2', 'v1'],
      ['v3', 'v2'],
    ] as const) {
      const r = apply(
        { fileIssues: [issue({ key, body: `${CORRECTED}${key}\n`, replaces: prev })] },
        at,
      );
      expect(r.refused).toEqual([]);
      setCrewIssue(w.db, r.filed[0] ?? -1, { state: 'rejected' }, at);
      at = plus(at, 3600_000);
    }
    const third = apply(
      { fileIssues: [issue({ key: 'v4', body: `${CORRECTED}v4\n`, replaces: 'v3' })] },
      at,
    );
    expect(third.filed).toEqual([]);
    expect(third.refused).toEqual(['v4: replaced twice already: raise a briefing']);
  });

  test('a replacement of one issue cannot carry the title of another recently rejected issue', async () => {
    fileRejected({ key: 'refuted', title: 'Refuted work', body: CORRECTED });
    const vetoed = fileRejected({ key: 'vetoed', title: 'Vetoed work' });
    await commandRejects(vetoed);
    const r = apply(
      {
        fileIssues: [
          // Command's rejected title and body, smuggled in as a replacement of another issue.
          issue({ key: 'vetoed-2', title: 'Vetoed work', replaces: 'refuted' }),
        ],
      },
      soon,
    );
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual(['vetoed-2: duplicate of a crew issue rejected in the last 7 days']);
  });

  test('a replacement cannot carry the title of another refute-rejected issue outside its chain', () => {
    fileRejected({ key: 'first', title: 'First work', body: CORRECTED });
    fileRejected({ key: 'second', title: 'Second work' });
    const r = apply(
      { fileIssues: [issue({ key: 'second-2', title: 'Second work', replaces: 'first' })] },
      soon,
    );
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual(['second-2: duplicate of a crew issue rejected in the last 7 days']);
  });

  test('a chain sharing one title files each refiling', () => {
    fileRejected({ key: 'c1', title: 'Chain work' });
    let at = soon;
    for (const [key, prev] of [
      ['c2', 'c1'],
      ['c3', 'c2'],
    ] as const) {
      const r = apply(
        {
          fileIssues: [
            issue({ key, title: 'Chain work', body: `${CORRECTED}${key}\n`, replaces: prev }),
          ],
        },
        at,
      );
      expect(r.refused).toEqual([]);
      expect(r.filed).toHaveLength(1);
      expect(getCrewIssue(w.db, r.filed[0] ?? -1)).toMatchObject({ key, replaces: prev });
      setCrewIssue(w.db, r.filed[0] ?? -1, { state: 'rejected' }, at);
      at = plus(at, 3600_000);
    }
  });

  test('a replacement with a new title that no other rejected issue has is filed', () => {
    fileRejected({ key: 'old', title: 'Old work' });
    fileRejected({ key: 'other', title: 'Other work' });
    const r = apply(
      {
        fileIssues: [
          issue({ key: 'renamed', title: 'Renamed work', body: CORRECTED, replaces: 'old' }),
        ],
      },
      soon,
    );
    expect(r.refused).toEqual([]);
    expect(r.filed).toHaveLength(1);
    expect(getCrewIssue(w.db, r.filed[0] ?? -1)).toMatchObject({
      key: 'renamed',
      replaces: 'old',
    });
  });
});

describe('the order of an objective’s issues: `after` (#843)', () => {
  const placed = (path: string) => `${BODY}\n## Placement\n\n- \`${path}\`\n`;
  const zone5 = () => ({ ...w.zone, crew: { ...w.zone.crew, maxStaged: 10 } });
  const apply5 = (input: Parameters<typeof applyCrewActions>[2]) =>
    applyCrewActions(w.db, zone5(), input, DROP, t0);

  test('an issue may follow an existing issue and an earlier item; the keys are stored', () => {
    apply5({ fileIssues: [issue({ key: 'a', title: 'A', body: placed('src/a.ts') })] });
    const r = apply5({
      fileIssues: [
        issue({ key: 'b', title: 'B', body: placed('src/b.ts'), after: ['a'] }),
        issue({ key: 'c', title: 'C', body: placed('src/c.ts'), after: ['a', 'b'] }),
        issue({ key: 'd', title: 'D', body: placed('src/d.ts'), after: [] }),
        issue({ key: 'e', title: 'E', body: BODY }),
      ],
    });
    expect(r.refused).toEqual([]);
    expect(r.filed.map((id) => getCrewIssue(w.db, id)?.after)).toEqual([
      ['a'],
      ['a', 'b'],
      [],
      null,
    ]);
  });

  test('an unknown key, its own key, another objective’s, a later item and six keys are refused with the reason', () => {
    apply5({
      fileIssues: [
        issue({ key: 'cli', objective: 'ship-the-cli', title: 'Cli', body: placed('cli.ts') }),
      ],
    });
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']) {
      apply5({ fileIssues: [issue({ key: k, title: k, body: placed(`${k}.ts`) })] });
    }
    const r = apply5({
      fileIssues: [
        issue({ key: 'n1', title: 'N1', body: placed('x.ts'), after: ['nope'] }),
        issue({ key: 'n2', title: 'N2', body: placed('x.ts'), after: ['n2'] }),
        issue({ key: 'n3', title: 'N3', body: placed('x.ts'), after: ['cli'] }),
        issue({ key: 'n4', title: 'N4', body: placed('x.ts'), after: ['n5'] }),
        issue({
          key: 'n5',
          title: 'N5',
          body: placed('x.ts'),
          after: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
        }),
      ],
    });
    expect(r.filed).toEqual([]);
    expect(r.refused).toEqual([
      'n1: after nope: no such crew issue',
      'n2: after n2: its own key',
      "n3: after cli: another objective's issue",
      'n4: after n5: a later item of this result',
      'n5: after names more than 5 issues',
    ]);
    expect(
      apply5({
        fileIssues: [
          issue({
            key: 'n6',
            title: 'N6',
            body: placed('x.ts'),
            after: ['k1', 'k2', 'k3', 'k4', 'k5'],
          }),
        ],
      }).refused,
    ).toEqual([]);
  });

  test('an issue with after but no Placement path is refused; without after it is filed', () => {
    const r = apply5({
      fileIssues: [
        issue({ key: 'a', title: 'A', after: [] }),
        issue({
          key: 'b',
          title: 'B',
          body: `${BODY}\n## Placement\n\nthe docs folder\n`,
          after: [],
        }),
        issue({ key: 'c', title: 'C' }),
      ],
    });
    expect(r.refused).toEqual([
      'a: an issue with after needs a Placement section',
      'b: an issue with after needs a Placement section',
    ]);
    expect(r.filed).toHaveLength(1);
  });
});
