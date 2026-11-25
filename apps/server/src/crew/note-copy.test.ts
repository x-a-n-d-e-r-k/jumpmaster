import type { DropResult } from '@jumpmaster/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { raiseBriefing, ruleBriefing } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import { getDrop, listEvents, updateDrop, upsertDropZone } from '../db/repo.js';
import { zonePass } from '../flow/snapshot.js';
import { listGoalChanges } from '../goal-change.js';
import { promptVersions } from '../payloads.js';
import { applyResult, type ResultDeps } from '../results.js';
import { crewWorld, GOAL, ISSUE_BODY } from '../test/crew.js';
import { usageCfg, type ZoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import {
  applyCrewActions,
  type CrewSource,
  NOTE_WINDOW,
  NOTES_UNREADABLE,
  noteCopyCheck,
  noteWords,
} from './actions.js';
import { enqueueCrew } from './schedule.js';
import {
  getCrewIssue,
  getTriageRequest,
  listCrewIssues,
  recordTriageRequest,
  setCrewIssue,
} from './store.js';

/** The issue's example note: an option label, then private plans. */
const NOTE = 'Use the second option and tell the platform team before the March move';
const COPY = 'tell the platform team before the March move';
/** Every word of the note an output must never carry, beyond the option label's. */
const PRIVATE = ['platform', 'march', 'move'];

let w: ZoneWorld;
let logs: string[];
beforeEach(async () => {
  w = await crewWorld();
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

let subjects = 0;
/** A ruled crew briefing of `zoneId` with `note`; returns the ruling's id. */
function rule(note: string, zoneId = 'main', at = t0): number {
  const id = raiseBriefing(
    w.db,
    {
      zoneId,
      kind: 'crew',
      subject: `crew:none:q${++subjects}`,
      decision: 'Which option?',
      why: 'Two ways to do it.',
      options: [
        { id: 'o1', label: 'Use the first option', effect: 'none' },
        { id: 'o2', label: 'Use the second option', effect: 'none' },
      ],
      onHold: 'nothing',
      source: 'crew',
      sourceRef: 'd0',
    },
    at,
  );
  const r = ruleBriefing(w.db, id, 'o2', note, at, { via: 'session' });
  if (!r.ok) throw new Error('not ruled');
  return r.rulingId;
}

const withLine = (line: string): string =>
  ISSUE_BODY.replace('The API has no docs.', `The API has no docs.\n\n${line}`);

const DROP: CrewSource = { kind: 'drop', dropId: 'd1' };
const MCP: CrewSource = { kind: 'mcp', tokenId: 7 };
const fileOne = (body: string, source: CrewSource = DROP, title = 'Add docs') =>
  applyCrewActions(
    w.db,
    w.zone,
    { fileIssues: [{ key: 'add-docs', objective: 'document-every-endpoint', title, body }] },
    source,
    t0,
  );

/** Nothing here may carry the note's private words. */
function expectNoNoteWords(...outputs: unknown[]): void {
  for (const out of [...outputs, ...logs]) {
    const text = (typeof out === 'string' ? out : JSON.stringify(out)).toLowerCase();
    for (const word of PRIVATE) expect(text).not.toContain(word);
  }
}

const deps = (zone: DropZoneConfig = w.zone): ResultDeps => ({
  forges: w.forges,
  zone,
  secrets: [],
  usageCfg,
  rand: () => 0.5,
});

async function crewDrop(at = t0): Promise<string> {
  const pass = await zonePass(w.forges, w.zone, 'main');
  const id = await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, at);
  if (!id) throw new Error('no crew drop enqueued');
  updateDrop(w.db, id, { state: 'running', startedAt: at.toISOString() });
  return id;
}

const completed = (crew: unknown): DropResult => ({ status: 'completed', crew, gates: [] });

describe("a crew issue never copies Command's ruling note (#893)", () => {
  test('the example: a lead issue copying the note is refused with the ruling, not the words', async () => {
    const n = rule(NOTE);
    const id = await crewDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        summary: `Ruling ${n} said: ${NOTE}`,
        fileIssues: [
          {
            key: 'add-docs',
            objective: 'document-every-endpoint',
            title: 'Add docs',
            body: withLine(`Per Command, ${COPY}.`),
          },
        ],
        briefings: [],
      }),
      t0,
    );
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    const drop = getDrop(w.db, id);
    const report = (JSON.parse(drop?.resultJson ?? '{}') as { crewReport: unknown }).crewReport;
    expect(report).toEqual({
      filed: [],
      briefings: [],
      refused: [`add-docs: copies Command's ruling note (ruling ${n})`],
    });
    expect(logs.some((l) => l.includes(`copies Command's ruling note (ruling ${n})`))).toBe(true);
    expectNoNoteWords(report, listEvents(w.db, id));
  });

  test("an issue saying the second option was chosen, quoting the option's label, is filed", () => {
    const n = rule(NOTE);
    expect(
      fileOne(withLine(`Ruling ${n} chose the second option: "Use the second option".`)).refused,
    ).toEqual([]);
    expect(listCrewIssues(w.db, 'main')).toHaveLength(1);
  });

  test("the lead's summary quoting the note is accepted", async () => {
    rule(NOTE);
    const id = await crewDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ summary: `The note said: ${NOTE}`, fileIssues: [], briefings: [] }),
      t0,
    );
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
  });

  test('a copy in the title is refused too', () => {
    const n = rule(NOTE);
    expect(fileOne(ISSUE_BODY, DROP, `Docs: ${COPY}`).refused).toEqual([
      `add-docs: copies Command's ruling note (ruling ${n})`,
    ]);
  });

  test.each([
    ['different case', 'TELL The Platform TEAM before THE march MOVE'],
    ['punctuation', 'tell, the platform-team; before... the "March" move!'],
    ['line breaks', 'tell the\nplatform team\r\nbefore the\n\nMarch move'],
    ['Markdown emphasis', 'tell **the platform** _team_ before *the* `March` move'],
    [
      'zero-width characters',
      'tell the pla\u200Btform te\u200Dam before\u2060 the Ma\uFEFFrch move',
    ],
    [
      'soft hyphens and full-width letters',
      'tell the plat\u00ADform \uFF54\uFF45\uFF41\uFF4D before the March move',
    ],
  ])('evasion by %s is still refused', (_, line) => {
    const n = rule(NOTE);
    const r = fileOne(withLine(line));
    expect(r.refused).toEqual([`add-docs: copies Command's ruling note (ruling ${n})`]);
    expectNoNoteWords(r);
  });

  test('five matching words in a row are accepted', () => {
    rule(NOTE);
    expect(fileOne(withLine('Then tell the platform team before anything.')).refused).toEqual([]);
  });

  test('a three-word note is matched whole; a two-word note never', () => {
    const n = rule('Freeze the release');
    expect(fileOne(withLine('Please freeze, the RELEASE.')).refused).toEqual([
      `add-docs: copies Command's ruling note (ruling ${n})`,
    ]);
    w.db.prepare('UPDATE rulings SET note = ? WHERE id = ?').run('ship it', n);
    expect(fileOne(withLine('Then ship it.')).refused).toEqual([]);
  });

  test("another zone's note is not matched", () => {
    upsertDropZone(w.db, { id: 'other', repo: 'o/other', defaultBranch: 'main', configJson: '{}' });
    rule(NOTE, 'other');
    expect(fileOne(withLine(COPY)).refused).toEqual([]);
  });

  test(`only the last ${NOTE_WINDOW} non-empty notes are checked; empty ones don't count`, () => {
    const n = rule(NOTE);
    for (let k = 1; k < NOTE_WINDOW; k++) rule(`unrelated note number ${k}`, 'main', plus(t0, k));
    for (let k = 0; k < 3; k++) rule('', 'main', plus(t0, 100 + k));
    expect(fileOne(withLine(COPY)).refused).toEqual([
      `add-docs: copies Command's ruling note (ruling ${n})`,
    ]);
    rule('one more unrelated note', 'main', plus(t0, 200));
    expect(fileOne(withLine(COPY)).refused).toEqual([]);
  });

  test("a run that is also in the goal file on main isn't a copy of the note", () => {
    rule('Every endpoint is documented, LIGHTHOUSE-TEXT; ask Dana first');
    expect(
      fileOne(withLine('So that every endpoint is documented, lighthouse text.')).refused,
    ).toEqual([]);
  });

  test('D2: an error reading the notes refuses the text, without echoing it', () => {
    rule(NOTE);
    w.db.exec('ALTER TABLE rulings RENAME TO rulings_away');
    const r = fileOne(ISSUE_BODY);
    expect(r.refused).toEqual([`add-docs: ${NOTES_UNREADABLE}`]);
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(noteCopyCheck(w.db, 'main')('anything at all')).toBe(NOTES_UNREADABLE);
  });

  test('an MCP filing goes through the same check', () => {
    const n = rule(NOTE);
    const r = fileOne(withLine(COPY), MCP);
    expect(r).toEqual({
      filed: [],
      briefings: [],
      refused: [`add-docs: copies Command's ruling note (ruling ${n})`],
    });
    expectNoNoteWords(r);
    expect(fileOne(withLine('The second option was chosen.'), MCP).refused).toEqual([]);
  });

  test('noteWords drops case, punctuation, emphasis and invisible characters', () => {
    expect(noteWords('**Tell**\u200B the _Pla\u00ADtform_,\nteam!')).toEqual([
      'tell',
      'the',
      'platform',
      'team',
    ]);
  });
});

describe('a refute revision never copies a ruling note (#893)', () => {
  /** A staged crew issue, as a refute drop sees it. */
  function staged(): number {
    const r = fileOne(ISSUE_BODY);
    const id = r.filed[0] ?? -1;
    setCrewIssue(w.db, id, { state: 'staged', number: 40, bodySha: 'sha-1' }, t0);
    w.f.state.addIssue({ number: 40, body: ISSUE_BODY, labels: ['agent-staged'] });
    return id;
  }

  test('a revision copying the note is rejected, with the ruling in its findings', async () => {
    const issue = staged();
    const n = rule(NOTE);
    const id = await crewDrop();
    expect(getDrop(w.db, id)?.role).toBe('refute');
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ decision: 'revise', findings: ['vague'], revisedBody: withLine(COPY) }),
      t0,
    );
    const row = getCrewIssue(w.db, issue);
    expect(row).toMatchObject({ state: 'rejecting', body: ISSUE_BODY });
    expect(JSON.parse(row?.findingsJson ?? '[]')).toEqual([
      'vague',
      `revision refused: copies Command's ruling note (ruling ${n})`,
    ]);
    expectNoNoteWords(row?.findingsJson ?? '');
  });

  test('a revision saying what the note asks for in its own words is kept', async () => {
    const issue = staged();
    rule(NOTE);
    const id = await crewDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        decision: 'revise',
        findings: [],
        revisedBody: withLine('Command chose the second option.'),
      }),
      t0,
    );
    expect(getCrewIssue(w.db, issue)?.state).toBe('revising');
  });
});

describe('a triage child never copies a ruling note (#893)', () => {
  const TEXT = { title: 'Docs', body: 'Please document the API.' };

  async function triage(body: string) {
    w.f.state.addIssue({ number: 179, ...TEXT, author: 'human', labels: ['jm-triage'] });
    const req = recordTriageRequest(w.db, 'main', { number: 179, ...TEXT, author: 'human' }, t0);
    const id = await crewDrop();
    expect(getDrop(w.db, id)?.role).toBe('triage');
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        summary: 's',
        outcome: 'split',
        children: [{ key: 'docs-page', title: 'Docs page', body }],
      }),
      t0,
    );
    const events = listEvents(w.db, id).map((e) => String(e.data.message));
    return { req: getTriageRequest(w.db, req ?? -1), events };
  }

  test('a child copying the note files nothing, and the refusal names only the ruling', async () => {
    const n = rule(NOTE);
    const { req, events } = await triage(withLine(COPY));
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(req).toMatchObject({ state: 'open', attempts: 1 });
    expect(events).toEqual([`split refused: copies Command's ruling note (ruling ${n})`]);
    expectNoNoteWords(req, events);
  });

  test('a child in its own words is filed', async () => {
    rule(NOTE);
    await triage(withLine('Command chose the second option.'));
    expect(listCrewIssues(w.db, 'main')).toHaveLength(1);
  });
});

describe('a crew goal change never copies a ruling note (#893)', () => {
  const withObjective = (title: string) =>
    GOAL.replace('### Ship the CLI', `### Ship the CLI\n\n### ${title}`);

  async function propose(text: string) {
    const id = await crewDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ summary: 's', fileIssues: [], briefings: [], goalChange: { text, why: 'w' } }),
      t0,
    );
    const drop = getDrop(w.db, id);
    return (JSON.parse(drop?.resultJson ?? '{}') as { crewReport: { refused: string[] } })
      .crewReport;
  }

  test('a goal change copying the note is refused with the ruling, not the words', async () => {
    const n = rule(NOTE);
    const report = await propose(withObjective('Tell the platform team before the March move'));
    expect(report.refused).toEqual([`goalChange: copies Command's ruling note (ruling ${n})`]);
    expect(listGoalChanges(w.db, 'main')).toEqual([]);
    expectNoNoteWords(report);
  });

  test('a run the current goal file already has is allowed in a goal change', async () => {
    rule('Every endpoint is documented, LIGHTHOUSE-TEXT; ask Dana first');
    const report = await propose(withObjective('Write the guide'));
    expect(report.refused).toEqual([]);
    expect(listGoalChanges(w.db, 'main')).toHaveLength(1);
  });
});
