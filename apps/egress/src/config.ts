import { isIP } from 'node:net';
import { EGRESS_PROXY_PORT } from '@jumpmaster/protocol/egress';
import { validAllowEntry } from './allow.js';

export type EgressConfig = {
  mode: 'monitor' | 'enforce';
  allow: string[];
  ports: number[];
  bind: string;
  port: number;
};

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
  return { mode, allow, ports, bind, port: EGRESS_PROXY_PORT };
}
