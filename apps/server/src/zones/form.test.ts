import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { mergePatch } from '../config/diff.js';
import type { DropZoneConfig } from '../config.js';
import { crewOn } from '../test/crew.js';
import { makeZone } from '../test/fixtures.js';
import { FORM_SCRIPT, formToZone, issueField, toMergePatch, zoneToForm } from './form.js';

/** Every zone shape the fixtures make, plus the variants each section edits. */
const FIXTURES: DropZoneConfig[] = [
  makeZone(),
  makeZone({ id: 'starter', identity: 'starter', authorMayBeAdmin: true, ciRequired: true }),
  makeZone({ id: 'crew', crew: crewOn, protectedPaths: ['GOAL.md', '.github/**'] }),
  makeZone({
    id: 'egress',
    preset: 'node',
    egress: { mode: 'enforce', allow: ['registry.example.com', '*.cdn.example.com'] },
  }),
  makeZone({
    id: 'svc',
    services: [
      {
        name: 'db',
        image: `postgres@sha256:${'a'.repeat(64)}`,
        port: 5432,
        readyTimeoutSeconds: 60,
      },
    ],
    verification: [
      { name: 'e2e', paths: ['web/**'], run: 'npm run e2e', artifacts: 'out', timeoutMinutes: 30 },
    ],
    limits: { pids: 256, memoryMb: 2048 },
    adoptPulls: [12, 40],
    overrideApprovers: ['alice', 'bob'],
    reviewReadToken: true,
    requireBranchProtection: false,
    ciDeadlineMinutes: 90,
    gates: [
      { name: 'install', run: 'npm ci', timeoutMinutes: 20 },
      { name: 'test', run: 'npm test', timeoutMinutes: 45 },
    ],
  }),
];

describe('zone form', () => {
  test('form fields and zone JSON round-trip for every fixture zone', () => {
    for (const zone of FIXTURES) {
      const fields = zoneToForm(zone);
      // The form's patch, applied to the zone it was drawn from, changes nothing.
      expect(mergePatch(zone, formToZone(fields)), zone.id).toEqual(zone);
      // And drawing the patched zone gives the same form.
      expect(zoneToForm(mergePatch(zone, formToZone(fields)) as DropZoneConfig), zone.id).toEqual(
        fields,
      );
    }
  });

  test('a section posts only its own fields: what it does not carry is left alone', () => {
    const zone = FIXTURES[4] as DropZoneConfig;
    const fields = zoneToForm(zone);
    // The Project section alone.
    const patch = formToZone({
      id: zone.id,
      readyLabel: 'go',
      retryLabel: fields.retryLabel as string,
      adoptPulls: '12, 40, 41',
    });
    expect(patch).toEqual({
      id: 'svc',
      readyLabel: 'go',
      retryLabel: 'agent-retry',
      adoptPulls: [12, 40, 41],
    });
    // A checkbox the section names but the browser did not send is false.
    expect(
      formToZone({ id: 'svc', bool: ['ciRequired', 'reviewReadToken'], ciRequired: '1' }),
    ).toEqual({ id: 'svc', ciRequired: true, reviewReadToken: false });
  });

  test('gates come back as rows, and a blank row is dropped', () => {
    expect(
      formToZone({
        id: 'z',
        'gate.name': ['test', '', 'lint'],
        'gate.run': ['npm test', '', 'npm run lint'],
        'gate.timeout': ['30', '', ''],
      }),
    ).toEqual({
      id: 'z',
      gates: [
        { name: 'test', run: 'npm test', timeoutMinutes: 30 },
        { name: 'lint', run: 'npm run lint' },
      ],
    });
  });

  test('text that is not what the schema wants stays as typed, so the schema names the field', () => {
    const patch = formToZone({
      id: 'z',
      services: '[{ not json',
      ciDeadlineMinutes: 'soon',
      adoptPulls: '12, x',
    }) as Record<string, unknown>;
    expect(patch.services).toBe('[{ not json');
    expect(patch.ciDeadlineMinutes).toBe('soon');
    expect(patch.adoptPulls).toEqual([12, 'x']);
  });

  test('egress off with an empty allow list removes the egress block; blanks remove optional blocks', () => {
    expect(formToZone({ id: 'z', 'egress.mode': 'off', 'egress.allow': '' })).toEqual({
      id: 'z',
      egress: null,
    });
    expect(
      formToZone({
        id: 'z',
        'egress.mode': 'monitor',
        'egress.allow': 'a.example.com\n\n b.example.com ',
      }),
    ).toEqual({ id: 'z', egress: { mode: 'monitor', allow: ['a.example.com', 'b.example.com'] } });
    expect(formToZone({ id: 'z', preset: '', limits: '', services: '' })).toEqual({
      id: 'z',
      preset: null,
      limits: null,
      services: null,
    });
  });

  test('a schema issue maps to the field its path names, for this zone only', () => {
    expect(issueField('dropZones.2.gates.1.run', 2)).toBe('gates');
    expect(issueField('dropZones.2.egress.allow.0', 2)).toBe('egress.allow');
    expect(issueField('dropZones.2.egress.mode', 2)).toBe('egress.mode');
    expect(issueField('dropZones.2.readyLabel', 2)).toBe('readyLabel');
    expect(issueField('dropZones.2.crew.goalPath', 2)).toBe('advanced');
    expect(issueField('dropZones.1.readyLabel', 2)).toBeUndefined();
    expect(issueField('pollSeconds', 2)).toBeUndefined();
  });

  test('toMergePatch turns an edited zone into the RFC 7396 patch that makes it, nulls for removals', () => {
    const before = { id: 'z', a: 1, b: { c: 2, d: 3 }, list: [1, 2], gone: true };
    const after = { id: 'z', a: 1, b: { c: 5 }, list: [2], added: 'x' };
    const patch = toMergePatch(before, after);
    expect(patch).toEqual({ id: 'z', b: { c: 5, d: null }, list: [2], gone: null, added: 'x' });
    expect(mergePatch(before, patch)).toEqual(after);
  });

  test('the browser runs the same functions: the page script defines them and they agree', () => {
    const ctx = vm.createContext({});
    vm.runInContext(FORM_SCRIPT, ctx);
    const zone = FIXTURES[4] as DropZoneConfig;
    const fields = zoneToForm(zone);
    expect(JSON.stringify((ctx.formToZone as typeof formToZone)(fields))).toBe(
      JSON.stringify(formToZone(fields)),
    );
    expect((ctx.issueField as typeof issueField)('dropZones.0.gates.0.run', 0)).toBe('gates');
    expect(JSON.stringify((ctx.toMergePatch as typeof toMergePatch)({ a: 1 }, {}))).toBe(
      '{"a":null}',
    );
  });
});
