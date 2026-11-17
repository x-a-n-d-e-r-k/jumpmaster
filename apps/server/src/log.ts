import type { Config } from './config.js';
import { scrub } from './scrub.js';

/** What the server log scrubs against besides the scrub set: the live config and retired values. */
export type LogSource = { current(): Config; retired(): readonly string[] };

let source: LogSource | undefined;

/**
 * Points the server log at the running server's config store (main.ts, once the store is open).
 * Returns an undo that clears it again if no later call replaced it.
 */
export function setLogSource(s: LogSource | undefined): () => void {
  source = s;
  return () => {
    if (source === s) source = undefined;
  };
}

/**
 * Writes one line to the server log, stderr, after `scrub`: the configured secrets and the
 * retired ones (once the store is open), every value in the scrub set, and every token shape.
 * The only place under `apps/server/src` that writes server log lines to the console
 * (`scripts/no-direct-console.test.ts`).
 */
export function writeLog(
  msg: string,
  config: Config | undefined,
  retired: readonly string[] = [],
): void {
  console.error(`[jumpmaster] ${scrub(msg, config, retired)}`);
}

/** The server log, for writers with no store of their own: see `writeLog`. */
export function log(msg: string): void {
  writeLog(msg, source?.current(), source?.retired());
}
