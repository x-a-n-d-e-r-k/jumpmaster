import type { CrewLeadOutput } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { listBriefings } from '../briefings.js';
import { setKilled, setZoneMode } from '../db/repo.js';
import { refreshGoals } from '../goals.js';
import { makeZone, type ZoneWorld, zoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import {
  applyCrewActions,
  type CrewSource,
  crewIssueSlots,
  normaliseTitle,
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
    expect(b?.subject).toBe('crew:item:1');
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
