import type { DropResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { listBriefings, ruleBriefing, syncParkBriefings } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import { listOutbox, listWorkItems, setKilled, setZoneMode } from '../db/repo.js';
import { commentMarker } from '../outbox.js';
import { crewOn } from '../test/crew.js';
import { type Harness, harness } from '../test/flowHarness.js';
import { nextDiagnose } from './schedule.js';
import {
  getTriageRequest,
  insertDoneClaim,
  listItemDoneClaims,
  recordTriageRequest,
  setTriageRequest,
} from './store.js';
import {
  CLAIM_DONE_REASON,
  CLAIM_REFUSED,
  claimKeys,
  flushDoneClaims,
  flushTriageTrail,
  verifyCited,
} from './trail.js';

const completed = (crew: unknown): DropResult => ({ status: 'completed', crew, gates: [] });
const implementFailed: DropResult = { status: 'failed', reason: 'gate test failed', gates: [] };
const DIAGNOSIS = 'Issue #1 shipped whole with its parent in #502.';

type Evidence = { pulls?: number[]; issues?: number[] };
const claimOutput = (evidence: Evidence, diagnosis = DIAGNOSIS) => ({
  diagnosis,
  recommendation: 'already_done',
  detail: 'Close it.',
  evidence,
});

/** Issue 1 with the crew on: its implement fails, it parks and is briefed; its diagnose queued. */
async function parked(zone: Partial<DropZoneConfig> = {}): Promise<Harness> {
  const h = await harness({ zone: { crew: crewOn, triage: { gate: false }, ...zone } });
  await h.reconcile();
  expect(await h.finishDrop('implement', implementFailed)).toBe(204);
  await h.reconcile();
  return h;
}

/** #502 closed as completed, #503 closed as not planned, #600 merged to main, #700 to release. */
function forgeFacts(h: Harness): void {
  const s = h.forge.state;
  s.addIssue({ number: 502, title: 'Parent', body: 'b', author: 'human', labels: [] });
  s.closeIssue(502, 'completed');
  s.addIssue({ number: 503, title: 'Not planned', body: 'b', author: 'human', labels: [] });
  s.closeIssue(503, 'not_planned');
  const pull = { headSha: 'a'.repeat(40), author: 'human', state: 'closed' as const };
  s.addPull({ ...pull, number: 600, headRef: 'feat-a', merged: true });
  s.addPull({ ...pull, number: 601, headRef: 'feat-b' });
  s.addPull({ ...pull, number: 700, headRef: 'feat-c', merged: true, baseRef: 'release' });
}

async function diagnose(h: Harness, out: unknown): Promise<string> {
  const { dropId, epoch, payload } = await h.lease();
  expect(payload.role).toBe('diagnose');
  expect(await h.postResult(dropId, epoch, completed(out))).toBe(204);
  return dropId;
}

const item = (h: Harness) => listWorkItems(h.db, 'main').find((i) => i.id === 1);
const briefing = (h: Harness) =>
  listBriefings(h.db, { zoneId: 'main', kind: 'parked' }).find((b) => b.subject === 'item:1');
const claims = (h: Harness) => listItemDoneClaims(h.db, 1);
const ops = (h: Harness) => listOutbox(h.db, ['pending', 'unknown', 'done', 'failed'], 'main');
const claimOps = (h: Harness) => ops(h).filter((o) => o.opKey.includes(':crew-done:'));
const writes = (h: Harness) =>
  h.forge.author.calls
    .map((c) => c.method)
    .filter((m) => m === 'createIssueComment' || m === 'updateIssue');
const commentsOn1 = (h: Harness) => h.forge.state.comments.filter((c) => c.issue === 1);
const flush = (h: Harness, secrets: string[] = []) =>
  flushDoneClaims(h.db, h.forges, h.zone, secrets, h.at(1));

describe('a diagnosis that finds the parked item already done (#536)', () => {
  test('records a verifying claim and writes nothing to the forge', async () => {
    const h = await parked();
    forgeFacts(h);
    const raised = briefing(h);
    const dropId = await diagnose(h, claimOutput({ issues: [502] }));
    expect(claims(h)).toMatchObject([
      {
        state: 'verifying',
        dropId,
        briefingId: raised?.id,
        evidence: { issues: [502] },
        diagnosis: DIAGNOSIS,
      },
    ]);
    expect(claims(h)[0]?.basis).toBe(briefing(h)?.diagnosisBasis);
    expect(briefing(h)).toMatchObject({ state: 'open', recommendation: 'already_done: Close it.' });
    expect(claimOps(h)).toEqual([]);
    expect(writes(h)).toEqual([]);
  });

  test('verified: one comment, then the close as completed; the item done, the briefing withdrawn', async () => {
    const h = await parked();
    forgeFacts(h);
    await diagnose(h, claimOutput({ pulls: [600], issues: [502] }));
    await h.reconcile();
    expect(writes(h)).toEqual(['createIssueComment', 'updateIssue']);
    const close = claimOps(h).find((o) => o.kind === 'update_issue');
    expect(JSON.parse(close?.payloadJson ?? '{}')).toEqual({
      number: 1,
      state: 'closed',
      stateReason: 'completed',
    });
    const id = claims(h)[0]?.id ?? -1;
    expect(commentsOn1(h).map((c) => c.body)).toEqual([
      `The crew found this already done: Issue #‍1 shipped whole with its parent in #‍502. Done in: #600, #502. Closing it. Reopen the issue if something is missing.\n\n${commentMarker('main', `crew-done:${id}`)}`,
    ]);
    expect(h.forge.state.issues.get(1)).toMatchObject({
      state: 'closed',
      stateReason: 'completed',
    });
    expect(item(h)).toMatchObject({ state: 'done', reason: CLAIM_DONE_REASON });
    expect(briefing(h)?.state).toBe('withdrawn');
    expect(claims(h)).toMatchObject([{ state: 'done', reason: null }]);
    // Each once: more passes write nothing more.
    await h.reconcile();
    await flush(h);
    expect(writes(h)).toEqual(['createIssueComment', 'updateIssue']);
    expect(claimOps(h)).toHaveLength(2);
  });

  const refusals: [string, Evidence, string, (h: Harness) => void][] = [
    [
      'a pull merged to another branch',
      { pulls: [700] },
      '#700 was not merged to the default branch',
      () => {},
    ],
    ['an unmerged pull', { pulls: [601] }, '#601 is not merged', () => {}],
    [
      'an issue closed as not planned',
      { issues: [503] },
      '#503 was not closed as completed',
      () => {},
    ],
    [
      'a PR cited under issues',
      { issues: [600] },
      '#600 is a pull request, not an issue',
      (h) => {
        // Even were GitHub to name it closed as completed, a pull request is not an issue.
        const read = h.forge.author.getIssue.bind(h.forge.author);
        h.forge.author.getIssue = async (n) => {
          const r = await read(n);
          return n === 600 && r ? { ...r, state: 'closed', stateReason: 'completed' } : r;
        };
      },
    ],
    ['the item’s own issue', { issues: [502, 1] }, '#1 is this issue', () => {}],
    [
      'a lookup that throws',
      { pulls: [600] },
      'a cited item could not be read',
      (h) => h.forge.author.failNext('getPull', 'throw'),
    ],
  ];

  test.each(refusals)(
    'refused: %s → the claim refused, no op, the reason as needs_command',
    async (_name, evidence, why, arrange) => {
      const h = await parked();
      forgeFacts(h);
      await diagnose(h, claimOutput(evidence));
      arrange(h);
      await h.reconcile();
      expect(claims(h)).toMatchObject([{ state: 'refused', reason: why }]);
      expect(claimOps(h)).toEqual([]);
      expect(writes(h)).toEqual([]);
      expect(item(h)?.state).toBe('parked');
      expect(briefing(h)).toMatchObject({
        state: 'open',
        diagnosis: DIAGNOSIS,
        recommendation: `needs_command: ${CLAIM_REFUSED}${why}`,
      });
      // Not tried again.
      await h.reconcile();
      expect(claims(h)).toMatchObject([{ state: 'refused' }]);
      expect(writes(h)).toEqual([]);
    },
  );

  describe('superseded: nothing is written', () => {
    test('Command rules Retry first: the retry proceeds', async () => {
      const h = await parked();
      forgeFacts(h);
      await diagnose(h, claimOutput({ issues: [502] }));
      const b = briefing(h);
      expect(ruleBriefing(h.db, b?.id ?? -1, 'retry', '', h.now()).ok).toBe(true);
      await h.reconcile();
      expect(claims(h)).toMatchObject([{ state: 'superseded' }]);
      expect(claimOps(h)).toEqual([]);
      expect(writes(h)).toEqual([]);
      expect(item(h)?.state).not.toBe('parked');
      expect(item(h)?.state).not.toBe('done');
      expect(h.queuedRoles()).toContain('implement');
    });

    test("the briefing's basis changes", async () => {
      const h = await parked();
      forgeFacts(h);
      await diagnose(h, claimOutput({ issues: [502] }));
      h.db
        .prepare(`UPDATE briefings SET why = 'parked on something else' WHERE id = ?`)
        .run(briefing(h)?.id);
      await flush(h);
      expect(claims(h)).toMatchObject([{ state: 'superseded' }]);
      expect(claimOps(h)).toEqual([]);
      expect(writes(h)).toEqual([]);
    });

    test('the issue is closed meanwhile', async () => {
      const h = await parked();
      forgeFacts(h);
      await diagnose(h, claimOutput({ issues: [502] }));
      h.forge.state.closeIssue(1, 'completed');
      await flush(h);
      expect(claims(h)).toMatchObject([{ state: 'superseded', reason: '#1 is closed' }]);
      expect(claimOps(h)).toEqual([]);
      expect(writes(h)).toEqual([]);
    });
  });

  describe('D3: each write once', () => {
    test('the close fails on the first pass: the next makes one comment and one close in all', async () => {
      const h = await parked();
      forgeFacts(h);
      await diagnose(h, claimOutput({ issues: [502] }));
      h.forge.author.failNext('updateIssue', 'throw');
      await flush(h);
      expect(claims(h)).toMatchObject([{ state: 'verifying' }]);
      expect(item(h)?.state).toBe('parked');
      expect(briefing(h)?.state).toBe('open');
      expect(commentsOn1(h)).toHaveLength(1);
      await flush(h);
      expect(claims(h)).toMatchObject([{ state: 'done' }]);
      expect(commentsOn1(h)).toHaveLength(1);
      expect(writes(h).filter((m) => m === 'createIssueComment')).toHaveLength(1);
      // The first close threw before it was sent: one close reached the forge.
      expect(h.forge.state.issues.get(1)?.stateReason).toBe('completed');
      expect(h.forge.state.issues.get(1)?.state).toBe('closed');
      expect(claimOps(h)).toHaveLength(2);
      expect(item(h)?.state).toBe('done');
    });

    test('a second diagnosis while one claim is verifying records no second claim, and none is scheduled', async () => {
      const h = await parked();
      forgeFacts(h);
      await diagnose(h, claimOutput({ issues: [502] }));
      const b = briefing(h);
      // The briefing asks afresh (as a changed why would); no diagnosis is scheduled meanwhile.
      h.db.prepare('UPDATE briefings SET diagnose_attempts = 0 WHERE id = ?').run(b?.id);
      expect(nextDiagnose(h.db, h.zone, h.now())).toBeNull();
      // A second result (a drop that raced the first) is refused by the schema.
      const second = () =>
        insertDoneClaim(
          h.db,
          {
            zoneId: 'main',
            itemId: 1,
            briefingId: b?.id ?? -1,
            dropId: 'd2',
            basis: 'x',
            diagnosis: 'd',
            evidence: { issues: [502] },
          },
          h.now(),
        );
      expect(second).toThrow(/UNIQUE/);
      expect(claims(h)).toHaveLength(1);
    });
  });

  describe('mode', () => {
    test.each([
      ['observe mode', (h: Harness) => setZoneMode(h.db, 'main', 'observe', h.now())],
      ['the kill switch', (h: Harness) => setKilled(h.db, true, h.now())],
    ])(
      '%s: nothing is written and the claim stays verifying; active, it is applied',
      async (_n, hold) => {
        const h = await parked();
        forgeFacts(h);
        await diagnose(h, claimOutput({ issues: [502] }));
        hold(h);
        await flush(h);
        await flushTriageTrail(h.db, h.forges, h.zone, [], h.at(1));
        expect(claims(h)).toMatchObject([{ state: 'verifying' }]);
        expect(claimOps(h)).toEqual([]);
        expect(writes(h)).toEqual([]);
        expect(item(h)?.state).toBe('parked');
        setZoneMode(h.db, 'main', 'active', h.now());
        setKilled(h.db, false, h.now());
        await flush(h);
        expect(claims(h)).toMatchObject([{ state: 'done' }]);
        expect(writes(h)).toEqual(['createIssueComment', 'updateIssue']);
        expect(item(h)?.state).toBe('done');
      },
    );
  });

  test('closeDone off: no op; the claim done and the briefing names the verified numbers', async () => {
    const h = await parked({ crew: { ...crewOn, closeDone: false } });
    forgeFacts(h);
    await diagnose(h, claimOutput({ pulls: [600], issues: [502] }));
    await h.reconcile();
    expect(claims(h)).toMatchObject([{ state: 'done' }]);
    expect(claimOps(h)).toEqual([]);
    expect(writes(h)).toEqual([]);
    expect(item(h)?.state).toBe('parked');
    expect(briefing(h)).toMatchObject({
      state: 'open',
      recommendation: 'needs_command: verified already done in #600, #502',
    });
    expect(briefing(h)?.options.map((o) => o.effect)).toContain('close_item');
  });

  test('redaction: a secret in a 3,000-character diagnosis is redacted, then cut to 500', async () => {
    const h = await parked();
    forgeFacts(h);
    const secret = ['very', 'secret', 'value', '42'].join('-');
    const diagnosis = `Done. ${secret} ${'x'.repeat(3000)}`;
    await diagnose(h, claimOutput({ issues: [502] }, diagnosis));
    await flush(h, [secret]);
    const id = claims(h)[0]?.id ?? -1;
    const body = commentsOn1(h)[0]?.body ?? '';
    expect(body).not.toContain(secret);
    const quoted = `Done. [redacted] ${'x'.repeat(500 - 'Done. [redacted] '.length)}`;
    expect(body).toBe(
      `The crew found this already done: ${quoted}. Done in: #502. Closing it. Reopen the issue if something is missing.\n\n${commentMarker('main', `crew-done:${id}`)}`,
    );
    expect(claimKeys('main', id).comment).toBe(claimOps(h)[0]?.opKey);
  });

  test('D5: one evidence set through triage and diagnose gets the same verifyCited verdict and reason', async () => {
    const sets: Evidence[] = [
      { pulls: [700] },
      { pulls: [601] },
      { issues: [503] },
      { issues: [1] },
      { pulls: [600], issues: [502] },
    ];
    for (const evidence of sets) {
      // Diagnose's path: the claim on issue #1.
      const h = await parked();
      forgeFacts(h);
      await diagnose(h, claimOutput(evidence));
      await flush(h);
      const claim = claims(h)[0];
      // Triage's path: an already-done request on the same issue, the same evidence.
      if (claim?.state === 'done') h.forge.state.reopenIssue(1);
      // The harness's issue #1, as triage would have recorded it.
      const issue1 = { number: 1, title: 'Issue 1', body: 'b', author: 'human' };
      const req = recordTriageRequest(h.db, 'main', issue1, h.now()) ?? -1;
      setTriageRequest(
        h.db,
        req,
        {
          state: 'verifying',
          outcome: 'already-done',
          reason: 'r',
          evidence,
        },
        h.now(),
      );
      setZoneMode(h.db, 'main', 'observe', h.now()); // verifies only
      await flushTriageTrail(h.db, h.forges, h.zone, [], h.at(2));
      const tri = getTriageRequest(h.db, req);
      const direct = await verifyCited(h.forges, 1, evidence);
      if (direct.ok) {
        expect(claim?.state, JSON.stringify(evidence)).toBe('done');
        expect(tri?.state).toBe('done');
      } else {
        expect(claim).toMatchObject({ state: 'refused', reason: direct.why });
        expect(tri?.lastError).toBe(`evidence refused: ${direct.why}`);
      }
    }
  });
});

test('syncParkBriefings leaves a refused claim’s briefing open with its reason', async () => {
  const h = await parked();
  forgeFacts(h);
  await diagnose(h, claimOutput({ pulls: [700] }));
  await flush(h);
  syncParkBriefings(h.db, h.zone, h.now());
  expect(briefing(h)?.recommendation).toBe(
    `needs_command: ${CLAIM_REFUSED}#700 was not merged to the default branch`,
  );
});
