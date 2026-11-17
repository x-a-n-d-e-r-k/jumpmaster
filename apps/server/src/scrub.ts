import { redactTokenShapes } from '@jumpmaster/protocol';
import { type Config, secretList } from './config.js';
import { type ScrubSet, serverScrubSet } from './forge/scrub-set.js';

/**
 * Redacts secrets from a message before it is logged: the configured ones, the values a rotation
 * replaced while this process ran (a running drop may still print one), and the values minted
 * while it ran (`set`), which apply before the store opens too. Longest first, so a secret that
 * contains another (a PEM and its lines) is replaced whole. Last, anything shaped like a token is
 * replaced too, so a secret never registered (or evicted from the set) still does not get through.
 */
export function scrub(
  msg: string,
  config: Config | undefined,
  retired: readonly string[] = [],
  set: ScrubSet = serverScrubSet,
): string {
  // Retired values come from the store, which a missing config means is not open yet.
  const known = config ? [...secretList(config.secrets), ...retired] : [];
  const all = [...known, ...set.values()]
    .filter((s) => s !== '')
    // Stable: equal lengths keep list order, as before.
    .sort((a, b) => b.length - a.length);
  const byValue = all.reduce((m, s) => m.split(s).join('[redacted]'), msg);
  return redactTokenShapes(byValue, '[redacted]');
}

/**
 * The values a server-side redactor (status, stored results, doctor runs, MCP output, the audit
 * log) removes: the configured secrets and every value in the scrub set, so each redactor sees
 * what the log scrub sees.
 */
export function redactionList(
  secrets: Config['secrets'],
  set: Pick<ScrubSet, 'values'> = serverScrubSet,
): string[] {
  return [...secretList(secrets), ...set.values()];
}
