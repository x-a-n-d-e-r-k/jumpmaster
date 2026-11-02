import { redact } from './redact.js';

/** One event line must stay well under the server's body limit even in a 50-event batch. */
const MAX_EVENT_DATA_BYTES = 63 * 1024;

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  }
  return v;
}

/**
 * Caps an event's serialized data. Strings are redacted BEFORE truncation, so a cut can never leave
 * an unrecognisable fragment of a secret behind.
 */
export function capEventData(
  data: Record<string, unknown>,
  secrets: string[],
  maxBytes = MAX_EVENT_DATA_BYTES,
): Record<string, unknown> {
  const clean = mapStrings(data, (s) => redact(s, secrets)) as Record<string, unknown>;
  const size = jsonBytes(clean);
  if (size <= maxBytes) return clean;
  for (let limit = 16 * 1024; limit >= 64; limit = Math.floor(limit / 2)) {
    const cut = mapStrings(clean, (s) =>
      s.length > limit ? `${s.slice(0, limit)}…[truncated ${s.length - limit} chars]` : s,
    ) as Record<string, unknown>;
    if (jsonBytes(cut) <= maxBytes) return { ...cut, truncated: true };
  }
  return { truncated: true, bytes: size };
}
