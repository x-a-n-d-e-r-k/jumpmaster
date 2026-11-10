import { describe, expect, test } from 'vitest';
import { openDb } from './db/open.js';
import type { Drop, OutboxRow, WorkItem } from './db/repo.js';
import type { DoctorCheck } from './doctor/checks.js';
import {
  cannotRunText,
  lastPassAt,
  recordPass,
  type StatusInput,
  type StatusZone,
  statusOf,
  type UsageFacts,
} from './status.js';
import { plus, t0, tmpDbFile } from './test/helpers.js';
import type { CredentialProblem } from './vault/problems.js';

const NOW = plus(t0, 60 * 60_000);
const MIN = 60_000;

const item = (o: Partial<WorkItem> = {}): WorkItem => ({
  id: 1,
  dropZoneId: 'main',
  issueNumber: 7,
  title: 'Add sum',
  body: 'b',
  author: 'a',
  priority: 0,
  isFix: false,
  issueCreatedAt: t0.toISOString(),
  state: 'ready',
  reason: null,
  prNumber: null,
  retryLabelSeen: false,
  waitingSince: null,
  blockedBy: [],
  ...o,
});

const drop = (o: Partial<Drop> = {}): Drop => ({
  id: 'd1',
  dropZoneId: 'main',
  workItemId: 1,
  role: 'implement',
  state: 'running',
  stickId: 's1',
  epoch: 1,
  leaseExpiresAt: null,
  promptVersion: null,
  image: null,
  resultJson: null,
  createdAt: t0.toISOString(),
  startedAt: plus(NOW, -12 * MIN).toISOString(),
  finishedAt: null,
  fingerprint: null,
  prNumber: null,
  headSha: null,
  inputJson: null,
  chargedKey: null,
  requestedModel: null,
  servedModel: null,
  ...o,
});

const fail = (id: string): DoctorCheck => ({ id, zoneId: null, status: 'fail', summary: id });
const problem = (o: Partial<CredentialProblem> = {}): CredentialProblem => ({
  zoneId: 'main',
  kind: 'missing',
  credential: 'claudeToken',
  message: 'no Claude token is set: enter it under Settings, Credentials',
  ...o,
});
const outbox = (o: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 'o1',
  opKey: 'k',
  kind: 'merge',
  workItemId: 1,
  zoneId: 'main',
  payloadJson: '{}',
  state: 'unknown',
  resultJson: null,
  error: null,
  createdAt: t0.toISOString(),
  updatedAt: t0.toISOString(),
  ...o,
});

const zone = (o: Partial<StatusZone> = {}): StatusZone => ({
  id: 'main',
  mode: 'active',
  items: [],
  drops: [],
  parked: 0,
  credentialProblems: [],
  repo: 'octo/demo',
  ciDeadlineMinutes: 45,
  gateCount: 3,
  ...o,
});

/** A healthy, idle install: a live stick with a free slot, one active zone, nothing to do. */
const base = (o: Partial<StatusInput> = {}): StatusInput => ({
  setupActive: false,
  killed: false,
  sticks: { live: 1, slots: 1, busy: 0 },
  doctor: { fails: [] },
  lastPassAt: plus(NOW, -MIN).toISOString(),
  openBriefings: 0,
  zones: [zone()],
  outboxRetrying: [],
  restartPending: false,
  ...o,
});

const STOP_AT = plus(NOW, -10 * MIN).toISOString();
const RESET_AT = plus(NOW, 4 * 60 * MIN).toISOString();
const stopped: UsageFacts = {
  gate: 'stopped',
  overageDropId: 'cd9',
  overageStoppedAt: STOP_AT,
  overageUntil: RESET_AT,
};

/**
 * Every state at once, highest first: removing the top condition each time must surface the next
 * headline. Each row: what to remove, then the expected headline, waitingOn and action href.
 */
function everything(): StatusInput {
  return base({
    setupActive: true,
    killed: true,
    killedSince: plus(NOW, -5 * MIN).toISOString(),
    usage: stopped,
    usagePausedUntil: plus(NOW, 30 * MIN).toISOString(),
    sticks: { live: 0, slots: 0, busy: 0 },
    doctor: { fails: [fail('forge.labels'), fail('stick.seen')], finishedAt: NOW.toISOString() },
    lastPassAt: plus(NOW, -MIN).toISOString(),
    openBriefings: 2,
    outboxRetrying: [outbox()],
    zones: [
      zone({
        items: [
          item({ id: 1, issueNumber: 7, state: 'in_flight' }),
          item({ id: 2, issueNumber: 8, state: 'pr_open', prNumber: 12 }),
          item({
            id: 3,
            issueNumber: 9,
            state: 'parked',
            reason: 'CODEOWNERS does not cover GOAL.md',
          }),
          item({ id: 4, issueNumber: 10, state: 'in_flight' }),
          item({ id: 5, issueNumber: 11, state: 'ready' }),
        ],
        drops: [drop(), drop({ id: 'q1', workItemId: 4, state: 'queued', startedAt: null })],
        parked: 1,
        prs: [{ workItemId: 2, number: 12, headFirstSeenAt: plus(NOW, -20 * MIN).toISOString() }],
        gateEvents: { d1: 1 },
      }),
      // The credential problem is another zone's: a zone parked for one has no held work.
      zone({ id: 'docs', credentialProblems: [problem({ zoneId: 'docs' })] }),
    ],
  });
}

type Step = [string, (i: StatusInput) => void, string, string, string | undefined];
const z0 = (i: StatusInput) => i.zones[0] as StatusZone;

const STEPS: Step[] = [
  ['setup', (i) => void (i.setupActive = false), 'Finish setup', 'setup', '/setup'],
  [
    'killed',
    (i) => void (i.killed = false),
    `Stopped by the kill switch since ${plus(NOW, -5 * MIN).toISOString()}`,
    'you',
    '/',
  ],
  [
    'credits stop',
    (i) => void (i.usage = { gate: 'finishing_only' }),
    `Stopped: drop cd9 ran on usage credits at ${STOP_AT}; nothing new runs until you rule on the credits briefing or the window resets at ${RESET_AT}`,
    'you',
    '/briefings',
  ],
  [
    'usage pause',
    (i) => void delete i.usagePausedUntil,
    `Paused by Claude's usage limit until ${plus(NOW, 30 * MIN).toISOString()}`,
    'claude',
    '/',
  ],
  [
    'stick',
    (i) => void (i.sticks = { live: 1, slots: 1, busy: 1 }),
    "No runner: the stick hasn't checked in",
    'stick',
    '/#sticks',
  ],
  [
    'running',
    (i) => void z0(i).drops.shift(),
    'Working: implement #7 in main, 12m 0s, gate 1 of 3',
    'nothing',
    '/drops/d1',
  ],
  [
    'ci',
    (i) => void delete z0(i).prs,
    'Waiting on CI for PR #12 (20 of 45 min)',
    'ci',
    'https://github.com/octo/demo/pull/12',
  ],
  [
    'held',
    (i) => {
      // The gate opens, and the zone is paused: the states below it read a paused zone.
      i.usage = { gate: 'open' };
      z0(i).mode = 'paused';
      (i.zones[1] as StatusZone).mode = 'paused';
    },
    "Held by Claude's usage throttle: 2 issues wait; only finishing work starts",
    'claude',
    '/',
  ],
  [
    'credentials',
    (i) => void ((i.zones[1] as StatusZone).credentialProblems = []),
    'Blocked: docs needs claudeToken: no Claude token is set: enter it under Settings, Credentials',
    'credentials',
    '/settings/credentials',
  ],
  [
    'doctor',
    (i) => void (i.doctor = { fails: [] }),
    '2 doctor fails, first forge.labels',
    'doctor',
    '/doctor',
  ],
  [
    'briefings',
    (i) => void (i.openBriefings = 0),
    'Waiting on you: 2 briefings',
    'you',
    '/briefings',
  ],
  [
    'paused',
    (i) => void (z0(i).mode = 'active'),
    'Paused by you: main (paused), docs (paused)',
    'you',
    '/zones',
  ],
  [
    'outbox',
    (i) => void (i.outboxRetrying = []),
    'Retrying a GitHub call: merge in main',
    'forge',
    '/',
  ],
  [
    'parked',
    (i) => void (z0(i).parked = 0),
    '1 parked: CODEOWNERS does not cover GOAL.md',
    'you',
    '/',
  ],
  [
    'queued',
    (i) => void (z0(i).drops = []),
    'Queued: 1 issue; every slot is busy',
    'stick',
    undefined,
  ],
  [
    'ready, waiting for the pass',
    (i) => void (z0(i).items = z0(i).items.filter((it) => it.state !== 'ready')),
    '1 ready issue waits for the next pass',
    'nothing',
    undefined,
  ],
  [
    'idle',
    () => {},
    'Idle: no ready issues. Label one agent-ready or file one from Intake',
    'you',
    '/zones/main/intake',
  ],
];

describe('statusOf', () => {
  test('statusOf returns one headline per state, in priority order, over the fixture table', () => {
    const input = everything();
    const seen: [string, string, string, string | undefined][] = [];
    for (const [name, remove] of STEPS) {
      const s = statusOf(input, NOW);
      seen.push([name, s.headline, s.waitingOn, s.action?.href]);
      remove(input);
    }
    expect(seen).toEqual(STEPS.map(([name, , h, w, href]) => [name, h, w, href]));
  });

  test('running work outranks a doctor fail older than the last pass and a credential problem in another zone, which move to the list of other blockers', () => {
    const s = statusOf(
      base({
        doctor: { fails: [fail('forge.labels')], finishedAt: plus(NOW, -10 * MIN).toISOString() },
        lastPassAt: plus(NOW, -MIN).toISOString(),
        restartPending: true,
        zones: [
          zone({ items: [item({ state: 'in_flight' })], drops: [drop()], gateEvents: {} }),
          zone({ id: 'docs', credentialProblems: [problem({ zoneId: 'docs' })] }),
        ],
      }),
      NOW,
    );
    expect(s.headline).toBe('Working: implement #7 in main, 12m 0s, gate 0 of 3');
    expect(s.since).toBe(plus(NOW, -12 * MIN).toISOString());
    // The detail explains the headline only; every other cause is a short item with its fix.
    expect(s.detail).toBe('');
    expect(s.also).toEqual([
      { text: 'docs: no Claude token', href: '/settings/credentials' },
      { text: '1 doctor fail (forge.labels), from a run before the last pass', href: '/doctor' },
      { text: 'a setting takes effect at the next restart' },
    ]);
    // An older doctor fail alone never takes the headline.
    const idle = statusOf(
      base({
        doctor: { fails: [fail('forge.labels')], finishedAt: plus(NOW, -10 * MIN).toISOString() },
      }),
      NOW,
    );
    expect(idle.headline).toMatch(/^Idle/);
    expect(idle.also?.map((a) => a.text)).toEqual([
      '1 doctor fail (forge.labels), from a run before the last pass',
    ]);
  });

  test('a credential problem takes the headline only when no zone is working, naming the zone and the credential', () => {
    const blocked = statusOf(
      base({
        zones: [
          zone({
            credentialProblems: [
              problem({ credential: 'githubAuthorToken', message: 'no author token' }),
              problem({
                credential: 'githubReviewerToken',
                kind: 'same',
                message: 'same as author',
              }),
            ],
          }),
        ],
      }),
      NOW,
    );
    expect(blocked.headline).toBe('Blocked: main needs githubAuthorToken: no author token');
    expect(blocked.waitingOn).toBe('credentials');
    expect(blocked.action).toEqual({
      label: 'Open Settings, Credentials',
      href: '/settings/credentials',
    });
    // The other problem is listed, in the short form; the headline's own is not repeated.
    expect(blocked.also).toEqual([
      { text: 'main: the reviewer token is the same as another', href: '/settings/credentials' },
    ]);
    // Before the Credentials tab exists, the wizard step that sets it.
    const early = statusOf(
      base({
        zones: [zone({ credentialProblems: [problem()] })],
        pages: { zones: false, settings: false, credentials: false },
      }),
      NOW,
    );
    expect(early.action?.href).toBe('/setup/claude');
    const working = statusOf(
      base({
        zones: [
          zone({ id: 'docs', credentialProblems: [problem({ zoneId: 'docs' })] }),
          zone({ items: [item({ state: 'in_flight' })], drops: [drop()] }),
        ],
      }),
      NOW,
    );
    expect(working.headline).toMatch(/^Working: implement #7 in main/);
  });

  test('pausing a zone with work still running says it is draining, and a queued doctor drop says why it waits', () => {
    const draining = statusOf(
      base({
        zones: [
          zone({
            mode: 'observe',
            drops: [drop({ state: 'queued', startedAt: null })],
            items: [item({ state: 'in_flight' })],
          }),
        ],
      }),
      NOW,
    );
    expect(draining.headline).toBe('Paused by you: main (observe)');
    expect(draining.detail).toContain('main is still draining 1 drop');
    const doctorQueued = statusOf(
      base({
        zones: [
          zone({
            drops: [drop({ role: 'doctor', workItemId: null, state: 'queued', startedAt: null })],
            doctorWait: 'waiting for a free stick slot',
          }),
        ],
      }),
      NOW,
    );
    // A doctor drop is not an issue (M7), and a free slot is not "busy".
    expect(doctorQueued.headline).toBe('Queued: 1 drop; it starts when a stick next asks for work');
    expect(doctorQueued.detail).toContain(
      'The doctor drop in main: waiting for a free stick slot.',
    );
  });

  test('the status names zones, issues and PRs and never a token', () => {
    const token = 'github_pat_STATUSNEVERSHOWN0123456789';
    const s = statusOf(everything(), NOW);
    expect(JSON.stringify(s)).not.toContain(token);
    // Text is plain: the page escapes it.
    const odd = statusOf(
      base({ zones: [zone({ parked: 1, items: [item({ state: 'parked', reason: 'r <x>' })] })] }),
      NOW,
    );
    expect(odd.headline).toBe('1 parked: r <x>');
  });
});

describe('usage holds (round 2, I1 and I2)', () => {
  const ready = () => [item({ id: 5, issueNumber: 11, state: 'ready' })];

  test('the credits stop has its own headline after the kill switch, with the two rulings in the detail', () => {
    const s = statusOf(
      base({ usage: stopped, openBriefings: 1, zones: [zone({ items: ready() })] }),
      NOW,
    );
    expect(s.headline).toBe(
      `Stopped: drop cd9 ran on usage credits at ${STOP_AT}; nothing new runs until you rule on the credits briefing or the window resets at ${RESET_AT}`,
    );
    expect(s.waitingOn).toBe('you');
    expect(s.since).toBe(STOP_AT);
    expect(s.action).toEqual({ label: 'Rule on it', href: '/briefings' });
    expect(s.detail).toContain('Run on credits now');
    expect(s.detail).toContain('Noted');
    expect(s.detail).toContain('reviews included');
    // Above a usage pause too; below the kill switch.
    expect(statusOf(base({ usage: stopped, usagePausedUntil: RESET_AT }), NOW).headline).toMatch(
      /^Stopped: drop cd9/,
    );
    expect(statusOf(base({ usage: stopped, killed: true }), NOW).headline).toMatch(
      /^Stopped by the kill switch/,
    );
  });

  test('the throttle holds ready work: the line names it instead of Idle', () => {
    const s = statusOf(
      base({ usage: { gate: 'finishing_only' }, zones: [zone({ items: ready() })] }),
      NOW,
    );
    expect(s.headline).toBe(
      "Held by Claude's usage throttle: 1 issue waits; only finishing work starts",
    );
    expect(s.waitingOn).toBe('claude');
    // Nothing ready or queued: the throttle holds nothing, so the line is Idle.
    expect(statusOf(base({ usage: { gate: 'finishing_only' } }), NOW).headline).toMatch(/^Idle/);
  });

  test('a probe after a pause or a credits stop says one drop runs until the limit shows clear', () => {
    const s = statusOf(
      base({
        usage: { gate: 'probe', overageProbeSince: STOP_AT },
        zones: [zone({ items: ready() })],
      }),
      NOW,
    );
    expect(s.headline).toBe(
      'Probing the usage limit: one drop runs until it shows the limit cleared; 1 issue waits',
    );
    expect(s.detail).toContain(`The credits stop ended at ${STOP_AT}`);
    expect(s.waitingOn).toBe('claude');
  });

  test('a credits Resume names the work item that runs and until when', () => {
    const s = statusOf(
      base({
        usage: { gate: 'credits_resume', overageResumeWorkItemId: 4, overageResumeUntil: RESET_AT },
        zones: [
          zone({
            items: [...ready(), item({ id: 4, issueNumber: 10, state: 'in_flight' })],
            drops: [drop({ id: 'q2', workItemId: 5, state: 'queued', startedAt: null })],
          }),
        ],
      }),
      NOW,
    );
    expect(s.headline).toBe(`Resuming after a credits stop: only #10 runs until ${RESET_AT}`);
    expect(s.waitingOn).toBe('claude');
  });

  test('queued work no live stick can run says which capability is missing, and every-slot-busy only when it is', () => {
    const q = () => [drop({ id: 'q1', workItemId: 5, state: 'queued', startedAt: null })];
    const items = [item({ id: 5, issueNumber: 11, state: 'in_flight' })];
    const capability = statusOf(
      base({ zones: [zone({ items, drops: q(), cannotRun: 'no live stick has egress-v1' })] }),
      NOW,
    );
    expect(capability.headline).toBe(
      'Queued: 1 issue; no stick can run zone main: no live stick has egress-v1',
    );
    expect(capability.waitingOn).toBe('stick');
    const busy = statusOf(
      base({ sticks: { live: 1, slots: 2, busy: 2 }, zones: [zone({ items, drops: q() })] }),
      NOW,
    );
    expect(busy.headline).toBe('Queued: 1 issue; every slot is busy');
    const free = statusOf(
      base({ sticks: { live: 1, slots: 2, busy: 1 }, zones: [zone({ items, drops: q() })] }),
      NOW,
    );
    expect(free.headline).toBe('Queued: 1 issue; it starts when a stick next asks for work');
  });
});

describe('the detail and its list (round 2: S1, M2, M3)', () => {
  test('a paused zone among active ones is listed with a link to it', () => {
    const s = statusOf(base({ zones: [zone(), zone({ id: 'docs', mode: 'paused' })] }), NOW);
    expect(s.headline).toMatch(/^Idle/);
    expect(s.also).toEqual([{ text: 'docs is paused', href: '/zones/docs' }]);
  });

  test('before the first pass the list says so, and fails count as new', () => {
    const s = statusOf(
      base({
        lastPassAt: undefined,
        doctor: { fails: [fail('forge.labels')], finishedAt: STOP_AT },
      }),
      NOW,
    );
    expect(s.headline).toBe('1 doctor fail, first forge.labels');
    expect(s.also).toEqual([{ text: 'no pass yet since start' }]);
  });
});

describe('the last pass (round 2, M3)', () => {
  test('the end of a pass is stamped in the database, so a restart keeps it', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    expect(lastPassAt(db)).toBeUndefined();
    recordPass(db, NOW);
    db.close();
    expect(lastPassAt(openDb(file))).toBe(NOW.toISOString());
  });
});

describe('round 3', () => {
  const blocked = (id: number, by: string[]) =>
    item({ id, issueNumber: id + 10, state: 'ready', blockedBy: by });

  test('a ready issue blocked by another says what it waits on, and never counts as held', () => {
    const one = statusOf(base({ zones: [zone({ items: [blocked(5, ['#5'])] })] }), NOW);
    expect(one.headline).toBe('1 ready issue waits on the issues it is blocked by (#5)');
    const two = statusOf(
      base({ zones: [zone({ items: [blocked(5, ['#5']), blocked(6, ['#5', 'octo/lib#2'])] })] }),
      NOW,
    );
    expect(two.headline).toBe(
      '2 ready issues wait on the issues they are blocked by (#5, octo/lib#2)',
    );
    // Under the throttle, a blocked item is not work the gate holds.
    const throttled = statusOf(
      base({ usage: { gate: 'finishing_only' }, zones: [zone({ items: [blocked(5, ['#5'])] })] }),
      NOW,
    );
    expect(throttled.headline).toBe('1 ready issue waits on the issues it is blocked by (#5)');
    const mixed = statusOf(
      base({
        usage: { gate: 'finishing_only' },
        zones: [zone({ items: [blocked(5, ['#5']), item({ id: 9, state: 'ready' })] })],
      }),
      NOW,
    );
    expect(mixed.headline).toBe(
      "Held by Claude's usage throttle: 1 issue waits; only finishing work starts",
    );
  });

  test('a zone parked for a credential is not throttled work: the credential takes the headline', () => {
    const s = statusOf(
      base({
        usage: { gate: 'finishing_only' },
        zones: [zone({ items: [item({ state: 'ready' })], credentialProblems: [problem()] })],
      }),
      NOW,
    );
    expect(s.headline).toMatch(/^Blocked: main needs claudeToken/);
  });

  test('a queued crew-lead drop under the throttle is held, not about to start', () => {
    const s = statusOf(
      base({
        usage: { gate: 'finishing_only' },
        zones: [
          zone({
            drops: [
              drop({
                id: 'c1',
                role: 'crew-lead',
                workItemId: null,
                state: 'queued',
                startedAt: null,
              }),
            ],
          }),
        ],
      }),
      NOW,
    );
    expect(s.headline).toBe(
      "Held by Claude's usage throttle: 1 drop waits; only finishing work starts",
    );
  });

  test('a missing capability is named for every stick, or as shared only when every stick lacks it', () => {
    const egress = 'egress-v1';
    expect(
      cannotRunText([
        { name: 'a', missing: [egress] },
        { name: 'b', missing: [egress, 'image-verify-v1'] },
      ]),
    ).toBe('no live stick has egress-v1');
    expect(
      cannotRunText([
        { name: 'a', missing: [egress] },
        { name: 'b', missing: ['image-verify-v1'] },
      ]),
    ).toBe('no live stick can run it (a lacks egress-v1; b lacks image-verify-v1)');
    expect(cannotRunText([{ name: 'a', missing: [] }])).toBeUndefined();
  });
});
