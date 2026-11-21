import { describe, expect, test } from 'vitest';
import {
  type Briefing,
  briefingAbout,
  crewKeyNumbers,
  EFFECT_TEXT,
  EFFECTS,
  effectText,
  MAX_FINDING,
  REFUTE_RECOMMENDATION,
  type Ruling,
  raiseBriefing,
  refuteExhaustedWhy,
} from '../briefings.js';
import type { ClaudePlan, DropZoneConfig } from '../config.js';
import { STARTER_WARNING } from '../config.js';
import { type CrewIssue, getCrewIssue, insertCrewIssue, setCrewIssue } from '../crew/store.js';
import type { Drop, StoredEvent, UsageWindowRow, WorkItem } from '../db/repo.js';
import { insertDrop, updateDrop } from '../db/repo.js';
import type { GoalRow } from '../goals.js';
import { forgetSubmitKey, submitKey } from '../intake.js';
import { statusOf } from '../status.js';
import { makeZone, zoneWorld } from '../test/fixtures.js';
import { harness } from '../test/flowHarness.js';
import {
  askButton,
  DROP_HEAD,
  dropRows,
  escapeHtml,
  FAVICON_HREF,
  linkify,
  MARK,
  modelFamily,
  page,
  pageParams,
  renderBriefing,
  renderBriefings,
  renderDoctor,
  renderDrop,
  renderDropList,
  renderGoals,
  renderHome,
  renderIntake,
  renderNewIssue,
  renderObservations,
  renderWorkItem,
  renderWorkList,
  statusBanner,
  waitingOnYou,
  workItemRows,
} from './pages.js';
import { zoneTextNamer } from './zone-name.js';

const z: DropZoneConfig = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img',
  model: 'm',
  maxTurns: 200,
};
const item: WorkItem = {
  id: 1,
  dropZoneId: 'main',
  issueNumber: 7,
  title: 'plain',
  body: 'b',
  author: 'a',
  priority: 2,
  isFix: false,
  issueCreatedAt: '2026-01-01T00:00:00.000Z',
  state: 'pr_open',
  reason: null,
  prNumber: 9,
  retryLabelSeen: false,
  waitingSince: null,
  blockedBy: [],
};
const drop: Drop = {
  id: 'd1',
  dropZoneId: 'main',
  workItemId: 1,
  role: 'implement',
  state: 'succeeded',
  stickId: null,
  epoch: 1,
  leaseExpiresAt: null,
  promptVersion: null,
  image: null,
  resultJson: JSON.stringify({
    status: 'completed',
    gates: [{ name: 'lint<b>', exitCode: 0, durationMs: 1, timedOut: false, outputTail: '' }],
  }),
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:05.000Z',
};

describe('renderHome', () => {
  test('the home page shows each stick, and names a stick that cannot run a zone and why', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      sticks: [
        {
          id: 's1',
          name: 'old<stick>',
          version: null,
          lastSeenAt: '2026-01-01T00:00:00.000Z',
          capabilities: [],
          imagePolicy: 'allowlist',
          cannotRun: [{ zoneId: 'locked', missing: ['egress-v1', 'image-policy:signed'] }],
        },
        {
          id: 's2',
          name: 'new',
          version: '0.4.0',
          lastSeenAt: null,
          capabilities: ['egress-v1'],
          imagePolicy: 'signed',
          cannotRun: [],
        },
      ],
    });
    // Collapsed: the summary counts the live ones (none here) and those that can't run a zone.
    expect(html).toContain(
      '<details id="sticks" class="card sticks"><summary>Sticks: 0 live, 1 can&#39;t run a zone</summary>',
    );
    expect(html).toContain('old&lt;stick&gt;');
    expect(html).not.toContain('old<stick>');
    expect(html).toContain('cannot run locked: lacks egress-v1, image-policy:signed');
    expect(html).toMatch(
      /new<\/td><td>0\.4\.0<\/td><td>never<\/td><td>egress-v1<\/td><td>signed<\/td><td>all zones<\/td>/,
    );
    // No sticks known: the section says so rather than vanishing.
    expect(renderHome({ zones: [z], items: [], drops: [], sticks: [] })).toContain(
      'No stick has enrolled.',
    );
  });

  test("the Crew table links each zone's New issue page and its GOAL.md stub, the id encoded (#581)", () => {
    const id = 'a"<>&/b';
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      crew: [{ zoneId: id, enabled: true, lastCycle: null, nextDue: null, fable: 'available' }],
    });
    const enc = encodeURIComponent(id);
    expect(html).toContain(`<a href="/zones/${enc}/issues/new">New issue</a>`);
    expect(html).toContain(`<a href="/zones/${enc}/intake">GOAL.md stub</a>`);
    expect(html).not.toContain(`/intake">Intake</a>`);
    expect(html).not.toContain(id);
  });

  test('escapes issue titles', () => {
    const html = renderHome({
      zones: [z],
      items: [{ ...item, title: '<script>alert(1)</script>' }],
      drops: [{ ...drop, state: 'running', finishedAt: null }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('the issue cell links to GitHub; the title links to the work-item page (#498)', () => {
    const html = workItemRows(
      [{ ...item, issueNumber: 12, title: 'fix <b>it</b>' }],
      [{ ...z, repo: 'o/r' }],
    );
    expect(html).toContain('href="https://github.com/o/r/issues/12"');
    expect(html).toMatch(/<a href="https:\/\/github\.com\/o\/r\/issues\/12"[^>]*>#12<\/a>/);
    expect(html).toContain('<a href="/work/main/12">fix &lt;b&gt;it&lt;/b&gt;</a>');
    expect(html).not.toContain('/drops?zone=main');
    expect(html).not.toContain('<b>');
  });

  test('a blocked ready item shows what it waits on', () => {
    const html = workItemRows(
      [{ ...item, state: 'ready', prNumber: null, blockedBy: ['#4', 'o/x#<2>'] }],
      [z],
    );
    expect(html).toContain('waiting on #4, o/x#&lt;2&gt;');
  });

  test('the ledger rows escape reasons and gate names, and show the PR link and elapsed', () => {
    const items = [{ ...item, reason: '"><img src=x>' }];
    const html = workItemRows(items, [z]) + dropRows([drop], items, [z], new Date());
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('lint<b>');
    expect(html).toContain('lint&lt;b&gt;');
    expect(html).toContain('https://github.com/octo/demo/pull/9');
    expect(html).toContain('1m 5s');
  });
});

describe('renderWorkItem (#498)', () => {
  const now = new Date('2026-01-01T02:00:00.000Z');
  const evil = '<img src=x onerror=alert(1)>';

  test('a title with <img onerror> is escaped on /work and on the work-item page', () => {
    const items = [{ ...item, title: evil }];
    const list = renderWorkList({ zones: [z], state: 'active', items });
    const one = renderWorkItem({ item: items[0] as WorkItem, zones: [z], drops: [], now });
    for (const html of [list, one]) {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
  });

  test('the header: issue link, project, state, PR, head and verdict', () => {
    const html = renderWorkItem({
      item: { ...item, reason: 'needs <review>' },
      zones: [z],
      detail: {
        headSha: 'abcdef0123456789',
        verdict: { decision: 'approve', forced: true, summary: 'looks <ok>' },
        attempts: { implement: 2, diagnose: 1, resolve: 0 },
      },
      drops: [],
      now,
    });
    expect(html).toMatch(/<a href="https:\/\/github\.com\/octo\/demo\/issues\/7"[^>]*>#7<\/a>/);
    expect(html).toContain('<a href="/zones/main">octo/demo</a>');
    expect(html).toContain('<span class="badge crew">pr_open</span>');
    expect(html).toContain('needs &lt;review&gt;');
    expect(html).toMatch(/<a href="https:\/\/github\.com\/octo\/demo\/pull\/9"[^>]*>#9<\/a>/);
    expect(html).toContain('<code>abcdef0</code>');
    expect(html).not.toContain('abcdef01');
    expect(html).toContain('approve (forced)');
    expect(html).toContain('looks &lt;ok&gt;');
    expect(html).toContain('Attempt counts: implement 2, diagnose 1');
    expect(html).not.toContain('resolve 0');
    expect(html).toContain('No attempts yet.');
  });

  test('a drop with no resultJson shows - for gates, and never renders inputJson raw', () => {
    const html = renderWorkItem({
      item,
      zones: [z],
      drops: [
        {
          ...drop,
          id: 'abe46fc6-1234-4abc-8def-0123456789ab',
          resultJson: null,
          inputJson: '{"secret":"<b>raw</b>"}',
          prNumber: null,
        },
      ],
      now,
    });
    const row = html.match(/<tr class="attempt">.*?<\/tr>/)?.[0] ?? '';
    expect(row).toContain('<td>-</td>');
    expect(row).toContain('>abe46fc6</a>');
    expect(row).toContain('href="/drops/abe46fc6-1234-4abc-8def-0123456789ab"');
    expect(row).toContain('<time datetime="2026-01-01T00:00:00.000Z"');
    expect(row).toContain('1m 5s');
    expect(html).not.toContain('secret');
  });
});

describe('dropRows (#497)', () => {
  const uuid = 'abe46fc6-1234-4abc-8def-0123456789ab';
  const now = new Date('2026-01-01T02:00:00.000Z');

  test('the drop link shows the first 8 characters, the full id in title and href', () => {
    const html = dropRows([{ ...drop, id: uuid }], [item], [z], now);
    expect(html).toContain(`<a href="/drops/${uuid}" title="${uuid}">abe46fc6</a>`);
  });

  test('project and issue title show; a 70-character title is cut with …', () => {
    const long = `${'x'.repeat(59)}<${'y'.repeat(10)}`;
    expect(long).toHaveLength(70);
    const html = dropRows([drop], [{ ...item, title: long }], [z], now);
    expect(html).toContain('<td>octo/demo</td>');
    expect(html).toContain(`<td>#7 ${'x'.repeat(59)}&lt;…</td>`);
    expect(html).not.toContain('y');
    expect(dropRows([drop], [item], [z], now)).toContain('<td>#7 plain</td>');
  });

  test('a title cut never splits a surrogate pair', () => {
    const title = `${'x'.repeat(59)}\u{1F600}${'y'.repeat(10)}`;
    const html = dropRows([drop], [{ ...item, title }], [z], now);
    expect(html.isWellFormed()).toBe(true);
    expect(html).toContain(`<td>#7 ${'x'.repeat(59)}…</td>`);
  });

  test('an emoji ending exactly at the cut is kept whole', () => {
    const title = `${'x'.repeat(58)}\u{1F600}${'y'.repeat(10)}`;
    const html = dropRows([drop], [{ ...item, title }], [z], now);
    expect(html.isWellFormed()).toBe(true);
    expect(html).toContain(`<td>#7 ${'x'.repeat(58)}\u{1F600}…</td>`);
  });

  test('crew and doctor drops say so in the Work column', () => {
    const crew = dropRows([{ ...drop, workItemId: null, role: 'audit' }], [], [z], now);
    expect(crew).toContain('<td>crew</td>');
    const doc = dropRows([{ ...drop, workItemId: null, role: 'doctor' }], [], [z], now);
    expect(doc).toContain('<td>doctor</td>');
  });

  test('Started is a <time> of the start, or of the creation when not started', () => {
    const started = dropRows(
      [{ ...drop, createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T01:00:00.000Z' }],
      [item],
      [z],
      now,
    );
    expect(started).toContain('<time datetime="2026-01-01T01:00:00.000Z"');
    expect(started).toContain('1 h ago');
    const queued = dropRows(
      [{ ...drop, state: 'queued', startedAt: null, finishedAt: null }],
      [item],
      [z],
      now,
    );
    expect(queued).toContain('<time datetime="2026-01-01T00:00:00.000Z"');
  });

  test('the head names the columns in order', () => {
    expect(DROP_HEAD).toBe(
      '<tr><th>Drop</th><th>Project</th><th>Work</th><th>Role</th><th>State</th><th>Started</th><th>Elapsed</th><th>Gates</th></tr>',
    );
  });
});

describe('renderDrop', () => {
  test('escapes event data', () => {
    const html = renderDrop(drop, [
      { seq: 1, ts: 't', kind: 'log', data: { msg: '<script>x</script>' } },
    ]);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('the drop page lists denied hosts before allowed ones', () => {
    const ev = (seq: number, host: string, decision: string, count: number) => ({
      seq,
      ts: 't',
      kind: 'egress' as const,
      data: { host, decision, count },
    });
    const html = renderDrop(drop, [
      ev(1, 'registry.npmjs.org', 'allow', 40),
      ev(2, 'api.anthropic.com', 'allow', 3),
      ev(3, 'example.com', 'deny', 2),
      ev(4, 'cdn.example.net', 'unlisted', 5),
      ev(5, '<b>evil</b>.test', 'deny', 9),
      ev(6, 'example.com', 'deny', 1), // a second batch for the same host adds up
      { seq: 7, ts: 't', kind: 'log', data: { msg: 'x' } },
    ]);
    const section = html.slice(html.indexOf('<h3>Egress</h3>'));
    expect(section).toContain('<h3>Egress</h3>');
    const rows = [
      ...section.matchAll(/<tr class="egress"><td>([^<]*)<\/td><td>([^<]*)<\/td><td>(\d+)<\/td>/g),
    ].map((m) => [m[1], m[2], Number(m[3])]);
    expect(rows).toEqual([
      ['&lt;b&gt;evil&lt;/b&gt;.test', 'deny', 9],
      ['example.com', 'deny', 3],
      ['cdn.example.net', 'unlisted', 5],
      ['registry.npmjs.org', 'allow', 40],
      ['api.anthropic.com', 'allow', 3],
    ]);
    expect(html).not.toContain('<b>evil</b>');
    // No egress events, no Egress section.
    expect(renderDrop(drop, [])).not.toContain('<h3>Egress</h3>');
  });
});

const usageState = {
  status: 'rejected' as const,
  pausedUntil: '2026-01-01T05:00:00.000Z',
  fiveHourUtil: 0.97,
  fiveHourResetsAt: null,
  sevenDayUtil: 0.41,
  sevenDayResetsAt: null,
  observedAt: '2026-01-01T00:30:00.000Z',
  pausedAt: null,
  pauseConfirmed: true,
  probeDropId: null,
  probeNotBefore: null,
  causeDropId: 'd-cause',
  causeWorkItemId: 1,
  updatedAt: null,
};

describe('the Usage card by plan (#144)', () => {
  const home = (
    plan: ClaudePlan,
    windows: UsageWindowRow[] = [],
    state: typeof usageState = usageState,
  ): string =>
    renderHome({ zones: [z], items: [], drops: [], usage: { gate: 'open', state, plan, windows } });
  /** Each meter on the card: its label, figure and note. */
  const meters = (html: string) =>
    [
      ...html.matchAll(
        /<div class="meter"><div class="meter-row"><span>([^<]*)<\/span><b>([^<]*)<\/b><\/div>(?:<small class="note">([^<]*)<\/small>)?/g,
      ),
    ].map(([, label, value, note]) => ({ label, value, ...(note ? { note } : {}) }));
  const labels = (html: string) => meters(html).map((m) => m.label);
  const win = (
    key: string,
    utilization: number,
    observedAt = '2026-01-01T00:00:00.000Z',
    model: string | null = null,
  ): UsageWindowRow => ({ key, utilization, resetsAt: null, observedAt, model });

  test('ultra shows no 5-hour meter', () => {
    const html = home('ultra');
    expect(labels(html)).toEqual(['7-day', 'Fable (7-day)']);
    expect(html).not.toContain('<span>5-hour</span>');
  });

  test('max, pro and team_premium show the 5-hour meter, "-" when nothing is known', () => {
    for (const plan of ['max', 'pro', 'team_premium'] as const) {
      expect(labels(home(plan)), plan).toEqual(['5-hour', '7-day', 'Fable (7-day)']);
      expect(meters(home(plan))[0], plan).toEqual({ label: '5-hour', value: '97%' });
      const unknown = home(plan, [], { ...usageState, fiveHourUtil: null });
      expect(meters(unknown)[0], plan).toEqual({ label: '5-hour', value: '-' });
    }
  });

  test('with no Fable window, the Fable meter shows "-" and says so, never 0', () => {
    for (const plan of ['pro', 'ultra'] as const) {
      const fable = meters(home(plan)).find((m) => m.label === 'Fable (7-day)');
      expect(fable, plan).toEqual({
        label: 'Fable (7-day)',
        value: '-',
        note: 'not reported by Claude yet',
      });
    }
  });

  test('the Fable meter reads the reported window, the most recently observed if several', () => {
    const fable = (ws: UsageWindowRow[]) =>
      meters(home('pro', ws)).filter((m) => m.label.startsWith('Fable'));
    expect(fable([win('seven_day_fable', 0.42)])).toEqual([
      { label: 'Fable (7-day)', value: '42%' },
    ]);
    expect(
      fable([
        win('seven_day_fable', 0.42, '2026-01-02T00:00:00.000Z'),
        win('seven_day_fable_beta', 0.7, '2026-01-01T00:00:00.000Z'),
      ]),
    ).toEqual([{ label: 'Fable (7-day)', value: '42%' }]);
  });

  test('another model window gets its own meter, labelled from its key', () => {
    const html = home('max', [
      win('seven_day', 0.41),
      win('five_hour', 0.97),
      win('seven_day_opus', 0.33),
    ]);
    expect(labels(html)).toEqual(['5-hour', '7-day', 'Fable (7-day)', 'Opus (7-day)']);
    expect(meters(html).at(-1)).toEqual({ label: 'Opus (7-day)', value: '33%' });
  });

  test('the per-model weekly window reported by a Fable drop is the Fable meter (#377)', () => {
    const html = home(
      'max',
      [
        win('seven_day', 0.04),
        win('seven_day_overage_included', 0.01, undefined, 'claude-fable-5-2'),
      ],
      { ...usageState, sevenDayUtil: 0.04 },
    );
    expect(meters(html).filter((m) => m.label !== '5-hour')).toEqual([
      { label: '7-day', value: '4%' },
      { label: 'Fable (7-day)', value: '1%' },
    ]);
    expect(html).not.toContain('Overage Included');
  });

  test('the per-model weekly window is labelled by its model family (#377)', () => {
    const html = home('max', [
      win('seven_day_overage_included', 0.3, undefined, 'claude-opus-5-5'),
    ]);
    const ms = meters(html);
    expect(ms.find((m) => m.label === 'Fable (7-day)')).toEqual({
      label: 'Fable (7-day)',
      value: '-',
      note: 'not reported by Claude yet',
    });
    expect(ms.at(-1)).toEqual({ label: 'Opus (7-day)', value: '30%' });
    expect(html).not.toContain('Overage Included');
  });

  test('with no model, the per-model weekly window says so (#377)', () => {
    const html = home('max', [win('seven_day_overage_included', 0.2)]);
    expect(meters(html).at(-1)).toEqual({
      label: 'Model weekly limit (7-day)',
      value: '20%',
      note: 'Claude didn&#39;t say which model',
    });
    expect(html).not.toContain('Overage Included');
  });

  test('modelFamily reads the family of a claude-<family>- id (#377)', () => {
    expect(modelFamily('claude-fable-5-2')).toBe('Fable');
    expect(modelFamily('claude-opus-5-5')).toBe('Opus');
    expect(modelFamily('gpt-4')).toBeNull();
    expect(modelFamily(null)).toBeNull();
  });
});

describe('renderHome loop state', () => {
  test('shows usage gate', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      usage: { gate: 'closed', state: usageState, plan: 'pro', windows: [] },
    });
    expect(html).toContain('<h2>Usage</h2>');
    expect(html).toContain('closed');
    expect(html).toContain('2026-01-01T05:00:00.000Z');
    expect(html).toContain('97%');
    expect(html).toContain('41%');
    expect(html).toContain('2026-01-01T00:30:00.000Z');
    expect(html).toContain('d-cause');
  });

  test('shows verdict and attempts', () => {
    const html =
      workItemRows(
        [item],
        [z],
        new Map([
          [
            1,
            {
              headSha: 'abcdef1234567890',
              verdict: { decision: 'approve', forced: true, summary: 'fine' },
              attempts: { heal: 2, review: 1 },
            },
          ],
        ]),
      ) + dropRows([{ ...drop, role: 'review' }], [item], [z], new Date());
    expect(html).toContain('abcdef1');
    expect(html).not.toContain('abcdef12345');
    expect(html).toContain('approve (forced)');
    expect(html).toContain('heal 2');
    expect(html).toContain('review 1');
    expect(html).toContain('<td>review</td>');
  });

  test("shows Command's gate change allowance for the item's head", () => {
    const html = workItemRows(
      [item],
      [z],
      new Map([
        [1, { headSha: 'abcdef1234567890', gateAllowedSha: 'abcdef1234567890', attempts: {} }],
      ]),
    );
    expect(html).toContain('gate change allowed by Command for abcdef1');
    const plain = workItemRows(
      [item],
      [z],
      new Map([[1, { headSha: 'abcdef1234567890', attempts: {} }]]),
    );
    expect(plain).not.toContain('allowed by Command');
  });

  test('a carried gate allowance names its source head (issue #422)', () => {
    const html = workItemRows(
      [item],
      [z],
      new Map([
        [
          1,
          {
            headSha: 'abcdef1234567890',
            gateAllowedSha: 'abcdef1234567890',
            gateCarriedFrom: '0123456789abcdef',
            attempts: {},
          },
        ],
      ]),
    );
    expect(html).toContain('gate change allowed by Command for abcdef1 (carried from 0123456)');
  });

  test('escapes verdict summary', () => {
    const html = workItemRows(
      [item],
      [z],
      new Map([
        [
          1,
          {
            headSha: 'h',
            verdict: { decision: 'request_changes', forced: false, summary: '<svg onload=x>' },
            attempts: {},
          },
        ],
      ]),
    );
    expect(html).not.toContain('<svg onload=x>');
    expect(html).toContain('&lt;svg onload=x&gt;');
  });

  test('counts unknown and failed outbox ops on the zone card, as blocked', () => {
    const op = (id: string, state: 'unknown' | 'failed', error: string | null) => ({
      id,
      opKey: `k-${id}`,
      kind: 'merge' as const,
      workItemId: 1,
      zoneId: 'main',
      payloadJson: '{}',
      state,
      resultJson: null,
      error,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const html = renderHome({
      zones: [z],
      items: [item],
      drops: [],
      outbox: [op('o1', 'unknown', null), op('o2', 'failed', '<b>409</b>')],
    });
    expect(html).not.toContain('<h2>Outbox</h2>');
    expect(html).toContain('data-state="blocked" data-zone="main"');
    expect(html).toContain('2 forge writes unknown or failed');
    expect(html).not.toContain('<b>409</b>');
  });
});

const X = '<img src=x onerror=alert(1)>';
const briefing = (o: Partial<Briefing> = {}): Briefing => ({
  id: 4,
  zoneId: 'main',
  kind: 'crew',
  subject: 'crew:split',
  decision: 'Split the CLI objective?',
  why: 'It is two drops of work.',
  options: [
    { id: 'o1', label: 'Split it', effect: 'none' },
    { id: 'o2', label: 'Keep it', effect: 'none' },
  ],
  recommendation: 'Split it',
  onHold: 'The CLI objective',
  source: 'crew',
  sourceRef: 'd1',
  state: 'open',
  diagnoseAttempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  diagnosis: null,
  diagnosisBasis: null,
  ...o,
});

const ruling = (o: Partial<Ruling> = {}): Ruling => ({
  id: 1,
  zoneId: 'main',
  briefingId: 4,
  choice: 'o1',
  note: '',
  createdAt: 't',
  appliedAt: null,
  applyError: null,
  diagnosis: null,
  effect: 'none',
  ...o,
});

describe('briefings', () => {
  test('home shows "Waiting on you" with a counted line per project and a link to /briefings', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      briefings: [briefing(), briefing({ id: 5, decision: 'Retry #7?' })],
    });
    expect(html).toContain('<h2>Waiting on you</h2>');
    expect(html).toContain('<a href="/briefings?zone=main">octo/demo: 2 waiting</a>');
    expect(html).not.toContain('Split the CLI objective?');
    expect(html).not.toContain('Retry #7?');
    expect(html).toContain('href="/briefings"');
    expect(waitingOnYou([])).toContain('Nothing is waiting on you.');
  });

  test('each open briefing shows decision, why, options, recommendation and what is on hold', () => {
    const html = renderBriefings({ open: [briefing()], rulings: [], zones: [z] });
    expect(html).toContain('Briefings (decisions waiting on you)');
    expect(html).toContain('Rulings (0)');
    for (const text of [
      'Split the CLI objective?',
      'It is two drops of work.',
      'Split it',
      'Keep it',
      'The CLI objective',
    ]) {
      expect(html).toContain(text);
    }
  });

  test('a briefing keeps the line breaks of its why and shows each option id for ctl', () => {
    const html = renderBriefings({
      open: [
        briefing({
          why: 'gate script changed: test\n  test: "a" → "<b>"',
          options: [{ id: 'allow-x', label: 'Allow', effect: 'allow_gate_change', sha: 'x' }],
        }),
      ],
      rulings: [],
      zones: [z],
    });
    expect(html).toContain(
      '<pre>gate script changed: test\n  test: &quot;a&quot; → &quot;&lt;b&gt;&quot;</pre>',
    );
    expect(html).toContain('<code>allow-x</code>');
  });

  test('a diagnosis shows under the why, and beside the ruling once ruled', () => {
    const parked = briefing({
      kind: 'parked',
      subject: 'item:3',
      why: 'heal budget exhausted',
      diagnosis: 'The test is flaky.',
      source: 'server',
    });
    const html = renderBriefings({ open: [parked], rulings: [], zones: [z] });
    expect(html).toMatch(
      /<pre>heal budget exhausted<\/pre><\/td><\/tr><tr><th>Diagnosis<\/th><td><pre>The test is flaky\.<\/pre>/,
    );
    const ruled = renderBriefings({
      open: [],
      rulings: [ruling({ diagnosis: 'Out of disk.' })],
      zones: [z],
    });
    expect(ruled).toContain('<th>Diagnosis</th>');
    expect(ruled).toContain('<td>Out of disk.</td>');
  });

  test('a Promote ruling held while the crew is off says so; a Reject does not wait', () => {
    const off = { ...z, crew: { ...z.crew, enabled: false } };
    const on = { ...z, crew: { ...z.crew, enabled: true } };
    const rulings = [
      ruling({ id: 1, choice: 'promote', effect: 'promote_issue' }),
      ruling({ id: 2, choice: 'reject', effect: 'reject_issue' }),
    ];
    const html = renderBriefings({ open: [], rulings, zones: [off] });
    expect(html).toMatch(/<td>promote<\/td>.*?<td>waiting: crew disabled<\/td>/s);
    expect(html.match(/waiting: crew disabled/g)).toHaveLength(1);
    expect(renderBriefings({ open: [], rulings, zones: [on] })).not.toContain(
      'waiting: crew disabled',
    );
  });

  test('a held refute promotion shows its Reject option and when it will promote', () => {
    const held = briefing({
      kind: 'promote_held',
      subject: 'issue:3',
      options: [
        { id: 'reject', label: 'Reject', effect: 'reject_issue' },
        { id: 'promote', label: 'Promote now', effect: 'promote_issue' },
      ],
      source: 'server',
    });
    const html = renderBriefings({
      open: [held],
      rulings: [],
      zones: [z],
      holds: new Map([['issue:3', '2026-01-01T00:01:00.000Z']]),
    });
    expect(html).toContain('value="reject"');
    expect(html).toContain('Reject');
    expect(html).toContain('Promotes at 2026-01-01T00:01:00.000Z unless you reject it.');
  });

  test('a held promotion is listed under "Going ahead unless you stop it", after what needs you (#449)', async () => {
    const h = await harness();
    const options = [
      { id: 'reject', label: 'Reject', effect: 'reject_issue' as const },
      { id: 'promote', label: 'Promote now', effect: 'promote_issue' as const },
    ];
    const held = raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'promote_held',
        subject: 'issue:3',
        decision:
          'A reviewer found nothing to fix. It goes ahead in about a minute unless you reject it.',
        why: 'w',
        options,
        source: 'server',
      },
      h.now(),
    );
    const parked = raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'parked',
        subject: 'item:9',
        decision: 'Item 9 is parked. Retry it?',
        why: 'w',
        options: [{ id: 'retry', label: 'Retry', effect: 'none' }],
        source: 'server',
      },
      h.now(),
    );
    for (const url of ['/briefings', '/briefings?zone=main']) {
      const html = (await h.view(url)).body;
      const heading = html.indexOf('Going ahead unless you stop it');
      expect(heading).toBeGreaterThan(-1);
      const parkedAt = html.indexOf(`id="briefing-${parked}"`);
      const heldAt = html.indexOf(`id="briefing-${held}"`);
      expect(parkedAt).toBeGreaterThan(-1);
      expect(parkedAt).toBeLessThan(heading);
      expect(heldAt).toBeGreaterThan(heading);
      const block = html.slice(heldAt);
      expect(block).toContain(`<form class="rule" data-briefing="${held}"`);
      expect(block).toContain('value="reject"');
      expect(block).toContain('value="promote"');
      expect(block).toContain('Promote now');
    }
    // The all-projects page counts only what needs you.
    expect((await h.view('/briefings')).body).toContain('1 decision waiting.');
  });

  test('a rule form posts optionId through jmFetch, with no token field', () => {
    const html = renderBriefings({ open: [briefing()], rulings: [], zones: [z] });
    expect(html).toMatch(/<form class="rule" data-briefing="4" data-options="[0-9a-f]{16}">/);
    expect(html).not.toContain('type="password"');
    expect(html).toContain(
      "jmFetch('/api/control/briefings/'+f.dataset.briefing+'/rule',{optionId:o.value,optionsDigest:f.dataset.options",
    );
    expect(html).toContain('location.reload()');
    // A refusal names its reason (already ruled, options changed), not only the status.
    expect(html).toContain(
      "alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''))",
    );
  });

  test('markup in any crew-written field is escaped', () => {
    const evil = briefing({
      decision: X,
      why: X,
      recommendation: X,
      onHold: X,
      subject: X,
      options: [
        { id: X, label: X, effect: 'none' },
        { id: 'b', label: 'b', effect: 'none' },
      ],
    });
    const evilRuling = ruling({ choice: X, note: X, applyError: X, diagnosis: X });
    const html =
      renderBriefings({ open: [evil], rulings: [evilRuling], zones: [z] }) +
      renderHome({ zones: [z], items: [], drops: [], briefings: [evil] }) +
      renderGoals({
        zone: z,
        zones: [z],
        goals: undefined,
        crewIssues: [
          crewIssue({ title: X, key: X, objective: X, findingsJson: JSON.stringify([X]) }),
        ],
        items: [],
        skippedCrewUnpromoted: [],
        doneByRuling: new Map(),
      });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

const crewIssue = (o: Partial<CrewIssue> = {}): CrewIssue => ({
  id: 3,
  zoneId: 'main',
  key: 'add-docs',
  source: 'drop',
  sourceRef: 'd1',
  objective: 'document-every-endpoint',
  title: 'Add docs',
  titleNorm: 'add docs',
  body: 'b',
  bodySha: 's',
  priority: null,
  number: 7,
  state: 'promoted',
  refuteCount: 1,
  refutedSha: 's',
  findingsJson: null,
  holdUntil: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...o,
});

const goals = (parse: GoalRow['parse']): GoalRow => ({
  zoneId: 'main',
  sha256: 'x',
  parserVersion: 1,
  raw: '# Goals',
  parse,
  readAt: '2026-01-01T00:00:00.000Z',
});

describe('goal ladder', () => {
  test('the ladder marks done objectives and the current one, and lists crew issues with their state and work item', () => {
    const html = renderGoals({
      zone: z,
      zones: [z],
      goals: goals({
        ok: true,
        lighthouse: 'Every endpoint is documented.',
        sections: {},
        objectives: [
          { key: 'set-up', title: 'Set up', done: true, body: '' },
          {
            key: 'document-every-endpoint',
            title: 'Document every endpoint',
            done: false,
            body: '',
          },
          { key: 'ship-the-cli', title: 'Ship the CLI', done: false, body: '' },
        ],
      }),
      crewIssues: [
        crewIssue(),
        crewIssue({ id: 4, key: 'b', title: 'Second', state: 'staged', number: 8 }),
      ],
      items: [item],
      skippedCrewUnpromoted: [],
      doneByRuling: new Map(),
    });
    expect(html).toContain('Objectives (goal ladder)');
    expect(html).toContain('Every endpoint is documented.');
    expect(html).toMatch(/Set up[^<]*<\/td><td>done/);
    expect(html).toMatch(/Document every endpoint[^<]*<\/td><td>Current objective/);
    expect(html).toMatch(/Ship the CLI[^<]*<\/td><td>open/);
    expect(html).toMatch(/Add docs<\/td><td>promoted<\/td><td>#7<\/td><td>pr_open/);
    expect(html).toMatch(/Second<\/td><td>staged<\/td><td>#8<\/td><td>-/);
  });

  test('marker-bearing issues skipped at intake are listed on the zone page', () => {
    const html = renderGoals({
      zone: z,
      zones: [z],
      goals: undefined,
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [12, 13],
      doneByRuling: new Map(),
    });
    expect(html).toContain('Crew issues not started (no recorded promotion)');
    expect(html).toContain('#12');
    expect(html).toContain('#13');
  });

  test('a skipped issue on a rejected or failed crew row is listed with its remedy', () => {
    const html = renderGoals({
      zone: z,
      zones: [z],
      goals: undefined,
      crewIssues: [
        crewIssue({ id: 5, number: 24, state: 'rejected' }),
        crewIssue({ id: 6, number: 25, state: 'failed' }),
        crewIssue({ id: 7, number: 26, state: 'staged' }),
      ],
      items: [],
      skippedCrewUnpromoted: [24, 25, 26, 27],
      doneByRuling: new Map(),
    });
    expect(html).toContain(
      '<li>#24: crew issue rejected. It can never start: close it, or file a fresh issue for the work.</li>',
    );
    expect(html).toContain(
      '<li>#25: crew issue failed. It can never start: close it, or file a fresh issue for the work.</li>',
    );
    expect(html).toContain('<li>#26: crew issue staged, not promoted</li>');
    expect(html).toContain('<li>#27</li>');
  });

  const ladder = (zone: DropZoneConfig, g: GoalRow | undefined): string =>
    renderGoals({
      zone,
      zones: [zone],
      goals: g,
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [],
      doneByRuling: new Map(),
    });
  const withPath = (goalPath: string, repo = 'o/r'): DropZoneConfig => ({
    ...makeZone({ id: 'jm', repo }),
    crew: { ...makeZone().crew, goalPath },
  });
  const parsed = goals({ ok: true, lighthouse: 'L', sections: {}, objectives: [] });

  test('the edit link encodes each path segment and keeps the slashes (#365)', () => {
    const html = ladder(withPath('a b/goals.md'), parsed);
    expect(html).toContain('href="https://github.com/o/r/blob/HEAD/a%20b/goals.md"');
    expect(html).toContain('The goals live in a b/goals.md in o/r.');
    expect(html).toContain('href="/zones/jm"');
  });

  test('a repo or goal path holding markup is escaped in the text and encoded in the link (#365)', () => {
    const html = ladder(withPath('<script>/g.md', 'o/<script>'), parsed);
    expect(html).not.toContain('<script>/g.md');
    expect(html).not.toContain('o/<script>');
    expect(html).toContain('The goals live in &lt;script&gt;/g.md in o/&lt;script&gt;.');
    expect(html).toContain('href="https://github.com/o/%3Cscript%3E/blob/HEAD/%3Cscript%3E/g.md"');
  });

  test('a missing goal file links the intake page instead of GitHub (#365)', () => {
    const html = ladder(
      withPath('a b/goals.md'),
      goals({ ok: false, error: 'a b/goals.md not found' }),
    );
    expect(html).toContain(
      `a b/goals.md isn't in the repository yet. <a href="/zones/jm/intake">Write one with the intake page</a>.`,
    );
    expect(html).not.toContain('github.com');
  });

  test('an unparsed GOAL.md shows its parse error', () => {
    const html = renderGoals({
      zone: z,
      zones: [z],
      goals: goals({ ok: false, error: 'no ## Objectives section' }),
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [],
      doneByRuling: new Map(),
    });
    expect(html).toContain('could not be parsed: no ## Objectives section');
  });
});

describe('models on the drop page', () => {
  test('the drop page shows requested and served model and flags a mismatch', () => {
    const same = renderDrop({ ...drop, requestedModel: 'm1', servedModel: 'm1' }, []);
    expect(same).toContain('Requested model: m1');
    expect(same).toContain('Served model: m1');
    expect(same).not.toContain('mismatch');
    const diff = renderDrop({ ...drop, requestedModel: 'fable-1', servedModel: 'opus' }, []);
    expect(diff).toContain('Served model: opus (mismatch: requested fable-1)');
    expect(renderDrop({ ...drop, requestedModel: null, servedModel: null }, [])).toContain(
      'Requested model: -',
    );
  });
});

describe('home crew line', () => {
  test('each zone shows whether its crew is on, the last cycle, the next due and the Fable status', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      crew: [
        {
          zoneId: 'main',
          enabled: true,
          lastCycle: '2026-01-01T00:00:00.000Z',
          nextDue: '2026-01-01T01:00:00.000Z',
          fable: 'plan pro does not include Fable',
        },
      ],
    });
    expect(html).toContain('<h2>Crew</h2>');
    expect(html).toMatch(
      /octo\/demo<\/td><td>on<\/td><td>2026-01-01T00:00:00.000Z<\/td><td>2026-01-01T01:00:00.000Z<\/td><td>plan pro does not include Fable/,
    );
  });
});

describe('starter banner', () => {
  test('the home page warns about each starter zone, and says nothing for two-bot', () => {
    const starter = { ...z, id: 'solo', identity: 'starter' } as DropZoneConfig;
    const html = renderHome({ zones: [z, starter], items: [], drops: [] });
    // The starter shares main's repository, so its id follows.
    expect(html).toContain('Starter mode in octo/demo <small>(solo)</small>');
    expect(html).toContain(escapeHtml(STARTER_WARNING));
    expect(renderHome({ zones: [z], items: [], drops: [] })).not.toContain('Starter mode');
  });
});

describe('renderIntake', () => {
  const zone = {
    id: 'main"><script>x</script>',
    repo: 'octo/<script>x</script>',
  } as DropZoneConfig;

  test('two steps, every value escaped, no secret, and a link to New issue instead of step 3', () => {
    const html = renderIntake(zone);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('GOAL.md stub: octo/&lt;script&gt;x&lt;/script&gt;');
    for (const t of ['existing', 'idea', 'partial']) expect(html).toContain(`value="${t}"`);
    expect(html).toMatch(/Step 1/);
    expect(html).toMatch(/Step 2/);
    expect(html).not.toMatch(/Step 3/);
    expect(html).not.toContain('issue-form');
    expect(html).toContain(
      'To file an issue, use <a href="/zones/main%22%3E%3Cscript%3Ex%3C%2Fscript%3E/issues/new"><strong>New issue</strong></a>',
    );
    expect(html).not.toContain('type="password"');
    expect(html).toContain('const r = await jmFetch(base + path, body);');
    expect(html).not.toMatch(/github_pat_|ghp_|sk-ant-/);
    expect(html).not.toContain('innerHTML');
  });
});

describe('renderNewIssue', () => {
  const zone = {
    id: 'main"><script>x</script>',
    repo: 'octo/<script>x</script>',
  } as DropZoneConfig;

  test('the issue form alone, every value escaped, no secret, and the first issue needs no merged GOAL.md', () => {
    const html = renderNewIssue(zone);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('New issue: octo/&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain("it doesn't need GOAL.md merged first");
    expect(html).not.toContain('stub-form');
    expect(html).toContain('<button type="button" id="issue-again" hidden>File another</button>');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('const r = await jmFetch(base + path, body);');
    expect(html).not.toMatch(/github_pat_|ghp_|sk-ant-/);
    // The page reuses the tested helpers, not a copy of them.
    expect(html).toContain(submitKey.toString());
    expect(html).toContain(forgetSubmitKey.toString());
    expect(html).toContain('sessionStorage');
    // A refused filing starts afresh: the stored key is dropped, and the page says so.
    expect(html).toMatch(/r\.status === 502\) \{\s*forgetSubmitKey\(sessionStorage, content\)/);
    expect(html).not.toContain('innerHTML');
  });
});

describe('the page shell and its forms', () => {
  test('the kill, rule, doctor and intake forms carry no token field and send the CSRF header', () => {
    const pages = {
      kill: renderHome({ zones: [z], items: [], drops: [], sticks: [] }),
      killed: renderHome({ zones: [z], items: [], drops: [], sticks: [], killed: true }),
      rule: renderBriefings({ open: [briefing()], rulings: [], zones: [z] }),
      doctor: renderDoctor(null, [z]),
      intake: renderIntake(z),
      newIssue: renderNewIssue(z),
    };
    for (const [name, html] of Object.entries(pages)) {
      expect([name, html]).not.toEqual([name, expect.stringMatching(/type="password"/)]);
      expect([name, html]).not.toEqual([name, expect.stringMatching(/Operator token|Bearer/)]);
      // The shell: an empty meta the guard fills per session, the helper, and the logout button.
      expect(html).toContain('<meta name="jm-csrf" content="">');
      expect(html).toContain("'x-jm-csrf':document.querySelector('meta[name=jm-csrf]').content");
      expect(html).toContain('<form method="post" action="/logout"');
      expect(html).toMatch(/jmFetch\(/);
    }
    expect(pages.kill).toContain("jmFetch('/api/control/kill',{engaged:true})");
    expect(pages.killed).toContain("jmFetch('/api/control/kill',{engaged:false})");
    expect(pages.doctor).toContain("jmFetch(b.dataset.doctor,JSON.parse(b.dataset.body||'{}'))");
  });

  test('the login and setup shell has no CSRF meta, helper or logout', () => {
    const html = page('<p>x</p>', { chrome: false });
    expect(html).not.toContain('jm-csrf');
    expect(html).not.toContain('jmFetch');
    expect(html).not.toContain('/logout');
  });
});

describe('the status banner (Task 12, round 2)', () => {
  test('code renders as <code>, other blockers as a list with Fix links, and an unsafe href is no link', () => {
    const html = statusBanner({
      headline: 'No runner: <it> & `x`',
      detail: 'check `docker compose logs stick` <now>',
      waitingOn: 'stick',
      action: { label: 'See the sticks', href: '/' },
      also: [
        { text: 'demo: no Claude token', href: '/settings/credentials' },
        { text: 'docs is paused', href: '/zones/docs' },
        { text: 'evil', href: 'javascript:alert(1)' },
        { text: 'no pass yet since start' },
      ],
    });
    expect(html).toContain('<strong>No runner: &lt;it&gt; &amp; <code>x</code></strong>');
    expect(html).toContain('<p>check <code>docker compose logs stick</code> &lt;now&gt;</p>');
    expect(html).not.toContain('`');
    expect(html).toContain(
      '<ul class="also"><li>demo: no Claude token <a href="/settings/credentials">Fix</a></li><li>docs is paused <a href="/zones/docs">Fix</a></li><li>evil</li><li>no pass yet since start</li></ul>',
    );
    expect(html).not.toContain('javascript:');
    // The action link goes through the same check.
    const unsafe = statusBanner({
      headline: 'h',
      detail: '',
      waitingOn: 'you',
      action: { label: 'x', href: '//evil.test/' },
    });
    expect(unsafe).not.toContain('evil.test');
  });
});

test('the home page sticks section has an anchor the status links to', () => {
  const html = renderHome({ zones: [], items: [], drops: [], sticks: [] });
  expect(html).toContain(
    '<details id="sticks" class="card sticks"><summary>Sticks: 0 live</summary>',
  );
});

describe('zones are named by their repository (#99)', () => {
  const solo: DropZoneConfig = { ...z, id: 'zid-solo', repo: 'acme/widgets', identity: 'starter' };
  const a: DropZoneConfig = { ...z, id: 'zid-a', repo: 'acme/shared' };
  const b: DropZoneConfig = { ...z, id: 'zid-b', repo: 'acme/shared' };
  const zones = [solo, a, b];
  /** The page with every URL, and the attributes that carry ids to the API, taken out. */
  const outsideUrls = (html: string) =>
    html.replace(/(href|action|data-[a-z-]+)="[^"]*"/g, '').replace(/\/zones\/[^\s"'<]*/g, '');
  /** No zone id anywhere but in a shared-repository suffix. */
  const expectNoBareId = (html: string) => {
    const text = outsideUrls(html).replaceAll(/<small>\(zid-[ab]\)<\/small>/g, '');
    expect(text).not.toMatch(/zid-/);
  };

  test('the floor names every zone by repository, and adds the id where a repository is shared', () => {
    const html = renderHome({
      zones,
      items: [
        { ...item, dropZoneId: 'zid-solo', state: 'ready', prNumber: null },
        { ...item, id: 2, dropZoneId: 'zid-a' },
      ],
      drops: [
        { ...drop, dropZoneId: 'zid-solo', workItemId: 1, state: 'running' },
        {
          ...drop,
          id: 'd2',
          dropZoneId: 'zid-b',
          workItemId: null,
          role: 'crew-lead',
          state: 'running',
        },
      ],
      briefings: [briefing({ zoneId: 'zid-b' })],
      crew: zones.map((zz) => ({
        zoneId: zz.id,
        enabled: true,
        lastCycle: null,
        nextDue: null,
        fable: 'ok',
      })),
      sticks: [
        {
          id: 's1',
          name: 'st',
          version: null,
          lastSeenAt: null,
          capabilities: [],
          imagePolicy: 'allowlist',
          cannotRun: [{ zoneId: 'zid-solo', missing: ['egress-v1'] }],
        },
      ],
      outbox: [
        {
          id: 1,
          kind: 'comment',
          zoneId: 'zid-a',
          workItemId: null,
          state: 'failed',
          error: null,
          updatedAt: 't',
        } as never,
      ],
    });
    expect(html).toContain('acme/widgets');
    expect(html).toContain('acme/shared <small>(zid-a)</small>');
    expect(html).toContain('acme/shared <small>(zid-b)</small>');
    expect(html).toContain('Starter mode in acme/widgets');
    expect(html).toContain('cannot run acme/widgets: lacks egress-v1');
    // The ids stay in the URLs.
    expect(html).toContain('href="/zones/zid-solo/goals"');
    expectNoBareId(html);
  });

  test("the floor's status banner and page title name zones by repository", () => {
    const problem = {
      zoneId: 'zid-a',
      kind: 'missing',
      credential: 'claudeToken',
      message: 'no Claude token is set',
    } as const;
    const statusZone = (id: string, mode: 'active' | 'paused') => ({
      id,
      mode,
      items: [],
      drops: [],
      parked: 0,
      credentialProblems: id === 'zid-solo' ? [] : [{ ...problem, zoneId: id }],
    });
    const status = statusOf(
      {
        setupActive: false,
        killed: false,
        sticks: { live: 1, slots: 1, busy: 0 },
        doctor: { fails: [] },
        lastPassAt: 't',
        openBriefings: 0,
        zones: [
          statusZone('zid-a', 'active'),
          statusZone('zid-b', 'active'),
          statusZone('zid-solo', 'paused'),
        ],
        outboxRetrying: [],
        restartPending: false,
        zoneName: zoneTextNamer(zones),
      },
      new Date(),
    );
    const html = renderHome({ zones, items: [], drops: [], sticks: [], status });
    expect(html).toContain('<title>Jumpmaster: Blocked: acme/shared (zid-a) needs claudeToken');
    expect(html).toContain('<strong>Blocked: acme/shared (zid-a) needs claudeToken');
    expect(html).toContain('acme/shared (zid-b): no Claude token');
    expect(html).toContain('acme/widgets is paused');
    expect(html).toContain('href="/zones/zid-solo"');
    // A shared repository's id follows it in the plain-text status, as it does in <small> elsewhere.
    expectNoBareId(html.replaceAll(/acme\/shared \(zid-[ab]\)/g, ''));
  });

  test('the briefings page names the zone of each briefing and ruling by repository', () => {
    const html = renderBriefings({
      open: [briefing({ zoneId: 'zid-solo' }), briefing({ id: 5, zoneId: 'zid-a' })],
      rulings: [ruling({ zoneId: 'zid-b' })],
      zones,
    });
    expect(html).toContain('<th>Zone</th><td>acme/widgets</td>');
    expect(html).toContain('<th>Zone</th><td>acme/shared <small>(zid-a)</small></td>');
    expect(html).toContain('<td>acme/shared <small>(zid-b)</small></td>');
    expectNoBareId(html);
  });

  test("one zone's briefings page names the zone by repository in its bulk dismiss", () => {
    const html = renderBriefings({
      open: [briefing({ zoneId: 'zid-a' }), briefing({ id: 5, zoneId: 'zid-a' })],
      rulings: [],
      zones,
      zone: { id: 'zid-a', mode: 'paused' },
    });
    expect(html).toContain('Dismiss all 2 briefings of acme/shared <small>(zid-a)</small>');
    expect(html).toContain('data-ask="Dismiss 2 briefings of acme/shared (zid-a)?');
    expect(html).toContain('data-zone="zid-a"');
    expectNoBareId(html);
    const solo1 = renderBriefings({
      open: [briefing({ zoneId: 'zid-solo' })],
      rulings: [],
      zones,
      zone: { id: 'zid-solo', mode: 'active' },
    });
    expect(solo1).toContain('Dismiss all 1 briefing of acme/widgets</button>');
    expectNoBareId(solo1);
  });

  test('the goals, intake, doctor and observations pages name the zone by repository', () => {
    const goals = renderGoals({
      zone: solo,
      zones,
      goals: undefined,
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [],
      doneByRuling: new Map(),
    });
    expect(goals).toContain('acme/widgets');
    expectNoBareId(goals);
    const intake = renderIntake(a, zones);
    expect(intake).toContain('GOAL.md stub: acme/shared <small>(zid-a)</small>');
    expectNoBareId(intake);
    const newIssue = renderNewIssue(a, zones);
    expect(newIssue).toContain('New issue: acme/shared <small>(zid-a)</small>');
    expectNoBareId(newIssue);
    const doctor = renderDoctor(
      {
        id: 1,
        finishedAt: 't',
        checks: [{ id: 'c1', zoneId: 'zid-b', status: 'fail', summary: 's' }],
      },
      zones,
    );
    expect(doctor).toContain('Doctor drop: acme/widgets');
    // The doctor drop buttons are a list under their explanation, one item per project.
    expect(doctor).toMatch(
      /it spends one turn of usage\.<\/p><ul class="doctor-drops"><li><button [^>]*>Doctor drop: [^<]*<\/button><\/li><li><button /,
    );
    expect(doctor).not.toMatch(/usage\.\s*<button/);
    expect(doctor).toContain('<td>acme/shared <small>(zid-b)</small></td>');
    expectNoBareId(doctor);
    const obs = renderObservations(
      [
        {
          zoneId: 'zid-solo',
          itemId: null,
          action: 'x',
          detail: 'y',
          count: 1,
          firstAt: 't',
          lastAt: 't',
        } as never,
      ],
      zones,
    );
    expect(obs).toContain('<td>acme/widgets</td>');
    expectNoBareId(obs);
  });
});

describe('renderWorkList and renderDropList (#119)', () => {
  const ref: DropZoneConfig = { ...z, id: 'ref', repo: 'octo/ref' };
  const zones = [z, ref];

  test('/work renders work rows through workItemRows; the floor only counts them', () => {
    const items = [item, { ...item, id: 2, dropZoneId: 'ref', title: 'other <b>' }];
    const rows = workItemRows(items, zones);
    expect(rows).toContain('other &lt;b&gt;');
    expect(renderHome({ zones, items, drops: [] })).not.toContain(rows);
    expect(renderWorkList({ zones, state: 'active', items })).toContain(rows);
  });

  test('/drops renders drop rows through dropRows; the floor only counts them', () => {
    const now = new Date('2026-01-01T00:02:00.000Z');
    const rows = dropRows([drop], [item], zones, now);
    expect(rows).toContain('title="d1">d1</a>');
    expect(renderHome({ zones, items: [item], drops: [drop], now })).not.toContain(rows);
    expect(
      renderDropList({ zones, state: 'all', drops: [drop], items: [item], limited: false, now }),
    ).toContain(rows);
  });

  test('the heading names the filter in words, the zone by repository', () => {
    expect(renderWorkList({ zones, zone: 'main', state: 'parked', items: [] })).toContain(
      'Parked work in octo/demo',
    );
    expect(renderWorkList({ zones, state: 'active', items: [item] })).toContain('All active work');
    expect(
      renderDropList({ zones, zone: 'ref', state: 'active', drops: [], items: [], limited: false }),
    ).toContain('Active drops in octo/ref');
    expect(
      renderDropList({ zones, state: 'all', drops: [drop], items: [], limited: false }),
    ).toContain('All drops');
  });

  test('filter links keep the other parameter and mark the current choice', () => {
    const html = renderWorkList({ zones, zone: 'ref', state: 'ready', items: [] });
    expect(html).toContain(
      '<a href="/work?zone=ref&amp;state=ready" aria-current="page">octo/ref</a>',
    );
    expect(html).toContain('<a href="/work?zone=main&amp;state=ready">octo/demo</a>');
    expect(html).toContain('<a href="/work?state=ready">All projects</a>');
    expect(html).toContain('<a href="/work?zone=ref&amp;state=parked">Parked</a>');
    expect(html).toContain('<a href="/work?zone=ref">Active</a>');
    const drops = renderDropList({ zones, state: 'failed', drops: [], items: [], limited: false });
    expect(drops).toContain('<a href="/drops?state=failed" aria-current="page">All projects</a>');
    expect(drops).toContain('<a href="/drops?zone=main&amp;state=failed">octo/demo</a>');
    expect(drops).toContain('<a href="/drops?state=active">Active</a>');
    expect(drops).toContain('<a href="/drops">All states</a>');
  });

  test('empty results: the page-specific line and no table', () => {
    const work = renderWorkList({ zones, zone: 'main', state: 'parked', items: [] });
    expect(work).toContain('No parked work in octo/demo.');
    expect(work).not.toContain('<table');
    const drops = renderDropList({ zones, state: 'active', drops: [], items: [], limited: false });
    expect(drops).toContain('No active drops.');
    expect(drops).not.toContain('<table');
  });

  test('the limit line shows only when limited', () => {
    const args = { zones, state: 'all' as const, drops: [drop], items: [] };
    expect(renderDropList({ ...args, limited: true })).toContain('Showing the newest 200');
    expect(renderDropList({ ...args, limited: false })).not.toContain('Showing the newest 200');
  });

  test('the page nav links Work and Drops', () => {
    const html = page('x');
    expect(html).toContain('<a href="/work">Work</a>');
    expect(html).toContain('<a href="/drops">Drops</a>');
  });
});

describe('briefings grouped by project and paged (#132)', () => {
  const za: DropZoneConfig = { ...z, id: 'za', repo: 'acme/alpha' };
  const zb: DropZoneConfig = { ...z, id: 'zb', repo: 'acme/beta' };
  const zc: DropZoneConfig = { ...z, id: 'zc', repo: 'acme/gamma' };
  /** `n` open briefings of `zoneId`, ids from `from`, each decision naming its zone and number. */
  const many = (zoneId: string, n: number, from = 1): Briefing[] =>
    Array.from({ length: n }, (_, i) =>
      briefing({ id: from + i, zoneId, decision: `Decide ${zoneId}#${from + i}?` }),
    );
  const blocks = (html: string): number => html.match(/data-briefing="/g)?.length ?? 0;
  /** The HTML of one project's section, from its opening tag to its close. */
  const section = (html: string, zoneId: string): string => {
    const start = html.search(
      new RegExp(`<(section|details) class="project[^"]*" data-zone="${zoneId}"`),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const tag = html.slice(start + 1, html.indexOf(' ', start));
    return html.slice(start, html.indexOf(`</${tag}><!--/project-->`, start));
  };

  test('pageParams: per is 10, 20, 50 or 100, else 10; page and rpage are positive integers, else 1', () => {
    for (const per of ['10', '20', '50', '100']) expect(pageParams({ per }).per).toBe(Number(per));
    for (const per of [undefined, '0', '7', 'abc', '1000', '', ['20', '50'], '20.0'])
      expect(pageParams({ per }).per).toBe(10);
    expect(pageParams({ page: '3', rpage: '2' })).toEqual({ per: 10, page: 3, rpage: 2 });
    for (const page of [undefined, '-1', '0', 'x', '1.5', ['2']])
      expect(pageParams({ page, rpage: page })).toEqual({ per: 10, page: 1, rpage: 1 });
  });

  test('grouping: the busier project comes first with 10 blocks and Show all; no briefing crosses sections', () => {
    const open = [...many('za', 3, 1), ...many('zb', 12, 100)];
    const html = renderBriefings({ open, rulings: [], zones: [za, zb] });
    const a = section(html, 'za');
    const b = section(html, 'zb');
    expect(html.indexOf(b)).toBeLessThan(html.indexOf(a));
    expect(blocks(b)).toBe(10);
    expect(b).toContain('Show all 12 in acme/beta');
    expect(b).toContain('href="/briefings?zone=zb&amp;per=10"');
    expect(blocks(a)).toBe(3);
    expect(a).not.toContain('Show all');
    expect(a).toContain('3 waiting');
    expect(b).toContain('12 waiting');
    for (const x of many('za', 3, 1)) expect(b).not.toContain(x.decision);
    for (const x of many('zb', 12, 100)) expect(a).not.toContain(x.decision);
    // Newest first: the highest ids of zb show, the two oldest do not.
    expect(b).toContain('Decide zb#111?');
    expect(b).not.toContain('Decide zb#101?');
    expect(html).not.toContain('Rulings (decisions recorded)');
  });

  test('order: by open count descending, ties by repository; then quiet projects; no zone ids shown', () => {
    const open = [...many('zc', 2, 1), ...many('za', 2, 10), ...many('zb', 5, 20)];
    const quiet: DropZoneConfig = { ...z, id: 'zq', repo: 'acme/aaa-quiet' };
    const html = renderBriefings({ open, rulings: [], zones: [zc, quiet, za, zb] });
    const at = (id: string) => html.indexOf(section(html, id));
    expect(at('zb')).toBeLessThan(at('za'));
    expect(at('za')).toBeLessThan(at('zc'));
    expect(at('zc')).toBeLessThan(at('zq'));
    expect(section(html, 'zq')).toContain('Nothing waiting');
    expect(blocks(section(html, 'zq'))).toBe(0);
    // The decisions name their zone (fixture text), so they are taken out with the URLs.
    const text = html
      .replace(/(href|data-[a-z-]+)="[^"]*"/g, '')
      .replace(/Decide z[a-z]#\d+\?/g, '');
    expect(text).not.toMatch(/\bz[abcq]\b/);
    expect(html).not.toMatch(/zone z[abcq]/);
  });

  test('a held project is collapsed after the others and not counted as waiting', () => {
    const open = [...many('za', 2, 1), ...many('zb', 30, 100)];
    const html = renderBriefings({
      open,
      rulings: [],
      zones: [za, zb, zc],
      modes: { za: 'active', zb: 'paused', zc: 'active' },
    });
    const held = section(html, 'zb');
    expect(held.startsWith('<details class="project held"')).toBe(true);
    expect(held).toContain('<summary>acme/beta: 30 held while paused</summary>');
    expect(blocks(held)).toBe(10);
    expect(held).toContain('Show all 30 in acme/beta');
    expect(html.indexOf(held)).toBeGreaterThan(html.indexOf(section(html, 'za')));
    expect(html.indexOf(held)).toBeGreaterThan(html.indexOf(section(html, 'zc')));
    expect(html).toContain('2 decisions waiting');
    expect(html).not.toContain('32 decisions');
  });

  test('each section carries its newest rulings, collapsed, with a link when there are more', () => {
    const rulings = Array.from({ length: 12 }, (_, i) =>
      ruling({ id: i + 1, zoneId: 'za', note: `note-a-${i + 1}` }),
    ).concat([ruling({ id: 99, zoneId: 'zb', note: 'note-b' })]);
    const html = renderBriefings({ open: many('za', 1), rulings, zones: [za, zb] });
    const a = section(html, 'za');
    expect(a).toContain('<details class="rulings"><summary>Rulings (12)</summary>');
    expect(a).toContain('note-a-12');
    expect(a).not.toContain('note-a-2<');
    expect(a).toContain('href="/briefings?zone=za&amp;per=10#rulings"');
    expect(a).not.toContain('note-b');
    const b = section(html, 'zb');
    expect(b).toContain('Rulings (1)');
    expect(b).toContain('note-b');
    expect(b).not.toContain('#rulings"');
  });

  test.each([10, 20, 50, 100])('per=%i shows exactly that many blocks', (per) => {
    const html = renderBriefings({ open: many('za', 120), rulings: [], zones: [za], per });
    expect(blocks(html)).toBe(per);
    const one = renderBriefings({
      open: many('za', 120),
      rulings: [],
      zones: [za],
      zone: { id: 'za', mode: 'active' },
      per,
    });
    expect(blocks(one)).toBe(per);
  });

  test('the size selector marks the current size and keeps the zone, resetting the pages', () => {
    const html = renderBriefings({
      open: many('za', 30),
      rulings: [],
      zones: [za],
      zone: { id: 'za', mode: 'active' },
      per: 20,
      page: 2,
      rpage: 2,
    });
    expect(html).toContain('<a href="/briefings?zone=za&amp;per=10">10</a>');
    expect(html).toContain('<a href="/briefings?zone=za&amp;per=20" aria-current="page">20</a>');
    expect(html).toContain('<a href="/briefings?zone=za&amp;per=50">50</a>');
    expect(html).toContain('<a href="/briefings?zone=za&amp;per=100">100</a>');
    const all = renderBriefings({ open: [], rulings: [], zones: [za] });
    expect(all).toContain('<a href="/briefings?per=10" aria-current="page">10</a>');
  });

  test('the zone view pages briefings, clamps the page, and keeps the dismiss for all of them', () => {
    const open = many('za', 23);
    const view = (page: number) =>
      renderBriefings({ open, rulings: [], zones: [za], zone: { id: 'za', mode: 'active' }, page });
    const first = view(1);
    expect(blocks(first)).toBe(10);
    expect(first).toContain('Page 1 of 3');
    expect(first).toContain('href="/briefings?zone=za&amp;per=10&amp;page=2">Next</a>');
    expect(first).not.toContain('>Previous</a>');
    expect(first).toContain('Decide za#23?');
    expect(first).toContain('Dismiss all 23 briefings of acme/alpha');
    expect(first).toContain(`data-ids="${escapeHtml(JSON.stringify(open.map((b) => b.id)))}"`);
    const last = view(3);
    expect(blocks(last)).toBe(3);
    expect(last).toContain('Page 3 of 3');
    expect(last).toContain('href="/briefings?zone=za&amp;per=10&amp;page=2">Previous</a>');
    expect(last).not.toContain('>Next</a>');
    expect(last).toContain('Decide za#1?');
    expect(view(99)).toBe(last);
  });

  test('rulings page independently of briefings', () => {
    const rulings = Array.from({ length: 15 }, (_, i) =>
      ruling({ id: i + 1, zoneId: 'za', note: `note-${i + 1}` }),
    );
    const view = (rpage: number) =>
      renderBriefings({
        open: many('za', 15),
        rulings,
        zones: [za],
        zone: { id: 'za', mode: 'active' },
        rpage,
      });
    const one = view(1);
    const two = view(2);
    const briefingsOf = (html: string) => html.slice(0, html.indexOf('id="rulings"'));
    expect(briefingsOf(two)).toBe(briefingsOf(one));
    expect(two).toContain('<h2 id="rulings">');
    expect(two).toContain('<td>note-5</td>');
    expect(two).not.toContain('<td>note-6</td>');
    expect(one).toContain('<td>note-15</td>');
    expect(one).toContain('Page 1 of 2');
    expect(one).toContain('href="/briefings?zone=za&amp;per=10&amp;rpage=2#rulings">Next</a>');
    expect(two).toContain('href="/briefings?zone=za&amp;per=10&amp;rpage=1#rulings">Previous</a>');
  });

  test('the floor card shows one counted line per project, in the same order, and no decision', () => {
    const open = [...many('za', 2, 1), ...many('zb', 5, 10)];
    const html = waitingOnYou(open, [], [za, zb]);
    const lines = html.match(/<li>.*?<\/li>/g) ?? [];
    expect(lines).toEqual([
      '<li><a href="/briefings?zone=zb">acme/beta: 5 waiting</a></li>',
      '<li><a href="/briefings?zone=za">acme/alpha: 2 waiting</a></li>',
    ]);
    expect(html).toContain('7 decisions waiting');
    expect(html).toContain('href="/briefings"');
    for (const b of open) expect(html).not.toContain(b.decision);
  });

  test('escaping: a decision with <script> is escaped, and a zone id needing it is encoded', () => {
    const odd: DropZoneConfig = { ...z, id: 'a b', repo: 'acme/<odd>' };
    const open = [
      ...many('a b', 11, 1),
      briefing({ id: 50, zoneId: 'a b', decision: '<script>alert(1)</script>' }),
    ];
    const all = renderBriefings({ open, rulings: [ruling({ zoneId: 'a b' })], zones: [odd] });
    const one = renderBriefings({
      open,
      rulings: [],
      zones: [odd],
      zone: { id: 'a b', mode: 'active' },
      page: 1,
    });
    const floor = waitingOnYou(open, [], [odd]);
    for (const html of [all, one, floor]) {
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<odd>');
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      for (const href of hrefs.filter((x) => x?.includes('zone='))) {
        expect(href).toContain('zone=a%20b');
      }
      expect(hrefs.some((x) => x?.includes('zone=a%20b'))).toBe(true);
    }
    expect(all).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(one).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('a credits stop on an unconfigured zone (#593)', () => {
  const zones = [z];
  const stop = (zoneId: string) =>
    briefing({ id: 9, zoneId, kind: 'credits_required', subject: 'credits:stop:d1' });

  test('its Waiting on you row links to /briefings, never to a zone that 404s, with a label', () => {
    for (const zoneId of ['old', '']) {
      const html = waitingOnYou([stop(zoneId)], [], zones);
      expect(html).not.toContain(`href="/briefings?zone=${encodeURIComponent(zoneId)}"`);
      expect(html).not.toMatch(/<a [^>]*>: 1 waiting<\/a>/);
      const rows = html.match(/<li>.*?<\/li>/g) ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/^<li><a href="\/briefings">[^<:]+: 1 waiting<\/a><\/li>$/);
    }
    expect(waitingOnYou([stop('')], [], zones)).toContain('All dispatch stopped: 1 waiting');
    expect(waitingOnYou([stop('old')], [], zones)).toContain('old: 1 waiting');
  });

  test('a configured zone’s row still links to its zone briefings', () => {
    const html = waitingOnYou([stop('main'), briefing({ id: 3 })], [], zones);
    expect(html).toContain('<a href="/briefings?zone=main">octo/demo: 2 waiting</a>');
  });

  test('its own page offers no "Briefings of" link to an unconfigured zone', () => {
    for (const zoneId of ['old', '']) {
      const html = renderBriefing({ briefing: stop(zoneId), rulings: [], zones });
      expect(html).not.toContain('/briefings?zone=');
      expect(html).toContain('<a href="/briefings">All briefings</a>');
    }
    const ok = renderBriefing({ briefing: stop('main'), rulings: [], zones });
    expect(ok).toContain('<a href="/briefings?zone=main">Briefings of octo/demo</a>');
  });
});

describe('external links open in a new tab (#133)', () => {
  const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';
  test('a work-item row’s PR link (on /work and the zone pages) opens in a new tab', () => {
    expect(workItemRows([item], [z])).toContain(
      `<a href="https://github.com/octo/demo/pull/9" ${NEW_TAB}>#9</a>`,
    );
  });

  test('the status banner’s "Open PR #7" action and an external Fix link open in a new tab', () => {
    const html = statusBanner({
      headline: 'h',
      detail: '',
      waitingOn: 'ci',
      action: { label: 'Open PR #7', href: 'https://github.com/o/r/pull/7' },
      also: [
        { text: 'ext', href: 'https://github.com/o/r/settings' },
        { text: 'int', href: '/settings/credentials' },
      ],
    });
    expect(html).toContain(`<a href="https://github.com/o/r/pull/7" ${NEW_TAB}>Open PR #7</a>`);
    expect(html).toContain(`<a href="https://github.com/o/r/settings" ${NEW_TAB}>Fix</a>`);
    expect(html).toContain('<a href="/settings/credentials">Fix</a>');
  });

  test('the floor’s PR link (its "Open PR #N") opens in a new tab; its in-app links do not', () => {
    const html = renderHome({
      zones: [z],
      items: [item],
      drops: [{ ...drop, state: 'running' }],
      sticks: [],
      status: {
        headline: 'Waiting on CI for PR #9',
        detail: '',
        waitingOn: 'ci',
        action: { label: 'Open PR #9', href: 'https://github.com/octo/demo/pull/9' },
      },
    });
    expect(html).toContain(
      `<a href="https://github.com/octo/demo/pull/9" ${NEW_TAB}>Open PR #9</a>`,
    );
    expect(html).toMatch(/<a href="\/work"[^>]*>/);
    expect(html).not.toMatch(/<a href="\/work"[^>]*target=/);
    expect(html).toMatch(/<a [^>]*href="\/drops\/d1"[^>]*>/);
    expect(html).not.toMatch(/<a [^>]*href="\/drops\/d1"[^>]*target=/);
  });
});

describe('transcript on the drop page', () => {
  // About 20 events in the shapes a real drop stores: phases, stream-json lines as `agent` events
  // ({ raw }), the stored end-of-run summary, rate limits, gates and egress.
  const ev = (
    seq: number,
    kind: StoredEvent['kind'],
    data: Record<string, unknown>,
  ): StoredEvent => ({
    seq,
    ts: `2026-11-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
    kind,
    data,
  });
  const assistant = (content: unknown[]) => ({
    raw: { type: 'assistant', message: { role: 'assistant', content }, session_id: 's1' },
  });
  const toolResult = (id: string, content: unknown, isError = false) => ({
    raw: {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
      },
      session_id: 's1',
    },
  });
  const fixture: StoredEvent[] = [
    ev(1, 'phase', { phase: 'clone' }),
    ev(2, 'phase', { phase: 'claude' }),
    ev(3, 'agent', assistant([{ type: 'text', text: 'I will read the sync module first.' }])),
    ev(
      4,
      'agent',
      assistant([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { file_path: 'apps/server/src/sync.ts' },
        },
      ]),
    ),
    ev(5, 'agent', toolResult('t1', 'export function sync() {}')),
    ev(
      6,
      'agent',
      assistant([
        {
          type: 'tool_use',
          id: 't2',
          name: 'Bash',
          input: { command: 'npm test', description: 'run tests' },
        },
      ]),
    ),
    ev(7, 'agent', toolResult('t2', [{ type: 'text', text: 'Tests failed: 1' }], true)),
    ev(
      8,
      'agent',
      assistant([
        {
          type: 'tool_use',
          id: 't3',
          name: 'Grep',
          input: { pattern: 'escapeHtml', path: 'apps' },
        },
      ]),
    ),
    ev(9, 'agent', toolResult('t3', 'apps/server/src/ui/pages.ts')),
    ev(
      10,
      'agent',
      assistant([
        {
          type: 'tool_use',
          id: 't4',
          name: 'TodoWrite',
          input: { todos: [{ content: 'x'.repeat(300) }] },
        },
      ]),
    ),
    ev(11, 'rate_limit', { status: 'allowed', rateLimitType: 'five_hour' }),
    ev(12, 'agent', { ...toolResult('t4', 'ok…[truncated 70000 chars]'), truncated: true }),
    ev(13, 'agent', { raw: { type: 'mystery_event', note: 'kept' } }),
    ev(14, 'agent', {
      raw: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 65400,
        num_turns: 14,
        total_cost_usd: 0.4213,
      },
    }),
    ev(15, 'agent', { result: true, isError: false, terminalReason: 'completed' }),
    ev(16, 'phase', { phase: 'gates' }),
    ev(17, 'gate', {
      name: 'lint',
      exitCode: 0,
      timedOut: false,
      durationMs: 1200,
      outputTail: 'all clean',
    }),
    ev(18, 'gate', {
      name: 'test',
      exitCode: 1,
      timedOut: false,
      durationMs: 30500,
      outputTail: '1 failed',
    }),
    ev(19, 'egress', { host: 'registry.npmjs.org', decision: 'allow', count: 4 }),
    ev(20, 'phase', { phase: 'checkpoint' }),
  ];
  const transcriptOf = (html: string) => {
    const start = html.indexOf('<h3>Transcript</h3>');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('<details class="raw-events">'));
  };

  test('every shape renders, labeled, in seq order', () => {
    const t = transcriptOf(renderDrop(drop, fixture));
    const marks = [
      '<div class="t-phase">clone</div>',
      '<div class="t-phase">claude</div>',
      '<div class="t-text"><b>Claude</b><p>I will read the sync module first.</p></div>',
      '<b>Read</b> apps/server/src/sync.ts',
      '<summary>result</summary><pre>export function sync() {}</pre>',
      '<b>Bash</b> npm test',
      '<summary>error</summary><pre>Tests failed: 1</pre>',
      '<b>Grep</b> escapeHtml',
      `<b>TodoWrite</b> ${escapeHtml(JSON.stringify({ todos: [{ content: 'x'.repeat(300) }] }).slice(0, 200))}<`,
      '<summary>rate_limit</summary>',
      'cut when stored (over 63 KB)',
      '<summary>agent: mystery_event</summary><pre>{&quot;type&quot;:&quot;mystery_event&quot;,&quot;note&quot;:&quot;kept&quot;}</pre>',
      'Run ended: success, 65.4 s, 14 turns, $0.4213',
      'Run ended: completed',
      '<div class="t-phase">gates</div>',
      'Gate <b>lint</b>: exit 0, 1.2 s<details><summary>output</summary><pre>all clean</pre></details>',
      'Gate <b>test</b>: exit 1, 30.5 s<details><summary>output</summary><pre>1 failed</pre></details>',
      '<summary>egress</summary>',
      '<div class="t-phase">checkpoint</div>',
    ];
    let at = -1;
    for (const m of marks) {
      const i = t.indexOf(m, at + 1);
      expect(i, m).toBeGreaterThan(at);
      at = i;
    }
    // The full tool input sits collapsed beside its one-line summary.
    expect(t).toContain(
      '<details><summary>input</summary><pre>{&quot;command&quot;:&quot;npm test&quot;,&quot;description&quot;:&quot;run tests&quot;}</pre></details>',
    );
    // Only the stored-truncated event carries the marker.
    expect(t.split('cut when stored').length - 1).toBe(1);
  });

  test('the transcript sits above the raw table', () => {
    const html = renderDrop(drop, fixture);
    expect(html.indexOf('<h3>Transcript</h3>')).toBeLessThan(
      html.indexOf('<details class="raw-events">'),
    );
  });

  const XSS = '<script>alert(1)</script>';
  const ESC = '&lt;script&gt;alert(1)&lt;/script&gt;';

  test('XSS in assistant text, tool name, tool input and tool result is escaped', () => {
    const html = renderDrop(drop, [
      ev(1, 'agent', assistant([{ type: 'text', text: XSS }])),
      ev(
        2,
        'agent',
        assistant([{ type: 'tool_use', id: 'a', name: XSS, input: { command: XSS } }]),
      ),
      ev(
        3,
        'agent',
        assistant([{ type: 'tool_use', id: 'b', name: 'Write', input: { content: XSS } }]),
      ),
      ev(4, 'agent', toolResult('a', XSS)),
      ev(5, 'agent', toolResult('b', [{ type: 'text', text: XSS }], true)),
    ]);
    expect(html).not.toContain(XSS);
    const t = transcriptOf(html);
    expect(t).toContain(`<div class="t-text"><b>Claude</b><p>${ESC}</p></div>`);
    expect(t).toContain(
      `<b>${ESC}</b> ${ESC}<details><summary>input</summary><pre>{&quot;command&quot;:&quot;${ESC}&quot;}</pre></details>`,
    );
    expect(t).toContain(`<b>Write</b> {&quot;content&quot;:&quot;${ESC}&quot;}`);
    expect(t).toContain(`<summary>result</summary><pre>${ESC}</pre>`);
    expect(t).toContain(`<summary>error</summary><pre>${ESC}</pre>`);
  });

  test('XSS in the result, gates, phases and unknown shapes is escaped', () => {
    const html = renderDrop(drop, [
      ev(1, 'phase', { phase: XSS }),
      ev(2, 'agent', { raw: { type: 'result', subtype: XSS, duration_ms: 1000 } }),
      ev(3, 'agent', { result: true, isError: true, terminalReason: XSS }),
      ev(4, 'gate', { name: XSS, exitCode: XSS, durationMs: 1000, outputTail: XSS }),
      ev(5, 'agent', { raw: { type: XSS, x: XSS } }),
      ev(6, 'log', { msg: XSS }),
    ]);
    expect(html).not.toContain(XSS);
    const t = transcriptOf(html);
    expect(t).toContain(`<div class="t-phase">${ESC}</div>`);
    expect(t).toContain(`Run ended: ${ESC}, 1.0 s`);
    expect(t).toContain(`Run ended: error, ${ESC}`);
    expect(t).toContain(
      `Gate <b>${ESC}</b>: exit ${ESC}, 1.0 s<details><summary>output</summary><pre>${ESC}</pre></details>`,
    );
    expect(t).toContain(
      `<summary>agent: ${ESC}</summary><pre>{&quot;type&quot;:&quot;${ESC}&quot;,&quot;x&quot;:&quot;${ESC}&quot;}</pre>`,
    );
    expect(t).toContain(`<summary>log</summary><pre>{&quot;msg&quot;:&quot;${ESC}&quot;}</pre>`);
  });

  test('a result over 4000 characters is shortened and states its full length', () => {
    const long = `${'a'.repeat(3999)}b${'c'.repeat(6000)}`;
    const t = transcriptOf(renderDrop(drop, [ev(1, 'agent', toolResult('a', long))]));
    expect(t).toContain(`<pre>${'a'.repeat(3999)}b</pre>`);
    expect(t).not.toContain('bc');
    expect(t).toContain('First 4000 of 10000 characters.');
    // A short result carries no such note.
    expect(
      transcriptOf(renderDrop(drop, [ev(1, 'agent', toolResult('a', 'short'))])),
    ).not.toContain('characters.');
  });

  test('an event cut when stored shows the marker, even with nothing else left', () => {
    const t = transcriptOf(
      renderDrop(drop, [
        ev(1, 'agent', { truncated: true, bytes: 900000 }),
        ev(2, 'gate', {
          name: 'lint',
          exitCode: 0,
          durationMs: 1,
          outputTail: 'x',
          truncated: true,
        }),
      ]),
    );
    expect(t.split('cut when stored (over 63 KB)').length - 1).toBe(2);
    expect(t).toContain('{&quot;truncated&quot;:true,&quot;bytes&quot;:900000}');
  });

  test('no events and no agent events are told apart', () => {
    const none = renderDrop(drop, []);
    expect(none).toContain('No events recorded');
    expect(none).not.toContain('No agent transcript');
    const doctor = renderDrop(drop, [
      ev(1, 'phase', { phase: 'gates' }),
      ev(2, 'gate', { name: 'check', exitCode: 0, durationMs: 5, outputTail: '' }),
    ]);
    expect(doctor).toContain('No agent transcript in this drop');
    expect(doctor).not.toContain('No events recorded');
    expect(doctor).toContain('Gate <b>check</b>');
    const full = renderDrop(drop, fixture);
    expect(full).not.toContain('No agent transcript');
    expect(full).not.toContain('No events recorded');
  });

  test('a pruned transcript says when and where it went, unlike one that never had events', () => {
    const archived = renderDrop(drop, [], [], {
      prunedAt: '2026-11-16T12:00:00.000Z',
      archive: 'transcripts/main/2026-08/d1.jsonl.gz',
    });
    expect(archived).toContain(
      'Transcript pruned on 2026-11-16; archived at transcripts/main/2026-08/d1.jsonl.gz',
    );
    expect(archived).not.toContain('No events recorded');
    const lost = renderDrop(drop, [], [], { prunedAt: '2026-11-16T12:00:00.000Z', archive: null });
    expect(lost).toContain('Transcript pruned on 2026-11-16; not archived');
    const never = renderDrop(drop, []);
    expect(never).toContain('No events recorded');
    expect(never).not.toContain('pruned');
    // The path is escaped like any other field.
    expect(renderDrop(drop, [], [], { prunedAt: 'x', archive: '<b>' })).toContain('&lt;b&gt;');
  });

  test('the raw table stays, collapsed, with the event count', () => {
    const html = renderDrop(drop, fixture);
    const raw = html.slice(html.indexOf('<details class="raw-events">'));
    expect(raw).toMatch(
      /^<details class="raw-events"><summary>Raw events \(20\)<\/summary><table>/,
    );
    expect(raw.match(/<tr><td>\d+<\/td>/g)).toHaveLength(fixture.length);
    expect(renderDrop(drop, [])).toContain('<summary>Raw events (0)</summary>');
  });
});

describe('every briefing stands on its own (#226)', () => {
  const at = new Date('2026-11-01T10:00:00Z');
  const refs = {
    repo: 'octo/demo',
    crewKeys: new Map([['app-push-token', 231]]),
  };

  test('About resolves each subject form to its text and link', () => {
    const w = zoneWorld();
    const filed = insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'app-push-token',
      source: 'drop',
      objective: 'o',
      title: 'Push tokens in app mode',
      body: 'b',
      priority: null,
      createdAt: at.toISOString(),
      number: 224,
    });
    const unfiled = insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'kill-suspend-installations',
      source: 'drop',
      objective: 'o',
      title: 'Kill suspends installations',
      body: 'b',
      priority: null,
      createdAt: at.toISOString(),
    });
    const item = w.item(3, 'parked');
    const about = (subject: string) => briefingAbout(w.db, w.zone, { subject });
    expect(about(`issue:${filed}`)).toEqual({
      text: '#224 Push tokens in app mode',
      url: 'https://github.com/octo/demo/issues/224',
    });
    expect(about(`issue:${unfiled}`)).toEqual({
      text: 'crew issue kill-suspend-installations (not filed yet)',
    });
    expect(about(`item:${item}`)).toEqual({
      text: '#3 Issue 3',
      url: 'https://github.com/octo/demo/issues/3',
    });
    expect(about('crew:split the push work')).toEqual({ text: 'split the push work' });
    expect(about('credits:fable')).toEqual({ text: 'credits:fable' });
    expect(about('issue:999')).toEqual({ text: 'issue:999' });
    expect(crewKeyNumbers(w.db, 'main')).toEqual(new Map([['app-push-token', 224]]));
  });

  test('linkify links #n, Ruling n, Briefing n, known crew keys and a drop page, nothing else', () => {
    expect(linkify('see #12.', refs)).toBe(
      'see <a href="https://github.com/octo/demo/issues/12" target="_blank" rel="noopener noreferrer">#12</a>.',
    );
    expect(linkify('after Ruling 42', refs)).toBe(
      'after <a href="/briefings#ruling-42">Ruling 42</a>',
    );
    expect(
      linkify('after Ruling 42 and Briefing 125', {
        ...refs,
        rulingHref: (n) => `#ruling-${n}`,
        briefingHref: (n) => `#briefing-${n}`,
      }),
    ).toBe('after <a href="#ruling-42">Ruling 42</a> and <a href="#briefing-125">Briefing 125</a>');
    expect(linkify('Briefing 125', refs)).toBe('<a href="/briefings/125">Briefing 125</a>');
    expect(linkify('land app-push-token first', refs)).toBe(
      'land app-push-token (<a href="https://github.com/octo/demo/issues/231" target="_blank" rel="noopener noreferrer">#231</a>) first',
    );
    expect(linkify('  full text: /drops/d-1', refs)).toBe('  <a href="/drops/d-1">full text</a>');
    // Not a reference: an issue number inside a word, an entity, an unknown key.
    expect(linkify('PR#12 &#39; kill-suspend-installations app-push-tokens', refs)).toBe(
      'PR#12 &amp;#39; kill-suspend-installations app-push-tokens',
    );
    // Without the zone's repository no issue link is built.
    expect(linkify('#12 app-push-token', {})).toBe('#12 app-push-token');
  });

  test('a script beside #12 is escaped, and the #12 link is the only markup (D4)', () => {
    const evil = '<script>alert(1)</script><a href="javascript:x">#13</a> "Ruling 1" #12';
    const html = linkify(evil, refs);
    expect(html).not.toContain('<script');
    expect(html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;a href=&quot;javascript:x&quot;&gt;',
    );
    // Strip the links the patterns built: no other tag is left.
    const rest = html.replace(
      /<a href="[^"]*"( target="_blank" rel="noopener noreferrer")?>[^<]*<\/a>/g,
      '',
    );
    expect(rest).not.toMatch(/[<>"]/);
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('<a href="https://github.com/octo/demo/issues/12"');
    // In a rendered briefing the same holds for every field.
    const page = renderBriefings({
      open: [briefing({ decision: evil, why: evil, recommendation: evil, onHold: evil })],
      rulings: [],
      zones: [z],
    });
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain('javascript:x"');
  });

  test('every option effect has its line, and the page shows it beside the label', () => {
    for (const e of EFFECTS) expect(EFFECT_TEXT[e].text, e).toMatch(/\w/);
    expect(Object.keys(EFFECT_TEXT).sort()).toEqual([...EFFECTS].sort());
    expect(effectText('promote', 'promote_issue')).toBe(
      'the issue gets the ready label; an implementer takes it as written',
    );
    expect(effectText('promote', 'reject_issue')).toBe(
      'the issue is closed; the crew may file a replacement',
    );
    expect(effectText('crew', 'none')).toBe(
      'recorded as guidance for the crew; nothing changes on GitHub',
    );
    expect(effectText('parked', 'retry_item')).toMatch(/runs it again/);
    expect(effectText('parked', 'none')).toMatch(/stays parked/);
    const html = renderBriefings({
      open: [
        briefing({
          kind: 'promote',
          options: [{ id: 'promote', label: 'Promote', effect: 'promote_issue' }],
        }),
      ],
      rulings: [],
      zones: [z],
    });
    expect(html).toContain(
      'Promote</label> <small><code>promote</code></small> <small class="effect">the issue gets the ready label; an implementer takes it as written</small>',
    );
  });

  test('a refute_exhausted briefing quotes both refutes and ends with the line the code writes', () => {
    const w = zoneWorld();
    const id = insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'app-push-token',
      source: 'drop',
      objective: 'o',
      title: 'Push tokens in app mode',
      body: 'b',
      priority: null,
      createdAt: at.toISOString(),
      number: 224,
    });
    setCrewIssue(w.db, id, { refuteCount: 2 }, at);
    const refute = (dropId: string, minute: number, findings: string[]) => {
      insertDrop(
        w.db,
        {
          id: dropId,
          dropZoneId: 'main',
          workItemId: null,
          role: 'refute',
          state: 'succeeded',
          inputJson: JSON.stringify({ work: { role: 'refute', crewIssueId: id }, input: '' }),
        },
        new Date(at.getTime() + minute * 60_000),
      );
      updateDrop(w.db, dropId, {
        finishedAt: new Date(at.getTime() + (minute + 5) * 60_000).toISOString(),
        resultJson: JSON.stringify({
          status: 'completed',
          crew: { decision: 'revise', findings, revisedBody: 'x' },
        }),
      });
    };
    refute('r1', 0, ['Criterion 2 is not testable.', `Long ${'x'.repeat(600)}`]);
    refute('r2', 60, ['The token scope needs contents:write <b>only</b>.']);
    const issue = getCrewIssue(w.db, id);
    if (!issue) throw new Error('no issue');
    const why = refuteExhaustedWhy(w.db, issue);
    expect(why).toContain(
      "#224 Push tokens in app mode was reviewed 2 times. Each review asked for changes, and the last revision hasn't been reviewed.",
    );
    expect(why).toContain(
      'Review 1 (2026-11-01 10:05 UTC), asked to revise:\n  1. Criterion 2 is not testable.',
    );
    expect(why).toContain('Review 2 (2026-11-01 11:05 UTC)');
    expect(why).toContain('full text: /drops/r1');
    const long = why.split('\n').find((l) => l.includes('Long '));
    expect(long?.trim().length).toBeLessThanOrEqual(3 + MAX_FINDING);
    expect(why.endsWith(`\n\n${REFUTE_RECOMMENDATION}`)).toBe(true);
    expect(REFUTE_RECOMMENDATION).toBe(
      "Promote if the last review's findings were only wording; reject if it found a design problem.",
    );

    const b = briefing({
      id: 142,
      kind: 'refute_exhausted',
      subject: `issue:${id}`,
      decision: 'Promote crew issue #224 as revised?',
      why,
      source: 'server',
      options: [
        { id: 'promote', label: 'Promote', effect: 'promote_issue' },
        { id: 'reject', label: 'Reject', effect: 'reject_issue' },
      ],
    });
    const html = renderBriefings({
      open: [b],
      rulings: [],
      zones: [z],
      about: new Map([[b.id, briefingAbout(w.db, w.zone, b)]]),
    });
    expect(html).toContain(
      '<a href="https://github.com/octo/demo/issues/224" target="_blank" rel="noopener noreferrer">#224 Push tokens in app mode</a>',
    );
    expect(html).toContain('Criterion 2 is not testable.');
    expect(html).toContain('contents:write &lt;b&gt;only&lt;/b&gt;');
    expect(html).toContain('<a href="/drops/r2">full text</a>');
    expect(html).toContain('Promote if the last review&#39;s findings were only wording');
    expect(html).toContain('id="briefing-142"');
  });

  test('a briefing the crew is still to diagnose shows a notice in place of the rule form (#397)', () => {
    const parked = briefing({
      id: 6,
      kind: 'parked',
      why: 'The test gate failed: `a.test.ts` > x',
    });
    const notice =
      '<p class="pending">The crew is looking at this. You&#39;ll be asked if it needs you.</p>';
    for (const html of [
      renderBriefings({ open: [parked], rulings: [], zones: [z], pending: new Set([6]) }),
      renderBriefings({
        open: [parked],
        rulings: [],
        zones: [z],
        zone: { id: 'main', mode: 'active' },
        pending: new Set([6]),
      }),
      renderBriefing({ briefing: parked, rulings: [], zones: [z], pending: true }),
    ]) {
      expect(html).toContain(notice);
      expect(html).not.toContain('class="rule"');
      expect(html).not.toContain('type="radio"');
      // The why and the options stay, read only.
      expect(html).toContain('<pre>The test gate failed: `a.test.ts` &gt; x</pre>');
      expect(html).toContain('<li>Split it <small><code>o1</code></small>');
    }
    // Not pending: the rule form, as before.
    for (const html of [
      renderBriefings({ open: [parked], rulings: [], zones: [z], pending: new Set([7]) }),
      renderBriefings({ open: [parked], rulings: [], zones: [z] }),
      renderBriefing({ briefing: parked, rulings: [], zones: [z], pending: false }),
    ]) {
      expect(html).not.toContain('class="pending"');
      expect(html).toContain('<form class="rule" data-briefing="6"');
    }
  });

  test('/briefings/<n> shows one briefing with its rulings, and the lists carry anchors', () => {
    const ruled = briefing({ id: 7, state: 'ruled', decision: 'Split it, after Ruling 3?' });
    const one = renderBriefing({
      briefing: ruled,
      rulings: [ruling({ id: 3, briefingId: 7 }), ruling({ id: 9, briefingId: 2 })],
      zones: [z],
    });
    expect(one).toContain('id="briefing-7"');
    expect(one).toContain('<tr id="ruling-3">');
    expect(one).not.toContain('id="ruling-9"');
    expect(one).toContain('<a href="#ruling-3">Ruling 3</a>');
    expect(one).toContain('ruled');
    // A ruled briefing has no rule form.
    expect(one).not.toContain('class="rule"');
    const open = renderBriefing({ briefing: briefing({ id: 8 }), rulings: [], zones: [z] });
    expect(open).toContain('class="rule"');
    const list = renderBriefings({
      open: [briefing({ id: 8, why: 'see Briefing 8, Briefing 2 and Ruling 1 and Ruling 5' })],
      rulings: [ruling({ id: 1, briefingId: 2 }), ruling({ id: 5, briefingId: 3 })],
      zones: [z],
      per: 10,
    });
    expect(list).toContain('id="briefing-8"');
    expect(list).toContain('<tr id="ruling-1">');
    expect(list).toContain('<a href="#briefing-8">Briefing 8</a>');
    expect(list).toContain('<a href="/briefings/2">Briefing 2</a>');
    expect(list).toContain('<a href="#ruling-1">Ruling 1</a>');
    expect(list).toContain('<a href="#ruling-5">Ruling 5</a>');
    // Each briefing links to its own page.
    expect(list).toContain('<a href="/briefings/8">');
  });
});

describe('the tab icon (#334)', () => {
  const LINK = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,';

  test('every page, with or without chrome, links the parachute mark as its icon', () => {
    expect(page('x')).toContain(LINK);
    expect(page('x', { chrome: false })).toContain(LINK);
  });

  test("the icon is the top bar's mark, drawn from the same paths, with no currentColor", () => {
    const prefix = 'data:image/svg+xml,';
    expect(FAVICON_HREF.startsWith(prefix)).toBe(true);
    const svg = decodeURIComponent(FAVICON_HREF.slice(prefix.length));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain('currentColor');
    const ds = [...MARK.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]);
    expect(ds.length).toBe(2);
    for (const d of ds) expect(svg).toContain(`d="${d}"`);
    expect(svg).toContain('<circle cx="10" cy="17" r="1.6"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  test('GET /setup and GET /login carry the icon link', async () => {
    const h = await harness({
      live: true,
      zone: { protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'] },
    });
    // Before an operator exists, the guard sends everyone to the setup page.
    const setup = await h.app.inject({ method: 'GET', url: '/setup' });
    expect(setup.statusCode).toBe(200);
    expect(setup.body).toContain(LINK);
    await h.view('/'); // signs the operator in, so the login page is served
    const res = await h.app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(LINK);
  });
});

describe('Ask about this (#103)', () => {
  const askForm = (html: string): string => {
    const at = html.indexOf('<form class="ask"');
    expect(at).toBeGreaterThanOrEqual(0);
    return html.slice(at, html.indexOf('</form>', at) + 7);
  };

  test('the zone page, the goals page and a briefing page each carry Ask about this with their focus', () => {
    const goalsHtml = renderGoals({
      zone: z,
      zones: [z],
      goals: undefined,
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [],
      doneByRuling: new Map(),
    });
    const g = askForm(goalsHtml);
    expect(g).toContain('Ask about this');
    expect(g).toContain('data-focus-kind="goals"');
    expect(g).toContain('data-focus-zone="main"');
    expect(g).toContain('data-focus-ref="main"');
    const briefingHtml = renderBriefing({
      briefing: briefing({ id: 12 }),
      rulings: [],
      zones: [z],
    });
    const b = askForm(briefingHtml);
    expect(b).toContain('Ask about this');
    expect(b).toContain('data-focus-kind="briefing"');
    expect(b).toContain('data-focus-zone="main"');
    expect(b).toContain('data-focus-ref="12"');
    // The page script posts the focus and goes to the new thread.
    for (const html of [goalsHtml, briefingHtml]) {
      expect(html).toContain("jmFetch('/api/chat/threads'");
      expect(html).toContain("'/chat/'+encodeURIComponent(");
    }
  });

  test("the button's focus values are escaped", () => {
    const html = askButton({ kind: 'zone', zoneId: '"><img src=x>', ref: "a'&<b>" });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('data-focus-zone="&quot;&gt;&lt;img src=x&gt;"');
    expect(html).toContain('data-focus-ref="a&#39;&amp;&lt;b&gt;"');
  });
});

describe('the drop page header and system-event groups (#499)', () => {
  const jm: DropZoneConfig = { ...z, id: 'jm', repo: 'octo/jm' };
  const now = new Date('2026-01-01T01:00:00.000Z');
  const issue: WorkItem = { ...item, id: 42, dropZoneId: 'jm', issueNumber: 487, title: 'Header' };
  const implement: Drop = {
    ...drop,
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    dropZoneId: 'jm',
    workItemId: 42,
    stickId: 'kidney',
    prNumber: 12,
    headSha: '0123456789abcdef',
  };
  const summaryOf = (html: string) =>
    html.slice(html.indexOf('<dl class="drop-summary">'), html.indexOf('</dl>'));

  test('an implement drop shows project, issue, PR, stick, times and its short id', () => {
    const html = renderDrop(implement, [], [], null, { item: issue, zones: [jm], now });
    expect(html).toContain(
      '<h2 title="abcdef12-3456-7890-abcd-ef1234567890">implement drop abcdef12</h2>',
    );
    expect(html).toContain('<code>abcdef12-3456-7890-abcd-ef1234567890</code>');
    const s = summaryOf(html);
    expect(s).toContain('<a href="/zones/jm">octo/jm</a>');
    expect(s).toContain('<a href="/work/jm/487">#487 Header</a>');
    expect(s).toContain('kidney');
    expect(s).toContain('https://github.com/octo/jm/pull/12');
    expect(s).toContain('<code>0123456</code>');
    expect(s).toContain('<time datetime="2026-01-01T00:01:05.000Z"');
    expect(s).toContain('1m 5s');
    expect(s).toContain('lint&lt;b&gt;: pass');
    expect(html.slice(html.indexOf('</dl>'), html.indexOf('<h3>Transcript'))).toContain(
      'Requested model:',
    );
    expect(html.indexOf('<dl class="drop-summary">')).toBeLessThan(html.indexOf('<h3>Transcript'));
    expect(html).toContain(
      '<a href="/work">Work</a> › <a href="/work?zone=jm">octo/jm</a> › <a href="/work/jm/487">#487</a> › abcdef12',
    );
    expect(html).not.toContain('href="/">Back');
  });

  const styleOf = (html: string) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  test('the summary list is styled as a key/value grid (#577)', () => {
    const html = renderDrop(implement, [], [], null, { item: issue, zones: [jm], now });
    const cls = /<dl class="([^"]+)">/.exec(html.slice(html.indexOf('<h2 title=')))?.[1] ?? '';
    expect(cls).not.toBe('');
    const css = styleOf(html);
    const classes = cls.split(/\s+/);
    expect(classes.some((c) => new RegExp(`dl\\.${c}\\{[^}]*display:grid`).test(css))).toBe(true);
    expect(classes.some((c) => css.includes(`dl.${c} dd{margin:0`))).toBe(true);
  });

  test('the stylesheet sets an opened system-event group apart (#577)', () => {
    const html = renderDrop(drop, [sys(1), sys(2)]);
    expect(html).toContain('<details class="t-system">');
    expect(styleOf(html)).toMatch(/\.t-system[^{]*\{[^}]*(border|margin-left|padding-left)/);
  });

  test('a crew drop shows crew and the Drops breadcrumb', () => {
    const html = renderDrop({ ...implement, role: 'crew', workItemId: null }, [], [], null, {
      zones: [jm],
      now,
    });
    expect(summaryOf(html)).toContain('<dd>crew</dd>');
    expect(html).toContain('<a href="/drops">Drops</a> › abcdef12');
    expect(html).not.toContain('<a href="/work">Work</a> ›');
  });

  test('a drop with no work item, stick or times shows - in those fields', () => {
    const bare: Drop = {
      ...drop,
      workItemId: 5,
      stickId: null,
      startedAt: null,
      finishedAt: null,
      prNumber: null,
      headSha: null,
      resultJson: null,
    };
    const s = summaryOf(renderDrop(bare, []));
    for (const f of ['Work', 'Stick', 'Started', 'Finished', 'Elapsed', 'PR', 'Head', 'Gates']) {
      expect(s).toContain(`<dt>${f}</dt><dd>-</dd>`);
    }
  });

  const sys = (seq: number) =>
    ({
      seq,
      ts: 't',
      kind: 'agent',
      data: { raw: { type: 'system', marker: `sys-${seq}` } },
    }) as const;
  const text = (seq: number) =>
    ({
      seq,
      ts: 't',
      kind: 'agent',
      data: {
        raw: { type: 'assistant', message: { content: [{ type: 'text', text: `txt-${seq}` }] } },
      },
    }) as const;

  test('runs of two or more system events fold into one group; a lone one does not', () => {
    const html = renderDrop(drop, [sys(1), sys(2), sys(3), text(4), sys(5)]);
    const t = html.slice(
      html.indexOf('<h3>Transcript</h3>'),
      html.indexOf('<details class="raw-events">'),
    );
    expect(t.match(/<details class="t-system">/g)).toHaveLength(1);
    expect(t).toContain('<summary>3 system events</summary>');
    const group = t.indexOf('<details class="t-system">');
    const groupEnd = t.indexOf('</details></details>', group);
    expect(t.indexOf('sys-3')).toBeLessThan(groupEnd);
    expect(t.indexOf('txt-4')).toBeGreaterThan(groupEnd);
    expect(t.indexOf('sys-5')).toBeGreaterThan(t.indexOf('txt-4'));
    // sys-5 stays outside any group: nothing after the text opens one.
    expect(t.slice(t.indexOf('txt-4'))).not.toContain('t-system');
    for (const m of ['sys-1', 'sys-2', 'sys-3', 'txt-4', 'sys-5']) {
      expect(t.split(m)).toHaveLength(2);
    }
  });
});
