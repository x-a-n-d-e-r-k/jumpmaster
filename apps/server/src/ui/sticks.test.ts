import { describe, expect, test } from 'vitest';
import type { MirrorStatus } from '../images/mirror.js';
import { t0 } from '../test/helpers.js';
import { renderInviteResult, renderSticks } from './sticks.js';

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

describe('a stick starting up on /sticks (issue #157)', () => {
  const row = {
    id: 's1',
    name: 'vps-1',
    version: '0.4.0',
    lastSeenAt: t0.toISOString(),
    capabilities: [],
    imagePolicy: 'signed',
    cannotRun: [],
    slots: 1,
    maxSlots: 4,
    reported: true,
    running: 0,
  };

  test('while the report is present the row shows the starting line, and polls', () => {
    const html = renderSticks({
      sticks: [{ ...row, starting: { image: `ghcr.io/o/jumpmaster-trooper@${digest}` } }],
      zones: [],
      now: t0,
    });
    expect(html).toContain('starting: checking the trooper image jumpmaster-trooper');
    expect(html).toContain('<span class="stage">Starting</span>');
    expect(html).toContain('data-poll data-stick="s1"');
  });

  test('once the report is cleared the line is gone and the stick is live', () => {
    const html = renderSticks({ sticks: [row], zones: [], now: t0 });
    expect(html).not.toContain('starting: checking');
    expect(html).toContain('<span class="stage">Live</span>');
  });
});

describe('the Remove confirmation (issue #255)', () => {
  test('says the stick keeps its credentials and a join-token stick can enroll again', () => {
    const html = renderSticks({
      sticks: [
        {
          id: 's1',
          name: 'vps-1',
          version: '0.4.0',
          lastSeenAt: t0.toISOString(),
          capabilities: [],
          imagePolicy: 'signed',
          cannotRun: [],
          slots: 1,
          maxSlots: 4,
          reported: true,
          running: 0,
        },
      ],
      zones: [],
      now: t0,
    });
    const ask = /data-ask="([^"]*)"/.exec(html)?.[1] ?? '';
    const text = ask.replaceAll('&#39;', "'").replaceAll('&#x27;', "'").replaceAll('&apos;', "'");
    expect(text).toContain(
      "This stick keeps any credentials it was already sent. Rotate the Claude and GitHub tokens if you don't trust it. A stick that enrolled with the join token can enroll again until that token is changed.",
    );
  });
});

describe('Add a stick: how it will be installed (issue #269)', () => {
  test('the form asks "How will you install it?": Paste a line (the default) or Cloud-init user data', () => {
    const html = renderSticks({ sticks: [], zones: [], now: t0, publicUrl: 'https://jm.example' });
    expect(html).toContain('<legend>How will you install it?</legend>');
    expect(html).toContain('<input type="radio" name="kind" value="line" checked> Paste a line');
    expect(html).toContain(
      '<input type="radio" name="kind" value="cloud_init"> Cloud-init user data',
    );
    expect(html).toContain('24 hours');
    expect(html).toContain('1 hour');
    // The form sends the choice.
    expect(html).toContain("kind:(add.querySelector('[name=kind]:checked')");
  });

  const base = { name: 'vps-1', slots: null, expiresAt: '2026-01-01T01:00:00.000Z' };

  test('a line invite: the result page holds the line only, 24 hours', () => {
    const html = renderInviteResult({ ...base, kind: 'line', line: 'curl LINE | sudo sh -s -- c' });
    expect(html).toContain('id="install-line"');
    expect(html).toContain('curl LINE');
    expect(html).toContain('(24 hours)');
    expect(html).not.toContain('id="cloud-init"');
    expect(html).not.toContain('role="tab"');
  });

  test('a cloud-init invite: the result page holds the cloud-config only, 1 hour', () => {
    const html = renderInviteResult({ ...base, kind: 'cloud_init', cloudInit: '#cloud-config\n' });
    expect(html).toContain('id="cloud-init"');
    expect(html).toContain('#cloud-config');
    expect(html).toContain('(1 hour)');
    expect(html).not.toContain('id="install-line"');
    expect(html).not.toContain('role="tab"');
  });
});
