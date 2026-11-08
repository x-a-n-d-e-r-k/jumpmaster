import { describe, expect, test } from 'vitest';
import type { Briefing, Ruling } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { CrewIssue } from '../crew/store.js';
import type { Drop, WorkItem } from '../db/repo.js';
import type { GoalRow } from '../goals.js';
import { renderBriefings, renderDrop, renderGoals, renderHome, waitingOnYou } from './pages.js';

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
  test('escapes issue titles', () => {
    const html = renderHome({
      zones: [z],
      items: [{ ...item, title: '<script>alert(1)</script>' }],
      drops: [],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('a blocked ready item shows what it waits on', () => {
    const html = renderHome({
      zones: [z],
      items: [{ ...item, state: 'ready', prNumber: null, blockedBy: ['#4', 'o/x#<2>'] }],
      drops: [],
    });
    expect(html).toContain('waiting on #4, o/x#&lt;2&gt;');
  });

  test('escapes reasons, gate names and shows PR link, elapsed, rate limit', () => {
    const html = renderHome({
      zones: [z],
      items: [{ ...item, reason: '"><img src=x>' }],
      drops: [drop],
      lastRateLimit: {
        dropId: 'd1',
        seq: 1,
        ts: 't',
        kind: 'rate_limit',
        data: { x: '<i>' },
      },
    });
    expect(html).toContain('Jumpmaster');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('lint<b>');
    expect(html).toContain('lint&lt;b&gt;');
    expect(html).not.toContain('<i>');
    expect(html).toContain('https://github.com/octo/demo/pull/9');
    expect(html).toContain('1m 5s');
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

describe('renderHome loop state', () => {
  test('shows usage gate', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      usage: { gate: 'closed', state: usageState },
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
    const html = renderHome({
      zones: [z],
      items: [item],
      drops: [{ ...drop, role: 'review' }],
      details: new Map([
        [
          1,
          {
            headSha: 'abcdef1234567890',
            verdict: { decision: 'approve', forced: true, summary: 'fine' },
            attempts: { heal: 2, review: 1 },
          },
        ],
      ]),
    });
    expect(html).toContain('abcdef1');
    expect(html).not.toContain('abcdef12345');
    expect(html).toContain('approve (forced)');
    expect(html).toContain('heal 2');
    expect(html).toContain('review 1');
    expect(html).toContain('<td>review</td>');
  });

  test('escapes verdict summary', () => {
    const html = renderHome({
      zones: [z],
      items: [item],
      drops: [],
      details: new Map([
        [
          1,
          {
            headSha: 'h',
            verdict: { decision: 'request_changes', forced: false, summary: '<svg onload=x>' },
            attempts: {},
          },
        ],
      ]),
    });
    expect(html).not.toContain('<svg onload=x>');
    expect(html).toContain('&lt;svg onload=x&gt;');
  });

  test('lists unknown and failed outbox ops', () => {
    const op = (id: string, state: 'unknown' | 'failed', error: string | null) => ({
      id,
      opKey: `k-${id}`,
      kind: 'merge' as const,
      workItemId: 1,
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
    expect(html).toContain('<h2>Outbox</h2>');
    expect(html).toContain('o1');
    expect(html).toContain('unknown');
    expect(html).toContain('o2');
    expect(html).toContain('&lt;b&gt;409&lt;/b&gt;');
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
  ...o,
});

describe('briefings', () => {
  test('home shows "Waiting on you" with each open briefing and a link to /briefings', () => {
    const html = renderHome({
      zones: [z],
      items: [],
      drops: [],
      briefings: [briefing(), briefing({ id: 5, decision: 'Retry #7?' })],
    });
    expect(html).toContain('<h2>Waiting on you</h2>');
    expect(html).toContain('Split the CLI objective?');
    expect(html).toContain('Retry #7?');
    expect(html).toContain('href="/briefings"');
    expect(waitingOnYou([])).toContain('Nothing is waiting on you.');
  });

  test('each open briefing shows decision, why, options, recommendation and what is on hold', () => {
    const html = renderBriefings({ open: [briefing()], rulings: [], zones: [z] });
    expect(html).toContain('Briefings (decisions waiting on you)');
    expect(html).toContain('Rulings (decisions recorded)');
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

  test('a rule form posts optionId with the operator token from a password field', () => {
    const html = renderBriefings({ open: [briefing()], rulings: [], zones: [z] });
    expect(html).toMatch(/<form class="rule" data-briefing="4">/);
    expect(html).toContain('type="password"');
    expect(html).toContain("'/api/control/briefings/'+f.dataset.briefing+'/rule'");
    expect(html).toContain("authorization:'Bearer '+");
    expect(html).toContain('JSON.stringify({optionId:');
    expect(html).toContain('location.reload()');
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
    const ruling: Ruling = {
      id: 1,
      zoneId: 'main',
      briefingId: 4,
      choice: X,
      note: X,
      createdAt: 't',
      appliedAt: null,
      applyError: X,
    };
    const html =
      renderBriefings({ open: [evil], rulings: [ruling], zones: [z] }) +
      renderHome({ zones: [z], items: [], drops: [], briefings: [evil] }) +
      renderGoals({
        zone: z,
        goals: undefined,
        crewIssues: [
          crewIssue({ title: X, key: X, objective: X, findingsJson: JSON.stringify([X]) }),
        ],
        items: [],
        skippedCrewUnpromoted: [],
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
      goals: undefined,
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [12, 13],
    });
    expect(html).toContain('Crew issues not started (no recorded promotion)');
    expect(html).toContain('#12');
    expect(html).toContain('#13');
  });

  test('an unparsed GOAL.md shows its parse error', () => {
    const html = renderGoals({
      zone: z,
      goals: goals({ ok: false, error: 'no ## Objectives section' }),
      crewIssues: [],
      items: [],
      skippedCrewUnpromoted: [],
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
      /main<\/td><td>on<\/td><td>2026-01-01T00:00:00.000Z<\/td><td>2026-01-01T01:00:00.000Z<\/td><td>plan pro does not include Fable/,
    );
  });
});
