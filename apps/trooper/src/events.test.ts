import {
  EVENT_PART_BYTES,
  EVENT_PART_PREFIX,
  EVENT_PREFIX,
  EventPartSchema,
  MAX_EVENT_BYTES,
  MAX_EVENT_LINE_BYTES,
  TrooperEventSchema,
} from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { eventLines } from './events.js';

const TS = '2026-11-16T00:00:00.000Z';
const SECRET = 'sk-ant-oat-SECRET1234567890abcdef';

/** A counter, as a drop's emitter keeps one. */
const counter = () => {
  let n = 0;
  return () => ++n;
};

/** The serialized event's size for a `text` of `len` characters. */
const envelope = Buffer.byteLength(JSON.stringify({ ts: TS, kind: 'agent', data: { text: '' } }));
const ofSize = (bytes: number) => ({ text: 'x'.repeat(bytes - envelope) });

/** Rebuilds the event from its part lines, as the stick does. */
function assemble(lines: string[]): string {
  const parts = lines.map((l) => {
    expect(l.startsWith(EVENT_PART_PREFIX)).toBe(true);
    return EventPartSchema.parse(JSON.parse(l.slice(EVENT_PART_PREFIX.length)));
  });
  const of = parts[0]?.of;
  expect(parts.map((p) => p.n)).toEqual(Array.from({ length: of ?? 0 }, (_, i) => i + 1));
  expect(new Set(parts.map((p) => p.id)).size).toBe(1);
  return Buffer.concat(parts.map((p) => Buffer.from(p.chunk, 'base64'))).toString('utf8');
}

describe('eventLines', () => {
  test('a small event is one JM_EVENT line, redacted', () => {
    const lines = eventLines('phase', { phase: 'clone', note: SECRET }, [SECRET], {
      ts: TS,
      id: counter(),
    });
    expect(lines).toEqual([
      `${EVENT_PREFIX}{"ts":"${TS}","kind":"phase","data":{"phase":"clone","note":"[REDACTED]"}}`,
    ]);
  });

  test('63 KiB is one line; 63 KiB + 1 byte goes in parts', () => {
    const at = eventLines('agent', ofSize(MAX_EVENT_LINE_BYTES), [], { ts: TS, id: counter() });
    expect(at).toHaveLength(1);
    expect(at[0]?.startsWith(EVENT_PREFIX)).toBe(true);
    expect(Buffer.byteLength(at[0] ?? '')).toBe(EVENT_PREFIX.length + MAX_EVENT_LINE_BYTES);

    const over = eventLines('agent', ofSize(MAX_EVENT_LINE_BYTES + 1), [], {
      ts: TS,
      id: counter(),
    });
    expect(over).toHaveLength(Math.ceil((MAX_EVENT_LINE_BYTES + 1) / EVENT_PART_BYTES));
    expect(JSON.parse(assemble(over))).toEqual({
      ts: TS,
      kind: 'agent',
      data: ofSize(MAX_EVENT_LINE_BYTES + 1),
    });
  });

  test('a 300 KB event is 7 parts, byte-identical once joined, every line within 64 KiB', () => {
    const data = { text: 'é'.repeat(50_000) + 'y'.repeat(200_000), n: 1 };
    const lines = eventLines('agent', data, [], { ts: TS, id: counter() });
    expect(lines).toHaveLength(7);
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(64 * 1024);
    const joined = assemble(lines);
    expect(joined).toBe(JSON.stringify({ ts: TS, kind: 'agent', data }));
    expect(TrooperEventSchema.parse(JSON.parse(joined)).data).not.toHaveProperty('truncated');
  });

  test('each split event takes the next id', () => {
    const id = counter();
    const big = ofSize(100_000);
    const first = eventLines('agent', big, [], { ts: TS, id });
    eventLines('phase', { phase: 'x' }, [], { ts: TS, id });
    const second = eventLines('agent', big, [], { ts: TS, id });
    const idOf = (l: string) => JSON.parse(l.slice(EVENT_PART_PREFIX.length)).id;
    expect(first.map(idOf)).toEqual([1, 1, 1]);
    expect(second.map(idOf)).toEqual([2, 2, 2]);
  });

  test('D4: a secret across a part boundary is redacted before the split', () => {
    // Without redaction the secret would start 10 bytes before the first part's end.
    const prefix = Buffer.byteLength(JSON.stringify({ ts: TS, kind: 'agent', data: { text: '' } }));
    const before = 'a'.repeat(EVENT_PART_BYTES - prefix + 1 - 10);
    const text = `${before}${SECRET}${'b'.repeat(200_000)}`;
    const lines = eventLines('agent', { text }, [SECRET], { ts: TS, id: counter() });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l).not.toContain(SECRET);
      const chunk = Buffer.from(
        JSON.parse(l.slice(EVENT_PART_PREFIX.length)).chunk,
        'base64',
      ).toString('latin1');
      for (let k = 4; k <= SECRET.length; k++) {
        expect(chunk).not.toContain(SECRET.slice(0, k));
        expect(chunk).not.toContain(SECRET.slice(-k));
      }
    }
    const joined = assemble(lines);
    expect(joined).not.toContain(SECRET);
    expect(JSON.parse(joined).data.text).toBe(`${before}[REDACTED]${'b'.repeat(200_000)}`);
  });

  test('a token shape is redacted too, even in a split event', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const lines = eventLines('agent', { text: `${'z'.repeat(100_000)}${token}` }, [], {
      ts: TS,
      id: counter(),
    });
    expect(assemble(lines)).not.toContain(token);
  });

  test('over 2 MiB: the first 2 MiB is kept, flagged with the original size', () => {
    const text = 'q'.repeat(3_000_000);
    const lines = eventLines('agent', { text }, [], { ts: TS, id: counter() });
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(64 * 1024);
    const joined = assemble(lines);
    expect(Buffer.byteLength(joined)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(Buffer.byteLength(joined)).toBeGreaterThan(MAX_EVENT_BYTES - 1024);
    const ev = JSON.parse(joined);
    expect(ev.data.truncated).toBe(true);
    expect(ev.data.bytes).toBe(Buffer.byteLength(JSON.stringify({ text })));
    expect(ev.data.text.startsWith('q'.repeat(2_000_000))).toBe(true);
    expect(ev.data.text).toMatch(/…\[truncated \d+ chars\]$/);
  });

  test('over 2 MiB: redaction runs before the cut, so no fragment of a secret is left', () => {
    // The secret sits where a naive 2 MiB cut would split it.
    const text = `${'r'.repeat(MAX_EVENT_BYTES - 100)}${SECRET}${'s'.repeat(1_000_000)}`;
    const lines = eventLines('agent', { text }, [SECRET], { ts: TS, id: counter() });
    const joined = assemble(lines);
    expect(joined).not.toContain(SECRET.slice(0, 8));
    expect(JSON.parse(joined).data.truncated).toBe(true);
  });

  test('over 2 MiB with many small strings: the first items kept, within 2 MiB', () => {
    const data = { items: Array.from({ length: 200_000 }, (_, i) => `item-${i}`) };
    const lines = eventLines('agent', data, [], { ts: TS, id: counter() });
    const joined = assemble(lines);
    expect(Buffer.byteLength(joined)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    const kept = JSON.parse(joined).data;
    expect(kept).toMatchObject({ truncated: true, bytes: Buffer.byteLength(JSON.stringify(data)) });
    expect(kept.items.length).toBeGreaterThan(100_000);
    expect(kept.items.slice(0, 3)).toEqual(['item-0', 'item-1', 'item-2']);
    expect(kept.items.at(-1)).toMatch(/^…\[truncated \d+ items\]$/);
  });
});
