import { hostAllowed, normalizeHost } from '@jumpmaster/protocol';

/**
 * The one host a GitLab zone's push and clone containers reach under egress (issue #783, Ruling
 * 117): its GitLab host, in canonical form, with its port (any from 1 to 65535, #915), when it is a
 * DNS name in an https baseUrl that the zone's own guarded list allows. Otherwise why not, naming
 * what the operator would change. The push and clone plans refuse on a reason, and the doctor's
 * zone.egress fails on the same one (issue #820).
 */
export const gitlabPushHost = (
  baseUrl: string,
  zoneAllow: string[],
): { host: string; port: number } | { why: string } => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { why: 'its gitlab.baseUrl is not a URL' };
  }
  if (url.protocol !== 'https:') return { why: 'its gitlab.baseUrl is not https' };
  const port = url.port === '' ? 443 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { why: `its GitLab host is on port ${url.port}` };
  }
  const host = normalizeHost(url.hostname);
  if (host === null) return { why: `its GitLab host ${url.hostname} is not a DNS name` };
  if (!hostAllowed(host, zoneAllow)) {
    return { why: `its GitLab host is not allowed: add ${host} to the zone's egress.allow` };
  }
  return { host, port };
};
