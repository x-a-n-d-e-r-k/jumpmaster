import { describe, expect, test } from 'vitest';
import type { Briefing, Ruling } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import { STARTER_WARNING } from '../config.js';
import type { CrewIssue } from '../crew/store.js';
import type { Drop, WorkItem } from '../db/repo.js';
import type { GoalRow } from '../goals.js';
import { forgetSubmitKey, submitKey } from '../intake.js';
import {
  escapeHtml,
  page,
  renderBriefings,
  renderDoctor,
  renderDrop,
  renderGoals,
  renderHome,
  renderIntake,
  statusBanner,
  waitingOnYou,
} from './pages.js';

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
    expect(html).toContain('<h2 id="sticks">Sticks</h2>');
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

  test("shows Command's gate change allowance for the item's head", () => {
    const html = renderHome({
      zones: [z],
      items: [item],
      drops: [],
      details: new Map([
        [1, { headSha: 'abcdef1234567890', gateAllowedSha: 'abcdef1234567890', attempts: {} }],
      ]),
    });
    expect(html).toContain('gate change allowed by Command for abcdef1');
    const plain = renderHome({
      zones: [z],
      items: [item],
      drops: [],
      details: new Map([[1, { headSha: 'abcdef1234567890', attempts: {} }]]),
    });
    expect(plain).not.toContain('allowed by Command');
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

  test('a skipped issue on a rejected or failed crew row is listed with its remedy', () => {
    const html = renderGoals({
      zone: z,
      goals: undefined,
      crewIssues: [
        crewIssue({ id: 5, number: 24, state: 'rejected' }),
        crewIssue({ id: 6, number: 25, state: 'failed' }),
        crewIssue({ id: 7, number: 26, state: 'staged' }),
      ],
      items: [],
      skippedCrewUnpromoted: [24, 25, 26, 27],
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

describe('starter banner', () => {
  test('the home page warns about each starter zone, and says nothing for two-bot', () => {
    const starter = { ...z, id: 'solo', identity: 'starter' } as DropZoneConfig;
    const html = renderHome({ zones: [z, starter], items: [], drops: [] });
    expect(html).toContain('Starter mode in zone solo');
    expect(html).toContain(escapeHtml(STARTER_WARNING));
    expect(renderHome({ zones: [z], items: [], drops: [] })).not.toContain('Starter mode');
  });
});

describe('renderIntake', () => {
  const zone = { id: 'main"><script>x</script>', repo: 'octo/demo' } as DropZoneConfig;

  test('three steps, every value escaped, no secret, and the first issue needs no merged GOAL.md', () => {
    const html = renderIntake(zone);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('main&quot;&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain("the first issue doesn't need GOAL.md merged first");
    for (const t of ['existing', 'idea', 'partial']) expect(html).toContain(`value="${t}"`);
    expect(html).toMatch(/Step 1/);
    expect(html).toMatch(/Step 2/);
    expect(html).toMatch(/Step 3/);
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
  expect(html).toContain('<h2 id="sticks">Sticks</h2>');
});
