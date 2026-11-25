import { EgressPayloadSchema } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { DropZoneObject } from './config.js';
import { egressFor } from './egress-for.js';

describe('egressFor and egress.private (issues #890, #899)', () => {
  const host = 'gitlab.internal.example';
  const zone = (egress: Record<string, unknown>) =>
    DropZoneObject.parse({
      id: 'g',
      repo: 'group/project',
      forge: 'gitlab',
      gitlab: { baseUrl: `https://${host}` },
      gates: [],
      preset: 'node',
      egress,
    });

  test.each(['monitor', 'enforce'])(
    'mode %s with private: [host] gives private: [host]',
    (mode) => {
      const e = egressFor(zone({ mode, allow: [host], private: [host] }));
      expect(e?.private).toEqual([host]);
      expect(e?.allow).toContain(host);
      expect(EgressPayloadSchema.parse(e)).toEqual(e);
    },
  );

  test('mode off gives undefined', () => {
    expect(egressFor(zone({ mode: 'off', allow: [host], private: [host] }))).toBeUndefined();
  });

  test.each([undefined, []])('private %j gives the result without a private key', (priv) => {
    const without = egressFor(zone({ mode: 'enforce', allow: [host] }));
    const e = egressFor(
      zone({ mode: 'enforce', allow: [host], ...(priv ? { private: priv } : {}) }),
    );
    expect(e).not.toHaveProperty('private');
    expect(JSON.stringify(e)).toBe(JSON.stringify(without));
  });

  test('a host the allow list covers only by a wildcard is added to allow exactly', () => {
    const e = egressFor(zone({ mode: 'enforce', allow: ['*.internal.example'], private: [host] }));
    expect(e?.private).toEqual([host]);
    expect(e?.allow).toContain(host);
    expect(e?.allow).toContain('*.internal.example');
    expect(e?.allow).toEqual([...new Set(e?.allow)].sort());
    expect(EgressPayloadSchema.parse(e)).toEqual(e);
  });

  test('private is canonical, deduplicated and sorted', () => {
    const e = egressFor(
      zone({ mode: 'monitor', allow: [host], private: ['GitLab.Internal.Example.', host] }),
    );
    expect(e?.private).toEqual([host]);
  });
});
