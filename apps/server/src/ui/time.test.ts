import { describe, expect, test } from 'vitest';
import { relativeTime } from './time.js';

const now = new Date('2026-11-26T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const phrase = (html: string) => html.replace(/^<time[^>]*>/, '').replace(/<\/time>$/, '');

describe('relativeTime', () => {
  test.each([
    [59 * S, 'just now'],
    [60 * S, '1 min ago'],
    [59 * M, '59 min ago'],
    [H, '1 h ago'],
    [23 * H + 59 * M, '23 h ago'],
    [D, '1 d ago'],
    [6 * D + 23 * H, '6 d ago'],
    [7 * D, '19 Nov 2026'],
    [7 * D + 13 * H, '18 Nov 2026'],
  ])('%i ms ago reads "%s"', (ms, want) => {
    expect(phrase(relativeTime(ago(ms), now))).toBe(want);
  });

  const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

  test.each([
    [59 * S, 'just now'],
    [60 * S, 'in 1 min'],
    [5 * M, 'in 5 min'],
    [H, 'in 1 h'],
    [23 * H + 59 * M, 'in 23 h'],
    [D, 'in 1 d'],
    [6 * D + 23 * H, 'in 6 d'],
    [7 * D, '3 Dec 2026'],
  ])('%i ms ahead reads "%s" (a next due, #620)', (ms, want) => {
    expect(phrase(relativeTime(ahead(ms), now))).toBe(want);
  });

  test('the <time> element carries the full ISO in datetime and title', () => {
    const iso = '2026-11-19T06:26:00.446Z';
    expect(relativeTime(iso, now)).toBe(
      `<time datetime="${iso}" title="${iso}">19 Nov 2026</time>`,
    );
  });

  test('an unparseable time is shown escaped as is', () => {
    expect(relativeTime('<x>', now)).toBe(
      '<time datetime="&lt;x&gt;" title="&lt;x&gt;">&lt;x&gt;</time>',
    );
  });
});
