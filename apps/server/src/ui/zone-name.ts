import type { DropZoneConfig } from '../config.js';

/**
 * How the UI names a zone to the operator: by its repository, `owner/name`, which is what the
 * operator recognizes. Where two zones share a repository the zone id follows in parentheses
 * (small text in HTML) so they can be told apart. The id itself stays in URLs, the API and `ctl`.
 * Text written to GitHub does not use this.
 */
export type ZoneRef = Pick<DropZoneConfig, 'id' | 'repo'>;

const esc = (v: string): string =>
  v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** The repository, and the id when another zone in `zones` shares that repository. */
function parts(zone: ZoneRef, zones: readonly ZoneRef[]): { repo: string; id?: string } {
  const shared = zones.some((z) => z.id !== zone.id && z.repo === zone.repo);
  return shared ? { repo: zone.repo, id: zone.id } : { repo: zone.repo };
}

/** The display name as plain text (page titles, attributes): `owner/name` or `owner/name (id)`. */
export function zoneNameText(zone: ZoneRef, zones: readonly ZoneRef[]): string {
  const p = parts(zone, zones);
  return p.id === undefined ? p.repo : `${p.repo} (${p.id})`;
}

/** The display name as escaped HTML: `owner/name`, or `owner/name <small>(id)</small>`. */
export function zoneName(zone: ZoneRef, zones: readonly ZoneRef[]): string {
  const p = parts(zone, zones);
  return p.id === undefined ? esc(p.repo) : `${esc(p.repo)} <small>(${esc(p.id)})</small>`;
}

/**
 * Names zones by id among `zones`, as escaped HTML. A zone no longer configured (a briefing or
 * observation outliving its zone) goes by the repository the caller still knows for it, else by
 * its id.
 */
export function zoneNamer(zones: readonly ZoneRef[]): (id: string, repo?: string) => string {
  const text = zoneTextNamer(zones);
  const byId = new Map(zones.map((z) => [z.id, z]));
  return (id, repo) => {
    const z = byId.get(id);
    return z ? zoneName(z, zones) : esc(text(id, repo));
  };
}

/** As zoneNamer, as plain text. */
export function zoneTextNamer(zones: readonly ZoneRef[]): (id: string, repo?: string) => string {
  const byId = new Map(zones.map((z) => [z.id, z]));
  return (id, repo) => {
    const z = byId.get(id);
    return z ? zoneNameText(z, zones) : (repo ?? id);
  };
}
