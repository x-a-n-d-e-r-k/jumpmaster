#!/usr/bin/env node
// The `jumpmaster` command:
//   jumpmaster [serve] [config]   run the server (the default); no path: JM_CONFIG, else db mode
//   jumpmaster ctl …              control commands against the running server
//   jumpmaster doctor …           alias of `ctl doctor …`
//   jumpmaster init --repo o/n …  write a compose install's config and secrets (init.ts)
// In the server container run ctl as `docker compose exec jumpmaster jumpmaster ctl …`, never
// `compose run`: a new container's loopback is not the server.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type CliDeps = {
  serve: (configPath: string | undefined) => Promise<number>;
  ctl: (args: string[]) => Promise<number>;
  init: (args: string[]) => Promise<number>;
  err?: (line: string) => void;
};

const USAGE = [
  'usage: jumpmaster serve [config]   (no config: JM_CONFIG, else the config lives in the database)',
  '       jumpmaster <config>',
  '       jumpmaster ctl <command> …   (see `jumpmaster ctl` for commands)',
  '       jumpmaster doctor …          (alias of `jumpmaster ctl doctor …`)',
  '       jumpmaster init --repo owner/name …   (see `jumpmaster init --help`)',
].join('\n');

/** Command words that are never read as a config path. */
const RESERVED = new Set(['serve', 'ctl', 'doctor', 'init', 'help', '--help', '-h']);

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const err = deps.err ?? console.error;
  const [command, ...rest] = argv;
  if (command === 'ctl') return deps.ctl(rest);
  if (command === 'doctor') return deps.ctl(['doctor', ...rest]);
  if (command === 'init') return deps.init(rest);
  // `serve` alone: the path comes from JM_CONFIG, or there is none (db mode).
  if (command === 'serve' && rest.length === 0) return deps.serve(undefined);
  const config = command === 'serve' ? rest[0] : command;
  if (!config || RESERVED.has(config) || (command === 'serve' && rest.length > 1)) {
    err(USAGE);
    return 2;
  }
  return deps.serve(config);
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function serve(configPath: string | undefined): Promise<number> {
  const { start } = await import('./main.js');
  try {
    const srv = await start(configPath);
    const shutdown = () => void srv.stop().finally(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return 0;
  } catch (e) {
    console.error(`[jumpmaster] fatal: ${errorMessage(e)}`);
    return 1;
  }
}

async function init(args: string[]): Promise<number> {
  const { initMain } = await import('./init.js');
  return initMain(args);
}

async function ctl(args: string[]): Promise<number> {
  const { runCtl } = await import('./ctl.js');
  return runCtl(args);
}

// Run when executed directly, including through a symlink such as /usr/local/bin/jumpmaster.
const isMain = (): boolean => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  const code = await runCli(process.argv.slice(2), { serve, ctl, init });
  if (code !== 0) process.exit(code);
}
