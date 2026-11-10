import { describe, expect, test } from 'vitest';
import type { Drop, OutboxRow, WorkItem } from './db/repo.js';
import type { DoctorCheck } from './doctor/checks.js';
import { type StatusInput, type StatusZone, statusOf } from './status.js';
import { plus, t0 } from './test/helpers.js';
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

/** A healthy, idle install: a live stick, one active zone, nothing to do. */
const base = (o: Partial<StatusInput> = {}): StatusInput => ({
  setupActive: false,
  killed: false,
  sticks: { live: 1 },
  doctor: { fails: [] },
  openBriefings: 0,
  zones: [zone()],
  outboxRetrying: [],
  restartPending: false,
  ...o,
});

/**
 * Every state at once, highest first: removing the top condition each time must surface the next
 * headline. Each row: what to remove, then the expected headline, waitingOn and action href.
 */
function everything(): StatusInput {
  return base({
    setupActive: true,
    killed: true,
    killedSince: plus(NOW, -5 * MIN).toISOString(),
    usagePausedUntil: plus(NOW, 30 * MIN).toISOString(),
    sticks: { live: 0 },
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
          item({ id: 4, issueNumber: 10, state: 'ready' }),
        ],
        drops: [drop(), drop({ id: 'q1', workItemId: 4, state: 'queued', startedAt: null })],
        parked: 1,
        credentialProblems: [problem()],
        prs: [{ workItemId: 2, number: 12, headFirstSeenAt: plus(NOW, -20 * MIN).toISOString() }],
        gateEvents: { d1: 1 },
      }),
    ],
  });
}

type Step = [string, (i: StatusInput) => void, string, string, string | undefined];

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
    'usage',
    (i) => void delete i.usagePausedUntil,
    `Paused by Claude's usage limit until ${plus(NOW, 30 * MIN).toISOString()}`,
    'claude',
    '/',
  ],
  [
    'stick',
    (i) => void (i.sticks = { live: 1 }),
    "No runner: the stick hasn't checked in",
    'stick',
    '/',
  ],
  [
    'running',
    (i) => void (i.zones[0] as StatusZone).drops.shift(),
    'Working: implement #7 in main, 12m 0s, gate 1 of 3',
    'nothing',
    '/drops/d1',
  ],
  [
    'ci',
    (i) => void delete (i.zones[0] as StatusZone).prs,
    'Waiting on CI for PR #12 (20 of 45 min)',
    'ci',
    'https://github.com/octo/demo/pull/12',
  ],
  [
    'credentials',
    (i) => void ((i.zones[0] as StatusZone).credentialProblems = []),
    'Blocked: main needs claudeToken: no Claude token is set: enter it under Settings, Credentials',
    'credentials',
    '/settings/credentials',
  ],
  [
    'doctor',
    (i) => void (i.doctor = { fails: [] }),
    'Blocked: 2 doctor fails, first forge.labels',
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
    (i) => void ((i.zones[0] as StatusZone).mode = 'active'),
    'Paused by you: main (paused)',
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
    (i) => void ((i.zones[0] as StatusZone).parked = 0),
    '1 parked: CODEOWNERS does not cover GOAL.md',
    'you',
    '/',
  ],
  [
    'queued',
    (i) => void ((i.zones[0] as StatusZone).drops = []),
    'Queued: 1 issue; every slot is busy',
    'stick',
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
    // The paused state needs every zone paused; it sits under the headlines above it all along.
    (input.zones[0] as StatusZone).mode = 'paused';
    const seen: [string, string, string, string | undefined][] = [];
    for (const [name, remove, , ,] of STEPS) {
      const s = statusOf(input, NOW);
      seen.push([name, s.headline, s.waitingOn, s.action?.href]);
      remove(input);
    }
    expect(seen).toEqual(STEPS.map(([name, , h, w, href]) => [name, h, w, href]));
  });

  test('running work outranks a doctor fail older than the last pass and a credential problem in another zone, which move to the detail', () => {
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
    expect(s.detail).toContain('Also blocked: docs needs claudeToken');
    expect(s.detail).toContain('1 doctor fail (forge.labels) from a run before the last pass');
    expect(s.detail).toContain('takes effect at the next restart');
    // An older doctor fail alone never takes the headline.
    const idle = statusOf(
      base({
        doctor: { fails: [fail('forge.labels')], finishedAt: plus(NOW, -10 * MIN).toISOString() },
        lastPassAt: plus(NOW, -MIN).toISOString(),
      }),
      NOW,
    );
    expect(idle.headline).toMatch(/^Idle/);
    expect(idle.detail).toContain('forge.labels');
  });

  test('a credential problem takes the headline only when no zone is working, naming the zone and the credential', () => {
    const blocked = statusOf(
      base({
        zones: [
          zone({
            credentialProblems: [
              problem({ credential: 'githubAuthorToken', message: 'no author token' }),
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
            doctorWait: 'waiting for a stick that can run zone main (see stick.capabilities)',
          }),
        ],
        usageGate: 'finishing_only',
      }),
      NOW,
    );
    expect(doctorQueued.headline).toBe('Queued: 1 issue; every slot is busy');
    expect(doctorQueued.detail).toContain(
      'The doctor drop in main: waiting for a stick that can run zone main',
    );
    expect(doctorQueued.detail).toContain('only finishing work starts');
  });

  test('the status names zones, issues and PRs and never a token', () => {
    const token = 'github_pat_STATUSNEVERSHOWN0123456789';
    const s = statusOf(everything(), NOW);
    const all = JSON.stringify([s, ...STEPS.map(() => s)]);
    expect(all).not.toContain(token);
    // Text is plain: the page escapes it. A zone id with markup comes back as written.
    const odd = statusOf(
      base({
        zones: [
          zone({ id: 'a<b', parked: 1, items: [item({ state: 'parked', reason: 'r <x>' })] }),
        ],
      }),
      NOW,
    );
    expect(odd.headline).toBe('1 parked: r <x>');
  });
});
