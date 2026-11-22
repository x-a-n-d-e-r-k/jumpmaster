/**
 * `s` without its trailing `/` characters. A loop, not `/\/+$/`: that regex is quadratic on a
 * long run of `/` followed by another character.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return s.slice(0, end);
}
