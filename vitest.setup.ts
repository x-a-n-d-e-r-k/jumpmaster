/**
 * Unit tests must not inherit the trooper container or drop they may run in, as when a Jumpmaster
 * zone runs this repository's own gates inside a trooper image.
 */

/** The trooper image's drop settings (its work root, the agent and gate users). */
export const CONTAINER_ENV = [
  'JM_CONTAINER',
  'JM_WORK_ROOT',
  'JM_AGENT_UID',
  'JM_AGENT_GID',
  'JM_AGENT_HOME',
  'JM_GATE_UID',
  'JM_GATE_GID',
  'JM_GATE_HOME',
] as const;

/**
 * The proxy settings a drop under egress gives its gates. NODE_USE_ENV_PROXY routes Node's own
 * fetch through the proxy, past the tests' HTTP mocks. It is cleared here, in each worker, and in
 * vitest.config.ts before any worker starts, in case a Node version reads it only at startup.
 */
export const DROP_PROXY_ENV = [
  'NODE_USE_ENV_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

/**
 * The foreground settings a drop gives its agent (the trooper's `foregroundEnv`). The trooper's
 * tests assert that only the agent roles set them, so a gate run by that agent must not inherit them.
 */
export const AGENT_FOREGROUND_ENV = [
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
] as const;

export function clearDropEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of [...CONTAINER_ENV, ...DROP_PROXY_ENV, ...AGENT_FOREGROUND_ENV])
    delete env[name];
}

clearDropEnv();
