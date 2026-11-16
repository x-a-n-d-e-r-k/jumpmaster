import { EVENT_PART_BYTES, type EventPart, MAX_EVENT_PARTS } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { EventAssembler } from './event-assembler.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

/** The part JSONs of `ev` serialized, in order, `size` bytes each. */
function parts(id: number, ev: unknown, size = EVENT_PART_BYTES): string[] {
  const whole = Buffer.from(JSON.stringify(ev));
  const of = Math.ceil(whole.length / size);
  return Array.from({ length: of }, (_, i) => {
    const part: EventPart = {
      id,
      n: i + 1,
      of,
      chunk: whole.subarray(i * size, (i + 1) * size).toString('base64'),
    };
    return JSON.stringify(part);
  });
}

const big = (text: string) => ({
  ts: '2026-11-16T11:00:00.000Z',
  kind: 'agent' as const,
  data: { text },
});

const incomplete = (id: number, k: number, of: number) => ({
  ts: NOW.toISOString(),
  kind: 'log',
  data: { message: `event ${id} incomplete: ${k} of ${of} parts` },
});

describe('EventAssembler', () => {
  test('assembles parts in order into the original event', () => {
    const a = new EventAssembler({ now: () => NOW });
    const ev = big('x'.repeat(200_000));
    const lines = parts(1, ev);
    expect(lines).toHaveLength(5);
    const out = lines.flatMap((l) => a.add(l));
    expect(out).toEqual([ev]);
    expect(a.finish()).toEqual([]);
  });

  test('parts out of order are assembled when the last one is in', () => {
    const a = new EventAssembler({ now: () => NOW });
    const ev = big('é'.repeat(100_000));
    const lines = parts(4, ev);
    const shuffled = [lines[2], lines[4], lines[0], lines[3], lines[1]] as string[];
    const out = shuffled.map((l) => a.add(l));
    expect(out.slice(0, 4).every((o) => o.length === 0)).toBe(true);
    expect(out[4]).toEqual([ev]);
  });

  test('two events interleaved by id are both assembled', () => {
    const a = new EventAssembler({ now: () => NOW });
    const e1 = big('1'.repeat(100_000));
    const e2 = big('2'.repeat(100_000));
    const [a1, a2, a3] = parts(1, e1);
    const [b1, b2, b3] = parts(2, e2);
    const out = [a1, b1, a2, b2, b3, a3].flatMap((l) => a.add(l as string));
    expect(out).toEqual([e2, e1]);
  });

  test('a part missing at exit: the event is discarded with one log', () => {
    const a = new EventAssembler({ now: () => NOW });
    const lines = parts(7, big('y'.repeat(300_000)));
    expect(lines).toHaveLength(7);
    for (const l of lines.slice(0, 3)) expect(a.add(l)).toEqual([]);
    expect(a.finish()).toEqual([incomplete(7, 3, 7)]);
    expect(a.finish()).toEqual([]);
  });

  test('over 64 MiB pending: the oldest incomplete id is discarded with one log', () => {
    const a = new EventAssembler({ now: () => NOW });
    // Each event is the most parts there can be; all but its last part are sent.
    const per = (MAX_EVENT_PARTS - 1) * EVENT_PART_BYTES;
    const ids = Math.floor((64 * 1024 * 1024) / per) + 1;
    const text = 'z'.repeat(MAX_EVENT_PARTS * EVENT_PART_BYTES - 200);
    const events = Array.from({ length: ids }, (_, i) => parts(i + 1, big(text)));
    const logs: unknown[] = [];
    for (const lines of events) {
      expect(lines).toHaveLength(MAX_EVENT_PARTS);
      for (const l of lines.slice(0, -1)) logs.push(...a.add(l));
    }
    expect(logs).toEqual([incomplete(1, MAX_EVENT_PARTS - 1, MAX_EVENT_PARTS)]);
    // The discarded id stays discarded; the others still complete.
    expect(a.add(events[0]?.at(-1) as string)).toEqual([]);
    expect(a.add(events[1]?.at(-1) as string)).toEqual([big(text)]);
    expect(a.finish()).toHaveLength(ids - 2);
  });

  test('a part that is not valid is ignored', () => {
    const a = new EventAssembler({ now: () => NOW });
    expect(a.add('not json')).toEqual([]);
    expect(a.add(JSON.stringify({ id: 1, n: 2, of: 1, chunk: '' }))).toEqual([]);
    expect(a.add(JSON.stringify({ id: 1, n: 1, of: 1000, chunk: '' }))).toEqual([]);
    expect(a.finish()).toEqual([]);
  });

  test('an assembled event that fails the event schema is dropped with a log', () => {
    const a = new EventAssembler({ now: () => NOW });
    const out = parts(3, { ts: 't', kind: 'nope', data: {} }, 10).flatMap((l) => a.add(l));
    expect(out).toEqual([
      { ts: NOW.toISOString(), kind: 'log', data: { message: 'event 3 unreadable' } },
    ]);
  });
});
