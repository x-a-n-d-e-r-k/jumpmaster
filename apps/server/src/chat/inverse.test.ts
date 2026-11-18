import { describe, expect, test } from 'vitest';
import { mergeConfigPatch } from '../config/diff.js';
import { changedSince, inversePatch, settingPatch, valueAt } from './inverse.js';

const doc = () => ({
  pollSeconds: 60,
  dropZones: [
    { id: 'main', repo: 'octo/main', maxOpenPrs: 3, crew: { enabled: true } },
    { id: 'other', repo: 'octo/other' },
  ],
});

describe('settingPatch', () => {
  test('a zone path patches that zone alone, by id', () => {
    const p = settingPatch(doc(), 'main', {
      'dropZones[].maxOpenPrs': 5,
      'dropZones[].crew.refutePromotes': true,
    });
    expect(p).toEqual({
      dropZones: [{ id: 'main', maxOpenPrs: 5, crew: { refutePromotes: true } }],
    });
    const next = mergeConfigPatch(doc(), p) as ReturnType<typeof doc>;
    expect(next.dropZones[0]).toMatchObject({ maxOpenPrs: 5, crew: { enabled: true } });
    expect(next.dropZones[1]).toEqual(doc().dropZones[1]);
  });

  test('an install path patches the install', () => {
    expect(settingPatch(doc(), undefined, { pollSeconds: 30 })).toEqual({ pollSeconds: 30 });
  });

  test('refuses a path the catalog does not name, of the other scope, or a zone not in the document', () => {
    expect(() => settingPatch(doc(), 'main', { 'dropZones[].nope': 1 })).toThrow(/not a setting/);
    expect(() => settingPatch(doc(), 'main', { pollSeconds: 1 })).toThrow(/not a setting/);
    expect(() => settingPatch(doc(), undefined, { 'dropZones[].maxOpenPrs': 1 })).toThrow(
      /not a setting/,
    );
    expect(() => settingPatch(doc(), 'gone', { 'dropZones[].maxOpenPrs': 1 })).toThrow(
      /unknown zone/,
    );
    expect(() => settingPatch(doc(), 'main', {})).toThrow(/nothing to set/);
  });
});

describe('inversePatch', () => {
  test('inversePatch restores just the changed paths and leaves a later change to another path alone', () => {
    const before = doc();
    const after = mergeConfigPatch(
      before,
      settingPatch(before, 'main', {
        'dropZones[].maxOpenPrs': 5,
        'dropZones[].crew.refutePromotes': true,
      }),
    ) as Record<string, unknown>;
    const paths = ['dropZones[main].maxOpenPrs', 'dropZones[main].crew.refutePromotes'];
    const inv = inversePatch(before, after, paths);
    expect(inv.expect).toEqual({
      'dropZones[main].maxOpenPrs': 5,
      'dropZones[main].crew.refutePromotes': true,
    });
    // An unset key is restored by removing it.
    expect(inv.patch).toEqual({
      dropZones: [{ id: 'main', maxOpenPrs: 3, crew: { refutePromotes: null } }],
    });
    // Someone changes another path later: the undo keeps it.
    const later = mergeConfigPatch(after, {
      pollSeconds: 15,
      dropZones: [{ id: 'main', crew: { enabled: false } }],
    }) as Record<string, unknown>;
    expect(changedSince(later, inv.expect)).toEqual([]);
    const undone = mergeConfigPatch(later, inv.patch) as ReturnType<typeof doc>;
    expect(undone.pollSeconds).toBe(15);
    expect(undone.dropZones[0]).toEqual({
      id: 'main',
      repo: 'octo/main',
      maxOpenPrs: 3,
      crew: { enabled: false },
    });
    expect(undone.dropZones[1]).toEqual(doc().dropZones[1]);
  });

  test('changedSince names a path whose value moved after the change', () => {
    const before = doc();
    const after = mergeConfigPatch(before, { pollSeconds: 30 }) as Record<string, unknown>;
    const inv = inversePatch(before, after, ['pollSeconds']);
    expect(inv.patch).toEqual({ pollSeconds: 60 });
    const moved = mergeConfigPatch(after, { pollSeconds: 45 }) as Record<string, unknown>;
    expect(changedSince(moved, inv.expect)).toEqual(['pollSeconds']);
    expect(valueAt(moved, 'pollSeconds')).toBe(45);
    expect(valueAt(moved, 'dropZones[main].crew.enabled')).toBe(true);
    expect(valueAt(moved, 'dropZones[gone].crew')).toBeUndefined();
  });
});
