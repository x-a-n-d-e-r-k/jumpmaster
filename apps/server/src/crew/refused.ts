/** How many refused entries of the lead's last cycle its next input lists (#808). */
export const MAX_REFUSED_SHOWN = 10;
/** The most characters of a refused issue's title, or of a refused entry in the server log. */
export const MAX_REFUSED_CHARS = 200;

/** What a lead drop's stored result says the server refused, with the titles it proposed. */
export type StoredRefusals = {
  refused: string[];
  /**
   * Parallel to `refused`: the title of the proposal each entry refused, or null when the entry is
   * not an issue's or its proposal cannot be told for certain (#934).
   */
  titles: (string | null)[];
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The key a refused entry begins with (`<key>: <why>`), or null when it has none. */
const entryKey = (entry: string): string | null => {
  const at = entry.indexOf(': ');
  return at <= 0 ? null : entry.slice(0, at);
};

/**
 * The `crewReport.refused` entries of a lead drop's stored result, or null when the result does
 * not parse or holds no report (the caller says it is not known, never that nothing was refused).
 * An entry's title is the one its stored `refusedIssues` index names, when that proposal has the
 * entry's key. A result stored before that index (#934) has a title only for a key proposed once:
 * a repeated key's entry could be any of its proposals, so it has none.
 */
export function storedRefusals(resultJson: string | null): StoredRefusals | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson ?? '');
  } catch {
    return null;
  }
  if (!isObj(parsed) || !isObj(parsed.crewReport)) return null;
  const report = parsed.crewReport;
  if (!Array.isArray(report.refused)) return null;
  const issues = isObj(parsed.crew) ? parsed.crew.fileIssues : undefined;
  const proposed = (Array.isArray(issues) ? issues : []).map((i) =>
    isObj(i) && typeof i.key === 'string' && typeof i.title === 'string'
      ? { key: i.key, title: i.title }
      : null,
  );
  const indices = Array.isArray(report.refusedIssues) ? report.refusedIssues : null;
  const refused: string[] = [];
  const titles: (string | null)[] = [];
  report.refused.forEach((entry: unknown, n: number) => {
    if (typeof entry !== 'string') return;
    refused.push(entry);
    const key = entryKey(entry);
    let title: string | null = null;
    if (key !== null && indices !== null) {
      // Only an index that names a proposal of this entry's key, never another proposal's title.
      const at: unknown = indices[n];
      const p = typeof at === 'number' && Number.isInteger(at) ? proposed[at] : undefined;
      if (p && p.key === key) title = p.title;
    } else if (key !== null) {
      const same = proposed.filter((p) => p?.key === key);
      if (same.length === 1) title = same[0]?.title ?? null;
    }
    titles.push(title);
  });
  return { refused, titles };
}

/** `s` cut to `max` characters (code points), never splitting one. */
export const cutChars = (s: string, max: number): string => [...s].slice(0, max).join('');
