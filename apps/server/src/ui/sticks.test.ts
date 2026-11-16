import { describe, expect, test } from 'vitest';
import type { MirrorStatus } from '../images/mirror.js';
import { t0 } from '../test/helpers.js';
import { renderSticks } from './sticks.js';

const digest = `sha256:${'a'.repeat(64)}`;
const image = (
  name: string,
  state: MirrorStatus['images'][number]['state'],
  o: Partial<MirrorStatus['images'][number]> = {},
): MirrorStatus['images'][number] => ({
  name,
  digest,
  ref: `ghcr.io/o/${name}@${digest}`,
  state,
  platforms: ['linux/amd64', 'linux/arm64'],
  size: 3 * 1024 * 1024,
  current: true,
  ...o,
});

describe('the Images card on /sticks (issue #140)', () => {
  test('lists each mirrored image with its platforms, size and state', () => {
    const html = renderSticks({
      sticks: [],
      zones: [],
      now: t0,
      images: {
        lock: true,
        images: [
          image('jumpmaster-trooper', 'complete'),
          image('jumpmaster-egress', 'failed', {
            error: 'the registry refused <anonymous> access',
            platforms: [],
            size: 0,
          }),
          image('jumpmaster-stick', 'fetching', { current: false }),
        ],
      },
    });
    expect(html).toContain('<h3>Images</h3>');
    expect(html).toMatch(
      /<tr data-image="jumpmaster-trooper"><td>jumpmaster-trooper<\/td><td>linux\/amd64, linux\/arm64<\/td><td>3\.0 MiB<\/td><td>complete<\/td>/,
    );
    // The reason is escaped: it is the registry's words, as data.
    expect(html).toContain('failed: the registry refused &lt;anonymous&gt; access');
    expect(html).toContain('fetching (previous release)');
  });

  test('with no lock it says there is nothing to mirror; with no mirror it shows nothing', () => {
    const none = renderSticks({
      sticks: [],
      zones: [],
      now: t0,
      images: { lock: false, images: [] },
    });
    expect(none).toContain('runs from a checkout');
    expect(renderSticks({ sticks: [], zones: [], now: t0 })).not.toContain('<h3>Images</h3>');
  });
});

describe('image downloads on /sticks (issue #141)', () => {
  const row = {
    id: 's1',
    name: 'vps-1',
    version: '1.0.0',
    lastSeenAt: t0.toISOString(),
    capabilities: ['push-v1'],
    imagePolicy: 'signed',
    cannotRun: [],
    slots: 2,
    maxSlots: 4,
    reported: true,
    running: 0,
  };

  test('a stick fetching an image shows the image and MB done of total', () => {
    const html = renderSticks({
      sticks: [
        {
          ...row,
          fetching: {
            ref: `ghcr.io/o/jumpmaster-trooper@${digest}`,
            done: 12_400_000,
            total: 40_000_000,
          },
        },
      ],
      zones: [],
      now: t0,
    });
    expect(html).toContain('fetching jumpmaster-trooper 12/40 MB');
  });

  test('a stick fetching nothing shows no download', () => {
    const html = renderSticks({ sticks: [row], zones: [], now: t0 });
    expect(html).not.toContain('fetching ');
  });
});
