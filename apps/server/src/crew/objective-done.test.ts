import { beforeEach, describe, expect, test } from 'vitest';
import {
  getBriefing,
  listBriefings,
  optionsDigest,
  SINCE_RAISED,
  syncObjectiveDoneBriefings,
} from '../briefings.js';
import {
  setWorkItemState,
  upsertDropZone,
  upsertWorkItem,
  type WorkItemState,
} from '../db/repo.js';
import { refreshGoals } from '../goals.js';
import { makeZone, type ZoneWorld, zoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { applyCrewActions, type CrewSource } from './actions.js';
import {
  CLAIM_DONE_REASON,
  COMMAND_DONE_REASON,
  type CrewIssueState,
  insertCrewIssue,
  setCrewIssue,
} from './store.js';

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

const A = 'document-every-endpoint';
const B = 'ship-the-cli';
/** A title that must never reach a refusal or a briefing's line. */
const TITLE = 'Secret title words';
const DROP: CrewSource = { kind: 'drop', dropId: 'drop-1' };
const DONE = { key: A, why: 'Every endpoint page has merged (#3, #4).' };

let w: ZoneWorld;
beforeEach(async () => {
  w = zoneWorld({ crew: { ...makeZone().crew, enabled: true } });
  w.f.state.files.set('main:GOAL.md', GOAL);
  await refreshGoals(w.db, w.f.author, w.zone, 'main', t0);
});

const apply = (input: Parameters<typeof applyCrewActions>[2], at = t0) =>
  applyCrewActions(w.db, w.zone, input, DROP, at);

let seq = 0;
/** A crew issue of `objective` in `state`, with forge number `n` (null: none yet). */
function crewIssue(
  state: CrewIssueState,
  n: number | null,
  o: { objective?: string; zoneId?: string; key?: string } = {},
): number {
  seq++;
  return insertCrewIssue(w.db, {
    zoneId: o.zoneId ?? 'main',
    key: o.key ?? `k${seq}`,
    source: 'drop',
    objective: o.objective ?? A,
    title: `${TITLE} ${seq}`,
    body: BODY,
    priority: null,
    number: n,
    state,
    createdAt: t0.toISOString(),
  });
}

/** Issue `n`'s work item in `state`, with `reason`. */
function item(n: number, state: WorkItemState, reason?: string, zoneId = 'main'): number {
  const it = upsertWorkItem(w.db, {
    dropZoneId: zoneId,
    issueNumber: n,
    title: TITLE,
    body: 'x',
    author: 'author-bot',
    priority: 1,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  setWorkItemState(w.db, it.id, state, reason);
  return it.id;
}

const doneOpen = () =>
  listBriefings(w.db, { zoneId: 'main', state: 'open' }).filter((b) => b.kind === 'objective_done');

describe('objectiveDone is refused while an issue of the objective is unfinished (#882)', () => {
  test('the 09:58 case: #879 in flight is named; once it merges the next report raises it', () => {
    crewIssue('promoted', 877);
    item(877, 'done', 'merged');
    crewIssue('promoted', 879);
    const it = item(879, 'in_flight');
    expect(apply({ objectiveDone: DONE })).toEqual({
      filed: [],
      briefings: [],
      refused: [`objectiveDone ${A}: not done: #879 (in_flight)`],
    });
    expect(doneOpen()).toEqual([]);
    setWorkItemState(w.db, it, 'done', 'merged');
    const r = apply({ objectiveDone: DONE }, plus(t0, 60_000));
    expect(r.refused).toEqual([]);
    expect(r.briefings).toHaveLength(1);
    expect(doneOpen()).toHaveLength(1);
  });

  test('every issue merged, one rejected and replaced by a merged one: recorded as today', () => {
    crewIssue('promoted', 3);
    item(3, 'done', 'merged');
    crewIssue('rejected', 4, { key: 'old' });
    crewIssue('promoted', 5);
    item(5, 'done', 'merged');
    const r = apply({ objectiveDone: DONE });
    expect(r).toEqual({ filed: [], briefings: [expect.any(Number)], refused: [] });
    expect(getBriefing(w.db, r.briefings[0] ?? -1)).toMatchObject({
      kind: 'objective_done',
      why: DONE.why,
      state: 'open',
    });
  });

  test('a parked issue of the objective is refused, naming it', () => {
    crewIssue('promoted', 12);
    item(12, 'parked', 'budget exhausted: heal');
    expect(apply({ objectiveDone: DONE }).refused).toEqual([
      `objectiveDone ${A}: not done: #12 (parked)`,
    ]);
  });

  // Every crew-issue state, and for a promoted one every work-item state: refused, or recorded.
  const cases: [string, CrewIssueState, [WorkItemState, string?] | null, string | null][] = [
    ['filing', 'filing', null, '#50 (filing)'],
    ['staged', 'staged', null, '#50 (staged)'],
    ['promote_held', 'promote_held', null, '#50 (promote_held)'],
    ['promoting', 'promoting', null, '#50 (promoting)'],
    ['revising', 'revising', null, '#50 (revising)'],
    ['rejecting', 'rejecting', null, null],
    ['rejected', 'rejected', null, null],
    ['failed', 'failed', null, null],
    ['promoted, no work item (D2)', 'promoted', null, '#50 (promoted)'],
    ['promoted, ready', 'promoted', ['ready'], '#50 (ready)'],
    ['promoted, in_flight', 'promoted', ['in_flight'], '#50 (in_flight)'],
    ['promoted, pr_open', 'promoted', ['pr_open'], '#50 (pr_open)'],
    ['promoted, parked', 'promoted', ['parked', 'gate ci failed'], '#50 (parked)'],
    ['promoted, done merged', 'promoted', ['done', 'merged'], null],
    ['promoted, closed by Command as done', 'promoted', ['done', COMMAND_DONE_REASON], null],
    ['promoted, verified already done', 'promoted', ['done', CLAIM_DONE_REASON], null],
    [
      'promoted, done not planned',
      'promoted',
      ['done', 'issue closed as not planned'],
      '#50 (done)',
    ],
    ['promoted, done with no reason', 'promoted', ['done'], '#50 (done)'],
  ];
  test.each(cases)('%s', (_name, state, workItem, named) => {
    crewIssue(state, 50);
    if (workItem) item(50, ...workItem);
    const r = apply({ objectiveDone: DONE });
    if (named === null) {
      expect(r.refused).toEqual([]);
      expect(r.briefings).toHaveLength(1);
    } else {
      expect(r).toEqual({
        filed: [],
        briefings: [],
        refused: [`objectiveDone ${A}: not done: ${named}`],
      });
    }
  });

  test('a promoted issue with no number yet (D2) and a staged one are named by key', () => {
    crewIssue('promoted', null, { key: 'no-number' });
    crewIssue('staged', null, { key: 'still-staged' });
    expect(apply({ objectiveDone: DONE }).refused).toEqual([
      `objectiveDone ${A}: not done: no-number (promoted), still-staged (staged)`,
    ]);
  });

  test("another zone's and another objective's unfinished issues are not counted", () => {
    upsertDropZone(w.db, {
      id: 'other',
      repo: 'octo/other',
      defaultBranch: 'main',
      configJson: '{}',
    });
    crewIssue('staged', 60, { zoneId: 'other' });
    crewIssue('promoted', 61, { zoneId: 'other' });
    item(61, 'in_flight', undefined, 'other');
    crewIssue('staged', 62, { objective: B });
    crewIssue('promoted', 63, { objective: B });
    item(63, 'in_flight');
    const r = apply({ objectiveDone: DONE });
    expect(r.refused).toEqual([]);
    expect(r.briefings).toHaveLength(1);
  });

  test('six unfinished: five are named, then "and 1 more"', () => {
    for (let n = 70; n < 76; n++) crewIssue('staged', n);
    expect(apply({ objectiveDone: DONE }).refused).toEqual([
      `objectiveDone ${A}: not done: #70 (staged), #71 (staged), #72 (staged), #73 (staged), #74 (staged), and 1 more`,
    ]);
  });

  test('an issue filed in the same result is read in the recording transaction (D3)', () => {
    const r = apply({
      fileIssues: [{ key: 'last-page', objective: A, title: TITLE, body: BODY }],
      objectiveDone: DONE,
    });
    expect(r.filed).toHaveLength(1);
    expect(r.briefings).toEqual([]);
    expect(r.refused).toEqual([`objectiveDone ${A}: not done: last-page (filing)`]);
    expect(doneOpen()).toEqual([]);
  });

  test("an issue's title never appears in the refusal", () => {
    crewIssue('staged', 80);
    crewIssue('promoted', 81);
    item(81, 'pr_open');
    const [refusal] = apply({ objectiveDone: DONE }).refused;
    expect(refusal).toContain('not done: #80 (staged), #81 (pr_open)');
    expect(refusal).not.toContain(TITLE);
  });
});

describe('an open objective_done briefing names issues unfinished since it was raised (#882)', () => {
  const raise = (): number => {
    const r = apply({ objectiveDone: DONE });
    expect(r.refused).toEqual([]);
    return r.briefings[0] ?? -1;
  };
  const sync = (at = plus(t0, 60_000)) => syncObjectiveDoneBriefings(w.db, 'main', at);

  test('the line appears once, changes with the list, and goes when nothing is unfinished', () => {
    const id = raise();
    const before = getBriefing(w.db, id);
    if (!before) throw new Error('no briefing');
    sync();
    expect(getBriefing(w.db, id)?.why).toBe(DONE.why);

    // An audit files a fix-forward after the briefing was raised.
    const audit = crewIssue('staged', 90);
    sync();
    sync();
    const once = getBriefing(w.db, id);
    expect(once?.why).toBe(
      `${DONE.why}\n\n${SINCE_RAISED}1 issue(s) of the objective are unfinished: #90 (staged).`,
    );
    expect(once?.why.split(SINCE_RAISED)).toHaveLength(2);

    setCrewIssue(w.db, audit, { state: 'promoted' }, t0);
    const it = item(90, 'in_flight');
    crewIssue('staged', 91);
    sync();
    const changed = getBriefing(w.db, id);
    expect(changed?.why).toBe(
      `${DONE.why}\n\n${SINCE_RAISED}2 issue(s) of the objective are unfinished: #90 (in_flight), #91 (staged).`,
    );
    expect(changed?.why).not.toContain(TITLE);

    setWorkItemState(w.db, it, 'done', 'merged');
    w.db.prepare("UPDATE crew_issues SET state = 'rejected' WHERE number = 91").run();
    sync();
    const after = getBriefing(w.db, id);
    expect(after?.why).toBe(DONE.why);

    // It stayed open the whole time, with the same options, decision and on-hold.
    for (const b of [once, changed, after]) {
      expect(b).toMatchObject({
        state: 'open',
        kind: 'objective_done',
        decision: before.decision,
        options: before.options,
        onHold: before.onHold,
      });
    }
    expect(optionsDigest(after ?? before)).toBe(optionsDigest(before));
  });

  test('the options are the same whatever the line says', () => {
    const id = raise();
    const before = getBriefing(w.db, id);
    for (let n = 100; n < 107; n++) crewIssue('staged', n);
    sync();
    const b = getBriefing(w.db, id);
    expect(b?.options).toEqual(before?.options);
    expect(b?.why).toBe(
      `${DONE.why}\n\n${SINCE_RAISED}7 issue(s) of the objective are unfinished: #100 (staged), #101 (staged), #102 (staged), #103 (staged), #104 (staged), and 2 more.`,
    );
    expect(b?.why).not.toContain(TITLE);
  });

  test('a ruled briefing and another objective are left alone', () => {
    const id = raise();
    w.db.prepare("UPDATE briefings SET state = 'ruled' WHERE id = ?").run(id);
    crewIssue('staged', 110);
    sync();
    expect(getBriefing(w.db, id)?.why).toBe(DONE.why);
  });
});
