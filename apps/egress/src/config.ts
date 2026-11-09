import { isIP } from 'node:net';
import { EGRESS_PROXY_PORT } from '@jumpmaster/protocol/egress';
import { validAllowEntry } from './allow.js';

export type EgressConfig = {
  mode: 'monitor' | 'enforce';
  allow: string[];
  ports: number[];
  bind: string;
  port: number;
  limits: { maxTunnels?: number; maxConnections?: number };
};

const MAX_LIMIT = 10_000;

function limitFrom(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT)
    throw new Error(`${name} must be an integer from 1 to ${MAX_LIMIT}, not ${raw}`);
  return n;
}

const WILDCARDS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']);

/**
 * The proxy's settings from its environment. `JM_EGRESS_BIND` is required and must be one
 * specific address (the drop-network address): there is no wildcard default, so a proxy can never
 * listen where other drops or the host could reach it.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): EgressConfig {
  const bind = (env.JM_EGRESS_BIND ?? '').trim();
  if (bind === '') throw new Error('JM_EGRESS_BIND is required (the drop-network address)');
  if (isIP(bind) === 0 || WILDCARDS.has(bind))
    throw new Error(`JM_EGRESS_BIND must be one specific IP address, not ${bind}`);
  const mode = env.JM_EGRESS_MODE;
  if (mode !== 'monitor' && mode !== 'enforce')
    throw new Error(`JM_EGRESS_MODE must be monitor or enforce, not ${mode ?? '(unset)'}`);
  const allow = (env.JM_EGRESS_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const bad = allow.find((a) => !validAllowEntry(a));
  if (bad !== undefined) throw new Error(`JM_EGRESS_ALLOW has an invalid entry: ${bad}`);
  const ports = (env.JM_EGRESS_PORTS ?? '443')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number);
  if (ports.length === 0 || !ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65_535))
    throw new Error(`JM_EGRESS_PORTS must list ports from 1 to 65535, not ${env.JM_EGRESS_PORTS}`);
  const maxTunnels = limitFrom(env, 'JM_EGRESS_MAX_TUNNELS');
  const maxConnections = limitFrom(env, 'JM_EGRESS_MAX_CONNECTIONS');
  return {
    mode,
    allow,
    ports,
    bind,
    port: EGRESS_PROXY_PORT,
    limits: {
      ...(maxTunnels !== undefined ? { maxTunnels } : {}),
      ...(maxConnections !== undefined ? { maxConnections } : {}),
    },
  };
}
