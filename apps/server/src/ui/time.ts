import { escapeHtml } from './pages.js';

/**
 * When something happened, as the UI shows it (#492): a `<time>` element whose text is a short
 * phrase relative to `now` and whose `datetime` and `title` carry the full ISO time.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * The phrase: "just now", "N min ago", "N h ago", "N d ago", else "D Mon YYYY" in UTC. A time a
 * minute or more ahead (a next due) reads "in N min", "in N h" or "in N d"; less is "just now".
 */
function phrase(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  const ahead = -ms;
  if (ahead >= MINUTE && ahead < WEEK) {
    if (ahead < HOUR) return `in ${Math.floor(ahead / MINUTE)} min`;
    if (ahead < DAY) return `in ${Math.floor(ahead / HOUR)} h`;
    return `in ${Math.floor(ahead / DAY)} d`;
  }
  if (ahead >= WEEK) return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  if (ms < WEEK) return `${Math.floor(ms / DAY)} d ago`;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** `<time datetime="<ISO>" title="<ISO>">` with the phrase; an unparseable time shows as is. */
export function relativeTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const attr = escapeHtml(iso);
  const text = Number.isNaN(at.getTime()) ? attr : phrase(at, now);
  return `<time datetime="${attr}" title="${attr}">${text}</time>`;
}
