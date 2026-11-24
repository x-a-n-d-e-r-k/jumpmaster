// What a zone's drops are given for egress: shared by the payload (payloads.ts) and the lease's
// stick matching (leases.ts), in its own module so neither imports the other.
import { BASE_EGRESS, type EgressPayload, normalizeHost } from '@jumpmaster/protocol';
import type { DropZoneConfig } from './config.js';
import { PRESET_EGRESS } from './presets.js';

/** An entry in canonical form: a name, or `*.` plus a name. */
const canonicalEntry = (e: string): string =>
  e.startsWith('*.') ? `*.${normalizeHost(e.slice(2)) ?? e.slice(2)}` : (normalizeHost(e) ?? e);

/**
 * The payload's `egress`, absent when the zone's mode is `off` (M3 behaviour). The allow list is
 * the base, the preset's hosts and the zone's own entries, canonical, deduplicated and sorted.
 */
export function egressFor(zone: Pick<DropZoneConfig, 'egress' | 'preset'>): EgressPayload | undefined {
  const mode = zone.egress?.mode ?? 'off';
  if (mode === 'off') return undefined;
  const entries = [
    ...BASE_EGRESS,
    ...(zone.preset ? PRESET_EGRESS[zone.preset] : []),
    ...(zone.egress?.allow ?? []),
  ].map(canonicalEntry);
  return { mode, allow: [...new Set(entries)].sort() };
}
