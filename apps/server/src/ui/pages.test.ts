import { describe, expect, test } from 'vitest';
import type { DropZoneConfig } from '../config.js';
import type { Drop, WorkItem } from '../db/repo.js';
import { renderDrop, renderHome } from './pages.js';

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
