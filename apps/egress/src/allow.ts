// The allow-list and address rules live in the protocol package (stdlib only, under its `egress`
// subpath) so the server validates a zone's list with exactly the code the proxy enforces it with.
export {
  type EgressLogLine,
  hostAllowed,
  isPublicAddress,
  normalizeHost,
  validAllowEntry,
} from '@jumpmaster/protocol/egress';
