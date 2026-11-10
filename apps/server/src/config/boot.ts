import { existsSync, readFileSync } from 'node:fs';
import { type BootSettings, splitConfigFile } from '../config.js';

/**
 * Boot settings: read before the database exists, so they are never in the editable document.
 * `listen` and `dataDir` come from the config file when one exists, else from the environment.
 * `JM_CONFIG`, `JM_SECRETS_DIR` and `JM_TLS_TERMINATED` have no key in the file's place and are
 * always read from the environment, file mode included.
 */
export type BootConfig = BootSettings & {
  listen: BootSettings['listen'] & { allowedHosts: string[]; tlsTerminated: boolean };
  /** The secrets directory read by name (Task 4); unset on the stick and in development. */
  secretsDir?: string;
  /** Where each boot setting was read, for the settings page. */
  source: { listen: 'file' | 'env'; dataDir: 'file' | 'env' };
  /**
   * Where each value actually came from: the file or the environment when one set it, else the
   * default. Optional, so a hand-built boot (tests, tools) may leave it out.
   */
  origin?: Record<BootField, BootOrigin>;
};

export type BootField = 'host' | 'port' | 'allowedHosts' | 'tlsTerminated' | 'dataDir';
export type BootOrigin = 'file' | 'env' | 'default';

/**
 * Editable settings that only take effect at the next start: `/mcp` and its body limit are
 * registered then. Everything else in the editable document applies live.
 */
export const RESTART_PATHS = ['mcp.enabled', 'mcp.maxBodyBytes'] as const;

function port(env: NodeJS.ProcessEnv): number {
  const raw = env.JM_LISTEN_PORT;
  if (raw === undefined || raw === '') return 7420;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 0 || n > 65535)
    throw new Error(`JM_LISTEN_PORT must be a port number, not ${JSON.stringify(raw)}`);
  return n;
}

/** The config file path: the `serve` argument, else `JM_CONFIG` (set in the image). */
export function configPathOf(env: NodeJS.ProcessEnv, arg?: string): string | undefined {
  return arg || env.JM_CONFIG || undefined;
}

export function loadBoot(env: NodeJS.ProcessEnv, filePath: string | undefined): BootConfig {
  const tlsFromEnv = env.JM_TLS_TERMINATED === '1';
  const secretsDir = env.JM_SECRETS_DIR ? { secretsDir: env.JM_SECRETS_DIR } : {};
  if (filePath && existsSync(filePath)) {
    const text = readFileSync(filePath, 'utf8');
    const { boot } = splitConfigFile(filePath, text);
    // What the file itself names (the parse above filled the defaults in).
    let raw: { listen?: Record<string, unknown> } = {};
    try {
      raw = JSON.parse(text) as typeof raw;
    } catch {
      raw = {};
    }
    const inFile = (k: string): BootOrigin =>
      raw.listen && typeof raw.listen === 'object' && raw.listen[k] !== undefined
        ? 'file'
        : 'default';
    const allowedHosts = boot.listen.allowedHosts ?? [
      `127.0.0.1:${boot.listen.port}`,
      `localhost:${boot.listen.port}`,
    ];
    return {
      dataDir: boot.dataDir,
      listen: {
        host: boot.listen.host,
        port: boot.listen.port,
        allowedHosts,
        tlsTerminated: tlsFromEnv || boot.listen.tlsTerminated === true,
      },
      ...secretsDir,
      source: { listen: 'file', dataDir: 'file' },
      origin: {
        host: inFile('host'),
        port: inFile('port'),
        allowedHosts: inFile('allowedHosts'),
        tlsTerminated: tlsFromEnv ? 'env' : inFile('tlsTerminated'),
        dataDir: 'file',
      },
    };
  }
  const p = port(env);
  const hosts = (env.JM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  return {
    dataDir: env.JM_DATA_DIR || './data',
    listen: {
      host: env.JM_LISTEN_HOST || '127.0.0.1',
      port: p,
      allowedHosts: hosts.length > 0 ? hosts : [`127.0.0.1:${p}`, `localhost:${p}`],
      tlsTerminated: tlsFromEnv,
    },
    ...secretsDir,
    source: { listen: 'env', dataDir: 'env' },
    origin: {
      host: env.JM_LISTEN_HOST ? 'env' : 'default',
      port: env.JM_LISTEN_PORT ? 'env' : 'default',
      allowedHosts: hosts.length > 0 ? 'env' : 'default',
      tlsTerminated: tlsFromEnv ? 'env' : 'default',
      dataDir: env.JM_DATA_DIR ? 'env' : 'default',
    },
  };
}
