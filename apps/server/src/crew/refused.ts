/** How many refused entries of the lead's last cycle its next input lists (#808). */
export const MAX_REFUSED_SHOWN = 10;
/** The most characters of a refused issue's title, or of a refused entry in the server log. */
export const MAX_REFUSED_CHARS = 200;

/** What a lead drop's stored result says the server refused, with the titles it proposed. */
export type StoredRefusals = {
  refused: string[];
  /** The proposed issues' titles by key, from the same stored result. */
  titles: Map<string, string>;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The `crewReport.refused` entries of a lead drop's stored result, or null when the result does
 * not parse or holds no report (the caller says it is not known, never that nothing was refused).
 */
export function storedRefusals(resultJson: string | null): StoredRefusals | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson ?? '');
  } catch {
    return null;
  }
  if (!isObj(parsed) || !isObj(parsed.crewReport)) return null;
  const refused = parsed.crewReport.refused;
  if (!Array.isArray(refused)) return null;
  const titles = new Map<string, string>();
  const issues = isObj(parsed.crew) ? parsed.crew.fileIssues : undefined;
  if (Array.isArray(issues)) {
    for (const i of issues) {
      if (isObj(i) && typeof i.key === 'string' && typeof i.title === 'string') {
        // A key repeated in one output is filed first and refused after: the last title is its.
        titles.set(i.key, i.title);
      }
    }
  }
  return { refused: refused.filter((r): r is string => typeof r === 'string'), titles };
}

/** The key a refused entry begins with (`<key>: <why>`), if it names a proposed issue. */
export function refusedKey(entry: string, titles: ReadonlyMap<string, string>): string | null {
  const at = entry.indexOf(': ');
  if (at <= 0) return null;
  const key = entry.slice(0, at);
  return titles.has(key) ? key : null;
}

/** `s` cut to `max` characters (code points), never splitting one. */
export const cutChars = (s: string, max: number): string => [...s].slice(0, max).join('');
