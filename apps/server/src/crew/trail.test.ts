import type { DropResult } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { ruleBriefing } from '../briefings.js';
import {
  getDrop,
  listOutbox,
  listWorkItems,
  setKilled,
  setZoneMode,
  updateDrop,
  updateOutbox,
} from '../db/repo.js';
import { zonePass } from '../flow/snapshot.js';
import { commentMarker, opKeys, sanitizeCrewText } from '../outbox.js';
import { promptVersions } from '../payloads.js';
import { applyResult, type ResultDeps } from '../results.js';
import { enqueueNext } from '../scheduler.js';
import { syncDropZone } from '../sync.js';
import { crewOn, crewWorld, ISSUE_BODY } from '../test/crew.js';
import { FORGE_WRITES } from '../test/fakes.js';
import { usageCfg, type ZoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { flushCrewOps } from './flush.js';
import { triageInput } from './inputs.js';
import { enqueueCrew } from './schedule.js';
import {
  getTriageRequest,
  listCrewIssues,
  listTriageRequests,
  recordTriageRequest,
  setTriageRequest,
} from './store.js';
import { flushTriageTrail } from './trail.js';

const MIN = 60_000;
const BODY_PHRASE = 'PURPLE-OVERAGE-SENTENCE';
const TEXT_179 = {
  title: 'Usage page: overage gauge and Fable usage',
  body: `The overage gauge shows ${BODY_PHRASE} even though overage is off.\n\nAlso show Fable usage.`,
};
const briefing = {
  subject: 'fable usage',
  decision: 'Drop the gauge, estimate it, or wait?',
  why: "Fable usage isn't in the usage API we read.",
  options: ['Drop the gauge', 'Estimate it', 'Wait'],
  recommendation: 'Drop the gauge',
  onHold: 'the Fable half of #179',
};
const child = (key: string) => ({ key, title: `Child ${key}`, body: ISSUE_BODY });

let w: ZoneWorld;
beforeEach(async () => {
  w = await crewWorld();
});

const deps = (): ResultDeps => ({
  forges: w.forges,
  zone: w.zone,
  secrets: [],
  usageCfg,
  rand: () => 0.5,
});

function request179(): number {
  w.f.state.addIssue({ number: 179, ...TEXT_179, author: 'human', labels: ['jm-triage'] });
  return recordTriageRequest(w.db, 'main', { number: 179, ...TEXT_179, author: 'human' }, t0) ?? -1;
}

/** A triage drop on the oldest open request, completed with `crew` as its output. */
async function triaged(crew: unknown, at = t0): Promise<void> {
  const pass = await zonePass(w.forges, w.zone, 'main');
  const id = await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, at);
  if (!id) throw new Error('no crew drop enqueued');
  expect(getDrop(w.db, id)?.role).toBe('triage');
  updateDrop(w.db, id, { state: 'running', startedAt: at.toISOString() });
  const result: DropResult = { status: 'completed', crew, gates: [] };
  await applyResult(w.db, deps(), id, result, at);
}

const trail = (at = plus(t0, 5 * MIN)) => flushTriageTrail(w.db, w.forges, w.zone, [], at);

const commentOps = () =>
  listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main').filter(
    (o) => o.kind === 'comment_issue',
  );
const labelOps = () =>
  listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main').filter(
    (o) => o.kind === 'set_labels',
  );
const commentsOn = (n: number) => w.f.state.comments.filter((c) => c.issue === n);
const labelsOf = (n: number) => w.f.state.issues.get(n)?.labels ?? [];

async function split179(): Promise<number> {
  const req = request179();
  await triaged({
    summary: 's',
    outcome: 'split',
    children: [child('hide-overage-gauge'), child('report-fable-usage')],
  });
  return req;
}

describe('triage trail (#185)', () => {
  test('split: no comment while a child create is pending; then one naming both, and the label swap', async () => {
    const req = await split179();
    // Nothing filed yet: no child number is known.
    expect(await trail()).toBe(0);
    expect(commentOps()).toEqual([]);

    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, MIN));
    const children = listCrewIssues(w.db, 'main');
    const [a, b] = children.map((c) => c.number ?? -1).sort((x, y) => x - y);
    const second = children[1];
    if (!second) throw new Error('two children expected');
    const secondKey = opKeys.issue('main', second.objective, second.key);
    updateOutbox(w.db, secondKey, { state: 'pending' }, plus(t0, MIN));
    await trail();
    expect(commentOps()).toEqual([]);
    expect(labelOps()).toEqual([]);

    updateOutbox(w.db, secondKey, { state: 'done' }, plus(t0, 2 * MIN));
    expect(await trail()).toBeGreaterThan(0);
    const marker = commentMarker('main', `triage:179:${req}`);
    expect(commentOps()).toHaveLength(1);
    expect(commentsOn(179)).toHaveLength(1);
    expect(commentsOn(179)[0]?.body).toBe(
      `Jumpmaster split this into #${a}, #${b}. They start once they are reviewed and promoted.\n\n${marker}`,
    );
    expect(labelsOf(179)).toContain('jm-triaged');
    expect(labelsOf(179)).not.toContain('jm-triage');
  });

  test('questions: one comment naming the briefing subject; the triage label stays', async () => {
    const req = request179();
    await triaged({ summary: 's', outcome: 'questions', briefing });
    await trail();
    const marker = commentMarker('main', `triage:179:${req}:questions`);
    expect(commentsOn(179).map((c) => c.body)).toEqual([
      `Jumpmaster needs a decision before this can be worked: fable usage. It continues once that is answered.\n\n${marker}`,
    ]);
    expect(labelOps()).toEqual([]);
    expect(labelsOf(179)).toEqual(['jm-triage']);
  });

  test('not-agent-work: one comment with the reason, and the label swap', async () => {
    const req = request179();
    await triaged({
      summary: 's',
      outcome: 'not-agent-work',
      reason: 'a question; answered in docs/runbooks/install.md',
    });
    await trail();
    const marker = commentMarker('main', `triage:179:${req}`);
    expect(commentsOn(179).map((c) => c.body)).toEqual([
      `Jumpmaster won't work this as an agent task: a question; answered in docs/runbooks/install.md\n\n${marker}`,
    ]);
    expect(labelsOf(179)).toEqual(['jm-triaged']);
  });

  test('a failed request and a superseded request get no comment and no label change', async () => {
    const req = request179();
    // Two attempts that came to nothing: maxTriage is 2, so the request fails.
    await triaged({ outcome: 'bogus' });
    await triaged({ outcome: 'bogus' }, plus(t0, MIN));
    expect(getTriageRequest(w.db, req)?.state).toBe('failed');

    w.f.state.addIssue({ number: 180, ...TEXT_179, author: 'human', labels: ['jm-triage'] });
    const first = recordTriageRequest(
      w.db,
      'main',
      { number: 180, ...TEXT_179, author: 'human' },
      t0,
    );
    // A request waiting on Command is superseded by an edited body before the trail runs.
    await triaged({ summary: 's', outcome: 'questions', briefing }, plus(t0, 2 * MIN));
    expect(getTriageRequest(w.db, first ?? -1)?.state).toBe('waiting');
    recordTriageRequest(
      w.db,
      'main',
      { number: 180, title: TEXT_179.title, body: 'edited', author: 'human' },
      plus(t0, 3 * MIN),
    );
    expect(getTriageRequest(w.db, first ?? -1)).toMatchObject({ reason: 'superseded' });

    expect(await trail()).toBe(0);
    expect(commentOps()).toEqual([]);
    expect(labelOps()).toEqual([]);
    expect(w.f.state.comments).toEqual([]);
  });

  test('D3: the trail run three times leaves one comment op and one comment per request', async () => {
    await split179();
    w.f.state.addIssue({ number: 180, ...TEXT_179, author: 'human', labels: ['jm-triage'] });
    recordTriageRequest(w.db, 'main', { number: 180, ...TEXT_179, author: 'human' }, t0);
    await triaged(
      { summary: 's', outcome: 'not-agent-work', reason: 'a duplicate' },
      plus(t0, MIN),
    );
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, 2 * MIN));
    for (const n of [1, 2, 3]) await trail(plus(t0, (5 + n) * MIN));
    expect(commentOps()).toHaveLength(2);
    expect(labelOps()).toHaveLength(2);
    expect(commentsOn(179)).toHaveLength(1);
    expect(commentsOn(180)).toHaveLength(1);
    expect(w.f.author.calls.filter((c) => c.method === 'createIssueComment')).toHaveLength(2);
  });

  test('questions answered, then split: one comment per outcome, each once', async () => {
    const req = request179();
    await triaged({ summary: 's', outcome: 'questions', briefing });
    await trail(plus(t0, MIN));
    const b = getTriageRequest(w.db, req)?.briefingId ?? -1;
    ruleBriefing(w.db, b, 'o1', 'drop the gauge', plus(t0, 2 * MIN));
    await triaged(
      { summary: 's', outcome: 'split', children: [child('hide-overage-gauge')] },
      plus(t0, 3 * MIN),
    );
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, 4 * MIN));
    await trail();
    await trail(plus(t0, 6 * MIN));
    const bodies = commentsOn(179).map((c) => c.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatch(/^Jumpmaster needs a decision/);
    expect(bodies[1]).toMatch(/^Jumpmaster split this into #\d+\. /);
  });

  test('CLAIM = PROOF: no comment contains text from the issue body', async () => {
    await split179();
    w.f.state.addIssue({ number: 180, ...TEXT_179, author: 'human', labels: ['jm-triage'] });
    recordTriageRequest(w.db, 'main', { number: 180, ...TEXT_179, author: 'human' }, t0);
    await triaged({ summary: 's', outcome: 'questions', briefing }, plus(t0, MIN));
    w.f.state.addIssue({ number: 181, ...TEXT_179, author: 'human', labels: ['jm-triage'] });
    recordTriageRequest(w.db, 'main', { number: 181, ...TEXT_179, author: 'human' }, t0);
    await triaged(
      { summary: 's', outcome: 'not-agent-work', reason: 'a duplicate' },
      plus(t0, 2 * MIN),
    );
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, 3 * MIN));
    await trail();
    expect(w.f.state.comments).toHaveLength(3);
    for (const c of w.f.state.comments) {
      expect(c.body).not.toContain(BODY_PHRASE);
      expect(c.body).not.toContain(TEXT_179.title);
      expect(c.body).not.toContain('overage gauge');
    }
  });

  test('an observe zone enqueues no trail op', async () => {
    request179();
    await triaged({ summary: 's', outcome: 'not-agent-work', reason: 'a duplicate' });
    setZoneMode(w.db, 'main', 'observe', plus(t0, MIN));
    expect(await trail()).toBe(0);
    expect(listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main')).toEqual([]);
    expect(w.f.author.calls.filter((c) => c.method === 'createIssueComment')).toEqual([]);
  });
});

describe('a split parent closes once all its parts are closed (#297)', () => {
  /** P = #179 split into two children, filed; X = #1 (agent-ready) blocked by P. */
  async function splitWithChildren(): Promise<{ req: number; c1: number; c2: number }> {
    const req = await split179();
    w.f.state.blockedByLinks.push({ issue: 1, blocker: 179 });
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, MIN));
    const [c1, c2] = listCrewIssues(w.db, 'main')
      .map((c) => c.number ?? -1)
      .sort((a, b) => a - b);
    if (c1 === undefined || c2 === undefined) throw new Error('two children expected');
    return { req, c1, c2 };
  }
  const closeOps = () =>
    listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main').filter(
      (o) => o.kind === 'update_issue',
    );
  const closedMarker = (req: number) => commentMarker('main', `triage:179:${req}:closed`);
  const issueState = (n: number) => w.f.state.issues.get(n)?.state;
  const forgeWrites = () =>
    [...w.f.author.calls, ...w.f.reviewer.calls].filter((c) =>
      (FORGE_WRITES as string[]).includes(c.method),
    );

  test('both children open: P stays open', async () => {
    await splitWithChildren();
    await trail();
    await trail(plus(t0, 6 * MIN));
    expect(issueState(179)).toBe('open');
    expect(closeOps()).toEqual([]);
    expect(commentsOn(179)).toHaveLength(1);
  });

  test('CLAIM = PROOF: C1 closed and C2 open: P stays open', async () => {
    const { c1 } = await splitWithChildren();
    await trail();
    w.f.state.closeIssue(c1);
    await trail(plus(t0, 6 * MIN));
    expect(issueState(179)).toBe('open');
    expect(closeOps()).toEqual([]);
    expect(commentsOn(179)).toHaveLength(1);
  });

  test('both children closed: one comment listing the parts, then P closed as completed', async () => {
    const { req, c1, c2 } = await splitWithChildren();
    await trail();
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    await trail(plus(t0, 6 * MIN));
    expect(issueState(179)).toBe('closed');
    expect(w.f.state.issues.get(179)?.stateReason).toBe('completed');
    expect(commentsOn(179).map((c) => c.body)).toEqual([
      expect.stringMatching(/^Jumpmaster split this into/),
      `All parts of this split are closed (#${c1}, #${c2}). Closing.\n\n${closedMarker(req)}`,
    ]);
    // The comment goes first, then the close, both as the author identity.
    const writes = w.f.author.calls
      .filter((c) => c.method === 'createIssueComment' || c.method === 'updateIssue')
      .filter((c) => c.args[0] === 179)
      .map((c) => c.method);
    expect(writes).toEqual(['createIssueComment', 'createIssueComment', 'updateIssue']);
    expect(w.f.reviewer.calls.filter((c) => c.method === 'updateIssue')).toEqual([]);
  });

  test('the close waits for the trail comment and label swap of the split', async () => {
    const { c1, c2 } = await splitWithChildren();
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    // The label swap's answer is lost: it stays unknown until read back next pass.
    w.f.author.failNext('setLabels', '5xx-after-success');
    await trail();
    expect(issueState(179)).toBe('open');
    expect(w.f.author.calls.filter((c) => c.method === 'getIssueState')).toEqual([]);
    await trail(plus(t0, 6 * MIN));
    expect(issueState(179)).toBe('closed');
  });

  test('through sync and the scheduler: X starts once P closes', async () => {
    const { c1, c2 } = await splitWithChildren();
    // X: a drop-ready issue blocked by P, and the only ready one.
    for (const n of [1, 2, 3, 4, 5]) w.f.state.closeIssue(n);
    w.f.state.addIssue({ number: 50, body: ISSUE_BODY, labels: ['agent-ready'] });
    w.f.state.blockedByLinks.push({ issue: 50, blocker: 179 });
    await trail();
    await syncDropZone(w.db, w.forges, w.zone, plus(t0, 6 * MIN));
    const x = () => listWorkItems(w.db, 'main').find((i) => i.issueNumber === 50);
    expect(x()?.blockedBy).toEqual(['#179']);
    expect(enqueueNext(w.db, w.zone, 'v1', usageCfg, plus(t0, 6 * MIN))).toBeNull();

    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    await trail(plus(t0, 7 * MIN));
    expect(issueState(179)).toBe('closed');
    await syncDropZone(w.db, w.forges, w.zone, plus(t0, 8 * MIN));
    expect(x()?.blockedBy).toEqual([]);
    const id = enqueueNext(w.db, w.zone, 'v1', usageCfg, plus(t0, 8 * MIN));
    expect(id).not.toBeNull();
    expect(getDrop(w.db, id ?? '')?.workItemId).toBe(x()?.id);
  });

  test('D2: a failed child read closes nothing; the next pass closes P', async () => {
    const { c1, c2 } = await splitWithChildren();
    await trail();
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    const reads = () => w.f.author.calls.filter((c) => c.method === 'getIssueState');
    const before = reads().length;
    w.f.author.failNext('getIssueState', 'throw');
    await trail(plus(t0, 6 * MIN));
    expect(reads().length).toBeGreaterThan(before);
    expect(issueState(179)).toBe('open');
    expect(closeOps()).toEqual([]);
    expect(commentsOn(179)).toHaveLength(1);

    await trail(plus(t0, 7 * MIN));
    expect(issueState(179)).toBe('closed');
    expect(commentsOn(179)).toHaveLength(2);
  });

  test('D2: the read of only the second child fails: nothing is closed', async () => {
    const { c1, c2 } = await splitWithChildren();
    await trail();
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    // Fail the read of C2 only: C1's read answers first.
    const real = w.f.author.getIssueState;
    w.f.author.getIssueState = async (n) => {
      if (n === c2) throw new Error('fake read failure');
      return real(n);
    };
    await trail(plus(t0, 6 * MIN));
    expect(issueState(179)).toBe('open');
    expect(commentsOn(179)).toHaveLength(1);
    w.f.author.getIssueState = real;
    await trail(plus(t0, 7 * MIN));
    expect(issueState(179)).toBe('closed');
  });

  test('D3: two passes, the close recorded done after the first: one comment and one close', async () => {
    const { c1, c2 } = await splitWithChildren();
    await trail();
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    await trail(plus(t0, 6 * MIN));
    expect(closeOps().map((o) => o.state)).toEqual(['done']);
    await trail(plus(t0, 7 * MIN));
    await trail(plus(t0, 8 * MIN));
    expect(commentsOn(179)).toHaveLength(2);
    expect(closeOps()).toHaveLength(1);
    expect(
      w.f.author.calls.filter((c) => c.method === 'updateIssue' && c.args[0] === 179),
    ).toHaveLength(1);
  });

  test('D3: a close write whose answer is lost is read back, not sent again', async () => {
    const { c1, c2 } = await splitWithChildren();
    await trail();
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    w.f.author.failNext('updateIssue', '5xx-after-success');
    await trail(plus(t0, 6 * MIN));
    expect(closeOps().map((o) => o.state)).toEqual(['unknown']);
    await trail(plus(t0, 7 * MIN));
    expect(closeOps().map((o) => o.state)).toEqual(['done']);
    expect(commentsOn(179)).toHaveLength(2);
    expect(
      w.f.author.calls.filter((c) => c.method === 'updateIssue' && c.args[0] === 179),
    ).toHaveLength(1);
  });

  test('a split whose trail already ran: its parent closes, and no blocker is copied later', async () => {
    const { c1, c2 } = await splitWithChildren();
    // The trail comment is recorded while the parent has no blocker (as a pre-#297 trail was).
    await trail();
    expect(commentsOn(179)).toHaveLength(1);
    w.f.state.addIssue({ number: 200 });
    w.f.state.blockedByLinks.push({ issue: 179, blocker: 200 });
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    await trail(plus(t0, 6 * MIN));
    expect(issueState(179)).toBe('closed');
    expect(w.f.state.blockedByLinks.filter((l) => l.issue === c1 || l.issue === c2)).toEqual([]);
    expect(w.f.author.calls.filter((c) => c.method === 'listBlockedBy')).toHaveLength(1);
  });

  describe("each part inherits the parent's open blockers", () => {
    const linkOps = () =>
      listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main').filter(
        (o) => o.kind === 'add_blocked_by',
      );
    const blockersOfChild = (n: number) =>
      w.f.state.blockedByLinks.filter((l) => l.issue === n).map((l) => l.blocker);

    test('P blocked by B (open) and B2 (closed): each child gets B only', async () => {
      w.f.state.addIssue({ number: 200 });
      w.f.state.addIssue({ number: 201 });
      w.f.state.closeIssue(201);
      w.f.state.blockedByLinks.push({ issue: 179, blocker: 200 }, { issue: 179, blocker: 201 });
      const { c1, c2 } = await splitWithChildren();
      await trail();
      expect(blockersOfChild(c1)).toEqual([200]);
      expect(blockersOfChild(c2)).toEqual([200]);
      expect(linkOps().map((o) => o.state)).toEqual(['done', 'done']);
    });

    test('the blocker ops run twice: one link each', async () => {
      w.f.state.addIssue({ number: 200 });
      w.f.state.blockedByLinks.push({ issue: 179, blocker: 200 });
      const { c1, c2 } = await splitWithChildren();
      w.f.author.failNext('addBlockedBy', '5xx-after-success');
      await trail();
      await trail(plus(t0, 6 * MIN));
      await trail(plus(t0, 7 * MIN));
      expect(blockersOfChild(c1)).toEqual([200]);
      expect(blockersOfChild(c2)).toEqual([200]);
      expect(linkOps()).toHaveLength(2);
      expect(linkOps().map((o) => o.state)).toEqual(['done', 'done']);
      expect(w.f.author.calls.filter((c) => c.method === 'addBlockedBy')).toHaveLength(2);
    });

    test('a link that already exists counts as success', async () => {
      w.f.state.addIssue({ number: 200 });
      w.f.state.blockedByLinks.push({ issue: 179, blocker: 200 });
      const { c1 } = await splitWithChildren();
      // Linked by hand already, and the read before the write misses it: the write answers
      // that the link exists, which is success.
      w.f.state.blockedByLinks.push({ issue: c1, blocker: 200 });
      const real = w.f.author.listBlockedBy;
      w.f.author.listBlockedBy = async (n) =>
        n === c1 ? { blockers: [], unreadable: 0 } : real(n);
      await trail();
      expect(blockersOfChild(c1)).toEqual([200]);
      expect(linkOps().map((o) => o.state)).toEqual(['done', 'done']);
    });

    test('a blocker in another repository is skipped and named in the comment', async () => {
      w.f.state.addIssue({ number: 200 });
      w.f.state.blockedByLinks.push(
        { issue: 179, blocker: 200 },
        { issue: 179, blocker: 7, repo: 'other/repo' },
      );
      const { req, c1, c2 } = await splitWithChildren();
      await trail();
      expect(blockersOfChild(c1)).toEqual([200]);
      expect(blockersOfChild(c2)).toEqual([200]);
      const marker = commentMarker('main', `triage:179:${req}`);
      expect(commentsOn(179).map((c) => c.body)).toEqual([
        `Jumpmaster split this into #${c1}, #${c2}. They start once they are reviewed and promoted. Blockers in another repository were not copied to them: other/repo#7.\n\n${marker}`,
      ]);
    });

    test('an unreadable blocker list leaves no comment and no link until it reads', async () => {
      w.f.state.addIssue({ number: 200 });
      w.f.state.blockedByLinks.push({ issue: 179, blocker: 200 });
      const { c1 } = await splitWithChildren();
      w.f.author.failNext('listBlockedBy', 'throw');
      await trail();
      expect(commentOps()).toEqual([]);
      expect(linkOps()).toEqual([]);
      await trail(plus(t0, 6 * MIN));
      expect(blockersOfChild(c1)).toEqual([200]);
      expect(commentsOn(179)).toHaveLength(1);
    });
  });

  test('a paused zone and the kill switch: no forge writes', async () => {
    w.f.state.addIssue({ number: 200 });
    w.f.state.blockedByLinks.push({ issue: 179, blocker: 200 });
    const { c1, c2 } = await splitWithChildren();
    w.f.state.closeIssue(c1);
    w.f.state.closeIssue(c2);
    const writesBefore = forgeWrites().length;

    setZoneMode(w.db, 'main', 'paused', plus(t0, 2 * MIN));
    expect(await trail()).toBe(0);
    setZoneMode(w.db, 'main', 'active', plus(t0, 3 * MIN));
    setKilled(w.db, true, plus(t0, 4 * MIN));
    expect(await trail()).toBe(0);
    expect(forgeWrites()).toHaveLength(writesBefore);
    expect(issueState(179)).toBe('open');
    expect(w.f.state.blockedByLinks.filter((l) => l.issue === c1 || l.issue === c2)).toEqual([]);

    setKilled(w.db, false, plus(t0, 5 * MIN));
    await trail(plus(t0, 6 * MIN));
    expect(issueState(179)).toBe('closed');
  });
});

describe('already-done: the server verifies the evidence, then the trail comments and closes (#466)', () => {
  /** #120 a pull merged to main, #119 an issue closed as completed: the work #179 asks for. */
  function shipped(): void {
    w.f.state.addPull({
      number: 120,
      headRef: 'feature',
      headSha: 'a'.repeat(40),
      author: 'human',
      state: 'closed',
      merged: true,
    });
    w.f.state.addIssue({ number: 119, title: 'Shipped', body: 'b', author: 'human', labels: [] });
    w.f.state.closeIssue(119, 'completed');
  }

  const done = (evidence: { pulls?: number[]; issues?: number[] }, reason = 'it shipped') => ({
    summary: 's',
    outcome: 'already-done',
    reason,
    evidence,
  });

  const allOps = () => listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main');
  const closeOps = () => allOps().filter((o) => o.kind === 'update_issue');
  const issue179 = () => w.f.state.issues.get(179);
  const closing = (req: number, reason = 'it shipped', done = '#120, #119') =>
    `The crew found this already done: ${reason}. Done in: ${done}. Closing it. Reopen the issue if something is missing.\n\n${commentMarker('main', `triage:179:${req}`)}`;

  test('a merged pull to the default branch and an issue closed as completed: one comment, then one close as completed', async () => {
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120], issues: [119] }));
    // Recorded only: verifying, nothing written to the forge.
    expect(getTriageRequest(w.db, req)).toMatchObject({
      state: 'verifying',
      outcome: 'already-done',
      reason: 'it shipped',
      evidence: { pulls: [120], issues: [119] },
    });
    expect(allOps()).toEqual([]);

    await trail();
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'done', outcome: 'already-done' });
    expect(commentOps()).toHaveLength(1);
    expect(closeOps()).toHaveLength(1);
    expect(JSON.parse(closeOps()[0]?.payloadJson ?? '{}')).toEqual({
      number: 179,
      state: 'closed',
      stateReason: 'completed',
    });
    expect(commentsOn(179).map((c) => c.body)).toEqual([closing(req)]);
    expect(issue179()).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(labelsOf(179)).toEqual(['jm-triaged']);
    // The comment is written before the close.
    const writes = w.f.author.calls
      .map((c) => c.method)
      .filter((m) => m === 'createIssueComment' || m === 'updateIssue');
    expect(writes).toEqual(['createIssueComment', 'updateIssue']);
  });

  test('D3: two trail passes write one comment op and one close op', async () => {
    shipped();
    request179();
    await triaged(done({ issues: [119] }));
    await trail();
    await trail(plus(t0, 6 * MIN));
    expect(commentOps()).toHaveLength(1);
    expect(closeOps()).toHaveLength(1);
    expect(commentsOn(179)).toHaveLength(1);
    expect(w.f.author.calls.filter((c) => c.method === 'updateIssue')).toHaveLength(1);
    // Its keys are not a split parent's.
    expect(closeOps()[0]?.opKey).not.toMatch(/^close:main:triage:\d+$/);
    expect(commentOps()[0]?.opKey).not.toMatch(/:closed$/);
  });

  const refusals: [string, () => void, { pulls?: number[]; issues?: number[] }, string][] = [
    [
      'an unmerged pull',
      () =>
        w.f.state.addPull({
          number: 121,
          headRef: 'x',
          headSha: 'b'.repeat(40),
          author: 'human',
          state: 'closed',
        }),
      { pulls: [121], issues: [119] },
      'evidence refused: #121 is not merged',
    ],
    [
      'a pull merged to another branch',
      () =>
        w.f.state.addPull({
          number: 121,
          headRef: 'x',
          headSha: 'b'.repeat(40),
          author: 'human',
          state: 'closed',
          merged: true,
          baseRef: 'release',
        }),
      { pulls: [120, 121] },
      'evidence refused: #121 was not merged to the default branch',
    ],
    [
      'a missing pull',
      () => {},
      { pulls: [999], issues: [119] },
      'evidence refused: #999 not found',
    ],
    [
      'a closed pull request cited under issues',
      () => {
        w.f.state.addPull({
          number: 121,
          headRef: 'x',
          headSha: 'b'.repeat(40),
          author: 'human',
          state: 'closed',
        });
        // Even were GitHub to name it closed as completed, a pull request is not an issue.
        const read = w.f.author.getIssue.bind(w.f.author);
        w.f.author.getIssue = async (n) => {
          const r = await read(n);
          return n === 121 && r ? { ...r, stateReason: 'completed' } : r;
        };
      },
      { pulls: [120], issues: [121] },
      'evidence refused: #121 is a pull request, not an issue',
    ],
    [
      'an issue closed as not planned',
      () => {
        w.f.state.addIssue({ number: 122, title: 'No', body: 'b', author: 'human', labels: [] });
        w.f.state.closeIssue(122, 'not_planned');
      },
      { issues: [119, 122] },
      'evidence refused: #122 was not closed as completed',
    ],
    [
      'an issue still open',
      () =>
        w.f.state.addIssue({ number: 122, title: 'No', body: 'b', author: 'human', labels: [] }),
      { issues: [122] },
      'evidence refused: #122 is not closed',
    ],
    [
      'the issue citing itself',
      () => {},
      { pulls: [120], issues: [179] },
      'evidence refused: #179 is this issue',
    ],
    [
      'getPull throwing',
      () => w.f.author.failNext('getPull', 'throw'),
      { pulls: [120], issues: [119] },
      'evidence refused: a cited item could not be read',
    ],
  ];

  test.each(refusals)(
    'refused: %s fails the attempt, enqueues no op and the retry sees why',
    async (_name, arrange, evidence, why) => {
      shipped();
      const req = request179();
      await triaged(done(evidence));
      arrange();
      await trail();
      expect(getTriageRequest(w.db, req)).toMatchObject({
        state: 'open',
        attempts: 1,
        lastError: why,
        outcome: null,
        evidence: null,
      });
      expect(allOps()).toEqual([]);
      expect(w.f.state.comments).toEqual([]);
      expect(issue179()).toMatchObject({ state: 'open', labels: ['jm-triage'] });
      expect(triageInput(w.db, w.zone, req, 'd-next')).toContain(why);
      // A second pass writes nothing either.
      await trail(plus(t0, 6 * MIN));
      expect(allOps()).toEqual([]);
    },
  );

  test('refused maxTriage times: failed and put to Command; the issue is untouched', async () => {
    request179();
    await triaged(done({ pulls: [999] }));
    await trail();
    await triaged(done({ pulls: [998] }), plus(t0, 10 * MIN));
    await trail(plus(t0, 15 * MIN));
    const req = listTriageRequests(w.db, 'main')[0];
    expect(req).toMatchObject({
      state: 'failed',
      attempts: 2,
      lastError: 'evidence refused: #998 not found',
    });
    const b = w.db.prepare('SELECT why FROM briefings WHERE id = ?').get(req?.briefingId) as {
      why: string;
    };
    expect(b.why).toContain('evidence refused: #998 not found');
    expect(allOps()).toEqual([]);
    expect(issue179()?.state).toBe('open');
  });

  test('superseded: the body edited while verifying is done with no op; the new text is triaged afresh', async () => {
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120] }));
    const entry = issue179();
    if (!entry?.issue) throw new Error('#179 expected');
    entry.issue.body = 'edited';
    await trail();
    expect(getTriageRequest(w.db, req)).toMatchObject({
      state: 'done',
      reason: 'superseded',
      outcome: null,
      attempts: 0,
    });
    expect(allOps()).toEqual([]);
    expect(issue179()?.state).toBe('open');
    // Sync records the new text as a fresh request.
    const fresh = recordTriageRequest(
      w.db,
      'main',
      { number: 179, title: TEXT_179.title, body: 'edited', author: 'human' },
      plus(t0, 6 * MIN),
    );
    expect(getTriageRequest(w.db, fresh ?? -1)?.state).toBe('open');
  });

  test('superseded: the issue closed while verifying is done with no op', async () => {
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120] }));
    w.f.state.closeIssue(179);
    await trail();
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'done', reason: 'superseded' });
    expect(allOps()).toEqual([]);
  });

  test('superseded: a body recorded before verification supersedes it through recordTriageRequest', async () => {
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120] }));
    recordTriageRequest(
      w.db,
      'main',
      { number: 179, title: TEXT_179.title, body: 'edited', author: 'human' },
      plus(t0, MIN),
    );
    expect(getTriageRequest(w.db, req)).toMatchObject({
      state: 'done',
      reason: 'superseded',
      outcome: null,
    });
    await trail();
    expect(allOps()).toEqual([]);
    expect(w.f.author.calls.filter((c) => c.method === 'getPull')).toEqual([]);
  });

  test('observe: verified and done, and the comment and close are written once the zone is active', async () => {
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120], issues: [119] }));
    setZoneMode(w.db, 'main', 'observe', plus(t0, MIN));
    expect(await trail()).toBe(0);
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'done', outcome: 'already-done' });
    expect(allOps()).toEqual([]);
    setZoneMode(w.db, 'main', 'active', plus(t0, 6 * MIN));
    await trail(plus(t0, 7 * MIN));
    expect(allOps().map((o) => [o.kind, o.state])).toEqual([
      ['comment_issue', 'done'],
      ['set_labels', 'done'],
      ['update_issue', 'done'],
    ]);
    expect(commentsOn(179).map((c) => c.body)).toEqual([closing(req)]);
    expect(issue179()?.state).toBe('closed');
  });

  test('crew.closeDone false: a comment, never a close', async () => {
    w = await crewWorld({ crew: { ...crewOn, closeDone: false } });
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120] }));
    await trail();
    await trail(plus(t0, 6 * MIN));
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'done', outcome: 'already-done' });
    expect(closeOps()).toEqual([]);
    expect(w.f.author.calls.filter((c) => c.method === 'updateIssue')).toEqual([]);
    expect(issue179()?.state).toBe('open');
    expect(commentsOn(179).map((c) => c.body)).toEqual([
      `The crew found this already done: it shipped. Done in: #120. Close the issue if nothing is missing.\n\n${commentMarker('main', `triage:179:${req}`)}`,
    ]);
  });

  const updateCalls = () => w.f.author.calls.filter((c) => c.method === 'updateIssue');

  test('a close whose write failed is sent again on the next pass', async () => {
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120], issues: [119] }));
    w.f.author.failNext('updateIssue', '5xx');
    await trail();
    // The comment and label swap are done; the close failed.
    expect(commentsOn(179)).toHaveLength(1);
    expect(issue179()).toMatchObject({ state: 'open', labels: ['jm-triaged'] });

    await trail(plus(t0, 6 * MIN));
    expect(issue179()).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(commentsOn(179)).toHaveLength(1);
    expect(commentOps()).toHaveLength(1);
    expect(closeOps().map((o) => o.state)).toEqual(['done']);
    expect(updateCalls()).toHaveLength(2);
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'done', outcome: 'already-done' });
  });

  test('a close refused with a 4xx is sent again on the next pass', async () => {
    shipped();
    const req = request179();
    await triaged(done({ pulls: [120], issues: [119] }));
    w.f.author.failNext('updateIssue', { status: 422 });
    await trail();
    expect(issue179()?.state).toBe('open');
    expect(closeOps().map((o) => o.state)).toEqual(['failed']);

    await trail(plus(t0, 6 * MIN));
    expect(issue179()).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(commentsOn(179)).toHaveLength(1);
    expect(closeOps().map((o) => o.state)).toEqual(['done']);
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'done', outcome: 'already-done' });
  });

  test('a close that landed but whose answer was lost settles done with no further write', async () => {
    shipped();
    request179();
    await triaged(done({ pulls: [120], issues: [119] }));
    w.f.author.failNext('updateIssue', '5xx-after-success');
    await trail();
    expect(issue179()?.state).toBe('closed');
    expect(closeOps().map((o) => o.state)).toEqual(['unknown']);
    expect(updateCalls()).toHaveLength(1);

    await trail(plus(t0, 6 * MIN));
    expect(closeOps().map((o) => o.state)).toEqual(['done']);
    expect(updateCalls()).toHaveLength(1);
    expect(commentsOn(179)).toHaveLength(1);
  });

  test('an issue closed by a person after a failed close settles done with no further write', async () => {
    shipped();
    request179();
    await triaged(done({ pulls: [120], issues: [119] }));
    w.f.author.failNext('updateIssue', '5xx');
    await trail();
    w.f.state.closeIssue(179, 'completed');

    await trail(plus(t0, 6 * MIN));
    expect(closeOps().map((o) => o.state)).toEqual(['done']);
    expect(updateCalls()).toHaveLength(1);
  });

  test('a failed close is not sent while the zone is paused or the kill switch is on, then is sent once active', async () => {
    shipped();
    request179();
    await triaged(done({ pulls: [120], issues: [119] }));
    w.f.author.failNext('updateIssue', '5xx');
    await trail();
    expect(updateCalls()).toHaveLength(1);

    setZoneMode(w.db, 'main', 'paused', plus(t0, 6 * MIN));
    expect(await trail(plus(t0, 7 * MIN))).toBe(0);
    setZoneMode(w.db, 'main', 'active', plus(t0, 8 * MIN));
    setKilled(w.db, true, plus(t0, 9 * MIN));
    expect(await trail(plus(t0, 10 * MIN))).toBe(0);
    expect(updateCalls()).toHaveLength(1);
    expect(issue179()?.state).toBe('open');

    setKilled(w.db, false, plus(t0, 11 * MIN));
    await trail(plus(t0, 12 * MIN));
    expect(updateCalls()).toHaveLength(2);
    expect(issue179()).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(commentsOn(179)).toHaveLength(1);
  });

  test('the reason is posted sanitized as sanitizeCrewText does, and cut to 500 characters', async () => {
    shipped();
    const reason = '@someone shipped it, see https://evil.example/x <!-- hidden --> and #12';
    const req = request179();
    await triaged(done({ pulls: [120] }, reason));
    await trail();
    const body = commentsOn(179)[0]?.body ?? '';
    expect(body).toBe(closing(req, sanitizeCrewText(reason, []), '#120'));
    expect(body).not.toContain('@someone');
    expect(body).not.toContain('https://');
    expect(body.split('<!--')).toHaveLength(2); // the marker's only

    w.f.state.addIssue({ number: 180, ...TEXT_179, author: 'human', labels: ['jm-triage'] });
    const long =
      recordTriageRequest(w.db, 'main', { number: 180, ...TEXT_179, author: 'human' }, t0) ?? -1;
    await triaged(done({ pulls: [120] }), plus(t0, 10 * MIN));
    setTriageRequest(w.db, long, { reason: 'y'.repeat(3000) }, plus(t0, 10 * MIN));
    await trail(plus(t0, 11 * MIN));
    const longBody = commentsOn(180)[0]?.body ?? '';
    expect(longBody).toContain(`done: ${'y'.repeat(500)}. Done in: #120.`);
    expect(longBody).not.toContain('y'.repeat(501));
  });
});
