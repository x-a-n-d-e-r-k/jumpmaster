import { createHash } from 'node:crypto';
import { MAX_TRIAGE_IMAGE_BYTES, sniffMediaType, TriageImageSchema } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { fetchIssueImages, type ImageFetch, imageUrls } from './images.js';

const TOKEN = 'ghs_' + 'READTOKEN1234567890';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-png-body'),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x"/>');
const GH = (id: string) => `https://github.com/user-attachments/assets/${id}`;
const CDN = (id: string) => `https://private-user-images.githubusercontent.com/1/${id}.png?jwt=x`;

type Call = { url: string; headers: Record<string, string> };
type Handler = (init: { signal: AbortSignal }) => Response | Promise<Response>;

/** A local HTTPS-shaped fetch: a map of URL to response, recording every request it is asked for. */
function fakeFetch(routes: Record<string, Handler>): { fetch: ImageFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: ImageFetch = async (url, init) => {
    expect(init.redirect).toBe('manual');
    calls.push({ url, headers: { ...init.headers } });
    const h = routes[url];
    if (!h) return new Response('not found', { status: 404 });
    return h(init);
  };
  return { fetch, calls };
}

const ok =
  (b: Buffer, type = 'image/png'): Handler =>
  () =>
    new Response(new Uint8Array(b), { status: 200, headers: { 'content-type': type } });
const redirect =
  (to: string): Handler =>
  () =>
    new Response(null, { status: 302, headers: { location: to } });

/** A body of `total` bytes starting with a PNG header, counting what is read from it. */
function counted(total: number, chunk = 64 * 1024) {
  const seen = { read: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (seen.read >= total) return c.close();
        const n = Math.min(chunk, total - seen.read);
        const part = new Uint8Array(n);
        if (seen.read === 0) part.set(PNG.subarray(0, Math.min(n, PNG.length)));
        seen.read += n;
        c.enqueue(part);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const handler: Handler = () => new Response(body, { status: 200 });
  return { seen, handler };
}

const md = (...urls: string[]) => urls.map((u, i) => `![shot ${i}](${u})`).join('\n');

describe('imageUrls', () => {
  test('finds Markdown and HTML images, in body order', () => {
    const body = [
      'text',
      `<img width="300" alt="x" src="${GH('b')}">`,
      `![a](${GH('a')} "title")`,
      `<IMG SRC='${CDN('c')}' />`,
      '[a link, not an image](https://github.com/user-attachments/assets/d)',
    ].join('\n');
    expect(imageUrls(body)).toEqual([GH('b'), GH('a'), CDN('c')]);
  });

  test('decodes each entity in an <img src> exactly once (D4)', () => {
    const base = 'https://github.com/user-attachments/assets/x';
    expect(imageUrls(`<img src="${base}?a=&amp;quot;b">`)).toEqual([`${base}?a=&quot;b`]);
    expect(imageUrls(`<img src="${base}?a=&amp;#39;b">`)).toEqual([`${base}?a=&#39;b`]);
    expect(imageUrls(`<img src="${base}?a=1&amp;b=2">`)).toEqual([`${base}?a=1&b=2`]);
    expect(imageUrls(`<img src="${base}?a=&#39;b">`)).toEqual([`${base}?a='b`]);
    expect(imageUrls(`<img src='${base}?a=&quot;b'>`)).toEqual([`${base}?a="b`]);
  });
});

describe('fetchIssueImages', () => {
  test('#179: one PNG fetched with the token on github.com', async () => {
    const f = fakeFetch({ [GH('179')]: ok(PNG) });
    const r = await fetchIssueImages(`Overage Included:\n\n${md(GH('179'))}`, {
      fetch: f.fetch,
      token: TOKEN,
    });
    expect(r.imagesSkipped).toEqual([]);
    expect(r.images).toHaveLength(1);
    const [img] = r.images;
    expect(img).toMatchObject({
      mediaType: 'image/png',
      sha256: createHash('sha256').update(PNG).digest('hex'),
      base64: PNG.toString('base64'),
    });
    expect(TriageImageSchema.safeParse(img).success).toBe(true);
    expect(f.calls).toEqual([{ url: GH('179'), headers: { authorization: `Bearer ${TOKEN}` } }]);
  });

  test('host allow-list: only the real hosts (and that path on github.com) are fetched (D4)', async () => {
    const urls = [
      GH('ok'),
      'https://user-images.githubusercontent.com/1/a.png',
      'https://evil.example/a.png',
      'https://github.com.evil.example/user-attachments/assets/x',
      'https://github.com@evil.example/user-attachments/assets/x',
      'https://github.com/o/r/blob/main/a.png',
      'http://github.com/user-attachments/assets/plain',
      'https://user:pw@github.com/user-attachments/assets/userinfo',
      'https://github.com:8443/user-attachments/assets/port',
      'https://raw.githubusercontent.com/o/r/main/a.png',
    ];
    const routes: Record<string, Handler> = {};
    for (const u of urls) routes[u] = ok(PNG);
    // Each URL in its own request, so the cap of 4 never hides one.
    for (const u of urls) {
      const f = fakeFetch(routes);
      const r = await fetchIssueImages(md(u), { fetch: f.fetch, token: TOKEN });
      const allowed = u === urls[0] || u === urls[1];
      expect(f.calls.map((c) => c.url)).toEqual(allowed ? [u] : []);
      expect(r.images).toHaveLength(allowed ? 1 : 0);
      expect(r.imagesSkipped).toEqual(allowed ? [] : [{ reason: 'host not allowed' }]);
    }
  });

  test('token: on github.com, never on a redirect, never on another host (D1)', async () => {
    const f = fakeFetch({
      [GH('r')]: redirect(CDN('r')),
      [CDN('r')]: ok(PNG),
      'https://user-images.githubusercontent.com/1/u.png': ok(PNG),
    });
    const r = await fetchIssueImages(
      md(GH('r'), 'https://user-images.githubusercontent.com/1/u.png', 'https://evil.example/a'),
      { fetch: f.fetch, token: TOKEN },
    );
    expect(r.images).toHaveLength(2);
    expect(r.imagesSkipped).toEqual([{ reason: 'host not allowed' }]);
    expect(f.calls).toEqual([
      { url: GH('r'), headers: { authorization: `Bearer ${TOKEN}` } },
      { url: CDN('r'), headers: {} },
      { url: 'https://user-images.githubusercontent.com/1/u.png', headers: {} },
    ]);
    expect(JSON.stringify(f.calls.slice(1))).not.toContain(TOKEN);
  });

  test('a redirect to a host outside the list is not followed, and the token never reaches it', async () => {
    const f = fakeFetch({
      [GH('a')]: redirect('https://evil.example/'),
      [GH('b')]: redirect('https://github.com/user-attachments/assets/again'),
      [GH('c')]: redirect('http://user-images.githubusercontent.com/1/plain.png'),
      'https://evil.example/': ok(PNG),
    });
    const r = await fetchIssueImages(md(GH('a'), GH('b'), GH('c')), {
      fetch: f.fetch,
      token: TOKEN,
    });
    expect(r.images).toEqual([]);
    expect(r.imagesSkipped).toEqual([
      { reason: 'redirect host not allowed' },
      { reason: 'redirect host not allowed' },
      { reason: 'redirect host not allowed' },
    ]);
    expect(f.calls.map((c) => c.url)).toEqual([GH('a'), GH('b'), GH('c')]);
  });

  test('at most 3 redirects', async () => {
    const hop = (n: number) => `https://user-images.githubusercontent.com/hop/${n}`;
    const routes: Record<string, Handler> = { [GH('h')]: redirect(hop(1)) };
    for (let n = 1; n <= 4; n++) routes[hop(n)] = redirect(hop(n + 1));
    routes[hop(3)] = ok(PNG);
    const three = fakeFetch(routes);
    expect((await fetchIssueImages(md(GH('h')), { fetch: three.fetch })).images).toHaveLength(1);
    routes[hop(3)] = redirect(hop(4));
    routes[hop(4)] = ok(PNG);
    const four = fakeFetch(routes);
    const r = await fetchIssueImages(md(GH('h')), { fetch: four.fetch });
    expect(r.imagesSkipped).toEqual([{ reason: 'too many redirects' }]);
    expect(four.calls).toHaveLength(4);
  });

  test('a 3 MiB + 1 byte stream is aborted at the cap, never read far past it', async () => {
    const big = counted(MAX_TRIAGE_IMAGE_BYTES + 1 + 10 * 64 * 1024);
    const f = fakeFetch({ [GH('big')]: big.handler, [GH('fine')]: ok(PNG) });
    const r = await fetchIssueImages(md(GH('big'), GH('fine')), { fetch: f.fetch });
    expect(r.imagesSkipped).toEqual([{ reason: 'over 3 MiB' }]);
    expect(r.images).toHaveLength(1);
    expect(big.seen.read).toBeLessThanOrEqual(MAX_TRIAGE_IMAGE_BYTES + 64 * 1024);
    expect(big.seen.cancelled).toBe(true);
  });

  test('exactly 3 MiB + 1 byte is refused, exactly 3 MiB is kept', async () => {
    const over = counted(MAX_TRIAGE_IMAGE_BYTES + 1);
    const at = counted(MAX_TRIAGE_IMAGE_BYTES);
    const f = fakeFetch({ [GH('over')]: over.handler, [GH('at')]: at.handler });
    const r = await fetchIssueImages(md(GH('over'), GH('at')), { fetch: f.fetch });
    expect(r.imagesSkipped).toEqual([{ reason: 'over 3 MiB' }]);
    expect(r.images).toHaveLength(1);
  });

  test('a declared content-length over the cap is refused without reading the body', async () => {
    const body = counted(MAX_TRIAGE_IMAGE_BYTES + 1);
    const f = fakeFetch({
      [GH('cl')]: async () => {
        const r = await body.handler({ signal: new AbortController().signal });
        return new Response(r.body, {
          status: 200,
          headers: { 'content-length': String(MAX_TRIAGE_IMAGE_BYTES + 1) },
        });
      },
    });
    const r = await fetchIssueImages(md(GH('cl')), { fetch: f.fetch });
    expect(r.imagesSkipped).toEqual([{ reason: 'over 3 MiB' }]);
    expect(body.seen.read).toBe(0);
  });

  test('a total over 8 MiB across 4 images skips the 4th', async () => {
    const size = Math.floor(2.5 * 1024 * 1024);
    const streams = [1, 2, 3, 4].map(() => counted(size));
    const routes: Record<string, Handler> = {};
    streams.forEach((s, i) => {
      routes[GH(`t${i}`)] = s.handler;
    });
    const f = fakeFetch(routes);
    const r = await fetchIssueImages(md(...[0, 1, 2, 3].map((i) => GH(`t${i}`))), {
      fetch: f.fetch,
    });
    expect(r.images).toHaveLength(3);
    expect(r.imagesSkipped).toEqual([{ reason: 'over 8 MiB in all' }]);
    // The 4th is cut once the running total passes 8 MiB, not read to its end.
    expect(streams[3]?.seen.read).toBeLessThan(size);
    expect(streams[3]?.seen.cancelled).toBe(true);
  });

  test('type is decided by content: SVG served as image/png and mislabeled text are refused', async () => {
    const f = fakeFetch({
      [GH('svg')]: ok(SVG, 'image/png'),
      [GH('json')]: ok(Buffer.from('{"a":1}'), 'image/png'),
      [GH('gif')]: ok(Buffer.from('GIF89a-gif-body'), 'application/octet-stream'),
    });
    const r = await fetchIssueImages(md(GH('svg'), GH('json'), GH('gif')), { fetch: f.fetch });
    expect(r.imagesSkipped).toEqual([
      { reason: 'not an allowed image type' },
      { reason: 'not an allowed image type' },
    ]);
    expect(r.images.map((i) => i.mediaType)).toEqual(['image/gif']);
  });

  test('a fetch that throws, times out, or answers an error status is skipped and counted (D2)', async () => {
    const f = fakeFetch({
      [GH('throw')]: () => {
        throw new TypeError('fetch failed');
      },
      [GH('hang')]: ({ signal }) =>
        new Promise<Response>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
      [GH('slow-body')]: ({ signal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(PNG));
              signal.addEventListener('abort', () => c.error(signal.reason));
            },
          }),
        ),
      [GH('fine')]: ok(PNG),
    });
    const r = await fetchIssueImages(md(GH('throw'), GH('hang'), GH('slow-body'), GH('gone')), {
      fetch: f.fetch,
      timeoutMs: 20,
    });
    expect(r.images).toEqual([]);
    expect(r.imagesSkipped).toEqual([
      { reason: 'fetch failed' },
      { reason: 'timed out' },
      { reason: 'timed out' },
      { reason: 'status 404' },
    ]);
  });

  test('5 images: 4 fetched, the 5th ignored and counted', async () => {
    const routes: Record<string, Handler> = {};
    for (let i = 0; i < 5; i++) routes[GH(`n${i}`)] = ok(PNG);
    const f = fakeFetch(routes);
    const r = await fetchIssueImages(md(...[0, 1, 2, 3, 4].map((i) => GH(`n${i}`))), {
      fetch: f.fetch,
    });
    expect(f.calls.map((c) => c.url)).toEqual([0, 1, 2, 3].map((i) => GH(`n${i}`)));
    expect(r.images).toHaveLength(4);
    expect(r.imagesSkipped).toEqual([{ reason: 'more than 4 images' }]);
  });

  test('no token: nothing is sent as authorization', async () => {
    const f = fakeFetch({ [GH('x')]: ok(PNG) });
    await fetchIssueImages(md(GH('x')), { fetch: f.fetch });
    expect(f.calls[0]?.headers).toEqual({});
  });

  test('the server and the protocol classify the same bytes the same way (D5)', async () => {
    const f = fakeFetch({ [GH('p')]: ok(PNG) });
    const [img] = (await fetchIssueImages(md(GH('p')), { fetch: f.fetch })).images;
    expect(img?.mediaType).toBe(sniffMediaType(PNG));
  });
});
