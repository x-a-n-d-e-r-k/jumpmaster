import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { routesOf } from '../app.js';
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
import { createThread } from '../chat/store.js';
import type { ClaudePlan, DropZoneConfig } from '../config.js';
import { STARTER_WARNING } from '../config.js';
import { type CrewIssue, getCrewIssue, insertCrewIssue, setCrewIssue } from '../crew/store.js';
import type { Drop, StoredEvent, UsageWindowRow, WorkItem } from '../db/repo.js';
import { insertDrop, setKilled, updateDrop, upsertDropZone, upsertWorkItem } from '../db/repo.js';
import type { GoalChange } from '../goal-change.js';
import type { GoalRow } from '../goals.js';
import { forgetSubmitKey, submitKey } from '../intake.js';
import { statusOf } from '../status.js';
import { makeZone, zoneWorld } from '../test/fixtures.js';
import { harness } from '../test/flowHarness.js';
import {
  askButton,
  breadcrumb,
  type CrewLine,
  DROP_HEAD,
  dismissAllForm,
  dropRows,
  escapeHtml,
  FAVICON_HREF,
  fillChrome,
  goalStub,
  KILL_SCRIPT,
  KILLED_NOTICE,
  type LogObservation,
  linkify,
  logEntries,
  MARK,
  modelFamily,
  navArea,
  needsBadge,
  OBSERVATION_ACTIONS,
  observationWords,
  page,
  projectHeader,
  renderBriefing,
  renderDoctor,
  renderDrop,
  renderDropList,
  renderGoals,
  renderHome,
  renderLog,
  renderNewIssue,
  renderWorkItem,
  renderWorkList,
  STORE_NAV,
  STORE_NAV_SLOT,
  STUB_SCRIPT,
  statusBanner,
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
  test("Capacity shows each stick's troopers busy out of its total, escaped, an offline one marked (#625)", () => {
    const now = new Date('2026-01-01T00:00:30.000Z');
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [
        { ...drop, id: 'r1', state: 'running', stickId: 's1', finishedAt: null },
        { ...drop, id: 'r2', state: 'leased', stickId: 's1', finishedAt: null },
        { ...drop, id: 'q1', state: 'queued', stickId: null, finishedAt: null },
      ],
      now,
      sticks: [
        {
          id: 's1',
          name: 'old<stick>',
          version: null,
          lastSeenAt: '2026-01-01T00:00:00.000Z',
          capabilities: [],
          imagePolicy: 'allowlist',
          cannotRun: [{ zoneId: 'locked', missing: ['egress-v1'] }],
          slots: 3,
        },
        {
          id: 's2',
          name: 'new',
          version: '0.4.0',
          lastSeenAt: null,
          capabilities: ['egress-v1'],
          imagePolicy: 'signed',
          cannotRun: [],
          slots: 2,
        },
      ],
    });
    const capacity = html.slice(html.indexOf('id="capacity"'), html.indexOf('id="pipeline"'));
    // Each stick names a project it cannot run and what it lacks.
    expect(capacity).toContain(
      'old&lt;stick&gt;: 2 of 3 troopers busy <small class="cannot-run">cannot run locked: lacks egress-v1</small></li>',
    );
    expect(capacity).toContain('new: 0 of 2 troopers busy <small class="muted">offline</small>');
    expect(html).not.toContain('old<stick>');
    // The status's "See the sticks" link lands here.
    expect(capacity).toContain('<div id="sticks">');
    expect(renderHome({ zones: [z], items: [], drops: [], sticks: [] })).toContain(
      'No stick has enrolled.',
    );
  });

  test("a project row links the project's New issue page and its page, the id encoded (#625)", () => {
    const id = 'a"<>&/b';
    const html = renderHome({ zones: [{ ...z, id }], items: [], drops: [] });
    const enc = encodeURIComponent(id);
    expect(html).toContain(`<a href="/projects/${enc}/issues/new">New issue</a>`);
    expect(html).toContain(`<a href="/projects/${enc}">Open</a>`);
    expect(html).not.toContain(id);
  });

  test('escapes issue titles', () => {
    const html = renderHome({
      zones: [z],
      items: [{ ...item, state: 'parked', title: '<script>alert(1)</script>' }],
      drops: [],
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
    expect(html).toContain('<a href="/projects/main/work/12">fix &lt;b&gt;it&lt;/b&gt;</a>');
    expect(html).not.toContain('/activity/drops?zone=main');
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
    expect(html).toContain('<a href="/projects/main">octo/demo</a>');
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
  test('#627 Ask on a drop page focuses the drop, its chip Drop and the 8-char id', () => {
    const html = renderDrop({ ...drop, id: '0123456789abcdef' }, []);
    expect(html).toContain(
      '<button type="button" id="ask-open" class="ask-open" aria-controls="ask-panel" aria-expanded="false" data-focus-kind="drop" data-focus-zone="main" data-focus-ref="0123456789abcdef">Ask</button>',
    );
    expect(html).toContain('<span class="chip">Drop 01234567</span>');
  });

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
  test('shows the gate in words, the bars, and no raw usage field as a label (#625)', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
      usage: { gate: 'closed', state: usageState, plan: 'pro', windows: [] },
    });
    const capacity = html.slice(html.indexOf('id="capacity"'), html.indexOf('id="pipeline"'));
    expect(capacity).toContain('<h2>Capacity</h2>');
    expect(capacity).toContain('Dispatch paused until');
    expect(capacity).toContain('datetime="2026-01-01T05:00:00.000Z"');
    expect(capacity).toContain('in 5 h');
    expect(capacity).toContain('97%');
    expect(capacity).toContain('41%');
    for (const raw of ['Gate', 'Overage', 'Cause drop', 'Paused until', 'Observed', 'closed'])
      expect(capacity, raw).not.toContain(raw);
    expect(capacity).not.toContain('d-cause');
  });

  test('a closed gate is paused until the later of its pause and its probe time, either alone (#625)', () => {
    const capacity = (state: typeof usageState) => {
      const html = renderHome({
        zones: [z],
        items: [],
        drops: [],
        now: new Date('2026-01-01T00:00:00.000Z'),
        usage: { gate: 'closed', state, plan: 'pro', windows: [] },
      });
      return html.slice(html.indexOf('id="capacity"'), html.indexOf('id="pipeline"'));
    };
    const later = '2026-01-01T07:00:00.000Z';
    // The probe time is later than the pause: it is the one shown.
    const probeLater = capacity({ ...usageState, probeNotBefore: later });
    expect(probeLater).toContain(`datetime="${later}"`);
    expect(probeLater).not.toContain('datetime="2026-01-01T05:00:00.000Z"');
    // The probe time alone, with no pause.
    const probeOnly = capacity({ ...usageState, pausedUntil: null, probeNotBefore: later });
    expect(probeOnly).toContain(
      `Dispatch paused until <span data-live-ignore><time datetime="${later}"`,
    );
    // The pause is later than the probe time: the pause is shown.
    const pauseLater = capacity({ ...usageState, probeNotBefore: '2026-01-01T02:00:00.000Z' });
    expect(pauseLater).toContain('datetime="2026-01-01T05:00:00.000Z"');
    expect(pauseLater).not.toContain('datetime="2026-01-01T02:00:00.000Z"');
  });

  test.each([
    ['open', 'Dispatch open'],
    ['finishing_only', 'Dispatch open to finishing work only'],
    ['probe', 'Dispatch probing'],
    ['stopped', 'Dispatch paused'],
    ['credits_resume', 'Dispatch open on credits'],
  ] as const)('the %s gate reads "%s"', (gate, words) => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      usage: { gate, state: usageState, plan: 'pro', windows: [] },
    });
    expect(html).toContain(words);
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
  test('Home lists each open briefing under Needs you, with its page as the one action (#625)', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      briefings: [briefing(), briefing({ id: 5, decision: 'Retry #7?' })],
    });
    const needs = html.slice(html.indexOf('id="waiting-on-you"'));
    expect(needs).toContain('<h2>Needs you</h2>');
    expect(needs).toContain('octo/demo: Split the CLI objective?');
    expect(needs).toContain('<a href="/briefings/4">Answer</a>');
    expect(needs).toContain('<a href="/briefings/5">Answer</a>');
    expect(html).not.toContain('href="/briefings"');
    expect(html).not.toContain('/briefings?');
  });

  test('an open briefing shows decision, why, options, recommendation and what is on hold', () => {
    const html = renderBriefing({ briefing: briefing(), rulings: [], zones: [z] });
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
    const html = renderBriefing({
      briefing: briefing({
        why: 'gate script changed: test\n  test: "a" → "<b>"',
        options: [{ id: 'allow-x', label: 'Allow', effect: 'allow_gate_change', sha: 'x' }],
      }),
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
    const html = renderBriefing({ briefing: parked, rulings: [], zones: [z] });
    expect(html).toMatch(
      /<pre>heal budget exhausted<\/pre><\/td><\/tr><tr><th>Diagnosis<\/th><td><pre>The test is flaky\.<\/pre>/,
    );
    // The ruling, with the diagnosis Command read, is on the project's Log (#621).
    const ruled = renderLog({
      zones: [z],
      kind: 'rulings',
      observations: [],
      rulings: [ruling({ diagnosis: 'Out of disk.' })],
      now: new Date(),
    });
    expect(ruled).toContain('diagnosis: Out of disk.');
  });

  test('a Promote ruling held while the crew is off says so; a Reject does not wait', () => {
    const off = { ...z, crew: { ...z.crew, enabled: false } };
    const on = { ...z, crew: { ...z.crew, enabled: true } };
    const rulings = [
      ruling({ id: 1, choice: 'promote', effect: 'promote_issue' }),
      ruling({ id: 2, choice: 'reject', effect: 'reject_issue' }),
    ];
    const log = (zones: DropZoneConfig[]) =>
      renderLog({ zones, kind: 'rulings', observations: [], rulings, now: new Date() });
    const html = log([off]);
    expect(html).toMatch(/Ruling 1<\/a>.*?promote <small>waiting: crew disabled/s);
    expect(html.match(/waiting: crew disabled/g)).toHaveLength(1);
    expect(log([on])).not.toContain('waiting: crew disabled');
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
    const html = renderBriefing({
      briefing: held,
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
    // The briefing's own page has the rule form; Home's Needs you lists only what needs you.
    const block = (await h.view(`/briefings/${held}`)).body;
    expect(block).toContain(`<form class="rule" data-briefing="${held}"`);
    expect(block).toContain('value="reject"');
    expect(block).toContain('value="promote"');
    expect(block).toContain('Promote now');
    const home = (await h.view('/')).body;
    expect(home).toContain(`<a href="/briefings/${parked}">Answer</a>`);
    expect(home).not.toContain(`/briefings/${held}"`);
  });

  test('a rule form posts optionId through jmFetch, with no token field', () => {
    const html = renderBriefing({ briefing: briefing(), rulings: [], zones: [z] });
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
      renderBriefing({ briefing: evil, rulings: [evilRuling], zones: [z] }) +
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

  test('#645 a crew-proposed change waits for its ruling; a chat-proposed one opens at the next pass', () => {
    const change = (id: number, source: GoalChange['source']): GoalChange => ({
      id,
      zoneId: z.id,
      source,
      sourceRef: 'r',
      text: 't',
      textSha256: 'x',
      baseSha: null,
      branch: null,
      prNumber: null,
      headSha: null,
      state: 'proposed',
      confirmedSha: null,
      confirmedAt: null,
      error: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const html = renderGoals({
      zone: z,
      zones: [z],
      goals: undefined,
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [],
      doneByRuling: new Map(),
      goalChanges: [change(1, 'chat'), change(2, 'crew')],
    });
    expect(html).toContain(
      '<li>Goal change 1, from the chat: Its pull request opens at the next pass.</li>',
    );
    expect(html).toContain(
      '<li>Goal change 2, from the crew: Waits for your ruling on its briefing.</li>',
    );
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
    expect(html).toContain('href="/projects/jm"');
  });

  test('a repo or goal path holding markup is escaped in the text and encoded in the link (#365)', () => {
    const html = ladder(withPath('<script>/g.md', 'o/<script>'), parsed);
    expect(html).not.toContain('<script>/g.md');
    expect(html).not.toContain('o/<script>');
    expect(html).toContain('The goals live in &lt;script&gt;/g.md in o/&lt;script&gt;.');
    expect(html).toContain('href="https://github.com/o/%3Cscript%3E/blob/HEAD/%3Cscript%3E/g.md"');
  });

  test('a missing goal file links the stub builder instead of GitHub (#365, #620)', () => {
    const html = ladder(
      withPath('a b/goals.md'),
      goals({ ok: false, error: 'a b/goals.md not found' }),
    );
    expect(html).toContain(
      `a b/goals.md isn't in the repository yet. <a href="#goal-stub">Draft one with the GOAL.md stub builder</a>.`,
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
  test('Home has no crew table: it is on Goals (#625)', () => {
    const html = renderHome({ zones: [z], items: [], drops: [] });
    expect(html).not.toContain('<h2>Crew</h2>');
    expect(html).not.toContain('<th>Crew</th>');
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

describe('the GOAL.md stub builder on Goals (#620)', () => {
  const zone = {
    id: 'main"><script>x</script>',
    repo: 'octo/<script>x</script>',
  } as DropZoneConfig;

  test('two steps, every value escaped, no secret, and a link to New issue instead of step 3', () => {
    const html = goalStub(zone, false);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toMatch(/^<details id="goal-stub"><summary>Draft a GOAL\.md<\/summary>/);
    for (const t of ['existing', 'idea', 'partial']) expect(html).toContain(`value="${t}"`);
    for (const id of [
      'stub-template',
      'stub-lighthouse',
      'stub-objectives',
      'stub-nongoals',
      'stub-constraints',
      'stub-out',
      'stub-copy',
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/Step 1/);
    expect(html).toMatch(/Step 2/);
    expect(html).not.toMatch(/Step 3/);
    expect(html).not.toContain('issue-form');
    expect(html).toContain(
      'data-base="/api/control/zones/main%22%3E%3Cscript%3Ex%3C%2Fscript%3E/intake"',
    );
    expect(html).toContain(
      'To file an issue, use <a href="/projects/main%22%3E%3Cscript%3Ex%3C%2Fscript%3E/issues/new"><strong>New issue</strong></a>',
    );
    expect(html).toContain(STUB_SCRIPT);
    expect(html).not.toContain('type="password"');
    expect(html).toContain('const r = await jmFetch(base + path, body);');
    expect(html).not.toMatch(/github_pat_|ghp_|sk-ant-/);
    expect(html).not.toContain('innerHTML');
    expect(goalStub(zone, true)).toMatch(/^<details id="goal-stub" open>/);
  });

  const zone2 = makeZone({ id: 'jm', repo: 'octo/jm' });
  const goalsPage = (g: GoalRow | undefined, crew?: CrewLine, now?: Date) =>
    renderGoals({
      zone: zone2,
      zones: [zone2],
      goals: g,
      crewIssues: [crewIssue()],
      items: [],
      skippedCrewUnpromoted: [],
      doneByRuling: new Map(),
      ...(crew ? { crew } : {}),
      ...(now ? { now } : {}),
    });
  const withGoals = goals({
    ok: true,
    lighthouse: 'L',
    sections: {},
    objectives: [{ key: 'a', title: 'A', done: false, body: '' }],
  });
  const opening = (html: string) => html.match(/<details id="goal-stub"[^>]*>/)?.[0];

  test('with goals, the builder is closed and comes after the ladder and the crew issues', () => {
    const html = goalsPage(withGoals);
    expect(opening(html)).toBe('<details id="goal-stub">');
    const at = html.indexOf('id="goal-stub"');
    expect(html.indexOf('<h2>Objectives (goal ladder)</h2>')).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(html.indexOf('<h2>Objectives (goal ladder)</h2>'));
    expect(at).toBeGreaterThan(html.indexOf('<h2>Crew issues</h2>'));
    expect(html.match(/id="goal-stub"/g)).toHaveLength(1);
  });

  test.each([
    ['missing', goals({ ok: false, error: 'GOAL.md not found' })],
    ['not read yet', undefined],
  ])('without goals (%s), the builder is open and comes before the ladder', (_name, g) => {
    const html = goalsPage(g);
    expect(opening(html)).toBe('<details id="goal-stub" open>');
    expect(html.indexOf('id="goal-stub"')).toBeLessThan(
      html.indexOf('<h2>Objectives (goal ladder)</h2>'),
    );
    expect(html.match(/id="goal-stub"/g)).toHaveLength(1);
  });

  test('a GOAL.md that does not parse is still a goal file: the builder stays closed, below', () => {
    const html = goalsPage(goals({ ok: false, error: 'no ## Objectives section' }));
    expect(opening(html)).toBe('<details id="goal-stub">');
  });

  test('the crew row sits at the top, its times relative, next due ahead', () => {
    const now = new Date('2026-11-22T12:00:00.000Z');
    const html = goalsPage(
      withGoals,
      {
        zoneId: 'jm',
        enabled: true,
        lastCycle: '2026-11-22T11:30:00.000Z',
        nextDue: '2026-11-22T14:30:00.000Z',
        fable: 'plan pro does not include Fable',
      },
      now,
    );
    const row = html.match(/<section id="crew">.*?<\/section>/)?.[0] ?? '';
    expect(row).toContain('<h2>Crew</h2>');
    expect(row).toContain(
      '<td>on</td><td><time datetime="2026-11-22T11:30:00.000Z" title="2026-11-22T11:30:00.000Z">30 min ago</time></td>' +
        '<td><time datetime="2026-11-22T14:30:00.000Z" title="2026-11-22T14:30:00.000Z">in 2 h</time></td>' +
        '<td>plan pro does not include Fable</td>',
    );
    expect(html.indexOf('<section id="crew">')).toBeLessThan(
      html.indexOf('<h2>Objectives (goal ladder)</h2>'),
    );
    expect(html.indexOf('<section id="crew">')).toBeGreaterThan(
      html.indexOf('<header class="project-header">'),
    );
  });

  test('the crew row says now when due, and - for times when the crew is off or never ran', () => {
    const line = { zoneId: 'jm', lastCycle: null, nextDue: null, fable: 'available' };
    expect(goalsPage(withGoals, { ...line, enabled: true })).toContain(
      '<td>on</td><td>-</td><td>now</td><td>available</td>',
    );
    expect(goalsPage(withGoals, { ...line, enabled: false })).toContain(
      '<td>off</td><td>-</td><td>-</td><td>available</td>',
    );
  });

  test('a vm run of the stub script posts the same body to /api/control/zones/jm/intake/goal-stub', async () => {
    const values: Record<string, string> = {
      'stub-template': 'idea',
      'stub-lighthouse': '  A tool.  ',
      'stub-objectives': 'First\n\n Second \n',
      'stub-nongoals': 'Not this',
      'stub-constraints': '',
    };
    const elements = new Map<string, Record<string, unknown>>();
    const el = (id: string) => {
      let e = elements.get(id);
      if (!e) {
        const listeners: Record<string, (ev: unknown) => unknown> = {};
        e = {
          value: values[id] ?? '',
          textContent: '',
          dataset: id === 'intake' ? { base: '/api/control/zones/jm/intake' } : {},
          listeners,
          addEventListener: (type: string, fn: (ev: unknown) => unknown) => {
            listeners[type] = fn;
          },
        };
        elements.set(id, e);
      }
      return e;
    };
    const calls: { path: string; body: unknown }[] = [];
    const ctx = vm.createContext({
      document: { getElementById: el },
      navigator: { clipboard: { writeText: async () => {} } },
      jmFetch: async (path: string, body: unknown) => {
        calls.push({ path, body });
        return { status: 200, json: async () => ({ markdown: '# Goal' }) };
      },
    });
    // The page embeds the script; run that copy.
    const html = goalStub(zone2, true);
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>') + 9);
    expect(script).toBe(STUB_SCRIPT);
    vm.runInContext(script.slice('<script>'.length, -'</script>'.length), ctx);
    const listeners = el('stub-form').listeners as Record<string, (ev: unknown) => Promise<void>>;
    await listeners.submit?.({ preventDefault: () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/control/zones/jm/intake/goal-stub');
    expect(calls[0]?.body).toEqual({
      template: 'idea',
      lighthouse: 'A tool.',
      objectives: ['First', 'Second'],
      nonGoals: ['Not this'],
    });
    expect(el('stub-out').value).toBe('# Goal');
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
      rule: renderBriefing({ briefing: briefing(), rulings: [], zones: [z] }),
      doctor: renderDoctor(null, [z]),
      goals: renderGoals({
        zone: z,
        zones: [z],
        goals: undefined,
        crewIssues: [],
        items: [],
        skippedCrewUnpromoted: [],
        doneByRuling: new Map(),
      }),
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
    expect(pages.kill).toContain("jmFetch('/api/control/kill',{engaged:!on})");
    expect(pages.kill).toContain('data-engaged="false"');
    expect(pages.killed).toContain('data-engaged="true"');
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
        { text: 'demo: no Claude token', href: '/system/credentials' },
        { text: 'docs is paused', href: '/projects/docs' },
        { text: 'evil', href: 'javascript:alert(1)' },
        { text: 'no pass yet since start' },
      ],
    });
    expect(html).toContain('<strong>No runner: &lt;it&gt; &amp; <code>x</code></strong>');
    expect(html).toContain('<p>check <code>docker compose logs stick</code> &lt;now&gt;</p>');
    expect(html).not.toContain('`');
    expect(html).toContain(
      '<ul class="also"><li>demo: no Claude token <a href="/system/credentials">Fix</a></li><li>docs is paused <a href="/projects/docs">Fix</a></li><li>evil</li><li>no pass yet since start</li></ul>',
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
  expect(html).toContain('<div id="sticks"><h3>Sticks</h3>');
});

describe('zones are named by their repository (#99)', () => {
  const solo: DropZoneConfig = { ...z, id: 'zid-solo', repo: 'acme/widgets', identity: 'starter' };
  const a: DropZoneConfig = { ...z, id: 'zid-a', repo: 'acme/shared' };
  const b: DropZoneConfig = { ...z, id: 'zid-b', repo: 'acme/shared' };
  const zones = [solo, a, b];
  /** The page with every URL, and the attributes that carry ids to the API, taken out. */
  const outsideUrls = (html: string) =>
    html.replace(/(href|action|data-[a-z-]+)="[^"]*"/g, '').replace(/\/projects\/[^\s"'<]*/g, '');
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
    expect(html).toContain('acme/shared <small>(zid-b)</small>: Split the CLI objective?');
    expect(html).toContain('cannot run acme/widgets: lacks egress-v1');
    // The ids stay in the URLs.
    expect(html).toContain('href="/projects/zid-solo/issues/new"');
    expectNoBareId(html);
  });

  test("Home's status banner names zones by repository; its title is Home (#625)", () => {
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
    expect(html).toContain('<title>Jumpmaster: Home</title>');
    expect(html).toContain('<h2 class="page-h">Home</h2>');
    expect(html).toContain('<strong>Blocked: acme/shared (zid-a) needs claudeToken');
    expect(html).toContain('acme/shared (zid-b): no Claude token');
    expect(html).toContain('acme/widgets is paused');
    expect(html).toContain('href="/projects/zid-solo"');
    // A shared repository's id follows it in the plain-text status, as it does in <small> elsewhere.
    expectNoBareId(html.replaceAll(/acme\/shared \(zid-[ab]\)/g, ''));
  });

  test("a briefing's page names its zone by repository", () => {
    const html =
      renderBriefing({ briefing: briefing({ zoneId: 'zid-solo' }), rulings: [], zones }) +
      renderBriefing({ briefing: briefing({ id: 5, zoneId: 'zid-a' }), rulings: [], zones });
    expect(html).toContain('<th>Project</th><td>acme/widgets</td>');
    expect(html).toContain('<th>Project</th><td>acme/shared <small>(zid-a)</small></td>');
    expectNoBareId(html.replaceAll(/href="[^"]*"/g, ''));
  });

  test("a project's bulk dismiss names the zone by repository (#625: on its Overview)", () => {
    const html = dismissAllForm(
      'zid-a',
      [briefing({ zoneId: 'zid-a' }), briefing({ id: 5, zoneId: 'zid-a' })],
      zones,
    );
    expect(html).toContain('Dismiss all 2 briefings of acme/shared <small>(zid-a)</small>');
    expect(html).toContain('data-ask="Dismiss 2 briefings of acme/shared (zid-a)?');
    expect(html).toContain('data-zone="zid-a"');
    expectNoBareId(html);
    const solo1 = dismissAllForm('zid-solo', [briefing({ zoneId: 'zid-solo' })], zones);
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
    const obs = renderLog({
      zones,
      kind: 'all',
      observations: [
        {
          id: 1,
          zoneId: 'zid-solo',
          itemId: null,
          action: 'x',
          detail: 'y',
          count: 1,
          firstAt: 't',
          lastAt: 't',
        },
      ],
      rulings: [],
      now: new Date(),
    });
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
      '<a href="/projects/ref/work?state=ready" aria-current="page">octo/ref</a>',
    );
    // A project's work is its Work tab (#619): /work links there directly, never via ?zone=.
    expect(html).toContain('<a href="/projects/main/work?state=ready">octo/demo</a>');
    expect(html).toContain('<a href="/activity/work?state=ready">All projects</a>');
    expect(html).toContain('<a href="/projects/ref/work?state=parked">Parked</a>');
    expect(html).toContain('<a href="/projects/ref/work">Active</a>');
    expect(html).not.toContain('zone=');
    const drops = renderDropList({ zones, state: 'failed', drops: [], items: [], limited: false });
    expect(drops).toContain(
      '<a href="/activity/drops?state=failed" aria-current="page">All projects</a>',
    );
    expect(drops).toContain('<a href="/activity/drops?zone=main&amp;state=failed">octo/demo</a>');
    expect(drops).toContain('<a href="/activity/drops?state=active">Active</a>');
    expect(drops).toContain('<a href="/activity/drops">All states</a>');
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

  test('the page nav links Activity, which holds Work and Drops (#622)', () => {
    const html = page('x');
    expect(html).toContain('<a href="/activity" data-area="activity">Activity</a>');
    expect(html).not.toContain('<a href="/work">');
    expect(html).not.toContain('<a href="/drops">');
  });
});

describe('briefings on Home and on a project (#625, was the paged list of #132)', () => {
  const za: DropZoneConfig = { ...z, id: 'za', repo: 'acme/alpha' };
  const zb: DropZoneConfig = { ...z, id: 'zb', repo: 'acme/beta' };
  /** `n` open briefings of `zoneId`, ids from `from`, each decision naming its zone and number. */
  const many = (zoneId: string, n: number, from = 1): Briefing[] =>
    Array.from({ length: n }, (_, i) =>
      briefing({ id: from + i, zoneId, decision: `Decide ${zoneId}#${from + i}?` }),
    );

  test('the bulk dismiss carries every open briefing of the zone, and says how many', () => {
    const open = many('za', 23);
    const html = dismissAllForm('za', open, [za]);
    expect(html).toContain('Dismiss all 23 briefings of acme/alpha');
    expect(html).toContain(`data-ids="${escapeHtml(JSON.stringify(open.map((b) => b.id)))}"`);
    expect(html).toContain('data-ask="Dismiss 23 briefings of acme/alpha?');
  });

  test("Home's Needs you lists each briefing by project, in the order given, each to its page (#625)", () => {
    const open = [...many('za', 2, 1), ...many('zb', 1, 10)];
    const html = renderHome({ zones: [za, zb], items: [], drops: [], briefings: open });
    const rows = html.match(/<li class="needs-row"[^>]*>.*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => /href="(\/briefings\/\d+)">Answer/.exec(r)?.[1])).toEqual(
      open.map((b) => `/briefings/${b.id}`),
    );
    expect(rows[2]).toContain('acme/beta: ');
  });

  test('escaping: a decision with <script> is escaped, and a zone id needing it is encoded', () => {
    const odd: DropZoneConfig = { ...z, id: 'a b', repo: 'acme/<odd>' };
    const evil = briefing({ id: 50, zoneId: 'a b', decision: '<script>alert(1)</script>' });
    const open = [...many('a b', 3, 1), evil];
    const floor = renderHome({ zones: [odd], items: [], drops: [], briefings: open });
    const one = renderBriefing({
      briefing: evil,
      rulings: [ruling({ zoneId: 'a b' })],
      zones: [odd],
    });
    const dismiss = dismissAllForm('a b', open, [odd]);
    for (const html of [floor, one, dismiss]) {
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<odd>');
    }
    expect(floor).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(one).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(floor).toContain('href="/projects/a%20b"');
    expect(one).toContain('href="/projects/a%20b#needs-you"');
    expect(dismiss).toContain('data-zone="a b"');
  });
});

describe('a credits stop on an unconfigured zone (#593)', () => {
  const zones = [z];
  const stop = (zoneId: string) =>
    briefing({ id: 9, zoneId, kind: 'credits_required', subject: 'credits:stop:d1' });

  test('its Needs you row names it and links to its own page, never to a zone that 404s (#625)', () => {
    for (const [zoneId, label] of [
      ['old', 'old'],
      ['', 'All dispatch stopped'],
    ] as const) {
      const html = renderHome({ zones, items: [], drops: [], briefings: [stop(zoneId)] });
      const rows = html.match(/<li class="needs-row"[^>]*>.*?<\/li>/g) ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(`${label}: Split the CLI objective?`);
      expect(rows[0]).toContain('<a href="/briefings/9">Answer</a>');
      expect(html).not.toContain('/projects/old');
    }
  });

  test('its own page offers no "Briefings of" link to an unconfigured zone', () => {
    for (const zoneId of ['old', '']) {
      const html = renderBriefing({ briefing: stop(zoneId), rulings: [], zones });
      expect(html).not.toContain('/briefings?zone=');
      expect(html).toContain('<a href="/#waiting-on-you">Needs you</a>');
      expect(html).not.toContain('Briefings of');
    }
    const ok = renderBriefing({ briefing: stop('main'), rulings: [], zones });
    expect(ok).toContain('<a href="/projects/main#needs-you">Briefings of octo/demo</a>');
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
        { text: 'int', href: '/system/credentials' },
      ],
    });
    expect(html).toContain(`<a href="https://github.com/o/r/pull/7" ${NEW_TAB}>Open PR #7</a>`);
    expect(html).toContain(`<a href="https://github.com/o/r/settings" ${NEW_TAB}>Fix</a>`);
    expect(html).toContain('<a href="/system/credentials">Fix</a>');
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
    expect(html).toMatch(/<a href="\/activity"[^>]*>/);
    expect(html).not.toMatch(/<a href="\/activity"[^>]*target=/);
    expect(html).toMatch(/<a [^>]*href="\/activity\/drops\?[^"]*"[^>]*>/);
    expect(html).not.toMatch(/<a [^>]*href="\/activity\/[^"]*"[^>]*target=/);
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
    // No briefing page to land on: the removed /briefings list is not a fallback (#625).
    expect(linkify('after Ruling 42', refs)).toBe('after Ruling 42');
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
    const html = linkify(evil, { ...refs, rulingHref: (n) => `#ruling-${n}` });
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
    const page = renderBriefing({
      briefing: briefing({ decision: evil, why: evil, recommendation: evil, onHold: evil }),
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
    const html = renderBriefing({
      briefing: briefing({
        kind: 'promote',
        options: [{ id: 'promote', label: 'Promote', effect: 'promote_issue' }],
      }),
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
    const html = renderBriefing({
      briefing: b,
      rulings: [],
      zones: [z],
      about: briefingAbout(w.db, w.zone, b),
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
      renderBriefing({ briefing: parked, rulings: [], zones: [z] }),
      renderBriefing({ briefing: parked, rulings: [], zones: [z], pending: false }),
    ]) {
      expect(html).not.toContain('class="pending"');
      expect(html).toContain('<form class="rule" data-briefing="6"');
    }
  });

  test('/briefings/<n> shows one briefing with its rulings, and its references carry anchors', () => {
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
    const list = renderBriefing({
      briefing: briefing({ id: 8, why: 'see Briefing 8, Briefing 2 and Ruling 1 and Ruling 5' }),
      rulings: [ruling({ id: 1, briefingId: 2 }), ruling({ id: 5, briefingId: 3 })],
      zones: [z],
    });
    expect(list).toContain('id="briefing-8"');
    // Another briefing's ruling is not shown: a reference leads to it on its briefing's page.
    expect(list).not.toContain('<tr id="ruling-1">');
    expect(list).toContain('<a href="#briefing-8">Briefing 8</a>');
    expect(list).toContain('<a href="/briefings/2">Briefing 2</a>');
    expect(list).toContain('<a href="/briefings/2#ruling-1">Ruling 1</a>');
    expect(list).toContain('<a href="/briefings/3#ruling-5">Ruling 5</a>');
    // A ruling of no known briefing stays text, not a link to the removed /briefings list.
    const unknown = renderBriefing({
      briefing: briefing({ id: 8, why: 'see Ruling 77' }),
      rulings: [],
      zones: [z],
    });
    expect(unknown).toContain('see Ruling 77');
    expect(unknown).not.toContain('#ruling-77');
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
    expect(s).toContain('<a href="/projects/jm">octo/jm</a>');
    expect(s).toContain('<a href="/projects/jm/work/487">#487 Header</a>');
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
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/activity">Activity</a></li><li><a href="/activity/work">Work</a></li><li><a href="/projects/jm/work">octo/jm</a></li><li><a href="/projects/jm/work/487">#487</a></li><li><span aria-current="page">Drop abcdef12</span></li></ol></nav>',
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
    expect(html).toContain(
      '<li><a href="/activity/drops">Drops</a></li><li><span aria-current="page">Drop abcdef12</span></li>',
    );
    expect(html).not.toContain('<a href="/activity/work">Work</a>');
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

describe('the Log: observe decisions in words and rulings (#621)', () => {
  const obs = (o: Partial<LogObservation> = {}): LogObservation => ({
    id: 1,
    zoneId: 'jm',
    itemId: 7,
    issueNumber: 4154,
    action: 'would_enqueue:implement',
    detail: 'issue #4154',
    count: 1,
    firstAt: '2026-01-01T00:00:00.000Z',
    lastAt: '2026-01-01T00:00:00.000Z',
    ...o,
  });
  /** The suffixes the server writes today, by base code. */
  const SUFFIXES: Record<string, string[]> = {
    would_enqueue: ['arbitrate', 'audit', 'crew', 'implement', 'resume', 'review'],
    would_wait: ['blocked', 'overlap'],
  };
  const codes = OBSERVATION_ACTIONS.flatMap((base) => [
    base,
    ...(SUFFIXES[base] ?? []).map((x) => `${base}:${x}`),
  ]);

  test('the issue examples: implement and park, the item linked to its work item', () => {
    expect(observationWords(obs())).toBe(
      'Would start implementing <a href="/projects/jm/work/4154">#4154</a>',
    );
    expect(
      observationWords(
        obs({
          action: 'would_park',
          issueNumber: 4155,
          detail: 'hand-opened PR on the agent branch',
        }),
      ),
    ).toBe(
      'Would park <a href="/projects/jm/work/4155">#4155</a> (hand-opened PR on the agent branch)',
    );
  });

  test.each(codes)('%s maps to a sentence without the raw code', (action) => {
    for (const row of [obs({ action }), obs({ action, itemId: null, issueNumber: null })]) {
      const words = observationWords(row);
      expect(words.startsWith('Would ')).toBe(true);
      expect(words).not.toContain('would_');
      expect(words).not.toContain(action);
      // Not the fallback for an unknown code.
      expect(words.startsWith(`Would ${action}`)).toBe(false);
    }
  });

  test('every would_ code the server writes is in OBSERVATION_ACTIONS', () => {
    const root = join(import.meta.dirname, '..');
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    const found = new Set<string>();
    for (const f of files)
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(/['"`](would_[a-z_]+)/g))
        found.add(m[1] ?? '');
    // Non-vacuous: the codes reconcile and the crew schedule write are found.
    for (const code of ['would_park', 'would_enqueue', 'would_wait', 'would_merge'])
      expect(found).toContain(code);
    const known: readonly string[] = OBSERVATION_ACTIONS;
    expect([...found].filter((code) => !known.includes(code))).toEqual([]);
  });

  test('an unknown code renders "Would " and the code, escaped, never dropped', () => {
    expect(
      observationWords(
        obs({ action: 'would_<b>x</b>', itemId: null, issueNumber: null, detail: '' }),
      ),
    ).toBe('Would would_&lt;b&gt;x&lt;/b&gt;');
    expect(
      observationWords(
        obs({ action: 'adopt_refused', itemId: null, issueNumber: null, detail: 'pr #9' }),
      ),
    ).toBe('Would adopt_refused (pr #9)');
    // An item without a known issue is named by its id.
    expect(observationWords(obs({ issueNumber: null }))).toBe('Would start implementing item 7');
  });

  test('the merged list orders by time across both kinds, newest first', () => {
    const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
    const observations = [1, 3, 5].map((n) =>
      obs({ id: n, lastAt: at(n), firstAt: at(1), detail: `o${n}`, action: 'would_merge' }),
    );
    const rulings = [2, 4, 6].map((n) =>
      ruling({ id: n, zoneId: 'jm', choice: 'yes', createdAt: at(n), note: `r${n}` }),
    );
    const order = logEntries(observations, rulings, new Date(at(9))).map(
      (e) => e.cells.match(/\b[or]\d\b/)?.[0],
    );
    expect(order).toEqual(['r6', 'o5', 'r4', 'o3', 'r2', 'o1']);
    const html = renderLog({
      zones: [{ id: 'jm', repo: 'acme/jm' }],
      kind: 'all',
      observations,
      rulings,
      now: new Date(at(9)),
    });
    const shown = [...html.matchAll(/<tr class="log-[a-z]+">.*?\b([or]\d)\b/g)].map((m) => m[1]);
    expect(shown).toEqual(['r6', 'o5', 'r4', 'o3', 'r2', 'o1']);
  });

  test('a ruling row links its ruling and briefing and says what was decided, when', () => {
    const html = renderLog({
      zones: [{ id: 'jm', repo: 'acme/jm' }],
      zone: 'jm',
      header: '<nav>tabs</nav>',
      kind: 'all',
      observations: [obs({ count: 3, firstAt: '2025-12-31T00:00:00.000Z' })],
      rulings: [
        ruling({
          id: 12,
          briefingId: 7,
          zoneId: 'jm',
          label: 'Split it',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(html).toContain(
      '<a href="/briefings/7#ruling-12">Ruling 12</a> on <a href="/briefings/7">Briefing 7</a>: Split it',
    );
    expect(html).toContain('<td>3</td>');
    expect(html).toContain('<time datetime="2025-12-31T00:00:00.000Z"');
    // The project's tab: no Project column, and its filters stay on the tab.
    expect(html).not.toContain('<th>Project</th>');
    expect(html).toContain('<a href="/projects/jm/log" aria-current="page">All</a>');
    expect(html).toContain('<a href="/projects/jm/log?kind=observed">Observed</a>');
    expect(html).toContain('<a href="/projects/jm/log?kind=rulings">Rulings</a>');
  });

  test('the global log has a Project column and project filter links that keep the kind', () => {
    const zones = [
      { id: 'jm', repo: 'acme/jm' },
      { id: 'b', repo: 'acme/b' },
    ];
    const html = renderLog({
      zones,
      kind: 'rulings',
      observations: [obs()],
      rulings: [ruling({ zoneId: 'b' })],
      now: new Date(),
    });
    expect(html).toContain('<th>Project</th>');
    expect(html).toContain('<td>acme/b</td>');
    expect(html).not.toContain('start implementing');
    expect(html).toContain(
      '<a href="/activity/log?kind=rulings" aria-current="page">All projects</a>',
    );
    expect(html).toContain('<a href="/activity/log?project=jm&amp;kind=rulings">acme/jm</a>');
    expect(html).toContain('<a href="/activity/log?project=b&amp;kind=rulings">acme/b</a>');
  });
});

/** A store install with one of each object a chrome page shows, and each GET route made concrete. */
async function chromeWorld() {
  const h = await harness({
    live: true,
    dataDir: mkdtempSync(join(tmpdir(), 'jm-ask-')),
    zone: { protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'] },
  });
  const bid = String(
    raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'promote',
        subject: 'issue:1',
        decision: 'Promote it?',
        why: 'because',
        options: [{ id: 'promote', label: 'Promote', effect: 'promote_issue' }],
        source: 'server',
      },
      h.now(),
    ),
  );
  const concrete = (pattern: string) =>
    pattern
      .replace(':issue', '1')
      .replace(
        /:[A-Za-z]+/g,
        pattern.startsWith('/briefings/')
          ? bid
          : pattern.startsWith('/projects/')
            ? 'main'
            : pattern.startsWith('/drops/')
              ? 'd1'
              : '1',
      )
      .replace(/\*$/, '');
  createThread(h.db, { title: 'a thread' }, h.now());
  upsertDropZone(h.db, {
    id: 'main',
    repo: h.zone.repo,
    defaultBranch: 'main',
    configJson: '{}',
  });
  const item = upsertWorkItem(
    h.db,
    {
      dropZoneId: 'main',
      issueNumber: 1,
      title: 'an issue',
      body: 'b',
      author: 'human',
      priority: 2,
      isFix: false,
      issueCreatedAt: '2026-01-01T00:00:00.000Z',
    },
    h.now(),
  );
  insertDrop(
    h.db,
    { id: 'd1', dropZoneId: 'main', workItemId: item.id, role: 'implement', state: 'succeeded' },
    h.now(),
  );
  return { h, concrete };
}

describe('the Ask panel (#626)', () => {
  const jm: DropZoneConfig = { ...z, id: 'jm', repo: 'octo/jm' };
  const projectPage = (current: 'overview' | 'goals' = 'overview') =>
    page(
      projectHeader({
        zone: jm,
        zones: [jm],
        mode: 'active',
        openBriefings: 0,
        current,
        ...(current === 'goals' ? { ask: { kind: 'goals', zoneId: 'jm', ref: 'jm' } } : {}),
      }),
    );

  /** The header Ask button's `data-focus-*` attributes, as the page rendered them. */
  const askDataset = (html: string): Record<string, string> => {
    const tag = /<button [^>]*id="ask-open"[^>]*>/.exec(html)?.[0] ?? '';
    const out: Record<string, string> = {};
    for (const [, k, v] of tag.matchAll(/data-focus-(kind|zone|ref)="([^"]*)"/g))
      out[`focus${(k as string)[0]?.toUpperCase()}${(k as string).slice(1)}`] = v as string;
    return out;
  };

  test('the page derives the focus: a project page its zone, Goals goals, a briefing its own, others none', () => {
    expect(askDataset(projectPage())).toEqual({
      focusKind: 'zone',
      focusZone: 'jm',
      focusRef: 'jm',
    });
    expect(askDataset(projectPage('goals'))).toEqual({
      focusKind: 'goals',
      focusZone: 'jm',
      focusRef: 'jm',
    });
    const b = renderBriefing({ briefing: briefing({ id: 12 }), rulings: [], zones: [z] });
    expect(askDataset(b)).toEqual({ focusKind: 'briefing', focusZone: 'main', focusRef: '12' });
    expect(askDataset(page('<h2>Activity</h2>'))).toEqual({});
    // The panel header's chip names it.
    expect(projectPage()).toMatch(
      /<div class="ask-head"><h2>Ask<\/h2><span class="chip">octo\/jm<\/span>/,
    );
    expect(projectPage('goals')).toContain('<span class="chip">octo/jm · goals</span>');
    expect(b).toContain('<span class="chip">Briefing 12</span>');
    expect(page('<h2>x</h2>')).toContain('<div class="ask-head"><h2>Ask</h2><a id="ask-full"');
  });

  test('the panel is a labelled, non-modal complementary region; a page without chrome has none', () => {
    const html = projectPage();
    expect(html).toContain(
      '<aside id="ask-panel" class="ask-panel" role="complementary" aria-label="Ask Jumpmaster" aria-modal="false"',
    );
    expect(html).toContain('Open in Chat');
    // Outside <main>, so the page's landmarks stay as they are.
    expect(html.indexOf('<aside id="ask-panel"')).toBeGreaterThan(html.indexOf('</main>'));
    const bare = page('<h2>Log in</h2>', { chrome: false });
    expect(bare).not.toContain('id="ask-open"');
    expect(bare).not.toContain('id="ask-panel"');
    const panel = page('<h2>t</h2>', { panel: true });
    expect(panel).not.toContain('class="topnav"');
    expect(panel).not.toContain('id="ask-open"');
    expect(panel).toContain('<meta name="jm-csrf" content="">');
    expect(panel).toContain('function jmFetch');
  });

  class El {
    hidden = false;
    textContent = '';
    href = '';
    dataset: Record<string, string> = {};
    attrs: Record<string, string> = {};
    listeners: Record<string, ((e: unknown) => unknown)[]> = {};
    static focused: El | null = null;
    constructor(readonly id: string) {}
    addEventListener(ev: string, fn: (e: unknown) => unknown) {
      (this.listeners[ev] ??= []).push(fn);
    }
    fire(ev: string, e: unknown = {}) {
      for (const fn of this.listeners[ev] ?? []) fn(e);
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    getAttribute(k: string) {
      return this.attrs[k] ?? null;
    }
    focus() {
      El.focused = this;
    }
  }

  type Thread = {
    id: number;
    focusKind: string | null;
    focusZoneId: string | null;
    focusRef: string | null;
    createdAt: string;
  };

  /** The page's Ask panel script in a vm with a fake DOM, `fetch`, `jmFetch` and `sessionStorage`. */
  function runPanel(
    html: string,
    o: {
      threads?: Thread[];
      storage?: 'throws' | Map<string, string>;
      now?: number;
      /** Holds the thread list's reply until this resolves. */
      hold?: Promise<void>;
    } = {},
  ) {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1] as string)
      .find((s) => s.includes("'jm-ask'"));
    if (!script) throw new Error('no Ask panel script on the page');
    El.focused = null;
    const ids = Object.fromEntries(
      ['ask-open', 'ask-panel', 'ask-frame', 'ask-full', 'ask-out', 'ask-close'].map((id) => [
        id,
        new El(id),
      ]),
    ) as Record<string, El>;
    const open = ids['ask-open'] as El;
    open.dataset = askDataset(html);
    (ids['ask-panel'] as El).hidden = true;
    const doc = new El('document');
    const win = new El('window');
    const classes = new Set<string>();
    const dialog = { open: false };
    const gets: string[] = [];
    const posts: { url: string; body: unknown }[] = [];
    const store = o.storage === 'throws' ? undefined : (o.storage ?? new Map<string, string>());
    const sessionStorage = {
      getItem: (k: string) => {
        if (!store) throw new Error('SecurityError');
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (!store) throw new Error('SecurityError');
        store.set(k, v);
      },
    };
    let nextId = 100;
    const json = (body: unknown, status = 200) => ({
      ok: status < 300,
      status,
      json: async () => body,
    });
    const ctx = vm.createContext({
      document: {
        getElementById: (id: string) => ids[id] ?? null,
        addEventListener: (ev: string, fn: (e: unknown) => unknown) => doc.addEventListener(ev, fn),
        querySelector: (sel: string) => (sel === 'dialog[open]' && dialog.open ? {} : null),
        body: {
          classList: {
            add: (c: string) => classes.add(c),
            remove: (c: string) => classes.delete(c),
          },
        },
      },
      location: { origin: 'http://127.0.0.1:7420' },
      sessionStorage,
      Date: { now: () => o.now ?? Date.parse('2026-11-23T12:00:00.000Z'), parse: Date.parse },
      JSON,
      fetch: async (url: string) => {
        gets.push(url);
        await o.hold;
        return json({ threads: o.threads ?? [] });
      },
      jmFetch: async (url: string, body: unknown) => {
        posts.push({ url, body });
        return json({ thread: { id: nextId++ } });
      },
    });
    ctx.window = ctx;
    ctx.addEventListener = (ev: string, fn: (e: unknown) => unknown) =>
      win.addEventListener(ev, fn);
    vm.runInContext(script, ctx);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { ids, open, doc, win, ctx, gets, posts, store, classes, dialog, settle };
  }

  const recent = (over: Partial<Thread> = {}): Thread => ({
    id: 7,
    focusKind: 'zone',
    focusZoneId: 'jm',
    focusRef: 'jm',
    createdAt: '2026-11-23T08:00:00.000Z',
    ...over,
  });

  test('on a project page, Ask with no recent thread posts one focused on the zone and shows it', async () => {
    // Threads that are not this focus's, or older than a day, are not reused.
    const r = runPanel(projectPage(), {
      threads: [
        recent({ id: 1, focusKind: 'goals' }),
        recent({ id: 2, focusZoneId: 'other', focusRef: 'other' }),
        recent({ id: 3, createdAt: '2026-11-22T11:00:00.000Z' }),
        recent({ id: 4, focusKind: null, focusZoneId: null, focusRef: null }),
      ],
    });
    r.open.fire('click');
    await r.settle();
    expect(r.posts).toEqual([
      { url: '/api/chat/threads', body: { focus: { kind: 'zone', zoneId: 'jm', ref: 'jm' } } },
    ]);
    const panel = r.ids['ask-panel'] as El;
    expect(panel.hidden).toBe(false);
    expect(El.focused).toBe(panel);
    expect(r.open.attrs['aria-expanded']).toBe('true');
    expect((r.ids['ask-frame'] as El).attrs.src).toBe('/chat/100?panel=1');
    expect((r.ids['ask-full'] as El).href).toBe('/chat/100');
    expect(JSON.parse(r.store?.get('jm-ask') ?? '{}')).toMatchObject({ open: true, thread: 100 });
  });

  test('Ask with a recent thread of the same focus reuses the newest and posts nothing', async () => {
    const r = runPanel(projectPage(), {
      threads: [recent({ id: 7 }), recent({ id: 9, createdAt: '2026-11-23T10:00:00.000Z' })],
    });
    r.open.fire('click');
    await r.settle();
    expect(r.gets).toEqual(['/api/chat/threads']);
    expect(r.posts).toEqual([]);
    expect((r.ids['ask-frame'] as El).attrs.src).toBe('/chat/9?panel=1');
  });

  test('the next page with the same focus keeps the tab’s thread, opened, without making one', async () => {
    const store = new Map<string, string>();
    const first = runPanel(projectPage(), { storage: store });
    first.open.fire('click');
    await first.settle();
    expect(first.posts).toHaveLength(1);
    // Another page of the same project: the panel comes back open on the same thread, the tab's
    // own even with a newer one of that focus about.
    const next = runPanel(projectPage(), {
      storage: store,
      threads: [recent({ id: 100 }), recent({ id: 9, createdAt: '2026-11-23T10:00:00.000Z' })],
    });
    await next.settle();
    expect((next.ids['ask-panel'] as El).hidden).toBe(false);
    expect((next.ids['ask-frame'] as El).attrs.src).toBe('/chat/100?panel=1');
    expect(next.posts).toEqual([]);
    // Reopened on load, it leaves the page's focus where it is.
    expect(El.focused).toBeNull();
    // A page with another focus reuses a recent thread of its own focus, if there is one...
    const goals = runPanel(projectPage('goals'), {
      storage: new Map(store),
      threads: [recent({ id: 11, focusKind: 'goals' })],
    });
    await goals.settle();
    expect(goals.posts).toEqual([]);
    expect((goals.ids['ask-frame'] as El).attrs.src).toBe('/chat/11?panel=1');
    // ...and otherwise makes none just by loading: the panel stays shut until Ask.
    const bare = runPanel(projectPage('goals'), { storage: store });
    await bare.settle();
    expect(bare.posts).toEqual([]);
    expect((bare.ids['ask-panel'] as El).hidden).toBe(true);
    expect(bare.open.attrs['aria-expanded']).toBe('false');
    bare.open.fire('click');
    await bare.settle();
    expect(bare.posts).toEqual([
      { url: '/api/chat/threads', body: { focus: { kind: 'goals', zoneId: 'jm', ref: 'jm' } } },
    ]);
  });

  test('the tab’s thread is not reused once older than a day or gone from the server', async () => {
    for (const threads of [
      [recent({ id: 100, createdAt: '2026-11-22T11:00:00.000Z' }), recent({ id: 9 })],
      [recent({ id: 9 })],
    ]) {
      const store = new Map([
        ['jm-ask', JSON.stringify({ open: true, focus: 'zone\njm\njm', thread: 100 })],
      ]);
      const r = runPanel(projectPage(), { storage: store, threads });
      await r.settle();
      expect((r.ids['ask-frame'] as El).attrs.src).toBe('/chat/9?panel=1');
      expect(JSON.parse(store.get('jm-ask') ?? '{}')).toMatchObject({ open: true, thread: 9 });
    }
  });

  test('closing while the lookup runs creates no thread and shows none', async () => {
    let release = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const r = runPanel(projectPage(), { hold });
    r.open.fire('click');
    await r.settle();
    (r.ids['ask-close'] as El).fire('click');
    release();
    await r.settle();
    await r.settle();
    expect(r.posts).toEqual([]);
    expect((r.ids['ask-frame'] as El).attrs.src).toBeUndefined();
    expect((r.ids['ask-panel'] as El).hidden).toBe(true);
  });

  test('Escape leaves the panel open while a dialog on the page has it', async () => {
    const r = runPanel(projectPage(), { threads: [recent()] });
    r.open.fire('click');
    await r.settle();
    r.dialog.open = true;
    let prevented = false;
    r.doc.fire('keydown', { key: 'Escape', preventDefault: () => (prevented = true) });
    expect((r.ids['ask-panel'] as El).hidden).toBe(false);
    expect(prevented).toBe(false);
    r.dialog.open = false;
    r.doc.fire('keydown', { key: 'Escape', defaultPrevented: true, preventDefault: () => {} });
    expect((r.ids['ask-panel'] as El).hidden).toBe(false);
    r.doc.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect((r.ids['ask-panel'] as El).hidden).toBe(true);
  });

  test('Escape closes the panel and returns focus to the Ask button; so does the frame’s message', async () => {
    const r = runPanel(projectPage(), { threads: [recent()] });
    r.open.fire('click');
    await r.settle();
    const panel = r.ids['ask-panel'] as El;
    expect(El.focused).toBe(panel);
    let prevented = false;
    r.doc.fire('keydown', { key: 'Escape', preventDefault: () => (prevented = true) });
    expect(panel.hidden).toBe(true);
    expect(prevented).toBe(true);
    expect(El.focused).toBe(r.open);
    expect(r.open.attrs['aria-expanded']).toBe('false');
    expect(JSON.parse(r.store?.get('jm-ask') ?? '{}')).toMatchObject({ open: false, thread: 7 });
    // Escape inside the frame arrives as a message from this origin; another origin's is ignored.
    r.open.fire('click');
    await r.settle();
    r.win.fire('message', { origin: 'http://evil.test', data: { jmAsk: 'close' } });
    expect(panel.hidden).toBe(false);
    r.win.fire('message', { origin: 'http://127.0.0.1:7420', data: { jmAsk: 'close' } });
    expect(panel.hidden).toBe(true);
    expect(El.focused).toBe(r.open);
  });

  test('a sessionStorage that throws still opens the panel', async () => {
    const r = runPanel(projectPage(), { storage: 'throws' });
    r.open.fire('click');
    await r.settle();
    expect((r.ids['ask-panel'] as El).hidden).toBe(false);
    expect((r.ids['ask-frame'] as El).attrs.src).toBe('/chat/100?panel=1');
  });

  test('Ask about this opens the panel with its focus, and focus returns to it on close', async () => {
    const html = page(askButton({ kind: 'briefing', zoneId: 'jm', ref: '12' }, 'Briefing 12'));
    const r = runPanel(html);
    const opener = new El('ask-about');
    await (r.ctx.jmAsk as (f: unknown, from: El) => Promise<void>)(
      { kind: 'briefing', zoneId: 'jm', ref: '12' },
      opener,
    );
    expect(r.posts).toEqual([
      { url: '/api/chat/threads', body: { focus: { kind: 'briefing', zoneId: 'jm', ref: '12' } } },
    ]);
    (r.ids['ask-close'] as El).fire('click');
    expect(El.focused).toBe(opener);
    // The Ask about this script hands the panel the form's focus rather than leaving the page.
    const ask = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1] as string)
      .find((s) => s.includes('form.ask'));
    if (!ask) throw new Error('no Ask about this script');
    const button = new El('button');
    const form = Object.assign(new El('form'), {
      dataset: { focusKind: 'briefing', focusZone: 'jm', focusRef: '12' } as Record<string, string>,
      querySelector: () => button,
    });
    const asked: unknown[][] = [];
    const left: unknown[] = [];
    const ctx = vm.createContext({
      document: { querySelectorAll: () => [form] },
      jmFetch: async (...a: unknown[]) => {
        left.push(a);
        return { ok: false };
      },
      location: {},
    });
    ctx.window = ctx;
    ctx.jmAsk = (...a: unknown[]) => asked.push(a);
    vm.runInContext(ask, ctx);
    let prevented = false;
    form.fire('submit', { preventDefault: () => (prevented = true) });
    await r.settle();
    expect(prevented).toBe(true);
    expect(asked).toEqual([[{ kind: 'briefing', zoneId: 'jm', ref: '12' }, button]]);
    expect(left).toEqual([]);
  });

  test('an unfocused page reuses its recent unfocused thread', async () => {
    const r = runPanel(page('<h2>Activity</h2>'), {
      threads: [
        recent({ id: 3 }),
        recent({ id: 5, focusKind: null, focusZoneId: null, focusRef: null }),
      ],
    });
    r.open.fire('click');
    await r.settle();
    expect(r.posts).toEqual([]);
    expect((r.ids['ask-frame'] as El).attrs.src).toBe('/chat/5?panel=1');
  });

  test('every page with chrome carries exactly one Ask button', async () => {
    const { h, concrete } = await chromeWorld();
    const checked = new Set<string>();
    for (const r of routesOf(h.app).filter((x) => x.method === 'GET')) {
      const url = concrete(r.url);
      const res = await h.view(url);
      // Any page with chrome, whatever its status (a page's own 404 has it too).
      if (!res.body.includes('class="topnav"')) continue;
      checked.add(r.url);
      expect(res.body.match(/id="ask-open"/g), url).toHaveLength(1);
      expect(res.body.match(/<aside id="ask-panel"/g), url).toHaveLength(1);
    }
    for (const p of [
      '/',
      '/chat',
      '/chat/:id',
      '/projects/:id',
      '/projects/:id/work/:issue',
      '/drops/:id',
      '/briefings/:id',
      '/config/confirm/:id',
      '/system',
    ])
      expect(checked, p).toContain(p);
  });
});

describe('renderDoctor Ask (#627)', () => {
  test('each finding row has an Ask link carrying its check id and zone, install for an install check', () => {
    const html = renderDoctor(
      {
        id: 3,
        finishedAt: 't',
        checks: [
          { id: 'claude.plan', zoneId: null, status: 'warn', summary: 'w' },
          { id: 'forge.token', zoneId: 'main', status: 'fail', summary: 'f' },
          { id: 'x"<b>', zoneId: 'main', status: 'pass', summary: 'p' },
        ],
      },
      [makeZone({ id: 'main', repo: 'acme/demo' })],
    );
    const rows = [...html.matchAll(/<tr class="(?:warn|fail|pass)">([\s\S]*?)<\/tr>/g)].map(
      (m) => m[1] as string,
    );
    expect(rows).toHaveLength(3);
    const ask = (zone: string, ref: string) =>
      `<form class="ask" data-focus-kind="doctor" data-focus-zone="${zone}" data-focus-ref="${ref}">`;
    expect(rows[0]).toContain(ask('main', 'forge.token'));
    expect(rows[1]).toContain(ask('install', 'claude.plan'));
    expect(rows[2]).toContain(ask('main', 'x&quot;&lt;b&gt;'));
    for (const r of rows) expect(r).toMatch(/<button title="Ask about [^"]*">Ask<\/button>/);
    expect(html).not.toContain('<b>');
    // The rows' forms are bound by the Ask script; the page itself keeps no focus of its own.
    expect(html).toContain("document.querySelectorAll('form.ask')");
    expect(html).toContain(
      '<button type="button" id="ask-open" class="ask-open" aria-controls="ask-panel" aria-expanded="false">Ask</button>',
    );
  });
});

describe('the top bar (#628)', () => {
  /** A page's top bar as a store install draws it, filled for `path`. */
  const bar = (path?: string, html = page('<p>x</p>')) => {
    const full = fillChrome(
      html.replace(STORE_NAV_SLOT, STORE_NAV),
      path === undefined ? {} : { path },
    );
    return /<nav class="topnav" aria-label="Main">([\s\S]*?)<\/nav>/.exec(full)?.[1] ?? '';
  };
  /**
   * An element's text, read by walking the markup one character at a time:
   * everything from a `<` to its `>` is a tag and is skipped, and an angle
   * bracket is never copied, so no tag can survive into the text.
   */
  const textOf = (html: string) => {
    let text = '';
    let inTag = false;
    for (const ch of html) {
      if (ch === '<') inTag = true;
      else if (ch === '>') inTag = false;
      else if (!inTag) text += ch;
    }
    return text;
  };
  const labels = (nav: string) =>
    [...nav.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
      textOf((m[1] as string).replace(/<span class="nav-badge"[\s\S]*?<\/span><\/span>/, '')),
    );
  const current = (nav: string) =>
    [...nav.matchAll(/<a [^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
      textOf(m[1] as string),
    );

  test('the nav reads exactly Home, Projects, Activity, Chat, System, in order', () => {
    expect(labels(bar())).toEqual(['Home', 'Projects', 'Activity', 'Chat', 'System']);
    // A config-file install has no Projects page, so no link to it.
    const file = /<nav class="topnav"[^>]*>([\s\S]*?)<\/nav>/.exec(page('x'))?.[1] ?? '';
    expect(labels(file)).toEqual(['Home', 'Activity', 'Chat', 'System']);
  });

  test.each([
    ['/', 'Home'],
    ['/projects/jm/setup', 'Projects'],
    ['/activity/drops', 'Activity'],
    ['/drops/abc', 'Activity'],
    ['/work/main/3', 'Activity'],
    ['/chat/1', 'Chat'],
    ['/system/history', 'System'],
    ['/setup/claude', 'System'],
    ['/briefings/3', 'Home'],
    ['/config/confirm/abc', 'Home'],
  ])('%s marks %s, and only it', (path, area) => {
    expect(current(bar(path))).toEqual([area]);
  });

  test('a path in no area marks nothing; a prefix is a whole segment', () => {
    expect(navArea('/chatter')).toBeUndefined();
    expect(navArea('/dropsy')).toBeUndefined();
    expect(navArea('/drops?x=1')).toBe('activity');
    expect(current(bar('/nowhere'))).toEqual([]);
  });

  test("Home's Needs you badge shows the count above 0, and nothing at 0", () => {
    const parked = (n: number): WorkItem => ({
      ...item,
      id: n,
      issueNumber: n,
      state: 'parked',
      reason: 'r',
    });
    const two = renderHome({ zones: [z], items: [parked(1), parked(2)], drops: [], sticks: [] });
    const home = (html: string) =>
      /<a href="\/" [^>]*>([\s\S]*?)<\/a>/.exec(bar(undefined, html))?.[1];
    expect(home(two)).toMatch(/^Home<span class="nav-badge"[^>]*>.*>2<.*<\/span>$/);
    expect(two.slice(two.indexOf('<main'))).toContain('data-kind="parked"');
    const none = renderHome({ zones: [z], items: [], drops: [], sticks: [] });
    expect(home(none)).toBe('Home');
    expect(none).not.toContain('class="nav-badge"');
    expect(needsBadge(0)).toBe('');
  });

  test('the kill switch control: compact in the top bar, red and "Kill switch on" when engaged', () => {
    const off = page('<p>x</p>', { killed: false });
    const on = page('<p>x</p>', { killed: true });
    const head = (html: string) => html.slice(0, html.indexOf('<main'));
    expect(head(off)).toContain(
      '<button type="button" id="kill-open" class="kill-btn" aria-haspopup="dialog" aria-controls="kill-dialog" data-engaged="false">Kill switch</button>',
    );
    expect(head(on)).toContain('class="kill-btn on"');
    expect(head(on)).toContain('>Kill switch on</button>');
    // The confirmation says what engaging does, with Engage and Cancel; Reset asks too.
    expect(off).toMatch(
      /<dialog id="kill-dialog"[^>]*>.*No work runs and no forge writes happen.*>Engage<\/button><button type="button" id="kill-cancel">Cancel<\/button><\/div><\/dialog>/,
    );
    expect(on).toMatch(
      /<dialog id="kill-dialog"[^>]*><h2 id="kill-title">Reset the kill switch\?<\/h2>.*>Reset<\/button><button type="button" id="kill-cancel">Cancel<\/button>/,
    );
    // Engaged, every page says so first.
    const main = (html: string) => html.slice(html.indexOf('<main id="main">') + 16);
    expect(main(on).startsWith(KILLED_NOTICE)).toBe(true);
    expect(main(off).startsWith('<p>x</p>')).toBe(true);
    expect(KILL_SCRIPT).not.toMatch(/\balert\(/);
  });

  test('the app fills the kill state on every page: unfilled, the slot draws nothing', () => {
    const bare = page('<p>x</p>');
    expect(bare).not.toContain('id="kill-open"');
    expect(fillChrome(bare, { killed: true })).toContain('Kill switch on');
    expect(fillChrome(bare, { killed: true })).toContain(KILLED_NOTICE);
  });

  test('at 375px the top bar wraps its tools and spreads the five links, with no scroller', () => {
    const css = page('x').slice(page('x').indexOf('<style>'), page('x').indexOf('</style>'));
    const mobile =
      /@media \(max-width:720px\)\{\.topbar-in\{([^}]*)\}\.topnav\{([^}]*)\}\.topnav a\{([^}]*)\}/.exec(
        css,
      );
    expect(mobile).not.toBeNull();
    expect(mobile?.[1]).toContain('flex-wrap:wrap');
    expect(mobile?.[2]).toContain('flex-basis:100%');
    expect(mobile?.[2]).toContain('overflow-x:visible');
    expect(mobile?.[2]).toContain('justify-content:space-between');
    expect(mobile?.[3]).toContain('padding:.375rem .375rem');
    expect(css).toMatch(/\.topbar-tools\{[^}]*flex-wrap:wrap/);
    expect(css).toMatch(/\.kill-dialog\{[^}]*max-width:min\(28rem,calc\(100vw - 2rem\)\)/);
  });

  test('breadcrumb: area › object › page, the page itself current and no link', () => {
    expect(
      breadcrumb([
        { label: 'Projects', href: '/projects' },
        { label: 'a&amp;b', href: '/projects/a"b' },
        { label: 'Setup' },
      ]),
    ).toBe(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/projects">Projects</a></li><li><a href="/projects/a&quot;b">a&amp;b</a></li><li><span aria-current="page">Setup</span></li></ol></nav>',
    );
  });
});

describe('the kill switch control script (#628)', () => {
  class Node {
    textContent = '';
    disabled = false;
    open = false;
    dataset: Record<string, string> = {};
    listeners: Record<string, (() => unknown)[]> = {};
    focused = 0;
    addEventListener(ev: string, fn: () => unknown) {
      (this.listeners[ev] ??= []).push(fn);
    }
    async click() {
      await Promise.all((this.listeners.click ?? []).map((fn) => fn()));
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    focus() {
      this.focused++;
    }
  }

  /** The page's kill script in a vm, with `jmFetch` answering `status` and an `alert` that throws. */
  function run(killed: boolean, status = 200, error?: string) {
    const html = page('<p>x</p>', { killed });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1] as string)
      .find((s) => s.includes("'kill-open'"));
    if (!script) throw new Error('no kill script on the page');
    const ids: Record<string, Node> = Object.fromEntries(
      ['kill-open', 'kill-dialog', 'kill-confirm', 'kill-cancel', 'kill-err'].map((id) => [
        id,
        new Node(),
      ]),
    );
    const open = ids['kill-open'] as Node;
    open.dataset.engaged = /data-engaged="(true|false)"/.exec(html)?.[1] ?? '';
    const posts: { url: string; body: unknown }[] = [];
    let reloads = 0;
    let alerts = 0;
    const ctx = vm.createContext({
      document: { getElementById: (id: string) => ids[id] ?? null },
      location: {
        reload: () => {
          reloads++;
        },
      },
      alert: () => {
        alerts++;
        throw new Error('alert called');
      },
      jmFetch: async (url: string, body: unknown) => {
        posts.push({ url, body });
        return {
          ok: status < 300,
          status,
          json: async () => (error === undefined ? {} : { error }),
        };
      },
    });
    vm.runInContext(script, ctx);
    return {
      open,
      dialog: ids['kill-dialog'] as Node,
      confirm: ids['kill-confirm'] as Node,
      cancel: ids['kill-cancel'] as Node,
      err: ids['kill-err'] as Node,
      posts,
      reloads: () => reloads,
      alerts: () => alerts,
    };
  }

  test('pressing Kill switch opens the confirmation and sends nothing; Cancel shuts it', async () => {
    const k = run(false);
    await k.open.click();
    expect(k.dialog.open).toBe(true);
    expect(k.posts).toEqual([]);
    await k.cancel.click();
    expect(k.dialog.open).toBe(false);
    expect(k.posts).toEqual([]);
    expect(k.reloads()).toBe(0);
  });

  test('confirming posts {engaged:true} once, then reloads', async () => {
    const k = run(false);
    await k.open.click();
    await Promise.all([k.confirm.click(), k.confirm.click()]);
    expect(k.posts).toEqual([{ url: '/api/control/kill', body: { engaged: true } }]);
    expect(k.reloads()).toBe(1);
  });

  test('Reset asks too, and its confirmation posts {engaged:false}', async () => {
    const k = run(true);
    await k.open.click();
    expect(k.posts).toEqual([]);
    await k.confirm.click();
    expect(k.posts).toEqual([{ url: '/api/control/kill', body: { engaged: false } }]);
  });

  test('a refused post shows the error in the dialog and never calls alert', async () => {
    const k = run(false, 403, 'forbidden');
    await k.open.click();
    await k.confirm.click();
    expect(k.posts).toHaveLength(1);
    expect(k.dialog.open).toBe(true);
    expect(k.err.textContent).toBe('Refused (403): forbidden');
    expect(k.alerts()).toBe(0);
    expect(k.reloads()).toBe(0);
    // It can be tried again, and reopening clears the old error.
    expect(k.confirm.disabled).toBe(false);
    await k.cancel.click();
    await k.open.click();
    expect(k.err.textContent).toBe('');
  });
});

describe('every chrome page (#628)', () => {
  /** The area pages themselves: the five areas' own and their sub-nav's and tabs' pages. */
  const TOP_LEVEL = new Set([
    '/',
    '/projects',
    '/activity',
    '/activity/work',
    '/activity/drops',
    '/activity/log',
    '/chat',
    '/system',
    '/system/sticks',
    '/system/sticks/images',
    '/system/credentials',
    '/system/server',
    '/system/mcp-tokens',
    '/system/history',
    '/system/advanced',
  ]);
  const OLD = ['Floor', 'Drops', 'Briefings', 'Sticks', 'Settings', 'Doctor', 'Observations'];

  test('one breadcrumb below the areas, none on them; no Back links; only the five in the top bar', async () => {
    const { h, concrete } = await chromeWorld();
    const checked = new Set<string>();
    for (const r of routesOf(h.app).filter((x) => x.method === 'GET')) {
      const url = concrete(r.url);
      const res = await h.view(url);
      if (!res.body.includes('class="topnav"')) continue;
      checked.add(r.url);
      const body = res.body;
      const main = body.slice(body.indexOf('<main'));
      const crumbs = main.match(/<nav[^>]*aria-label="Breadcrumb"/g) ?? [];
      expect(crumbs, url).toHaveLength(TOP_LEVEL.has(url) ? 0 : 1);
      if (crumbs.length === 1)
        expect(main, url).toContain('<nav class="crumbs" aria-label="Breadcrumb"><ol>');
      expect(body, url).not.toMatch(/<a [^>]*>\s*Back\s*<\/a>/);
      // No ad-hoc way back outside the breadcrumb and the top bar.
      const rest = main.replace(/<nav class="crumbs"[\s\S]*?<\/nav>/, '');
      expect(rest, url).not.toMatch(/<a href="\/">Home<\/a>|>All threads<\/a>/);
      const nav = /<nav class="topnav"[^>]*>([\s\S]*?)<\/nav>/.exec(body)?.[1] ?? '';
      const words = [...nav.matchAll(/<a [^>]*>(\w+)/g)].map((m) => m[1]);
      expect(words, url).toEqual(['Home', 'Projects', 'Activity', 'Chat', 'System']);
      for (const old of OLD) expect(nav, `${url} ${old}`).not.toContain(old);
      // The area the page is in is marked; the kill control and its slot are filled.
      const area = navArea(url);
      expect(nav.match(/aria-current="page"/g)?.length ?? 0, url).toBe(area ? 1 : 0);
      expect(body.match(/id="kill-open"/g), url).toHaveLength(1);
      expect(body, url).not.toContain('<!--jm-');
    }
    for (const p of ['/', '/drops/:id', '/briefings/:id', '/chat/:id', '/projects/:id/work/:issue'])
      expect(checked, p).toContain(p);
    // Non-vacuous: a drop's page marks Activity.
    const dropPage = (await h.view('/drops/d1')).body;
    expect(dropPage).toContain(
      '<a href="/activity" aria-current="page" data-area="activity">Activity</a>',
    );
  });

  test('engaged, every page shows the notice first and the control reads "Kill switch on"', async () => {
    const { h, concrete } = await chromeWorld();
    const off = await h.view('/chat');
    expect(off.body).not.toContain('class="kill-on"');
    expect(off.body).toContain('>Kill switch</button>');
    setKilled(h.db, true, h.now());
    for (const url of ['/', '/chat', concrete('/drops/:id'), '/system', '/projects/main']) {
      const body = (await h.view(url)).body;
      expect(body.slice(body.indexOf('<main id="main">') + 16).startsWith(KILLED_NOTICE), url).toBe(
        true,
      );
      expect(body, url).toContain('class="kill-btn on"');
      expect(body, url).toContain('>Kill switch on</button>');
    }
  });

  test("Needs you's badge is on Home's link on every page", async () => {
    const { h } = await chromeWorld();
    const badge = (body: string) =>
      /<a href="\/"[^>]*>Home(<span class="nav-badge"[\s\S]*?<\/span><\/span>)?<\/a>/.exec(
        body,
      )?.[1];
    const n = (await h.view('/')).body.match(/class="needs-row"/g)?.length ?? 0;
    expect(n).toBeGreaterThan(0);
    for (const url of ['/', '/chat', '/system'])
      expect(badge((await h.view(url)).body), url).toContain(`>${n}<`);
  });
});
