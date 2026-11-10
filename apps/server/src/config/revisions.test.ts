import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  canonicalJson,
  deleteSetting,
  getRevision,
  getSetting,
  hashOf,
  insertRevision,
  listRevisions,
  setSetting,
} from './revisions.js';

describe('canonicalJson', () => {
  test('sorts keys at every depth, keeps array order, indents two spaces and ends in a newline', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
    expect(a).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
    expect(canonicalJson({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 })).toBe(a);
  });

  test('drops undefined members, as JSON does', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{\n  "b": 1\n}\n');
  });

  test('hashOf is the SHA-256 hex of the text', () => {
    expect(hashOf('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('revisions and settings', () => {
  test('a revision round-trips and the list is newest first', () => {
    const db = openDb(tmpDbFile());
    const one = insertRevision(db, { parentId: null, doc: {}, via: 'setup' }, t0);
    const two = insertRevision(
      db,
      { parentId: one, doc: { pollSeconds: 30 }, via: 'ctl', note: '<b>why</b>' },
      t0,
    );
    expect(getRevision(db, two)).toEqual({
      id: two,
      parentId: one,
      doc: { pollSeconds: 30 },
      sourceHash: hashOf(canonicalJson({ pollSeconds: 30 })),
      via: 'ctl',
      note: '<b>why</b>',
      createdAt: t0.toISOString(),
    });
    expect(listRevisions(db, 10).map((r) => r.id)).toEqual([two, one]);
    expect(listRevisions(db, 1).map((r) => r.id)).toEqual([two]);
    expect(getRevision(db, 99)).toBeUndefined();
  });

  test('a note over 500 characters is refused by the table', () => {
    const db = openDb(tmpDbFile());
    expect(() =>
      insertRevision(db, { parentId: null, doc: {}, via: 'ui', note: 'x'.repeat(501) }, t0),
    ).toThrow(/CHECK/);
  });

  test('settings hold JSON values by key', () => {
    const db = openDb(tmpDbFile());
    expect(getSetting(db, 'config.mode')).toBeUndefined();
    setSetting(db, 'config.mode', 'file', t0);
    setSetting(db, 'config.mode', 'db', t0);
    expect(getSetting(db, 'config.mode')).toBe('db');
    setSetting(db, 'config.restart_pending', ['mcp.enabled'], t0);
    expect(getSetting(db, 'config.restart_pending')).toEqual(['mcp.enabled']);
    deleteSetting(db, 'config.restart_pending');
    expect(getSetting(db, 'config.restart_pending')).toBeUndefined();
  });
});
