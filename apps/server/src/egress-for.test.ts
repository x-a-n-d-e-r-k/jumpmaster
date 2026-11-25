import { describe, expect, test } from 'vitest';
import { DropZoneObject } from './config.js';
import { egressFor } from './egress-for.js';

describe('egressFor and egress.private (issue #890)', () => {
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

  test.each(['off', 'monitor', 'enforce'])(
    'a GitLab zone with egress.private set (mode %s) gets the same result as without it',
    (mode) => {
      const without = egressFor(zone({ mode, allow: [host] }));
      const withIt = egressFor(zone({ mode, allow: [host], private: [host] }));
      expect(JSON.stringify(withIt)).toBe(JSON.stringify(without));
      if (mode !== 'off') expect(withIt).toEqual({ mode, allow: expect.any(Array) });
      else expect(withIt).toBeUndefined();
    },
  );
});
