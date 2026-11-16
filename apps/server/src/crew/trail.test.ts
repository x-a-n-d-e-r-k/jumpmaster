import type { DropResult } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { ruleBriefing } from '../briefings.js';
import { getDrop, listOutbox, setZoneMode, updateDrop, updateOutbox } from '../db/repo.js';
import { zonePass } from '../flow/snapshot.js';
import { commentMarker, opKeys } from '../outbox.js';
import { promptVersions } from '../payloads.js';
import { applyResult, type ResultDeps } from '../results.js';
import { crewWorld, ISSUE_BODY } from '../test/crew.js';
import { usageCfg, type ZoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { flushCrewOps } from './flush.js';
import { enqueueCrew } from './schedule.js';
import { getTriageRequest, listCrewIssues, recordTriageRequest } from './store.js';
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
