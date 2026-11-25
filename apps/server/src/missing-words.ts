// What a stick lacks for a zone, in words (#780): the `missing` items `missingFor` gives, as the
// status, the doctor and the pages show them. Every item but an `egress-ceiling:` one and `clone-v1`
// stays as it is.

/** The prefix of the `missing` item a stick's egress ceiling adds. */
export const CEILING_MISSING = 'egress-ceiling:';
/** The item when the zone's egress mode, not a host, is what the ceiling refuses. */
export const CEILING_MODE = `${CEILING_MISSING}mode`;

/**
 * The hosts an `egress-ceiling:<hosts>` item names, in words (`a, b, c and 2 more`), or null for
 * any other item (`egress-ceiling:mode` included).
 */
export function ceilingHosts(item: string): string | null {
  if (!item.startsWith(CEILING_MISSING) || item === CEILING_MODE) return null;
  // Empty parts are dropped: a lone host named `mode` is sent as `mode+` (see `missingFor`).
  const parts = item
    .slice(CEILING_MISSING.length)
    .split('+')
    .filter((p) => p !== '');
  // At most 3 hosts, then the count of the rest (see `missingFor`).
  const more = parts.length > 3 ? parts.pop() : undefined;
  return `${parts.join(', ')}${more === undefined ? '' : ` and ${more} more`}`;
}

/** The capability a GitLab zone's drops need (#862), and what it is for (#871). */
export const CLONE_CAP = 'clone-v1';
const CLONE_WORDS = `${CLONE_CAP} (the clone container a GitLab project's drops need)`;

/** One `missing` item in words. */
export function missingWords(item: string): string {
  if (item === CLONE_CAP) return CLONE_WORDS;
  if (item === CEILING_MODE)
    return "egress set to enforce (the stick's JM_EGRESS_CEILING requires it)";
  const hosts = ceilingHosts(item);
  return hosts === null ? item : `${hosts} in the stick's JM_EGRESS_CEILING`;
}
