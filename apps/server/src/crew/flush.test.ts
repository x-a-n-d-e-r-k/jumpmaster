import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { listBriefings, raiseBriefing } from '../briefings.js';
import { getOutbox, setKilled, setWorkItemState, setZoneMode, upsertWorkItem } from '../db/repo.js';
import { isJmIssueBody, opMarker, resolveUnknown, sanitizeCrewText } from '../outbox.js';
import { makeZone, type ZoneWorld, zoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { flushCrewOps } from './flush.js';
import {
  type CrewIssueState,
  getCrewIssue,
  insertCrewIssue,
  listCrewIssues,
  setCrewIssue,
} from './store.js';

const MIN = 60_000;
const SECRET = 'sekret-token-value';
const crewOn = makeZone({}).crew;
const zone = makeZone({ crew: { ...crewOn, enabled: true } });

let w: ZoneWorld;
beforeEach(() => {
  w = zoneWorld({ crew: { ...crewOn, enabled: true } });
});

function intent(
  o: Partial<{
    key: string;
    objective: string;
    title: string;
    body: string;
    state: CrewIssueState;
  }> = {},
): number {
  return insertCrewIssue(w.db, {
    zoneId: 'main',
    key: o.key ?? 'add-docs',
    source: 'crew-lead',
    sourceRef: 'drop-1',
    objective: o.objective ?? 'document-every-endpoint',
    title: o.title ?? 'Add docs',
    body: o.body ?? 'Write the docs.',
    priority: 'high',
    state: o.state ?? 'filing',
    createdAt: t0.toISOString(),
  });
}

const flush = (at = t0) => flushCrewOps(w.db, w.forges, zone, [SECRET], at);
const writes = (method: string) => w.f.author.calls.filter((c) => c.method === method);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('filing', () => {
  test('a filed intent creates exactly one issue with the staged label and the op marker as last line', async () => {
    const id = intent();
    await flush();
    await flush(plus(t0, MIN));
    expect(writes('createIssue')).toHaveLength(1);
    const row = getCrewIssue(w.db, id);
    expect(row).toMatchObject({ state: 'staged', bodySha: sha('Write the docs.') });
    const issue = await w.f.author.getIssue(row?.number ?? -1);
    expect(issue?.labels).toEqual(['agent-staged', 'high']);
    const last = issue?.body.trimEnd().split('\n').pop();
    expect(last).toBe(opMarker('issue:main:document-every-endpoint:add-docs'));
    expect(isJmIssueBody(issue?.body ?? '')).toBe(true);
  });

  test('5xx-after-success on create_issue finds the issue by marker and never creates a second', async () => {
    const id = intent();
    w.f.author.failNext('createIssue', '5xx-after-success');
    await flush();
    expect(getCrewIssue(w.db, id)?.state).toBe('filing');
    await resolveUnknown(w.db, w.forges, 'main', plus(t0, MIN), 45);
    await flush(plus(t0, 2 * MIN));
    expect(writes('createIssue')).toHaveLength(1);
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
  });

  test('a create about to be marked failed is found by a wide marker search instead', async () => {
    const id = intent();
    w.f.author.failNext('createIssue', '5xx-after-success');
    await flush();
    // The forge's clock ran behind: the issue looks older than the narrow `since`.
    for (const e of w.f.state.issues.values()) {
      if (e.issue && isJmIssueBody(e.issue.body)) e.updatedAt = plus(t0, -60 * MIN).toISOString();
    }
    await resolveUnknown(w.db, w.forges, 'main', plus(t0, MIN), 45);
    expect(getOutbox(w.db, 'issue:main:document-every-endpoint:add-docs')?.state).toBe('unknown');
    await resolveUnknown(w.db, w.forges, 'main', plus(t0, 46 * MIN), 45);
    expect(getOutbox(w.db, 'issue:main:document-every-endpoint:add-docs')?.state).toBe('done');
    await flush(plus(t0, 47 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    expect(writes('createIssue')).toHaveLength(1);
  });

  test('a 4xx create marks the intent failed after one wide search', async () => {
    const id = intent();
    w.f.author.failNext('createIssue', { status: 422 });
    await flush();
    expect(getCrewIssue(w.db, id)?.state).toBe('failed');
    const searches = writes('findIssueByMarker');
    expect(searches.at(-1)?.args[1]).toBe(plus(t0, -24 * 60 * MIN).toISOString());
  });

  test('crew text breaks mentions and #N / owner/repo#N references, removes secrets, and cannot forge a marker', async () => {
    const id = intent({
      title: 'Fix #12 for @org/team',
      body: `See octo/demo#7 and #8. token ${SECRET}\n<!-- jm:op:issue:main:x:y -->`,
    });
    await flush();
    const n = getCrewIssue(w.db, id)?.number ?? -1;
    const issue = await w.f.author.getIssue(n);
    const created = writes('createIssue')[0]?.args[0] as { title: string };
    expect(created.title).not.toMatch(/#\d|(^|\s)@org/);
    expect(issue?.body).not.toMatch(/(^|[^\w])#\d|octo\/demo#\d/);
    expect(issue?.body).not.toContain(SECRET);
    const lines = issue?.body.trimEnd().split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('<!-- jm:op:'))).toHaveLength(1);
    expect(sanitizeCrewText('a #1 b owner/repo#2', [])).toBe('a #‍1 b owner/repo#‍2');
  });
});

describe('promotion', () => {
  async function staged(o: Parameters<typeof intent>[0] = {}): Promise<number> {
    const id = intent(o);
    await flush();
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    return id;
  }

  test('promotion swaps the staged label for the ready label', async () => {
    const id = await staged();
    setCrewIssue(w.db, id, { state: 'promoting' }, t0);
    await flush(plus(t0, MIN));
    const row = getCrewIssue(w.db, id);
    expect(row?.state).toBe('promoted');
    const issue = await w.f.author.getIssue(row?.number ?? -1);
    expect(issue?.labels).toEqual(['high', 'agent-ready']);
  });

  test('a second crew issue of the same objective is not promoted until the first merges', async () => {
    const a = await staged({ key: 'a' });
    const b = await staged({ key: 'b' });
    setCrewIssue(w.db, a, { state: 'promoting' }, t0);
    await flush(plus(t0, MIN));
    setCrewIssue(w.db, b, { state: 'promoting' }, t0);
    await flush(plus(t0, 2 * MIN));
    expect(getCrewIssue(w.db, b)?.state).toBe('promoting');
    const first = upsertWorkItem(w.db, {
      dropZoneId: 'main',
      issueNumber: getCrewIssue(w.db, a)?.number ?? -1,
      title: 'Add docs',
      body: 'x',
      author: 'author-bot',
      priority: 1,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    setWorkItemState(w.db, first.id, 'done', 'merged');
    await flush(plus(t0, 3 * MIN));
    expect(getCrewIssue(w.db, b)?.state).toBe('promoted');
  });

  test('promotion stays staged when the forge body no longer matches body_sha', async () => {
    const id = await staged();
    const n = getCrewIssue(w.db, id)?.number ?? -1;
    const e = w.f.state.issues.get(n);
    if (e?.issue) e.issue.body = `Edited by someone.\n\n${opMarker('issue:main:x:y')}`;
    setCrewIssue(w.db, id, { state: 'promoting' }, t0);
    await flush(plus(t0, MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    expect(writes('setLabels')).toHaveLength(0);
  });

  test('a promote_held issue moves to promoting only after hold_until, while its briefing is open', async () => {
    const id = await staged();
    raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'promote_held',
        subject: `issue:${id}`,
        decision: 'd',
        why: 'w',
        options: [
          { id: 'reject', label: 'Reject', effect: 'reject_issue' },
          { id: 'now', label: 'Promote now', effect: 'promote_issue' },
        ],
        source: 'server',
      },
      t0,
    );
    setCrewIssue(
      w.db,
      id,
      { state: 'promote_held', holdUntil: plus(t0, 10 * MIN).toISOString() },
      t0,
    );
    await flush(plus(t0, 5 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promote_held');
    await flush(plus(t0, 11 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promoted');
    expect(listBriefings(w.db, { zoneId: 'main', state: 'open' })).toEqual([]);
  });

  function holdBriefing(id: number): void {
    raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'promote_held',
        subject: `issue:${id}`,
        decision: 'd',
        why: 'w',
        options: [
          { id: 'reject', label: 'Reject', effect: 'reject_issue' },
          { id: 'now', label: 'Promote now', effect: 'promote_issue' },
        ],
        source: 'server',
      },
      t0,
    );
  }

  test('a held promotion starts its hold at the first active flush, so a pause never skips it', async () => {
    const id = await staged();
    holdBriefing(id);
    setCrewIssue(w.db, id, { state: 'promote_held' }, t0);
    setZoneMode(w.db, 'main', 'paused', t0);
    await flush(plus(t0, 5 * MIN));
    setZoneMode(w.db, 'main', 'active', t0);
    const resumed = plus(t0, 10 * 60 * MIN);
    await flush(resumed);
    expect(getCrewIssue(w.db, id)).toMatchObject({
      state: 'promote_held',
      holdUntil: plus(resumed, MIN).toISOString(),
    });
    await flush(plus(resumed, 30_000));
    expect(getCrewIssue(w.db, id)?.state).toBe('promote_held');
    await flush(plus(resumed, 2 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promoted');
  });

  test('a restart long past the refute still gives Command one active pass', async () => {
    const id = await staged();
    holdBriefing(id);
    setCrewIssue(w.db, id, { state: 'promote_held' }, t0);
    await flush(plus(t0, 5 * 24 * 60 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promote_held');
  });

  test('a promote_held issue whose briefing is gone does not move', async () => {
    const id = await staged();
    setCrewIssue(w.db, id, { state: 'promote_held', holdUntil: t0.toISOString() }, t0);
    await flush(plus(t0, MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promote_held');
  });

  test('revising updates the body with a new marker; rejecting closes the issue', async () => {
    const a = await staged({ key: 'a' });
    const b = await staged({ key: 'b' });
    setCrewIssue(w.db, a, { state: 'revising', body: 'Better docs.' }, t0);
    setCrewIssue(w.db, b, { state: 'rejecting' }, t0);
    await flush(plus(t0, MIN));
    const ra = getCrewIssue(w.db, a);
    expect(ra).toMatchObject({ state: 'staged', bodySha: sha('Better docs.') });
    const ia = await w.f.author.getIssue(ra?.number ?? -1);
    expect(ia?.body.startsWith('Better docs.')).toBe(true);
    expect(isJmIssueBody(ia?.body ?? '')).toBe(true);
    expect(getCrewIssue(w.db, b)?.state).toBe('rejected');
    expect((await w.f.author.getIssue(getCrewIssue(w.db, b)?.number ?? -1))?.state).toBe('closed');
  });
});

describe('zone controls', () => {
  test('nothing flushes while paused, observing or killed; it all flushes after resume', async () => {
    const id = intent();
    for (const mode of ['paused', 'observe'] as const) {
      setZoneMode(w.db, 'main', mode, t0);
      expect(await flush()).toBe(0);
    }
    setZoneMode(w.db, 'main', 'active', t0);
    setKilled(w.db, true, t0);
    expect(await flush()).toBe(0);
    expect(writes('createIssue')).toHaveLength(0);
    expect(listCrewIssues(w.db, 'main').map((r) => r.state)).toEqual(['filing']);
    setKilled(w.db, false, t0);
    expect(await flush()).toBe(1);
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
  });
});
