import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  listBriefings,
  listRulings,
  raiseBriefing,
  ruleBriefing,
} from '../briefings.js';
import {
  getOutbox,
  listWorkItems,
  setKilled,
  setWorkItemState,
  setZoneMode,
  upsertWorkItem,
} from '../db/repo.js';
import { reconcileZone } from '../flow/reconcile.js';
import { zonePass } from '../flow/snapshot.js';
import { isJmIssueBody, opMarker, resolveUnknown, sanitizeCrewText } from '../outbox.js';
import { promptVersions } from '../payloads.js';
import { syncDropZone } from '../sync.js';
import { makeZone, usageCfg, type ZoneWorld, zoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { flushCrewOps, PROMOTE_OPTIONS } from './flush.js';
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

test('crew text breaks GH-N references in any case', () => {
  const out = sanitizeCrewText('see GH-12, gh-3 and Gh-4 but not GH-x', []);
  expect(out).not.toMatch(/gh-\d/i);
  expect(out).toContain('GH-x');
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

  test('a body-changed briefing offers Re-stage and Reject; Re-stage takes the edited text for a fresh refute', async () => {
    const id = await staged();
    setCrewIssue(w.db, id, { refuteCount: 2, refutedSha: getCrewIssue(w.db, id)?.bodySha }, t0);
    const n = getCrewIssue(w.db, id)?.number ?? -1;
    const e = w.f.state.issues.get(n);
    if (e?.issue) e.issue.body = `Edited by someone.\n\n${opMarker('issue:main:x:y')}`;
    setCrewIssue(w.db, id, { state: 'promoting' }, t0);
    await flush(plus(t0, MIN));
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b?.options.map((o) => [o.label, o.effect])).toEqual([
      ['Re-stage', 'restage_issue'],
      ['Reject', 'reject_issue'],
    ]);
    ruleBriefing(w.db, b?.id ?? -1, 'restage', '', plus(t0, 2 * MIN));
    expect(await applyPendingRulings(w.db, rulingDeps(), 'main', plus(t0, 2 * MIN))).toBe(1);
    expect(getCrewIssue(w.db, id)).toMatchObject({
      state: 'staged',
      body: 'Edited by someone.',
      bodySha: sha('Edited by someone.'),
      refutedSha: null,
      refuteCount: 0,
    });
  });

  test('a body that differs only by CRLF line endings still promotes', async () => {
    const id = await staged({ body: 'Line one.\nLine two.\n\n- [ ] done' });
    const n = getCrewIssue(w.db, id)?.number ?? -1;
    const e = w.f.state.issues.get(n);
    if (e?.issue) e.issue.body = e.issue.body.replace(/\n/g, '\r\n');
    setCrewIssue(w.db, id, { state: 'promoting' }, t0);
    await flush(plus(t0, MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promoted');
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

  const rulingDeps = () => ({ forges: () => w.forges, zone: () => zone });

  function promoteBriefing(id: number): number {
    return raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'promote',
        subject: `issue:${id}`,
        decision: 'd',
        why: 'w',
        options: [
          { id: 'promote', label: 'Promote', effect: 'promote_issue' },
          { id: 'reject', label: 'Reject', effect: 'reject_issue' },
        ],
        source: 'server',
      },
      t0,
    );
  }

  test('a Reject applied while the promote write is in flight wins over the promotion', async () => {
    const id = await staged();
    const b = promoteBriefing(id);
    setCrewIssue(w.db, id, { state: 'promoting' }, t0);
    const author = w.forges.author;
    const setLabels = author.setLabels.bind(author);
    author.setLabels = async (...args: Parameters<typeof setLabels>) => {
      ruleBriefing(w.db, b, 'reject', '', t0);
      await applyPendingRulings(w.db, rulingDeps(), 'main', t0);
      return setLabels(...args);
    };
    await flush(plus(t0, MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('rejecting');
    author.setLabels = setLabels;
    await flush(plus(t0, 2 * MIN));
    const row = getCrewIssue(w.db, id);
    expect(row?.state).toBe('rejected');
    expect((await w.f.author.getIssue(row?.number ?? -1))?.state).toBe('closed');
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ applyError: null });
  });

  test('a Reject on a promoted issue whose work has not started rejects it and drops the item', async () => {
    const id = await staged();
    const b = promoteBriefing(id);
    setCrewIssue(w.db, id, { state: 'promoted' }, t0);
    const n = getCrewIssue(w.db, id)?.number ?? -1;
    const item = upsertWorkItem(w.db, {
      dropZoneId: 'main',
      issueNumber: n,
      title: 't',
      body: 'b',
      author: 'author-bot',
      priority: 2,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    ruleBriefing(w.db, b, 'reject', '', t0);
    expect(await applyPendingRulings(w.db, rulingDeps(), 'main', t0)).toBe(1);
    expect(getCrewIssue(w.db, id)?.state).toBe('rejecting');
    expect(w.db.prepare('SELECT state, reason FROM work_items WHERE id = ?').get(item.id)).toEqual({
      state: 'done',
      reason: 'rejected by Command',
    });
  });

  test('a Reject on a promoted issue whose work started records apply_error', async () => {
    const id = await staged();
    const b = promoteBriefing(id);
    setCrewIssue(w.db, id, { state: 'promoted' }, t0);
    const item = upsertWorkItem(w.db, {
      dropZoneId: 'main',
      issueNumber: getCrewIssue(w.db, id)?.number ?? -1,
      title: 't',
      body: 'b',
      author: 'author-bot',
      priority: 2,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    setWorkItemState(w.db, item.id, 'in_flight', undefined, t0);
    ruleBriefing(w.db, b, 'reject', '', t0);
    await applyPendingRulings(w.db, rulingDeps(), 'main', t0);
    expect(getCrewIssue(w.db, id)?.state).toBe('promoted');
    expect(listRulings(w.db, 'main')[0]?.applyError).toBe('already started');
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

describe('crew disabled', () => {
  const off = makeZone({ crew: { ...crewOn, enabled: false } });
  const flushOff = (at = t0) => flushCrewOps(w.db, w.forges, off, [SECRET], at);
  const depsOff = () => ({ forges: () => w.forges, zone: () => off });
  const depsOn = () => ({ forges: () => w.forges, zone: () => zone });
  const outboxRows = () =>
    (w.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;

  async function staged(key = 'add-docs'): Promise<number> {
    const id = intent({ key });
    await flush();
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    return id;
  }

  function briefingFor(id: number, kind: 'promote' | 'promote_held'): number {
    return raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind,
        subject: `issue:${id}`,
        decision: 'd',
        why: 'w',
        options: [
          { id: 'promote', label: 'Promote', effect: 'promote_issue' },
          { id: 'reject', label: 'Reject', effect: 'reject_issue' },
          { id: 'restage', label: 'Re-stage', effect: 'restage_issue' },
        ],
        source: 'server',
      },
      t0,
    );
  }

  test('a promoting issue stays promoting and nothing is written', async () => {
    const id = await staged();
    setCrewIssue(w.db, id, { state: 'promoting' }, t0);
    const before = outboxRows();
    expect(await flushOff(plus(t0, MIN))).toBe(0);
    expect(getCrewIssue(w.db, id)?.state).toBe('promoting');
    expect(outboxRows()).toBe(before);
    expect(writes('setLabels')).toHaveLength(0);
  });

  test('an MCP-filed intent is filed staged with the crew off, and is still not started', async () => {
    const id = insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'mcp-docs',
      source: 'mcp',
      sourceRef: 'token-1',
      objective: 'document-every-endpoint',
      title: 'Add docs',
      body: 'Write the docs.',
      priority: null,
      createdAt: t0.toISOString(),
    });
    expect(await flushOff()).toBe(1);
    const row = getCrewIssue(w.db, id);
    expect(row?.state).toBe('staged');
    const created = writes('createIssue');
    expect(created).toHaveLength(1);
    expect((created[0]?.args[0] as { labels: string[] }).labels).toEqual([off.crew.stagedLabel]);
    // Staged, not ready: the next sync starts nothing.
    await syncDropZone(w.db, w.forges, off, t0);
    expect(listWorkItems(w.db, 'main').filter((i) => i.issueNumber === row?.number)).toEqual([]);
  });

  /** An assistant's (MCP) proposal, waiting to be filed. */
  const mcpIntent = (key = 'mcp-docs') =>
    insertCrewIssue(w.db, {
      zoneId: 'main',
      key,
      source: 'mcp',
      sourceRef: 'token-1',
      objective: 'document-every-endpoint',
      title: `Add docs ${key}`,
      body: 'Write the docs.',
      priority: null,
      createdAt: t0.toISOString(),
    });
  const briefingsOn = (id: number) =>
    listBriefings(w.db).filter((b) => b.subject === `issue:${id}`);

  test('crew off: filed → server Promote briefing → Promote → ready label → the issue starts', async () => {
    const id = mcpIntent();
    await flushOff();
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    const [b] = briefingsOn(id);
    expect(b).toMatchObject({ kind: 'promote', source: 'server', state: 'open' });
    expect(b?.options.map((o) => [o.id, o.effect])).toEqual(
      PROMOTE_OPTIONS.map((o) => [o.id, o.effect]),
    );
    expect(ruleBriefing(w.db, b?.id ?? -1, 'promote', '', t0).ok).toBe(true);
    expect(await applyPendingRulings(w.db, depsOff(), 'main', plus(t0, MIN))).toBe(1);
    expect(getCrewIssue(w.db, id)?.state).toBe('promoting');
    await flushOff(plus(t0, 2 * MIN));
    const row = getCrewIssue(w.db, id);
    expect(row?.state).toBe('promoted');
    const labels = w.f.state.issues.get(row?.number ?? -1)?.labels;
    expect(labels).toContain(off.readyLabel);
    expect(labels).not.toContain(off.crew.stagedLabel);
    // Eligible to start: the next sync admits it as a ready work item.
    await syncDropZone(w.db, w.forges, off, plus(t0, 3 * MIN));
    expect(listWorkItems(w.db, 'main').find((i) => i.issueNumber === row?.number)?.state).toBe(
      'ready',
    );
  });

  test('crew off: a second flush, or a restart, raises no second briefing', async () => {
    const id = mcpIntent();
    await flushOff();
    await flushOff(plus(t0, MIN));
    expect(briefingsOn(id)).toHaveLength(1);
    // Ruled and closed: still never raised again.
    const [b] = briefingsOn(id);
    ruleBriefing(w.db, b?.id ?? -1, 'reject', '', t0);
    await applyPendingRulings(w.db, depsOff(), 'main', plus(t0, 2 * MIN));
    await flushOff(plus(t0, 3 * MIN));
    await flushOff(plus(t0, 4 * MIN));
    expect(briefingsOn(id)).toHaveLength(1);
    expect(getCrewIssue(w.db, id)?.state).toBe('rejected');
  });

  test('crew off: a crew-drop staged issue gets no server briefing', async () => {
    const id = await staged();
    await flushOff(plus(t0, MIN));
    expect(briefingsOn(id)).toEqual([]);
  });

  test('crew on: an MCP filing gets no server briefing; the refute owns promotion', async () => {
    const id = mcpIntent();
    await flush();
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    expect(briefingsOn(id)).toEqual([]);
  });

  test('a filing intent is not filed, and revising waits too', async () => {
    const r = await staged('other');
    const id = intent();
    setCrewIssue(w.db, r, { state: 'revising', body: 'Better docs.' }, t0);
    const updates = writes('updateIssue').length;
    expect(await flushOff()).toBe(0);
    expect(getCrewIssue(w.db, id)?.state).toBe('filing');
    expect(getCrewIssue(w.db, r)?.state).toBe('revising');
    expect(writes('createIssue')).toHaveLength(1); // only `other`, filed while the crew was on
    expect(writes('updateIssue')).toHaveLength(updates);
  });

  test('a Promote ruling is recorded but applies only once the crew is enabled again', async () => {
    const id = await staged();
    const b = briefingFor(id, 'promote');
    expect(ruleBriefing(w.db, b, 'promote', '', t0).ok).toBe(true);
    expect(await applyPendingRulings(w.db, depsOff(), 'main', plus(t0, MIN))).toBe(0);
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ appliedAt: null, applyError: null });
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    expect(await applyPendingRulings(w.db, depsOn(), 'main', plus(t0, 2 * MIN))).toBe(1);
    expect(getCrewIssue(w.db, id)?.state).toBe('promoting');
    await flush(plus(t0, 3 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promoted');
  });

  test('a Re-stage ruling waits for the crew too', async () => {
    const id = await staged();
    const b = briefingFor(id, 'promote');
    ruleBriefing(w.db, b, 'restage', '', t0);
    const reads = writes('getIssue').length;
    expect(await applyPendingRulings(w.db, depsOff(), 'main', plus(t0, MIN))).toBe(0);
    expect(writes('getIssue')).toHaveLength(reads);
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ appliedAt: null, applyError: null });
  });

  test('a Reject applies with the crew off: a promoted issue never starts', async () => {
    const id = await staged();
    const b = briefingFor(id, 'promote');
    setCrewIssue(w.db, id, { state: 'promoted' }, t0);
    const item = upsertWorkItem(w.db, {
      dropZoneId: 'main',
      issueNumber: getCrewIssue(w.db, id)?.number ?? -1,
      title: 't',
      body: 'b',
      author: 'author-bot',
      priority: 2,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    ruleBriefing(w.db, b, 'reject', '', t0);
    await reconcileZone(
      w.db,
      w.forges,
      off,
      await zonePass(w.forges, off, 'main'),
      promptVersions(),
      usageCfg,
      [],
      plus(t0, MIN),
    );
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ applyError: null });
    expect(listRulings(w.db, 'main')[0]?.appliedAt).not.toBeNull();
    // Command's Reject is the one forge write the disabled crew still makes: the issue closes.
    const row = getCrewIssue(w.db, id);
    expect(row?.state).toBe('rejected');
    expect((await w.f.author.getIssue(row?.number ?? -1))?.state).toBe('closed');
    expect(w.db.prepare('SELECT state FROM work_items WHERE id = ?').get(item.id)).toEqual({
      state: 'done',
    });
    expect(
      w.db.prepare('SELECT COUNT(*) AS n FROM drops WHERE work_item_id = ?').get(item.id),
    ).toEqual({ n: 0 });
  });

  test('a refute rejection landing while disabled closes nothing until the crew is enabled', async () => {
    const id = await staged();
    // What applyRefute records for a refute `reject` verdict: no ruling by Command.
    setCrewIssue(w.db, id, { state: 'rejecting' }, t0);
    const n = getCrewIssue(w.db, id)?.number ?? -1;
    const closes = () => writes('updateIssue').length;
    const before = closes();
    await flushOff(plus(t0, MIN));
    await flushOff(plus(t0, 2 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('rejecting');
    expect(closes()).toBe(before);
    expect((await w.f.author.getIssue(n))?.state).toBe('open');
    await flush(plus(t0, 3 * MIN));
    await flush(plus(t0, 4 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('rejected');
    expect((await w.f.author.getIssue(n))?.state).toBe('closed');
    expect(closes()).toBe(before + 1);
  });

  test('a Retry on a parked item applies with the crew off', async () => {
    const item = w.item(5, 'ready');
    setWorkItemState(w.db, item, 'parked', 'stuck', t0);
    const b = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'parked',
        subject: `item:${item}`,
        decision: 'd',
        why: 'stuck',
        options: [{ id: 'retry', label: 'Retry', effect: 'retry_item' }],
        source: 'server',
      },
      t0,
    );
    ruleBriefing(w.db, b, 'retry', '', t0);
    expect(await applyPendingRulings(w.db, depsOff(), 'main', plus(t0, MIN))).toBe(1);
    expect(w.db.prepare('SELECT state FROM work_items WHERE id = ?').get(item)).not.toEqual({
      state: 'parked',
    });
  });

  test('an expired refute hold does not promote while disabled; it does once enabled', async () => {
    const id = await staged();
    briefingFor(id, 'promote_held');
    setCrewIssue(w.db, id, { state: 'promote_held', holdUntil: t0.toISOString() }, t0);
    await flushOff(plus(t0, 10 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promote_held');
    expect(writes('setLabels')).toHaveLength(0);
    await flush(plus(t0, 11 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('promoted');
  });

  test('a filed row whose number was never recorded learns it on a disabled pass', async () => {
    const id = intent();
    w.f.author.failNext('createIssue', '5xx-after-success');
    await flush();
    await resolveUnknown(w.db, w.forges, 'main', plus(t0, MIN), 45);
    const n = getCrewIssue(w.db, id)?.number;
    expect(n).toEqual(expect.any(Number));
    // As a database from before the number was recorded at resolution would have it.
    w.db.prepare('UPDATE crew_issues SET number = NULL WHERE id = ?').run(id);
    await flushOff(plus(t0, 2 * MIN));
    expect(getCrewIssue(w.db, id)).toMatchObject({ state: 'filing', number: n });
    expect(writes('createIssue')).toHaveLength(1);
  });

  test('a filing whose create resolves while disabled gets its one issue after re-enable', async () => {
    const id = intent();
    w.f.author.failNext('createIssue', '5xx-after-success');
    await flush();
    expect(getCrewIssue(w.db, id)?.state).toBe('filing');
    await resolveUnknown(w.db, w.forges, 'main', plus(t0, MIN), 45);
    await flushOff(plus(t0, 2 * MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('filing');
    await flush(plus(t0, 3 * MIN));
    expect(getCrewIssue(w.db, id)).toMatchObject({ state: 'staged', number: expect.any(Number) });
    expect(writes('createIssue')).toHaveLength(1);
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
