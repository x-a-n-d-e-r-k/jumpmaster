import { hostAllowed, normalizeHost } from '@jumpmaster/protocol';

/**
 * The one host a GitLab zone's push container reaches under egress (issue #783, Ruling 117): its
 * GitLab host, in canonical form, when it is a DNS name on port 443 that the zone's own guarded
 * list allows. Otherwise why not, naming what the operator would change. The push plan refuses
 * on a reason, and the doctor's zone.egress fails on the same one (issue #820).
 */
export const gitlabPushHost = (
  baseUrl: string,
  zoneAllow: string[],
): { host: string } | { why: string } => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { why: 'its gitlab.baseUrl is not a URL' };
  }
  const port =
    url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  if (port !== '443') {
    return {
      why: `the egress proxy allows port 443 only, and its GitLab host is on port ${port || 'unknown'}`,
    };
  }
  const host = normalizeHost(url.hostname);
  if (host === null) return { why: `its GitLab host ${url.hostname} is not a DNS name` };
  if (!hostAllowed(host, zoneAllow)) {
    return { why: `its GitLab host is not allowed: add ${host} to the zone's egress.allow` };
  }
  return { host };
};
