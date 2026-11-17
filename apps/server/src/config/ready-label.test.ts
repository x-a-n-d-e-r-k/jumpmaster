import { describe, expect, test } from 'vitest';
import { LEGACY_READY_LABEL, pinReadyLabels, unpinnedZoneIds } from './ready-label.js';

describe('the readyLabel pin (#198)', () => {
  const doc = {
    pollSeconds: 30,
    dropZones: [{ id: 'a' }, { id: 'b', readyLabel: 'go' }, { id: 'c' }],
  };

  test('lists the zones with no readyLabel', () => {
    expect(unpinnedZoneIds(doc)).toEqual(['a', 'c']);
    expect(unpinnedZoneIds({})).toEqual([]);
  });

  test('pins only the named zones that have none, leaving explicit values and the input as they are', () => {
    const r = pinReadyLabels(doc, ['a', 'b']);
    expect(r.pinned).toEqual(['a']);
    expect(r.doc.dropZones).toEqual([
      { id: 'a', readyLabel: LEGACY_READY_LABEL },
      { id: 'b', readyLabel: 'go' },
      { id: 'c' },
    ]);
    expect(doc.dropZones[0]).toEqual({ id: 'a' });
  });

  test('is idempotent: pinning a pinned document changes nothing', () => {
    const once = pinReadyLabels(doc, ['a', 'c']);
    const twice = pinReadyLabels(once.doc, ['a', 'c']);
    expect(twice.pinned).toEqual([]);
    expect(twice.doc).toEqual(once.doc);
  });
});
