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
