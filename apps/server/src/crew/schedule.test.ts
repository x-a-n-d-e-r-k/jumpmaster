import { DropPayloadSchema } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  listBriefings,
  raiseBriefing,
  ruleBriefing,
  syncParkBriefings,
  whyBasis,
} from '../briefings.js';
import type { ClaudeConfig, Config, DropZoneConfig } from '../config.js';
import {
  getDrop,
  getPullRequest,
  getWorkItem,
  insertDrop,
  insertStick,
  listObservations,
  setKilled,
  setUsageState,
  setWorkItemState,
  setZoneMode,
  updateDrop,
  upsertPullRequest,
} from '../db/repo.js';
import { reconcileZone } from '../flow/reconcile.js';
import { zonePass } from '../flow/snapshot.js';
import { refreshGoals } from '../goals.js';
import { leaseNextDrop } from '../leases.js';
import { buildPayload, promptVersions } from '../payloads.js';
import { crewOn, crewWorld, ISSUE_BODY } from '../test/crew.js';
import { makeZone, usageCfg, type ZoneWorld } from '../test/fixtures.js';
import {
  arbiterHarness,
  FABLE_CLAUDE,
  type Harness,
  type HealRound,
  headN,
  reviewRounds,
  ruling,
  toHealsExhausted,
  toPrOpen,
} from '../test/flowHarness.js';
import { plus, t0 } from '../test/helpers.js';
import { applyCrewActions } from './actions.js';
import {
  type CrewInputJson,
  crewDropsToday,
  enqueueCrew,
  nextCrewWork,
  requestCrewCycle,
  reviewDisagreement,
} from './schedule.js';
import {
  getCrewIssue,
  getTriageRequest,
  recordTriageRequest,
  setCrewIssue,
  setTriageRequest,
} from './store.js';

const MIN = 60_000;

const secretsFor = () =>
  ({
    claudeToken: 'claude-secret',
    githubAuthorToken: 'author-secret',
    githubReviewerToken: 'reviewer-secret',
    joinToken: 'join',
    operatorToken: 'o'.repeat(32),
  }) as Config['secrets'];
const HOUR = 60 * MIN;

let w: ZoneWorld;
beforeEach(async () => {
  w = await crewWorld();
});

async function enqueue(at = t0, zone: DropZoneConfig = w.zone): Promise<string | null> {
  const pass = await zonePass(w.forges, zone, 'main');
  return enqueueCrew(w.db, w.forges, zone, pass, promptVersions(), usageCfg, at);
}

const work = (id: string) =>
  (JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}') as CrewInputJson).work;

/** Finishes a crew drop so the next one may start. */
const finish = (id: string) => updateDrop(w.db, id, { state: 'succeeded' });

function stagedIssue(key = 'add-docs'): number {
  const r = applyCrewActions(
    w.db,
    w.zone,
    {
      fileIssues: [
        { key, objective: 'document-every-endpoint', title: `Do ${key}`, body: ISSUE_BODY },
      ],
    },
    { kind: 'drop', dropId: 'd0' },
    t0,
  );
  const id = r.filed[0] ?? -1;
  setCrewIssue(w.db, id, { state: 'staged', number: 40, bodySha: 'sha-1' }, t0);
  return id;
}

function parkedItem(): number {
  const id = w.item(1, 'ready');
  setWorkItemState(w.db, id, 'parked', 'heal budget exhausted', t0);
  syncParkBriefings(w.db, w.zone, t0);
  return id;
}

describe('enqueueCrew', () => {
  test('nothing is enqueued when disabled, paused, killed, throttled or over the daily cap', async () => {
    expect(await enqueue(t0, makeZone())).toBeNull(); // crew.enabled defaults to false

    setZoneMode(w.db, 'main', 'paused', t0);
    expect(await enqueue()).toBeNull();
    setZoneMode(w.db, 'main', 'active', t0);

    setKilled(w.db, true, t0);
    expect(await enqueue()).toBeNull();
    setKilled(w.db, false, t0);

    setUsageState(
      w.db,
      { status: 'allowed', fiveHourUtil: 0.95, observedAt: t0.toISOString() },
      t0,
    );
    expect(await enqueue()).toBeNull(); // finishing_only
    setUsageState(w.db, { fiveHourUtil: 0.1 }, t0);

    const capped = { ...w.zone, crew: { ...crewOn, maxDropsPerDay: 2, cycleMinutes: 1 } };
    let at = t0;
    for (let n = 0; n < 2; n++) {
      const id = await enqueue(at, capped);
      expect(id).not.toBeNull();
      finish(id ?? '');
      at = plus(at, 2 * MIN);
    }
    expect(await enqueue(at, capped)).toBeNull();
    // The cap is a trailing 24 hours.
    expect(await enqueue(plus(t0, 25 * HOUR), capped)).not.toBeNull();
  });

  test('rate-limited and lost crew drops do not count toward maxDropsPerDay', async () => {
    const capped = { ...w.zone, crew: { ...crewOn, maxDropsPerDay: 1, cycleMinutes: 1 } };
    const a = (await enqueue(t0, capped)) ?? '';
    updateDrop(w.db, a, { state: 'lost' });
    const b = (await enqueue(plus(t0, 2 * MIN), capped)) ?? '';
    expect(b).not.toBe('');
    updateDrop(w.db, b, {
      state: 'cancelled',
      resultJson: JSON.stringify({ status: 'rate_limited', gates: [] }),
    });
    const c = (await enqueue(plus(t0, 4 * MIN), capped)) ?? '';
    expect(c).not.toBe('');
    finish(c);
    expect(await enqueue(plus(t0, 6 * MIN), capped)).toBeNull();
  });

  test('a doctor drop is not a crew drop: it neither counts toward the cap nor blocks one', async () => {
    const capped = { ...w.zone, crew: { ...crewOn, maxDropsPerDay: 1, cycleMinutes: 1 } };
    insertDrop(
      w.db,
      { id: 'doc0', dropZoneId: 'main', workItemId: null, role: 'doctor', state: 'succeeded' },
      t0,
    );
    insertDrop(
      w.db,
      { id: 'doc1', dropZoneId: 'main', workItemId: null, role: 'doctor', state: 'queued' },
      t0,
    );
    expect(await enqueue(plus(t0, MIN), capped)).not.toBeNull();
  });

  test('an unparsed GOAL.md blocks the lead cycle but not diagnose or refute', async () => {
    w.f.state.files.set('main:GOAL.md', '# nothing here');
    const issue = stagedIssue();
    await refreshGoals(w.db, w.f.author, w.zone, 'main', t0);
    parkedItem();
    const d = (await enqueue()) ?? '';
    expect(work(d).role).toBe('diagnose');
    finish(d);
    const r = (await enqueue(plus(t0, MIN))) ?? '';
    expect(work(r)).toEqual({ role: 'refute', crewIssueId: issue, securityTouching: false });
    finish(r);
    setCrewIssue(w.db, issue, { refutedSha: 'sha-1' }, t0);
    expect(nextCrewWork(w.db, w.zone, plus(t0, 2 * MIN))).toEqual({ role: 'crew-lead' });
    expect(await enqueue(plus(t0, 2 * MIN))).toBeNull();
  });

  test('with one slot, crew drops lease only after queued item drops, and still lease once the queue drains', async () => {
    insertStick(w.db, { id: 'stick', name: 'stick', tokenHash: 'h', slots: 1 });
    const crew = (await enqueue()) ?? '';
    const item = w.item(2, 'in_flight');
    insertDrop(w.db, {
      id: 'impl',
      dropZoneId: 'main',
      workItemId: item,
      role: 'implement',
      state: 'queued',
      createdAt: plus(t0, MIN).toISOString(),
    });
    expect(leaseNextDrop(w.db, 'stick', plus(t0, 2 * MIN), 'open')?.dropId).toBe('impl');
    updateDrop(w.db, 'impl', { state: 'succeeded' });
    expect(leaseNextDrop(w.db, 'stick', plus(t0, 3 * MIN), 'open')?.dropId).toBe(crew);
  });

  test('diagnose precedes refute precedes the lead cycle; one crew drop at a time', async () => {
    const issue = stagedIssue();
    const item = parkedItem();
    const [briefing] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({
      role: 'diagnose',
      briefingId: briefing?.id,
      itemId: item,
      basis: whyBasis(briefing?.why ?? 'no briefing'),
    });
    const d = (await enqueue()) ?? '';
    expect(work(d).role).toBe('diagnose');
    // Counted at enqueue: diagnose runs once per parked briefing.
    expect(listBriefings(w.db, { zoneId: 'main' })[0]?.diagnoseAttempts).toBe(1);
    expect(await enqueue(plus(t0, MIN))).toBeNull(); // one crew drop at a time
    finish(d);
    const r = (await enqueue(plus(t0, 2 * MIN))) ?? '';
    expect(work(r)).toEqual({ role: 'refute', crewIssueId: issue, securityTouching: false });
    expect(getCrewIssue(w.db, issue)?.refuteCount).toBe(1);
    finish(r);
    setCrewIssue(w.db, issue, { refutedSha: 'sha-1' }, t0);
    const l = (await enqueue(plus(t0, 3 * MIN))) ?? '';
    expect(work(l)).toEqual({ role: 'crew-lead' });
    finish(l);
    // The next cycle waits cycleMinutes.
    expect(nextCrewWork(w.db, w.zone, plus(t0, 30 * MIN))).toBeNull();
    expect(nextCrewWork(w.db, w.zone, plus(t0, 64 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test('a refute is retried until maxRefute, and again once the body changes', async () => {
    const issue = stagedIssue();
    setCrewIssue(w.db, issue, { refuteCount: 2 }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    setCrewIssue(w.db, issue, { refuteCount: 1, refutedSha: 'sha-1' }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    setCrewIssue(w.db, issue, { bodySha: 'sha-2' }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'refute', crewIssueId: issue });
  });

  test('a staged issue whose refute budget ran out unjudged is put to Command, once', async () => {
    const issue = stagedIssue();
    setCrewIssue(w.db, issue, { refuteCount: 2 }, t0); // two refute drops died without a verdict
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    nextCrewWork(w.db, w.zone, plus(t0, MIN));
    const open = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'refute_exhausted', subject: `issue:${issue}` });
    expect(open[0]?.options.map((o) => o.effect)).toEqual(['promote_issue', 'reject_issue']);
    expect(open[0]?.decision).toBe(
      "Reviewers asked for changes to crew issue #40 2 times, and its latest text hasn't been " +
        'reviewed. Promote it as it reads now, or reject it?',
    );
  });

  test("the out-of-refutes briefing counts the issue's own refutes, in plain words", () => {
    for (const refuteCount of [3, 2]) {
      const issue = stagedIssue(`k${refuteCount}`);
      setCrewIssue(w.db, issue, { refuteCount, number: null }, t0);
      nextCrewWork(w.db, w.zone, t0);
      const open = listBriefings(w.db, { zoneId: 'main', state: 'open' }).filter(
        (b) => b.subject === `issue:${issue}`,
      );
      expect(open).toHaveLength(1);
      const [b] = open;
      expect(b?.decision).toContain(`${refuteCount} times`);
      expect(b?.decision).toBe(
        `Reviewers asked for changes to crew issue k${refuteCount} ${refuteCount} times, and ` +
          "its latest text hasn't been reviewed. Promote it as it reads now, or reject it?",
      );
      for (const text of [b?.decision ?? '', b?.why ?? '']) {
        expect(text).not.toContain('survived the refute');
        expect(text).not.toContain('refute verdict');
      }
      setCrewIssue(w.db, issue, { state: 'rejected' }, t0);
    }
  });

  test('a ruling newer than the last cycle makes the lead cycle due at once', async () => {
    const l = (await enqueue()) ?? '';
    finish(l);
    expect(nextCrewWork(w.db, w.zone, plus(t0, 5 * MIN))).toBeNull();
    const b = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'crew:x',
        decision: 'd',
        why: 'w',
        options: [
          { id: 'o1', label: 'a', effect: 'none' },
          { id: 'o2', label: 'b', effect: 'none' },
        ],
        source: 'crew',
      },
      t0,
    );
    ruleBriefing(w.db, b, 'o1', '', plus(t0, 6 * MIN));
    expect(nextCrewWork(w.db, w.zone, plus(t0, 7 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test('a ruling on a parked or credits briefing does not make the lead cycle due', async () => {
    finish((await enqueue()) ?? '');
    parkedItem();
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    ruleBriefing(w.db, b?.id ?? -1, 'leave', '', plus(t0, 2 * MIN));
    expect(nextCrewWork(w.db, w.zone, plus(t0, 3 * MIN))).toBeNull();
  });

  test('crew-cycle makes the lead cycle due now', async () => {
    finish((await enqueue()) ?? '');
    expect(nextCrewWork(w.db, w.zone, plus(t0, 5 * MIN))).toBeNull();
    requestCrewCycle('main', plus(t0, 5 * MIN));
    expect(nextCrewWork(w.db, w.zone, plus(t0, 6 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test('observe records would_enqueue:crew-lead and creates no drop', async () => {
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(await enqueue()).toBeNull();
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM drops').get()).toEqual({ n: 0 });
    expect(listObservations(w.db, 'main').map((o) => o.action)).toEqual([
      'would_enqueue:crew-lead',
    ]);
  });

  test('the rendered input is stored on the drop', async () => {
    const id = (await enqueue()) ?? '';
    const stored = JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}') as CrewInputJson;
    expect(stored.input).toContain('LIGHTHOUSE-TEXT');
    expect(stored.input).toContain(`<<<jm-data:${id}:begin`);
    expect(getDrop(w.db, id)).toMatchObject({
      role: 'crew-lead',
      workItemId: null,
      state: 'queued',
      promptVersion: promptVersions()['crew-lead'],
    });
  });

  test('reconcileZone enqueues crew work after implement work, and none with the crew off', async () => {
    w.item(1, 'ready');
    const pass = await zonePass(w.forges, w.zone, 'main');
    await reconcileZone(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, [], t0);
    const roles = w.db
      .prepare('SELECT role FROM drops ORDER BY rowid')
      .all()
      .map((r) => (r as { role: string }).role);
    expect(roles).toEqual(['implement', 'crew-lead']);

    const off = await crewWorld({ crew: makeZone().crew });
    const offPass = await zonePass(off.forges, off.zone, 'main');
    await reconcileZone(off.db, off.forges, off.zone, offPass, promptVersions(), usageCfg, [], t0);
    expect(off.db.prepare('SELECT COUNT(*) AS n FROM drops').get()).toEqual({ n: 0 });
  });
});

describe('triage scheduling (#184)', () => {
  const request = (n = 179, body = 'Two complaints in two sentences.') =>
    recordTriageRequest(
      w.db,
      'main',
      { number: n, title: `Issue ${n}`, body, author: 'human' },
      t0,
    ) ?? -1;
  /** Fills every crew-issue slot with a staged issue that has been refuted already. */
  const fillSlots = () => {
    for (let n = 0; n < w.zone.crew.maxStaged; n++) {
      const id = stagedIssue(`fill-${n}`);
      setCrewIssue(w.db, id, { refutedSha: 'sha-1' }, t0);
    }
  };

  test('triage follows diagnose and refute and precedes the lead cycle', async () => {
    const req = request();
    const issue = stagedIssue();
    parkedItem();
    const d = (await enqueue()) ?? '';
    expect(work(d).role).toBe('diagnose');
    finish(d);
    const r = (await enqueue(plus(t0, MIN))) ?? '';
    expect(work(r)).toEqual({ role: 'refute', crewIssueId: issue, securityTouching: false });
    finish(r);
    setCrewIssue(w.db, issue, { refutedSha: 'sha-1' }, t0);
    expect(nextCrewWork(w.db, w.zone, plus(t0, 2 * MIN))).toEqual({
      role: 'triage',
      requestId: req,
    });
    const t = (await enqueue(plus(t0, 2 * MIN))) ?? '';
    expect(work(t)).toEqual({ role: 'triage', requestId: req });
    expect(getDrop(w.db, t)).toMatchObject({
      role: 'triage',
      workItemId: null,
      promptVersion: promptVersions().triage,
    });
    finish(t);
    setTriageRequest(w.db, req, { state: 'done', outcome: 'not-agent-work' }, t0);
    expect(nextCrewWork(w.db, w.zone, plus(t0, 3 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test("a triage drop carries the issue's images, fetched at enqueue, into its payload (#186)", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('png'),
    ]);
    const url = 'https://github.com/user-attachments/assets/179';
    request(179, `Overage Included\n\n![gauge](${url})\n![x](https://evil.example/a.png)`);
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const t =
      (await enqueueCrew(
        w.db,
        w.forges,
        w.zone,
        await zonePass(w.forges, w.zone, 'main'),
        promptVersions(),
        usageCfg,
        t0,
        {
          token: 'ghs_READ',
          fetch: async (u, init) => {
            seen.push({ url: u, headers: init.headers });
            return new Response(new Uint8Array(png), { status: 200 });
          },
        },
      )) ?? '';
    expect(seen).toEqual([{ url, headers: { authorization: 'Bearer ghs_READ' } }]);
    const p = buildPayload(
      w.db,
      w.zone,
      getDrop(w.db, t) as never,
      {
        claudeToken: 'c',
        githubAuthorToken: 'a',
      } as never,
    );
    expect(DropPayloadSchema.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({
      role: 'triage',
      images: [{ mediaType: 'image/png', base64: png.toString('base64') }],
      imagesSkipped: [{ reason: 'host not allowed' }],
    });
    expect(JSON.stringify(p)).not.toContain('ghs_READ');
  });

  test('a fetch that fails still enqueues the triage drop (D2)', async () => {
    request(179, '![a](https://github.com/user-attachments/assets/1)');
    const t = await enqueueCrew(
      w.db,
      w.forges,
      w.zone,
      await zonePass(w.forges, w.zone, 'main'),
      promptVersions(),
      usageCfg,
      t0,
      {
        fetch: async () => {
          throw new Error('network down');
        },
      },
    );
    expect(t).not.toBeNull();
    const stored = JSON.parse(getDrop(w.db, t ?? '')?.inputJson ?? '{}') as CrewInputJson;
    expect(stored).toMatchObject({ images: [], imagesSkipped: [{ reason: 'fetch failed' }] });
  });

  test('the oldest open request goes first', () => {
    const a = request(179);
    request(180);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'triage', requestId: a });
  });

  test('no triage with 0 free slots, in a paused or observe zone, or with the crew off', async () => {
    request();
    const offZone = { ...w.zone, crew: { ...w.zone.crew, enabled: false } };
    expect(nextCrewWork(w.db, offZone, t0)).not.toMatchObject({ role: 'triage' });
    expect(await enqueue(t0, offZone)).toBeNull();

    for (const mode of ['paused', 'observe'] as const) {
      setZoneMode(w.db, 'main', mode, t0);
      expect(nextCrewWork(w.db, w.zone, t0), mode).toEqual({ role: 'crew-lead' });
    }
    setZoneMode(w.db, 'main', 'active', t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toMatchObject({ role: 'triage' });

    fillSlots();
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
  });

  test('a request at maxTriage is not scheduled', () => {
    const req = request();
    setTriageRequest(w.db, req, { attempts: w.zone.crew.maxTriage }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    setTriageRequest(w.db, req, { attempts: w.zone.crew.maxTriage - 1 }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'triage', requestId: req });
  });

  test('a waiting request comes back to open once its briefing is ruled', () => {
    const req = request();
    const b = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'crew:#179 fable',
        decision: 'd',
        why: 'w',
        options: [
          { id: 'o1', label: 'a', effect: 'none' },
          { id: 'o2', label: 'b', effect: 'none' },
        ],
        source: 'crew',
      },
      t0,
    );
    setTriageRequest(w.db, req, { state: 'waiting', outcome: 'questions', briefingId: b }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    ruleBriefing(w.db, b, 'o2', 'drop the gauge', plus(t0, MIN));
    expect(nextCrewWork(w.db, w.zone, plus(t0, 2 * MIN))).toEqual({
      role: 'triage',
      requestId: req,
    });
    expect(getTriageRequest(w.db, req)?.state).toBe('open');
  });

  test('triage drops count toward maxDropsPerDay', async () => {
    const capped = { ...w.zone, crew: { ...crewOn, maxDropsPerDay: 1 } };
    request();
    const t = (await enqueue(t0, capped)) ?? '';
    expect(work(t).role).toBe('triage');
    finish(t);
    expect(await enqueue(plus(t0, MIN), capped)).toBeNull();
  });
});

describe('arbitration of crew issues out of refutes (#382)', () => {
  const FABLE = 'claude-fable-1';
  const fable: ClaudeConfig = { plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 5 };
  const noFable: ClaudeConfig = { plan: 'pro', fableModel: FABLE, fableWeeklyDropCap: 5 };
  const zone3 = (o: Partial<DropZoneConfig['crew']> = {}): DropZoneConfig => ({
    ...w.zone,
    crew: { ...crewOn, maxRefute: 3, ...o },
  });

  async function enqueueWith(
    at: Date,
    zone: DropZoneConfig,
    claude: ClaudeConfig | null = fable,
  ): Promise<string | null> {
    const pass = await zonePass(w.forges, zone, 'main');
    return enqueueCrew(
      w.db,
      w.forges,
      zone,
      pass,
      promptVersions(),
      usageCfg,
      at,
      undefined,
      claude ? { claude } : {},
    );
  }

  let seq = 0;
  /** A finished refute drop on the issue: a verdict when `decision` is given, else a dead drop. */
  function refuteDrop(issue: number, at: Date, decision?: string, findings: string[] = []): void {
    const id = `ref-${++seq}`;
    insertDrop(
      w.db,
      {
        id,
        dropZoneId: 'main',
        workItemId: null,
        role: 'refute',
        state: decision ? 'succeeded' : 'failed',
        inputJson: JSON.stringify({ work: { role: 'refute', crewIssueId: issue }, input: '' }),
      },
      at,
    );
    updateDrop(w.db, id, {
      resultJson: JSON.stringify(
        decision
          ? { status: 'completed', gates: [], crew: { decision, findings } }
          : { status: 'failed', gates: [], reason: 'boom' },
      ),
    });
  }

  /** Issue #50: three refutes each asked to revise, the last revision staged unrefuted. */
  function exhausted(key = 'add-docs'): number {
    const id = stagedIssue(key);
    for (let i = 0; i < 3; i++) refuteDrop(id, plus(t0, -(10 - i) * MIN), 'revise', [`fix ${i}`]);
    setCrewIssue(w.db, id, { number: 50, refuteCount: 3 }, t0);
    return id;
  }

  const arbitrations = () =>
    w.db.prepare('SELECT subject, basis, drop_id AS dropId, state FROM arbitrations').all() as {
      subject: string;
      basis: string;
      dropId: string;
      state: string;
    }[];
  const exhaustedBriefings = () =>
    listBriefings(w.db, { zoneId: 'main', state: 'open' }).filter(
      (b) => b.kind === 'refute_exhausted',
    );
  const arbitrateDrops = () =>
    (w.db.prepare(`SELECT id FROM drops WHERE role = 'arbitrate'`).all() as { id: string }[]).map(
      (r) => r.id,
    );

  test('order: diagnose, refute, arbitrate, triage, then the lead cycle', async () => {
    const zone = zone3();
    const req =
      recordTriageRequest(
        w.db,
        'main',
        { number: 179, title: 'Issue 179', body: 'Two things.', author: 'human' },
        t0,
      ) ?? -1;
    const arb = exhausted('arb');
    const fresh = stagedIssue('fresh');
    const item = parkedItem();
    const work = (at: Date) => nextCrewWork(w.db, zone, at, true);
    expect(work(t0)).toMatchObject({ role: 'diagnose', itemId: item });
    const [parked] = listBriefings(w.db, { zoneId: 'main', state: 'open', kind: 'parked' });
    w.db.prepare('UPDATE briefings SET diagnose_attempts = 1 WHERE id = ?').run(parked?.id);
    expect(work(t0)).toEqual({ role: 'refute', crewIssueId: fresh });
    setCrewIssue(w.db, fresh, { refutedSha: 'sha-1' }, t0);
    expect(work(t0)).toEqual({
      role: 'arbitrate',
      subject: 'issue',
      crewIssueId: arb,
      basis: 'sha-1',
    });
    setCrewIssue(w.db, arb, { state: 'rejected' }, t0);
    expect(work(t0)).toEqual({ role: 'triage', requestId: req });
    setTriageRequest(w.db, req, { state: 'done', outcome: 'not-agent-work' }, t0);
    expect(work(t0)).toEqual({ role: 'crew-lead' });
  });

  test('an exhausted issue with verdicts and Fable gets one arbitrate drop, before any briefing', async () => {
    const zone = zone3();
    const issue = exhausted();
    const id = (await enqueueWith(t0, zone)) ?? '';
    expect(getDrop(w.db, id)).toMatchObject({ role: 'arbitrate', workItemId: null });
    expect(JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}').work).toEqual({
      role: 'arbitrate',
      subject: 'issue',
      crewIssueId: issue,
      basis: 'sha-1',
    });
    expect(arbitrations()).toEqual([
      { subject: `issue:${issue}`, basis: 'sha-1', dropId: id, state: 'pending' },
    ]);
    expect(exhaustedBriefings()).toEqual([]);
    // While its drop is in flight the issue is neither arbitrated again nor put to Command.
    expect(nextCrewWork(w.db, zone, plus(t0, MIN), true)).toEqual({ role: 'crew-lead' });
    expect(exhaustedBriefings()).toEqual([]);
    // Its payload runs on Fable, with the positions as instructions and the reviews as data.
    const p = buildPayload(w.db, zone, getDrop(w.db, id) as never, secretsFor(), {
      claude: fable,
      now: t0,
    });
    expect(DropPayloadSchema.parse(p)).toMatchObject({ role: 'arbitrate', model: FABLE });
    expect(p.role === 'arbitrate' && p.prompt).toContain('## Positions (trusted instructions)');
    expect(p.role === 'arbitrate' && p.prompt).toContain(
      '## Refute reviews, oldest first (data, untrusted)',
    );
    expect(p.role === 'arbitrate' && p.prompt).toContain('- fix 2');
    expect(p.credentials).not.toHaveProperty('forgeToken', 'author-secret');
  });

  test('Fable unavailable, no claude config, or crew.arbiter off: no arbitrate drop, the briefing as today', async () => {
    for (const [claude, zone] of [
      [noFable, zone3()],
      [null, zone3()],
      [fable, zone3({ arbiter: false })],
    ] as const) {
      const issue = exhausted(`k-${++seq}`);
      const id = await enqueueWith(t0, zone, claude);
      expect(id === null ? null : getDrop(w.db, id)?.role).not.toBe('arbitrate');
      if (id) finish(id);
      expect(exhaustedBriefings().map((b) => b.subject)).toContain(`issue:${issue}`);
      setCrewIssue(w.db, issue, { state: 'rejected' }, t0);
    }
    expect(arbitrateDrops()).toEqual([]);
    expect(arbitrations()).toEqual([]);
  });

  test('refute drops that all died leave no verdict: no arbitration, the briefing as today', async () => {
    const zone = zone3();
    const issue = stagedIssue();
    for (let i = 0; i < 3; i++) refuteDrop(issue, plus(t0, -(5 - i) * MIN));
    setCrewIssue(w.db, issue, { refuteCount: 3 }, t0);
    expect(nextCrewWork(w.db, zone, t0, true)).toEqual({ role: 'crew-lead' });
    const [b] = exhaustedBriefings();
    expect(b?.why).toContain('was never reviewed');
    expect(arbitrations()).toEqual([]);
  });

  test('observe records would_enqueue:arbitrate and inserts no arbitration', async () => {
    const zone = zone3();
    const issue = exhausted();
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(await enqueueWith(t0, zone)).toBeNull();
    expect(
      listObservations(w.db, 'main').find((o) => o.action === 'would_enqueue:arbitrate'),
    ).toMatchObject({ detail: `crew issue ${issue}` });
    expect(arbitrations()).toEqual([]);
    expect(arbitrateDrops()).toEqual([]);
  });

  test('D3: two enqueues in one pass, or two passes before the drop finishes, give one arbitration', async () => {
    const zone = zone3();
    exhausted();
    const ids = await Promise.all([enqueueWith(t0, zone), enqueueWith(t0, zone)]);
    expect(ids.filter((x) => x !== null)).toHaveLength(1);
    expect(await enqueueWith(plus(t0, MIN), zone)).toBeNull();
    expect(arbitrations()).toHaveLength(1);
    expect(arbitrateDrops()).toHaveLength(1);
    // Even with the crew drop index out of the way, the same text is never arbitrated twice.
    for (const id of arbitrateDrops()) updateDrop(w.db, id, { state: 'running' });
    expect(nextCrewWork(w.db, zone, plus(t0, 2 * MIN), true)?.role).not.toBe('arbitrate');
  });

  test('D3: a forced second arbitration of the same text rolls the drop insert back', async () => {
    const zone = zone3();
    const issue = exhausted();
    w.db.exec(`CREATE TEMP TRIGGER dup AFTER INSERT ON drops WHEN NEW.role = 'arbitrate' BEGIN
      INSERT INTO arbitrations (zone_id, subject, basis, drop_id, state, created_at, updated_at)
        SELECT zone_id, subject, basis, 'other', 'pending', 't', 't' FROM arbitrations
        WHERE drop_id = NEW.id;
    END`);
    expect(await enqueueWith(t0, zone)).toBeNull();
    expect(arbitrateDrops()).toEqual([]);
    expect(arbitrations()).toEqual([]);
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
  });

  test('an arbitrate drop lost without a result fails closed: the briefing as today, once', async () => {
    const zone = zone3();
    const issue = exhausted();
    const id = (await enqueueWith(t0, zone)) ?? '';
    updateDrop(w.db, id, { state: 'lost' });
    expect(nextCrewWork(w.db, zone, plus(t0, MIN), true)).toEqual({ role: 'crew-lead' });
    expect(arbitrations()[0]?.state).toBe('failed');
    const [b] = exhaustedBriefings();
    expect(b?.subject).toBe(`issue:${issue}`);
    expect(b?.why).toContain(
      'The arbiter could not rule: the arbitrate drop ended without a ruling',
    );
    nextCrewWork(w.db, zone, plus(t0, 2 * MIN), true);
    expect(arbitrateDrops()).toHaveLength(1);
    expect(exhaustedBriefings()).toHaveLength(1);
  });

  test('a new body after an arbitration is arbitrated afresh', async () => {
    const zone = zone3();
    const issue = exhausted();
    const id = (await enqueueWith(t0, zone)) ?? '';
    finish(id);
    w.db.prepare(`UPDATE arbitrations SET state = 'discarded'`).run();
    setCrewIssue(w.db, issue, { bodySha: 'sha-2' }, t0);
    expect(nextCrewWork(w.db, zone, plus(t0, MIN), true)).toMatchObject({
      role: 'arbitrate',
      basis: 'sha-2',
    });
  });
});

describe('arbitration of review disagreements (#383)', () => {
  const fable = FABLE_CLAUDE;

  /** Issue #1, parked on its heals by the real flow: `rounds` say where each heal's feedback came from. */
  async function parked(
    rounds: HealRound[] = ['review', 'review', 'review'],
    o: Parameters<typeof arbiterHarness>[0] = {},
  ): Promise<Harness> {
    const h = await arbiterHarness({
      ...o,
      zone: { ...(rounds.includes('ci') ? { ciRequired: true } : {}), ...o.zone },
    });
    await toHealsExhausted(h, rounds);
    expect(getWorkItem(h.db, 1)).toMatchObject({
      state: 'parked',
      reason: 'budget exhausted: heal',
    });
    return h;
  }

  const enqueueOn = async (h: Harness, claude: ClaudeConfig | null = fable, zone = h.zone) =>
    enqueueCrew(
      h.db,
      h.forges,
      zone,
      await zonePass(h.forges, zone, 'main'),
      promptVersions(),
      usageCfg,
      h.now(),
      undefined,
      claude ? { claude } : {},
    );
  const parkedBriefing = (h: Harness) =>
    listBriefings(h.db, { zoneId: 'main', state: 'open', kind: 'parked' })[0];
  const rows = (h: Harness) =>
    h.db.prepare('SELECT subject, basis, drop_id AS dropId, state FROM arbitrations').all();
  const crewDrops = (h: Harness, role: string) =>
    (h.db.prepare('SELECT id FROM drops WHERE role = ?').all(role) as { id: string }[]).map(
      (r) => r.id,
    );

  test('#61: three review heals ran out, Fable available → one arbitrate drop on the PR head, before diagnose', async () => {
    const h = await parked();
    const b = parkedBriefing(h);
    const head = headN(4);
    expect(reviewDisagreement(h.db, getWorkItem(h.db, 1) as never)).toBe(true);
    expect(nextCrewWork(h.db, h.zone, h.now(), true)).toEqual({
      role: 'arbitrate',
      subject: 'item',
      itemId: 1,
      briefingId: b?.id,
      headSha: head,
      basis: 'review',
    });
    const id = (await enqueueOn(h)) ?? '';
    expect(getDrop(h.db, id)).toMatchObject({ role: 'arbitrate', workItemId: null });
    expect(rows(h)).toEqual([{ subject: 'item:1', basis: 'review', dropId: id, state: 'pending' }]);
    expect(crewDrops(h, 'diagnose')).toEqual([]);
    expect(parkedBriefing(h)?.diagnoseAttempts).toBe(0);
    // While it is in flight the item is neither arbitrated again nor diagnosed.
    expect(nextCrewWork(h.db, h.zone, h.now(), true)).toEqual({ role: 'crew-lead' });

    const p = buildPayload(h.db, h.zone, getDrop(h.db, id) as never, secretsFor(), {
      claude: fable,
      now: h.now(),
    });
    expect(DropPayloadSchema.parse(p)).toMatchObject({
      role: 'arbitrate',
      model: fable.fableModel,
      checkout: { number: 1, branch: 'agent/issue-1', headSha: head },
    });
    const prompt = p.role === 'arbitrate' ? p.prompt : '';
    expect(prompt).toContain('## Positions (trusted instructions)');
    expect(prompt).toContain('A: the reviewer is right: the change does not yet meet the issue.');
    expect(prompt).toContain(
      'B: the author is right: the change meets the issue, and the remaining findings are not defects.',
    );
    expect(prompt).toContain('## Issue (data)');
    expect(prompt).toContain(`#1 at head ${head}`);
    expect(prompt).toContain('## Review verdicts on this item, newest first (data, untrusted)');
    expect(prompt).toContain('the last finding');
    expect(prompt).toContain('## Author reports (data, untrusted)');
    expect(prompt).toContain('healed round 3');
    expect(prompt).toContain('## Last heal feedback (data, untrusted)');
    expect(prompt).toContain('finding 3');
    expect(p.credentials).not.toHaveProperty('forgeToken', 'author-token');
  });

  test('the last heal came from a trusted person, or from CI → no arbitrate drop: diagnose as today', async () => {
    for (const last of ['human', 'ci'] as const) {
      const h = await parked(['review', 'review', last]);
      expect(reviewDisagreement(h.db, getWorkItem(h.db, 1) as never), last).toBe(false);
      expect(nextCrewWork(h.db, h.zone, h.now(), true), last).toMatchObject({
        role: 'diagnose',
        itemId: 1,
      });
      const id = (await enqueueOn(h)) ?? '';
      expect(getDrop(h.db, id)?.role).toBe('diagnose');
      expect(rows(h)).toEqual([]);
    }
  });

  test('Fable unavailable, no claude config, or crew.arbiter off → diagnose as today', async () => {
    const noFable: ClaudeConfig = { ...fable, plan: 'pro' };
    for (const [claude, arbiter] of [
      [noFable, true],
      [null, true],
      [fable, false],
    ] as const) {
      const h = await parked();
      const zone = { ...h.zone, crew: { ...h.zone.crew, arbiter } };
      const id = (await enqueueOn(h, claude, zone)) ?? '';
      expect(getDrop(h.db, id)?.role).toBe('diagnose');
      expect(rows(h)).toEqual([]);
    }
  });

  test('reviewDisagreement is false for budget exhausted: review and budget exhausted: resolve', async () => {
    // Review drops that died on one head: a failed review, not a disagreement.
    const r = await arbiterHarness();
    await toPrOpen(r, headN(1));
    for (let i = 0; i < 6 && getWorkItem(r.db, 1)?.state === 'pr_open'; i++) {
      await r.reconcile();
      if (r.queuedRoles().includes('review')) {
        await r.finishDrop('review', { status: 'failed', reason: 'boom', gates: [] });
      }
    }
    syncParkBriefings(r.db, r.zone, r.now());
    expect(getWorkItem(r.db, 1)).toMatchObject({ reason: 'budget exhausted: review' });
    expect(reviewDisagreement(r.db, getWorkItem(r.db, 1) as never)).toBe(false);
    expect(nextCrewWork(r.db, r.zone, r.now(), true)).toMatchObject({ role: 'diagnose' });

    // Conflicting resolves after two review heals: the newest heal is still the reviewer's.
    const s = await arbiterHarness();
    await toPrOpen(s, headN(1));
    s.forge.state.updateConflicts.add(1);
    let head = 1;
    for (let i = 0; i < 12 && getWorkItem(s.db, 1)?.state === 'pr_open'; i++) {
      s.forge.state.compares.set(`main...${headN(head)}`, {
        aheadBy: 1,
        behindBy: 1,
        baseSha: `b${i}`,
        mergeBaseSha: 'b',
      });
      await s.reconcile();
      const role = s.queuedRoles()[0];
      if (role === 'review') {
        await s.finishDrop('review', {
          status: 'completed',
          gates: [],
          verdict:
            head < 3
              ? { decision: 'request_changes', summary: 'no', findings: [] }
              : { decision: 'approve', summary: 'ok', findings: [] },
        });
      } else if (role === 'heal' || role === 'resolve') {
        head++;
        await s.finishDrop(role, {
          status: 'completed',
          headSha: headN(head),
          gates: [],
          ...(role === 'resolve' ? { mergeOutcome: 'conflicts' as const } : {}),
        });
      }
    }
    syncParkBriefings(s.db, s.zone, s.now());
    expect(getWorkItem(s.db, 1)).toMatchObject({ reason: 'budget exhausted: resolve' });
    expect(reviewDisagreement(s.db, getWorkItem(s.db, 1) as never)).toBe(false);
    expect(nextCrewWork(s.db, s.zone, s.now(), true)).toMatchObject({ role: 'diagnose' });
  });

  test('reviewDisagreement is false for a closed PR and for an item whose arbitration is spent', async () => {
    const h = await parked();
    const pr = getPullRequest(h.db, 1);
    upsertPullRequest(h.db, { ...(pr as never), state: 'closed' }, h.now());
    expect(reviewDisagreement(h.db, getWorkItem(h.db, 1) as never)).toBe(false);
    expect(nextCrewWork(h.db, h.zone, h.now(), true)).toMatchObject({ role: 'diagnose' });

    const s = await parked();
    expect(await enqueueOn(s)).not.toBeNull();
    expect(reviewDisagreement(s.db, getWorkItem(s.db, 1) as never)).toBe(false);
  });

  test('D3: two enqueues in one pass, or two passes before the drop finishes → one arbitration, one drop', async () => {
    const h = await parked();
    const ids = await Promise.all([enqueueOn(h), enqueueOn(h)]);
    expect(ids.filter((x) => x !== null)).toHaveLength(1);
    expect(await enqueueOn(h)).toBeNull();
    expect(rows(h)).toHaveLength(1);
    expect(crewDrops(h, 'arbitrate')).toHaveLength(1);
    // Even with the crew drop index out of the way, the item is not arbitrated twice.
    for (const id of crewDrops(h, 'arbitrate')) updateDrop(h.db, id, { state: 'running' });
    expect(nextCrewWork(h.db, h.zone, h.now(), true)).toEqual({ role: 'crew-lead' });
  });

  test('an arbitrate drop lost without a result fails closed: the item stays parked, briefed, undiagnosed', async () => {
    const h = await parked();
    const id = (await enqueueOn(h)) ?? '';
    updateDrop(h.db, id, { state: 'lost' });
    expect(nextCrewWork(h.db, h.zone, h.now(), true)).toEqual({ role: 'crew-lead' });
    expect(rows(h)).toMatchObject([{ state: 'failed' }]);
    expect(parkedBriefing(h)).toMatchObject({
      diagnoseAttempts: 1,
      diagnosis: 'The arbiter could not rule: the arbitrate drop ended without a ruling.',
      recommendation: 'needs_command: the arbitrate drop ended without a ruling',
    });
    expect(getWorkItem(h.db, 1)?.state).toBe('parked');
  });

  test('#61 parks again after its arbitration was applied → diagnose and the owner, no second arbitration', async () => {
    const h = await parked();
    await h.reconcile(); // queues the arbitrate drop
    const { dropId, epoch, payload } = await h.lease();
    expect(payload.role).toBe('arbitrate');
    await h.postResult(dropId, epoch, { status: 'completed', gates: [], crew: ruling('B') });
    await h.reconcile(); // applies the ruling: the item is retried and its head reviewed afresh
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
    await reviewRounds(h, () => 'request_changes');
    syncParkBriefings(h.db, h.zone, h.now());
    expect(getWorkItem(h.db, 1)).toMatchObject({
      state: 'parked',
      reason: 'budget exhausted: heal',
    });
    expect(reviewDisagreement(h.db, getWorkItem(h.db, 1) as never)).toBe(false);
    expect(nextCrewWork(h.db, h.zone, h.now(), true)).toMatchObject({
      role: 'diagnose',
      itemId: 1,
    });
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['diagnose']);
    expect(crewDrops(h, 'arbitrate')).toHaveLength(1);
  });
});

describe('diagnose and the daily crew cap (#397)', () => {
  const capped = () => ({ ...w.zone, crew: { ...crewOn, maxDropsPerDay: 1, cycleMinutes: 1 } });
  const roles = () =>
    (w.db.prepare('SELECT role FROM drops').all() as { role: string }[]).map((r) => r.role);
  /** Uses the day's one crew drop on a lead cycle. */
  async function atCap(): Promise<void> {
    const lead = (await enqueue(t0, capped())) ?? '';
    expect(work(lead).role).toBe('crew-lead');
    finish(lead);
    expect(crewDropsToday(w.db, 'main', plus(t0, MIN))).toBe(1);
  }

  test('at maxDropsPerDay a parked briefing is still diagnosed; no other crew work is queued', async () => {
    await atCap();
    stagedIssue(); // refute work waiting
    parkedItem();
    const d = (await enqueue(plus(t0, 2 * MIN), capped())) ?? '';
    expect(work(d).role).toBe('diagnose');
    // Still one active crew drop at a time.
    expect(await enqueue(plus(t0, 3 * MIN), capped())).toBeNull();
    finish(d);
    expect(await enqueue(plus(t0, 4 * MIN), capped())).toBeNull();
    expect(roles().filter((r) => r === 'refute')).toEqual([]);
  });

  test('at the cap with no parked briefing nothing is queued, and an exhausted issue is not put to Command', async () => {
    await atCap();
    const issue = stagedIssue();
    setCrewIssue(w.db, issue, { refuteCount: 2 }, t0);
    expect(await enqueue(plus(t0, 2 * MIN), capped())).toBeNull();
    expect(listBriefings(w.db, { zoneId: 'main', state: 'open' })).toEqual([]);
  });

  test('the kill switch and observe mode still hold a diagnose at the cap', async () => {
    await atCap();
    parkedItem();
    setKilled(w.db, true, t0);
    expect(await enqueue(plus(t0, 2 * MIN), capped())).toBeNull();
    setKilled(w.db, false, t0);
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(await enqueue(plus(t0, 3 * MIN), capped())).toBeNull();
    expect(roles().filter((r) => r === 'diagnose')).toEqual([]);
  });

  test('diagnose drops do not count toward the cap', async () => {
    parkedItem();
    const d = (await enqueue(t0, capped())) ?? '';
    expect(work(d).role).toBe('diagnose');
    finish(d);
    expect(crewDropsToday(w.db, 'main', plus(t0, MIN))).toBe(0);
    const lead = (await enqueue(plus(t0, MIN), capped())) ?? '';
    expect(work(lead).role).toBe('crew-lead');
    expect(crewDropsToday(w.db, 'main', plus(t0, 2 * MIN))).toBe(1);
  });
});
