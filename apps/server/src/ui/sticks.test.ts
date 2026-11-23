import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import type { MirrorStatus } from '../images/mirror.js';
import { t0 } from '../test/helpers.js';
import { escapeHtml } from './pages.js';
import {
  COPY_DIGEST_JS,
  renderInviteResult,
  renderStickImages,
  renderSticks,
  STICKS_JS,
} from './sticks.js';

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

describe('the Images tab, /system/sticks/images (issue #140, #624)', () => {
  test('lists each mirrored image with its platforms, size and state', () => {
    const html = renderStickImages({
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
    });
    expect(html).toContain('<h2>Images</h2>');
    expect(html).toMatch(
      /<tr data-image="jumpmaster-trooper"><td>jumpmaster-trooper<\/td><td>linux\/amd64, linux\/arm64<\/td><td>3\.0 MiB<\/td><td>complete<\/td>/,
    );
    // The reason is escaped: it is the registry's words, as data.
    expect(html).toContain('failed: the registry refused &lt;anonymous&gt; access');
    expect(html).toMatch(
      /<tr data-image="jumpmaster-stick"><td>[^<]*<\/td><td>[^<]*<\/td><td>[^<]*<\/td><td>fetching<\/td>/,
    );
  });

  test('with no lock it says there is nothing to mirror; with no mirror it says so', () => {
    expect(renderStickImages({ lock: false, images: [] })).toContain('runs from a checkout');
    expect(renderStickImages(undefined)).toContain('This server mirrors no images');
  });

  test('/system/sticks has no image rows, and /system/sticks/images has all of them', () => {
    const images: MirrorStatus = {
      lock: true,
      images: [
        image('jumpmaster-trooper', 'complete'),
        image('jumpmaster-stick', 'complete', { current: false }),
      ],
    };
    const sticks = renderSticks({ sticks: [], zones: [], now: t0 });
    expect(sticks).not.toContain('data-image=');
    expect(sticks).not.toContain(digest);
    const page = renderStickImages(images);
    expect(page.match(/<tr data-image=/g)).toHaveLength(2);
    // Both carry the second-level tabs: Sticks · Images, the current one marked.
    const tabs = (html: string) =>
      /<nav class="settings-tabs sticks-tabs"[^>]*>.*?<\/nav>/.exec(html)?.[0];
    expect(tabs(sticks)).toBe(
      '<nav class="settings-tabs sticks-tabs" aria-label="Sticks tabs"><a href="/system/sticks" aria-current="page">Sticks</a><a href="/system/sticks/images">Images</a></nav>',
    );
    expect(tabs(page)).toBe(
      '<nav class="settings-tabs sticks-tabs" aria-label="Sticks tabs"><a href="/system/sticks">Sticks</a><a href="/system/sticks/images" aria-current="page">Images</a></nav>',
    );
    // The System sub-nav still marks Sticks on the Images tab.
    expect(page).toMatch(
      /<nav class="subnav"[^>]*>.*<a href="\/system\/sticks" aria-current="page">Sticks<\/a>/,
    );
  });

  test('current rows come before previous ones, under their headings, whatever the stored order', () => {
    const html = renderStickImages({
      lock: true,
      images: [
        image('old-a', 'complete', { current: false }),
        image('new-a', 'complete'),
        image('old-b', 'complete', { current: false }),
        image('new-b', 'complete'),
      ],
    });
    const order = [...html.matchAll(/<h3>(Current|Previous)<\/h3>|data-image="([^"]+)"/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(order).toEqual(['Current', 'new-a', 'new-b', 'Previous', 'old-a', 'old-b']);
  });

  test('a digest shows sha256: and 12 hex characters, the full digest in title and the copy button', () => {
    const full = `sha256:0123456789abcdef${'f'.repeat(48)}`;
    const html = renderStickImages({
      lock: true,
      images: [image('t', 'complete', { digest: full })],
    });
    expect(html).toContain(`<code title="${full}">sha256:0123456789ab</code>`);
    expect(html).toContain(`<button type="button" data-copy-digest="${full}">Copy</button>`);
    // The full digest appears nowhere visible: only in those two attributes.
    expect(html.split(full)).toHaveLength(3);
    expect(html.split(`title="${full}"`)).toHaveLength(2);
    expect(html.split(`data-copy-digest="${full}"`)).toHaveLength(2);
  });

  test('a digest that is not a sha256 one shows as it is, in full', () => {
    const odd = 'md5:0123456789abcdef0123456789abcdef';
    const html = renderStickImages({
      lock: true,
      images: [image('t', 'complete', { digest: odd })],
    });
    expect(html).toContain(`<code title="${odd}">${odd}</code>`);
  });

  test('a release with no images gets no heading', () => {
    const onlyCurrent = renderStickImages({ lock: true, images: [image('n', 'complete')] });
    expect(onlyCurrent).toContain('<h3>Current</h3>');
    expect(onlyCurrent).not.toContain('<h3>Previous</h3>');
    const onlyPrevious = renderStickImages({
      lock: true,
      images: [image('o', 'complete', { current: false })],
    });
    expect(onlyPrevious).toContain('<h3>Previous</h3>');
    expect(onlyPrevious).not.toContain('<h3>Current</h3>');
  });

  test('Copy writes the full digest to the clipboard', async () => {
    const full = `sha256:${'b'.repeat(64)}`;
    const html = renderStickImages({
      lock: true,
      images: [image('t', 'complete', { digest: full })],
    });
    expect(html).toContain(`<script>${COPY_DIGEST_JS}</script>`);
    const src = COPY_DIGEST_JS;
    const listeners: ((e: unknown) => Promise<void>)[] = [];
    const written: string[] = [];
    const button = {
      dataset: { copyDigest: full },
      textContent: 'Copy',
      closest: () => button,
    };
    vm.runInNewContext(src, {
      document: {
        addEventListener: (_: string, fn: (e: unknown) => Promise<void>) => listeners.push(fn),
      },
      navigator: {
        clipboard: { writeText: async (t: string) => void written.push(t) },
      },
    });
    for (const fn of listeners) await fn({ target: button });
    expect(written).toEqual([full]);
    expect(button.textContent).toBe('Copied');
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

describe('the Remove confirmation (issue #255, #624)', () => {
  const stick = {
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
  const html = renderSticks({ sticks: [stick], zones: [], now: t0 });
  const confirmBox = /<div class="confirm"[^>]*>(.*?)<\/div>/.exec(html);
  // The prompt as rendered (escaped HTML); expectations are escaped the same way.
  const askHtml = /<p>(.*?)<\/p>/.exec(confirmBox?.[1] ?? '')?.[1] ?? '';

  test('says the stick keeps its credentials and a join-token stick can enroll again', () => {
    expect(askHtml).toContain(
      escapeHtml(
        "This stick keeps any credentials it was already sent. Rotate the Claude and GitHub tokens if you don't trust it. A stick that enrolled with the join token can enroll again until that token is changed.",
      ),
    );
  });

  test("Remove is the row's last cell, with the confirmation hidden in the page, naming the stick", () => {
    const row = /<tr[^>]*data-stick="s1">(.*?)<\/tr>/.exec(html)?.[1] ?? '';
    const cells = row.match(/<td>.*?<\/td>(?=<td>|$)/g) ?? [];
    expect(cells).toHaveLength(7);
    expect(cells.at(-1)).toContain('data-remove="/api/control/sticks/s1/remove"');
    expect(confirmBox?.[0]).toMatch(/^<div class="confirm" role="alertdialog" hidden/);
    expect(askHtml.startsWith(escapeHtml('Remove the stick vps-1?'))).toBe(true);
    expect(html).not.toContain('confirm(');
  });

  test('in a vm: Remove shows the confirmation naming the stick, and posts only once it is confirmed', async () => {
    expect(html).toContain(`<script>${STICKS_JS}</script>`);
    const src = STICKS_JS;
    const clicks: ((e: unknown) => Promise<void>)[] = [];
    const posts: string[] = [];
    let reloads = 0;
    const out = { textContent: '' };
    const box = { hidden: true, textContent: askHtml, querySelector: () => yes };
    const button = (dataset: Record<string, string>) => {
      const b = {
        dataset,
        disabled: false,
        focus: () => {},
        closest: (sel: string) => (sel === 'td' ? td : b),
      };
      return b;
    };
    const remove = button({ remove: '/api/control/sticks/s1/remove' });
    const yes = button({ confirm: '/api/control/sticks/s1/remove' });
    const keep = button({ keep: '' });
    const td = {
      querySelector: (sel: string) =>
        sel === '.confirm'
          ? box
          : sel === 'output'
            ? out
            : sel === 'button[data-confirm]'
              ? yes
              : null,
    };
    vm.runInNewContext(src, {
      document: {
        addEventListener: (ev: string, fn: (e: unknown) => Promise<void>) => {
          if (ev === 'click') clicks.push(fn);
        },
        getElementById: () => null,
        querySelector: () => null,
      },
      jmFetch: async (path: string) => {
        posts.push(path);
        return { ok: true, status: 200 };
      },
      location: { reload: () => void reloads++, pathname: '/system/sticks' },
      confirm: () => {
        throw new Error('confirm() must not be used');
      },
      setTimeout,
    });
    const click = async (target: unknown) => {
      for (const fn of clicks) await fn({ target });
    };
    await click(remove);
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('vps-1');
    expect(posts).toEqual([]);
    await click(keep);
    expect(box.hidden).toBe(true);
    expect(posts).toEqual([]);
    await click(remove);
    await click(yes);
    expect(posts).toEqual(['/api/control/sticks/s1/remove']);
    expect(reloads).toBe(1);
  });

  describe('in a vm: the poll leaves the table alone while a confirmation is open', () => {
    const src = STICKS_JS;
    // One poll tick: `openBefore` is the confirmation's state when the timer fires, `openDuring`
    // its state once the fetch has answered.
    const tick = async (openBefore: boolean, openDuring: boolean) => {
      let open = openBefore;
      const timers: (() => Promise<void>)[] = [];
      let fetches = 0;
      let replaced = 0;
      const cur = { replaceWith: () => void replaced++ };
      vm.runInNewContext(src, {
        document: {
          addEventListener: () => {},
          getElementById: (id: string) => (id === 'sticks-live' ? cur : null),
          querySelector: (sel: string) =>
            sel === '#sticks-live [data-poll]'
              ? {}
              : sel === '#sticks-live .confirm:not([hidden])'
                ? open
                  ? {}
                  : null
                : null,
        },
        fetch: async () => {
          fetches++;
          open = openDuring;
          return { ok: true, text: async () => '<div id="sticks-live"></div>' };
        },
        DOMParser: class {
          parseFromString() {
            return { getElementById: () => ({}) };
          }
        },
        location: { pathname: '/system/sticks' },
        setTimeout: (fn: () => Promise<void>) => void timers.push(fn),
      });
      await timers[0]?.();
      return { fetches, replaced };
    };

    test('closed throughout: the table is replaced', async () => {
      expect(await tick(false, false)).toEqual({ fetches: 1, replaced: 1 });
    });

    test('open when the timer fires: no fetch', async () => {
      expect(await tick(true, true)).toEqual({ fetches: 0, replaced: 0 });
    });

    test('opened while the fetch is in flight: the answer is dropped', async () => {
      expect(await tick(false, true)).toEqual({ fetches: 1, replaced: 0 });
    });
  });
});

describe('Add a stick: how it will be installed (issue #269)', () => {
  test('the form asks "How will you install it?": Paste a line (the default) or Cloud-init user data', () => {
    const html = renderSticks({
      sticks: [],
      zones: [],
      now: t0,
      publicUrl: 'https://jm.example',
    });
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

  const base = {
    name: 'vps-1',
    slots: null,
    expiresAt: '2026-01-01T01:00:00.000Z',
  };

  test('a line invite: the result page holds the line only, 24 hours', () => {
    const html = renderInviteResult({
      ...base,
      kind: 'line',
      line: 'curl LINE | sudo sh -s -- c',
    });
    expect(html).toContain('id="install-line"');
    expect(html).toContain('curl LINE');
    expect(html).toContain('(24 hours)');
    expect(html).not.toContain('id="cloud-init"');
    expect(html).not.toContain('role="tab"');
  });

  test('#628: the result page carries the one breadcrumb, System › Sticks › Add a stick, and no Back link', () => {
    const html = renderInviteResult({ ...base, kind: 'line', line: 'curl LINE' });
    expect(html.match(/<nav class="crumbs" aria-label="Breadcrumb">/g)).toHaveLength(1);
    expect(html).toContain(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/system">System</a></li><li><a href="/system/sticks">Sticks</a></li><li><span aria-current="page">Add a stick</span></li></ol></nav>',
    );
    expect(html).not.toMatch(/<a [^>]*>[^<]*Back[^<]*<\/a>/);
  });

  test('a cloud-init invite: the result page holds the cloud-config only, 1 hour', () => {
    const html = renderInviteResult({
      ...base,
      kind: 'cloud_init',
      cloudInit: '#cloud-config\n',
    });
    expect(html).toContain('id="cloud-init"');
    expect(html).toContain('#cloud-config');
    expect(html).toContain('(1 hour)');
    expect(html).not.toContain('id="install-line"');
    expect(html).not.toContain('role="tab"');
  });
});
