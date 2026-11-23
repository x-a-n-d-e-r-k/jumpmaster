import { describe, expect, test } from 'vitest';
import { raiseBriefing } from '../briefings.js';
import { recordCard } from '../chat/cards.js';
import { appendMessage, createThread } from '../chat/store.js';
import { type Drop, setZoneMode, type WorkItem } from '../db/repo.js';
import type { DoctorCheck } from '../doctor/checks.js';
import { modeCardSummary } from '../mcp/chat-actions.js';
import { type StatusInput, type StatusZone, statusOf } from '../status.js';
import { harness } from '../test/flowHarness.js';
import { operatorSession, plus, t0 } from '../test/helpers.js';

/**
 * What a reader sees of a page: no `<script>`, `<style>`, `<code>` or `<pre>` content, no tags
 * (so no attribute values), no comments, entities decoded.
 */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|code|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const ZONE_WORD = /\bzones?\b/i;
const FLOOR_WORD = /\bFloor\b/;

/** Each offending match with some context around it, so a failure names the sentence. */
function offenders(text: string): string[] {
  const out: string[] = [];
  for (const re of [new RegExp(ZONE_WORD, 'gi'), new RegExp(FLOOR_WORD, 'g')])
    for (const m of text.matchAll(re))
      out.push(text.slice(Math.max(0, m.index - 60), m.index + 60).trim());
  return out;
}

describe('visibleText', () => {
  test('drops tags, attribute values, code, pre, script and style', () => {
    const html = `<p title="zone">Run <code>jumpmaster ctl zones list</code> for the
      <a href="/zones/x" data-zone="main">project</a></p><pre>zone: main</pre>
      <script>const zone = 1;</script><style>.zone{}</style><!-- zone -->`;
    expect(visibleText(html)).toBe(' Run for the project ');
    expect(offenders(visibleText(html))).toEqual([]);
  });

  test('keeps text that says zone', () => {
    expect(offenders(visibleText('<p>The zone is paused</p><h2>Floor</h2>'))).toHaveLength(2);
  });
});

const PROTECTED = ['.github/**', 'CODEOWNERS', 'GOAL.md'];
const PATCH_NEEDING_CONFIRMATION = { dropZones: [{ id: 'main', ciRequired: false }] };

async function seeded() {
  const h = await harness({
    live: true,
    zone: { ciRequired: true, protectedPaths: PROTECTED },
    extraZones: [{ id: 'merlin', repo: 'octo/merlin', protectedPaths: PROTECTED }],
    // The project's GitHub section reads these, never the network.
    guidanceForge: () => ({
      repoAccess: async () => ({
        private: false,
        defaultBranch: 'main',
        permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
        scopes: null,
        tokenExpiresAt: null,
        ownerType: 'Organization',
      }),
      ownerType: async () => 'Organization',
      viewerLogin: async () => 'jm-author',
      listDir: async () => [],
      getFileAt: async () => null,
    }),
  });
  const at = h.now();
  setZoneMode(h.db, 'merlin', 'paused', at);
  h.db
    .prepare('INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES (?, ?, ?)')
    .run(
      at.toISOString(),
      at.toISOString(),
      JSON.stringify([
        { id: 'config.listen', zoneId: null, status: 'pass', summary: 'loopback only' },
        {
          id: 'zone.mode',
          zoneId: 'merlin',
          status: 'warn',
          summary: 'the project is paused: no new drop starts in it',
        },
        {
          id: 'forge.labels',
          zoneId: 'main',
          status: 'fail',
          summary: 'label agent-ready is missing',
          fix: 'gh label create agent-ready',
        },
      ]),
    );
  const briefing = raiseBriefing(
    h.db,
    {
      zoneId: 'main',
      kind: 'crew',
      subject: 'crew:a',
      decision: 'Which way?',
      why: 'w',
      options: [
        { id: 'o1', label: 'Yes', effect: 'none' },
        { id: 'o2', label: 'No', effect: 'none' },
      ],
      source: 'crew',
    },
    at,
  );
  // A guarded change waiting for its confirmation.
  const s = operatorSession(h.db, at);
  const store = h.store;
  if (!store) throw new Error('live harness has a store');
  const r = await h.app.inject({
    method: 'PATCH',
    url: '/api/control/config',
    headers: s.headers,
    payload: { patch: PATCH_NEEDING_CONFIRMATION, expectRevision: store.revision() },
  });
  expect(r.statusCode, r.body).toBe(409);
  const confirm = r.json().confirm as string;
  // A chat thread focused on a project, with a card.
  const th = createThread(
    h.db,
    { title: 'Ask', focus: { kind: 'zone', zoneId: 'main', ref: 'main' } },
    at,
  );
  const msg = appendMessage(h.db, th.id, { role: 'owner', text: 'pause main', state: 'done' }, at);
  recordCard(
    h.db,
    {
      threadId: th.id,
      messageId: msg.id,
      kind: 'pause',
      zoneId: 'main',
      target: 'main',
      link: '/projects/main',
      state: 'done',
      summary: modeCardSummary('paused', 'main'),
    },
    at,
  );
  return { h, briefing, confirm, thread: th.id, cookie: s.cookie };
}

describe('every rendered page says project and Home', () => {
  test('no page shows "zone" or "Floor" in its visible text', async () => {
    const { h, briefing, confirm, thread, cookie } = await seeded();
    const urls = [
      '/',
      '/?needs=all',
      `/briefings/${briefing}`,
      '/activity',
      '/activity/work',
      '/activity/drops',
      '/activity/log',
      '/projects',
      '/projects/new',
      '/projects/main',
      '/projects/merlin',
      '/projects/main/setup',
      '/projects/main/flags',
      '/projects/main/work',
      '/projects/main/goals',
      '/projects/main/issues/new',
      '/projects/main/log',
      '/chat',
      `/chat/${thread}`,
      '/system',
      '/system/sticks',
      '/system/sticks/images',
      '/system/credentials',
      '/system/server',
      '/system/advanced',
      '/system/mcp-tokens',
      '/system/history',
      '/setup/claude',
      '/setup/forge',
      '/setup/stick',
      '/setup/project',
      '/setup/doctor',
    ];
    const found: Record<string, string[]> = {};
    for (const url of urls) {
      const res = await h.view(url);
      expect(res.statusCode, url).toBeLessThan(400);
      const bad = offenders(visibleText(res.body));
      if (bad.length > 0) found[url] = bad;
    }
    // The confirmation page belongs to the session that proposed the change.
    const page = await h.view(confirm, { cookie });
    expect(page.statusCode, confirm).toBe(200);
    const bad = offenders(visibleText(page.body));
    if (bad.length > 0) found[confirm.replace(/[^/]+$/, ':id')] = bad;
    expect(found).toEqual({});
  });

  test('a ctl command inside <code> on a page is not a finding', async () => {
    const { h } = await seeded();
    const html = (await h.view('/projects')).body;
    expect(visibleText(`${html}<p>Run <code>jumpmaster ctl zones list</code></p>`)).not.toMatch(
      ZONE_WORD,
    );
  });
});

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

const failing = (id: string): DoctorCheck => ({ id, zoneId: null, status: 'fail', summary: id });

/** One input per headline branch, each with the facts its detail, action and also lines name. */
const BRANCHES: [string, StatusInput][] = [
  ['setup', base({ setupActive: true })],
  ['killed', base({ killed: true, killedSince: NOW.toISOString() })],
  [
    'credits stop',
    base({
      usage: { gate: 'stopped', overageDropId: 'cd9', overageStoppedAt: 'a', overageUntil: 'b' },
    }),
  ],
  ['usage pause', base({ usagePausedUntil: plus(NOW, 30 * MIN).toISOString() })],
  ['no stick', base({ sticks: { live: 0, slots: 0, busy: 0 } })],
  [
    'working',
    base({
      zones: [
        zone({ items: [item({ state: 'in_flight' })], drops: [drop()], gateEvents: { d1: 1 } }),
        zone({ id: 'merlin', mode: 'paused' }),
      ],
    }),
  ],
  [
    'ci',
    base({
      zones: [
        zone({
          items: [item({ state: 'pr_open', prNumber: 12 })],
          prs: [{ workItemId: 1, number: 12, headFirstSeenAt: plus(NOW, -20 * MIN).toISOString() }],
        }),
      ],
    }),
  ],
  ['throttled', base({ usage: { gate: 'finishing_only' }, zones: [zone({ items: [item()] })] })],
  [
    'credential problem',
    base({
      zones: [
        zone({
          credentialProblems: [
            { zoneId: 'main', kind: 'missing', credential: 'claudeToken', message: 'no token' },
          ],
        }),
      ],
    }),
  ],
  [
    'doctor fails',
    base({
      doctor: { fails: [failing('forge.labels')], finishedAt: NOW.toISOString() },
      lastPassAt: plus(NOW, -2 * MIN).toISOString(),
    }),
  ],
  ['waiting on you', base({ openBriefings: 1 })],
  ['pending changes', base({ pendingChanges: 1 })],
  [
    'all paused',
    base({
      zones: [zone({ mode: 'paused', drops: [drop()] }), zone({ id: 'b', mode: 'observe' })],
    }),
  ],
  [
    'all paused, no projects page',
    base({
      zones: [zone({ mode: 'paused' })],
      pages: { zones: false, settings: false, credentials: false },
    }),
  ],
  [
    'parked',
    base({ zones: [zone({ parked: 1, items: [item({ state: 'parked', reason: 'stuck' })] })] }),
  ],
  [
    'queued, no stick can run',
    base({
      zones: [
        zone({
          items: [item({ state: 'in_flight' })],
          drops: [drop({ state: 'queued', startedAt: null })],
          cannotRun: 'm3: lacks egress-v1',
        }),
      ],
    }),
  ],
  [
    'queued doctor',
    base({
      zones: [
        zone({
          drops: [drop({ role: 'doctor', workItemId: null, state: 'queued', startedAt: null })],
          doctorWait: 'it waits for a slot',
        }),
      ],
    }),
  ],
  ['ready', base({ zones: [zone({ items: [item()] }), zone({ id: 'b', mode: 'paused' })] })],
  [
    'capped',
    base({
      zones: [
        zone({
          items: [item(), item({ id: 2, state: 'pr_open', prNumber: 3 })],
          maxOpenPrs: 1,
        }),
      ],
    }),
  ],
  ['held ready', base({ zones: [zone({ id: 'a' }), zone({ mode: 'paused', items: [item()] })] })],
  ['idle', base()],
  [
    'idle, no projects page',
    base({ zones: [], pages: { zones: false, settings: false, credentials: false } }),
  ],
];

describe('status lines say project', () => {
  test.each(BRANCHES)('%s', (_name, input) => {
    const s = statusOf(input, NOW);
    const words = [
      s.headline,
      s.detail ?? '',
      s.action?.label ?? '',
      ...(s.also ?? []).map((a) => a.text),
    ].join(' | ');
    expect(offenders(words), words).toEqual([]);
  });
});
