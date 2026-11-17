/**
 * Characters a terminal may act on rather than print (issue #264): C0 controls, DEL, C1 controls
 * (some terminals take U+009B as CSI) and the Unicode line and paragraph separators.
 */
export const TERMINAL_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A line for the terminal: every terminal control removed. */
export const plain = (line: string): string => line.replace(TERMINAL_CONTROLS, '');

/** Text kept for display later (an egress host): each terminal control replaced with `?`. */
export const defang = (text: string): string => text.replace(TERMINAL_CONTROLS, '?');

/**
 * A line of JSON made safe for `plain` without changing what it means: DEL, the C1 controls and
 * the line separators, which `JSON.stringify` leaves raw inside strings, become `\uXXXX` escapes.
 */
export const jsonLine = (line: string): string =>
  line.replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
