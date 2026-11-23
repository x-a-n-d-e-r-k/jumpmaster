import { describe, expect, test } from 'vitest';
import { projectWords, zoneName, zoneNamer, zoneNameText, zoneTextNamer } from './zone-name.js';

const main = { id: 'main', repo: 'octo/demo' };
const ref = { id: 'ref', repo: 'octo/reference' };
const shadow = { id: 'shadow', repo: 'octo/demo' };

describe('zone display name', () => {
  test('a zone alone on its repository renders owner/name', () => {
    expect(zoneNameText(ref, [main, ref])).toBe('octo/reference');
    expect(zoneName(ref, [main, ref])).toBe('octo/reference');
  });

  test('two zones on one repository render with their ids, the id in small text', () => {
    const all = [main, ref, shadow];
    expect(zoneNameText(main, all)).toBe('octo/demo (main)');
    expect(zoneNameText(shadow, all)).toBe('octo/demo (shadow)');
    expect(zoneName(shadow, all)).toBe('octo/demo <small>(shadow)</small>');
  });

  test('escapes the repository and the id', () => {
    const odd = { id: '<i>', repo: 'a/<b>' };
    expect(zoneName(odd, [odd, { id: 'x', repo: 'a/<b>' }])).toBe(
      'a/&lt;b&gt; <small>(&lt;i&gt;)</small>',
    );
  });

  test('a namer looks a zone up by id, and falls back to the id for a zone no longer configured', () => {
    const name = zoneNamer([main, ref, shadow]);
    expect(name('ref')).toBe('octo/reference');
    expect(name('shadow')).toBe('octo/demo <small>(shadow)</small>');
    expect(name('gone<')).toBe('gone&lt;');
  });

  test('a zone no longer configured falls back to its repository when one is known', () => {
    const name = zoneNamer([main]);
    expect(name('gone', 'octo/<old>')).toBe('octo/&lt;old&gt;');
    expect(name('gone')).toBe('gone');
    expect(zoneTextNamer([main])('gone', 'octo/old')).toBe('octo/old');
  });
});

describe('projectWords', () => {
  test('says project for zone in validator prose, and leaves keys and names alone', () => {
    expect(
      projectWords(
        'a starter zone requires ciRequired: true; githubApp applies to two-bot zones only; Zone ids clash',
      ),
    ).toBe(
      'a starter project requires ciRequired: true; githubApp applies to two-bot projects only; Project ids clash',
    );
    expect(projectWords('dropZones.1.id shares JM_ZONE_SECRET_A_<NAME>')).toBe(
      'dropZones.1.id shares JM_ZONE_SECRET_A_<NAME>',
    );
  });

  test('leaves an id shown as a value alone, even an id that is or holds the word zone', () => {
    expect(projectWords('duplicate zone id: drop-zone')).toBe('duplicate project id: drop-zone');
    expect(projectWords('duplicate zone id: zone')).toBe('duplicate project id: zone');
    expect(projectWords('zone zone: preset python needs the lock')).toBe(
      'project zone: preset python needs the lock',
    );
    expect(projectWords('zone ids zone-a and zone share JM_ZONE_SECRET_ZONE_<NAME>')).toBe(
      'project ids zone-a and zone share JM_ZONE_SECRET_ZONE_<NAME>',
    );
    expect(projectWords('a zone id may not be zone_x; not zone')).toBe(
      'a project id may not be zone_x; not zone',
    );
  });
});
