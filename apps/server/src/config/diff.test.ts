import { describe, expect, test } from 'vitest';
import { diff, mergeConfigPatch, mergePatch } from './diff.js';

const zone = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test' }],
  ...extra,
});

describe('diff', () => {
  test('equal documents have no changes, whatever their key order', () => {
    expect(diff({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toEqual([]);
  });

  test('scalars, added and removed keys, by dotted path', () => {
    expect(
      diff({ pollSeconds: 60, usage: { x: 1 } }, { pollSeconds: 30, mcp: { enabled: true } }),
    ).toEqual([
      { path: 'mcp', from: undefined, to: { enabled: true } },
      { path: 'pollSeconds', from: 60, to: 30 },
      { path: 'usage', from: { x: 1 }, to: undefined },
    ]);
  });

  test('matches zones by id, so a reorder is nothing and an edit names the zone', () => {
    const a = { dropZones: [zone('a'), zone('b')] };
    expect(diff(a, { dropZones: [zone('b'), zone('a')] })).toEqual([]);
    expect(diff(a, { dropZones: [zone('b', { readyLabel: 'go' }), zone('a')] })).toEqual([
      { path: 'dropZones[b].readyLabel', from: undefined, to: 'go' },
    ]);
  });

  test('a zone added or removed is one change carrying the whole zone', () => {
    expect(diff({ dropZones: [zone('a')] }, { dropZones: [zone('a'), zone('c')] })).toEqual([
      { path: 'dropZones[c]', from: undefined, to: zone('c') },
    ]);
    expect(diff({ dropZones: [zone('a')] }, {})).toEqual([
      { path: 'dropZones[a]', from: zone('a'), to: undefined },
    ]);
  });

  test('other arrays are matched by index', () => {
    const a = { dropZones: [zone('a', { egress: { allow: ['x.com', 'y.com'] } })] };
    const b = { dropZones: [zone('a', { egress: { allow: ['y.com'] } })] };
    expect(diff(a, b)).toEqual([
      { path: 'dropZones[a].egress.allow.0', from: 'x.com', to: 'y.com' },
      { path: 'dropZones[a].egress.allow.1', from: 'y.com', to: undefined },
    ]);
  });

  test('a document holds no secret, so neither does its diff', () => {
    const secret = 'ghp_secretvalue1234567890';
    const changes = diff({ pollSeconds: 60 }, { pollSeconds: 30, dropZones: [zone('a')] });
    expect(JSON.stringify(changes)).not.toContain(secret);
  });
});

describe('mergePatch (RFC 7396)', () => {
  test('merges objects, replaces arrays and scalars, and null removes a key', () => {
    const target = { a: 1, b: { c: 2, d: [1, 2] }, e: 'x' };
    expect(mergePatch(target, { a: null, b: { c: 3, d: [9] }, f: true })).toEqual({
      b: { c: 3, d: [9] },
      e: 'x',
      f: true,
    });
    // The target is not changed in place.
    expect(target).toEqual({ a: 1, b: { c: 2, d: [1, 2] }, e: 'x' });
  });

  test('a non-object patch replaces the whole document', () => {
    expect(mergePatch({ a: 1 }, [1])).toEqual([1]);
    expect(mergePatch({ a: 1 }, 'x')).toBe('x');
  });

  test('null inside a new object is dropped', () => {
    expect(mergePatch({}, { a: { b: null, c: 1 } })).toEqual({ a: { c: 1 } });
  });
});

describe('mergeConfigPatch (zones by id)', () => {
  const doc = {
    pollSeconds: 60,
    dropZones: [
      { id: 'a', repo: 'o/a', readyLabel: 'x', egress: { mode: 'monitor', allow: ['h'] } },
      { id: 'b', repo: 'o/b' },
    ],
  };

  test('a zone element merges into the zone with its id, and the others are kept in order', () => {
    expect(
      mergeConfigPatch(doc, { dropZones: [{ id: 'a', readyLabel: null, egress: { allow: [] } }] }),
    ).toEqual({
      pollSeconds: 60,
      dropZones: [
        { id: 'a', repo: 'o/a', egress: { mode: 'monitor', allow: [] } },
        { id: 'b', repo: 'o/b' },
      ],
    });
  });

  test('a new id is appended (an add), and the rest of the patch merges as RFC 7396', () => {
    expect(
      mergeConfigPatch(doc, { pollSeconds: 30, dropZones: [{ id: 'c', repo: 'o/c' }] }),
    ).toEqual({
      pollSeconds: 30,
      dropZones: [...doc.dropZones, { id: 'c', repo: 'o/c' }],
    });
  });

  test('zones are never removed by a patch: an empty list or a missing zone changes nothing', () => {
    expect(mergeConfigPatch(doc, { dropZones: [] })).toEqual(doc);
  });

  test('a zone element without a string id, or a list that is not one, is passed on for the schema to refuse', () => {
    const odd = mergeConfigPatch(doc, { dropZones: [{ repo: 'o/z' }] }) as { dropZones: unknown[] };
    expect(odd.dropZones.at(-1)).toEqual({ repo: 'o/z' });
    expect(mergeConfigPatch(doc, { dropZones: 'nope' })).toMatchObject({ dropZones: 'nope' });
  });
});
