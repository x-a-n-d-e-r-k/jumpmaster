import { describe, expect, test } from 'vitest';
import {
  compareReleaseVersions,
  isReleaseVersion,
  parseReleaseVersion,
  STICK_CAPABILITIES,
  UPGRADE_HEADER,
  UpgradeOfferSchema,
  UpgradeReportSchema,
} from './index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

/** `a` against `b`, both release versions: -1, 0 or 1. */
const cmp = (a: string, b: string): number => {
  const pa = parseReleaseVersion(a);
  const pb = parseReleaseVersion(b);
  if (!pa || !pb) throw new Error(`not release versions: ${a}, ${b}`);
  return Math.sign(compareReleaseVersions(pa, pb));
};

describe('release versions (moved from the stick, issue #427)', () => {
  test('parseReleaseVersion accepts X.Y.Z and X.Y.Z-rc.N, nothing else', () => {
    expect(parseReleaseVersion('0.4.1')).toEqual({ major: 0, minor: 4, patch: 1, rc: null });
    expect(parseReleaseVersion('1.20.3-rc.10')).toEqual({ major: 1, minor: 20, patch: 3, rc: 10 });
    for (const v of [
      '',
      'v0.4.1',
      '0.4',
      '0.4.1-beta.1',
      '0.4.1.1',
      '01.4.1',
      'main',
      'unknown',
      'dev',
      '0.0.0-dev',
      '0.4.1-dev',
    ])
      expect(parseReleaseVersion(v), v).toBeNull();
  });

  test.each([
    ['equal', '0.4.1', '0.4.1', 0],
    ['newer patch', '0.4.2', '0.4.1', 1],
    ['newer minor', '0.5.0', '0.4.1', 1],
    ['newer major', '1.0.0', '0.4.1', 1],
    ['older patch', '0.4.0', '0.4.1', -1],
    ['older minor', '0.3.9', '0.4.1', -1],
    ['an rc is before its final', '0.4.1-rc.3', '0.4.1', -1],
    ['the same rc', '0.4.1-rc.2', '0.4.1-rc.2', 0],
    ['a later rc', '0.4.1-rc.3', '0.4.1-rc.2', 1],
    ['rc ordering is numeric', '0.4.1-rc.10', '0.4.1-rc.2', 1],
    ['the final is after its rc', '0.4.1', '0.4.1-rc.2', 1],
    ['an earlier rc', '0.4.1-rc.1', '0.4.1-rc.2', -1],
    ['the previous final', '0.4.0', '0.4.1-rc.2', -1],
    ['numeric, not lexical', '0.10.0', '0.9.0', 1],
    ['0.9.0 is behind 0.10.0', '0.9.0', '0.10.0', -1],
  ])('compareReleaseVersions: %s (%s vs %s)', (_, a, b, want) => {
    expect(cmp(a, b)).toBe(want);
  });

  test('isReleaseVersion: only what parseReleaseVersion accepts', () => {
    expect(isReleaseVersion('0.6.0')).toBe(true);
    expect(isReleaseVersion('0.6.0-rc.1')).toBe(true);
    for (const v of ['0.0.0-dev', 'dev', 'unknown', '', null, undefined, 6])
      expect(isReleaseVersion(v), String(v)).toBe(false);
  });
});

describe('the upgrade offer and report (issue #427)', () => {
  test('upgrade-v1 is a stick capability; the header has its name', () => {
    expect(STICK_CAPABILITIES).toContain('upgrade-v1');
    expect(UPGRADE_HEADER).toBe('x-jumpmaster-upgrade');
  });

  test('an offer names a release version and a jumpmaster-stick digest reference', () => {
    const image = `ghcr.io/owner/jumpmaster-stick@${DIGEST}`;
    expect(UpgradeOfferSchema.parse({ version: '0.6.0', image })).toEqual({
      version: '0.6.0',
      image,
    });
    expect(
      UpgradeOfferSchema.safeParse({
        version: '0.6.0',
        image: `localhost:5000/jumpmaster-stick@${DIGEST}`,
      }).success,
    ).toBe(true);
    for (const bad of [
      { version: '0.0.0-dev', image },
      { version: 'dev', image },
      { version: 'v0.6.0', image },
      { version: '0.6.0', image: `ghcr.io/owner/jumpmaster-stick:0.6.0` },
      { version: '0.6.0', image: `ghcr.io/owner/jumpmaster-trooper@${DIGEST}` },
      { version: '0.6.0', image: `ghcr.io/owner/not-jumpmaster-stick@${DIGEST}` },
      { version: '0.6.0', image: `jumpmaster-stick@${DIGEST}` },
      { version: '0.6.0', image: `ghcr.io/owner/jumpmaster-stick@sha256:${'a'.repeat(63)}` },
      { version: '0.6.0', image: `ghcr.io/owner/jumpmaster-stick@${DIGEST}\n` },
      { version: '0.6.0' },
    ])
      expect(UpgradeOfferSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  test("a report is the stick's last attempt: a version, a result, a reason of at most 500", () => {
    expect(
      UpgradeReportSchema.safeParse({ version: '0.6.0', result: 'refused', reason: 'x' }).success,
    ).toBe(true);
    expect(UpgradeReportSchema.safeParse({ version: '0.6.0', result: 'ok' }).success).toBe(true);
    expect(
      UpgradeReportSchema.safeParse({ version: '0.6.0', result: 'failed', reason: 'x'.repeat(500) })
        .success,
    ).toBe(true);
    expect(
      UpgradeReportSchema.safeParse({ version: '0.6.0', result: 'failed', reason: 'x'.repeat(501) })
        .success,
    ).toBe(false);
    expect(UpgradeReportSchema.safeParse({ version: '0.6.0', result: 'done' }).success).toBe(false);
    expect(UpgradeReportSchema.safeParse({ result: 'ok' }).success).toBe(false);
  });
});
