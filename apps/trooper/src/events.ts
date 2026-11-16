import {
  EVENT_PART_BYTES,
  EVENT_PART_PREFIX,
  EVENT_PREFIX,
  type EventPart,
  MAX_EVENT_BYTES,
  MAX_EVENT_LINE_BYTES,
  type TrooperEvent,
} from '@jumpmaster/protocol';
import { redact } from './redact.js';

/** Room in a capped event for its envelope (`ts`, `kind`) and the `truncated`/`bytes` flags. */
const ENVELOPE_BYTES = 512;

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  }
  return v;
}

/** The longest string (in characters) or array (in items) in `v`. */
function longest(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (typeof v !== 'object' || v === null) return 0;
  // A loop, not `Math.max(...)`: a huge array would overflow the call stack.
  let max = Array.isArray(v) ? v.length : 0;
  for (const x of Object.values(v)) max = Math.max(max, longest(x));
  return max;
}

/** Cuts every string to `limit` characters and every array to `limit` items, each with a marker. */
function cutAt(v: unknown, limit: number): unknown {
  if (typeof v === 'string') {
    return v.length > limit ? `${v.slice(0, limit)}…[truncated ${v.length - limit} chars]` : v;
  }
  if (Array.isArray(v)) {
    const kept = v.slice(0, limit).map((x) => cutAt(x, limit));
    return v.length > limit ? [...kept, `…[truncated ${v.length - limit} items]`] : kept;
  }
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutAt(x, limit)]));
  }
  return v;
}

/**
 * Caps an event's serialized data at `maxBytes`. Strings are redacted BEFORE truncation, so a cut
 * can never leave an unrecognisable fragment of a secret behind. A cut keeps the longest prefix of
 * every long string and array that fits, and flags the data `truncated` with its original size in `bytes`.
 */
export function capEventData(
  data: Record<string, unknown>,
  secrets: string[],
  maxBytes = MAX_EVENT_BYTES - ENVELOPE_BYTES,
): Record<string, unknown> {
  const clean = mapStrings(data, (s) => redact(s, secrets)) as Record<string, unknown>;
  const bytes = jsonBytes(clean);
  if (bytes <= maxBytes) return clean;
  // The largest limit that fits: the size grows with the limit.
  let best: Record<string, unknown> | undefined;
  let lo = 0;
  let hi = longest(clean);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cut = cutAt(clean, mid) as Record<string, unknown>;
    if (jsonBytes(cut) <= maxBytes) {
      best = cut;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ? { ...best, truncated: true, bytes } : { truncated: true, bytes };
}

/**
 * The stdout lines for one event. Its strings are redacted (and, past {@link MAX_EVENT_BYTES}, cut)
 * first. An event that serializes to {@link MAX_EVENT_LINE_BYTES} or less is one `JM_EVENT ` line;
 * a larger one is redacted whole again, then split into `JM_EVENT_PART ` lines that take the next
 * `id`, each with at most {@link EVENT_PART_BYTES} of it in base64, so each stays under 64 KiB.
 */
export function eventLines(
  kind: TrooperEvent['kind'],
  data: Record<string, unknown>,
  secrets: string[],
  opts: { ts: string; id: () => number },
): string[] {
  const ev: TrooperEvent = { ts: opts.ts, kind, data: capEventData(data, secrets) };
  const json = JSON.stringify(ev);
  if (Buffer.byteLength(json) <= MAX_EVENT_LINE_BYTES) {
    return [redact(EVENT_PREFIX + json, secrets)];
  }
  // Redacted before the split: no secret can straddle a part boundary.
  const whole = Buffer.from(redact(json, secrets));
  const id = opts.id();
  const of = Math.ceil(whole.length / EVENT_PART_BYTES);
  const lines: string[] = [];
  for (let i = 0; i < of; i++) {
    const chunk = whole.subarray(i * EVENT_PART_BYTES, (i + 1) * EVENT_PART_BYTES);
    const part: EventPart = { id, n: i + 1, of, chunk: chunk.toString('base64') };
    lines.push(redact(EVENT_PART_PREFIX + JSON.stringify(part), secrets));
  }
  return lines;
}
