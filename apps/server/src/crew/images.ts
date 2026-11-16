import {
  isImageMediaType,
  MAX_TRIAGE_IMAGE_BYTES,
  MAX_TRIAGE_IMAGES,
  MAX_TRIAGE_IMAGES_SKIPPED,
  MAX_TRIAGE_IMAGES_TOTAL_BYTES,
  sniffMediaType,
  type TriageImage,
  type TriageImageSkipped,
  triageImage,
} from '@jumpmaster/protocol';

/**
 * The fetch the server uses for issue images: never follows a redirect itself, so each hop is
 * checked here. `globalThis.fetch` fits.
 */
export type ImageFetch = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
  },
) => Promise<Response>;

export type ImageFetchOpts = {
  fetch: ImageFetch;
  /** The zone's read token: sent to `github.com` only, never across a redirect. */
  token?: string;
  /** Per image, redirects and body included. */
  timeoutMs?: number;
};

export type IssueImages = { images: TriageImage[]; imagesSkipped: TriageImageSkipped[] };

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
/** The attachment hosts a redirect may lead to. */
const CDN_HOSTS = new Set([
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
]);

/** HTTPS on the default port, with no userinfo: the only URLs ever requested. */
function parseHttps(raw: string, base?: string): URL | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

/** An image URL the issue may point at: a GitHub attachment, or a GitHub user-images CDN URL. */
function allowedImageUrl(raw: string): URL | null {
  const u = parseHttps(raw);
  if (!u) return null;
  if (u.hostname === 'github.com') {
    return u.pathname.startsWith('/user-attachments/assets/') ? u : null;
  }
  return CDN_HOSTS.has(u.hostname) ? u : null;
}

const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\(\s*<?([^\s)>]+)/g;
const HTML_IMAGE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** The image URLs in an issue body, Markdown `![](…)` and HTML `<img src>`, in body order. */
export function imageUrls(body: string): string[] {
  const found: { at: number; url: string }[] = [];
  for (const m of body.matchAll(MARKDOWN_IMAGE)) {
    if (m[1]) found.push({ at: m.index, url: m[1] });
  }
  for (const m of body.matchAll(HTML_IMAGE)) {
    const url = m[1] ?? m[2] ?? m[3];
    if (url) found.push({ at: m.index, url: decodeEntities(url.trim()) });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.url);
}

/** A skip with a short, fixed reason: never the URL, the error text or anything fetched. */
class Skip extends Error {}

/** Reads at most `cap` bytes; one byte more cancels the stream and skips with `reason`. */
async function readCapped(res: Response, cap: number, reason: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new Skip(reason);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Skip(reason);
    }
    parts.push(value);
  }
  return Buffer.concat(parts, total);
}

async function fetchOne(start: URL, o: ImageFetchOpts, room: number): Promise<TriageImage> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Skip('timed out')), o.timeoutMs ?? TIMEOUT_MS);
  try {
    let url = start;
    for (let hops = 0; ; hops++) {
      // The token only on the first request, and only to github.com: never across a redirect.
      const headers: Record<string, string> =
        hops === 0 && url.hostname === 'github.com' && o.token
          ? { authorization: `Bearer ${o.token}` }
          : {};
      let res: Response;
      try {
        res = await o.fetch(url.href, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: ac.signal,
        });
      } catch {
        throw new Skip(ac.signal.aborted ? 'timed out' : 'fetch failed');
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        if (hops >= MAX_REDIRECTS) throw new Skip('too many redirects');
        const next = parseHttps(res.headers.get('location') ?? '', url.href);
        if (!next || !CDN_HOSTS.has(next.hostname)) throw new Skip('redirect host not allowed');
        url = next;
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw new Skip(`status ${res.status}`);
      }
      const perImage = room < MAX_TRIAGE_IMAGE_BYTES;
      let bytes: Buffer;
      try {
        bytes = await readCapped(
          res,
          Math.min(MAX_TRIAGE_IMAGE_BYTES, room),
          perImage ? 'over 8 MiB in all' : 'over 3 MiB',
        );
      } catch (e) {
        if (e instanceof Skip) throw e;
        throw new Skip(ac.signal.aborted ? 'timed out' : 'fetch failed');
      }
      const mediaType = sniffMediaType(bytes);
      if (!isImageMediaType(mediaType)) throw new Skip('not an allowed image type');
      return triageImage(bytes, mediaType);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The issue's images, fetched and checked for a triage drop. Only GitHub attachment URLs are
 * fetched (`github.com/user-attachments/assets/…`, or the user-images CDN hosts), at most
 * `MAX_TRIAGE_IMAGES` in body order, over HTTPS with redirects only to the CDN hosts. Each image is
 * at most 3 MiB and 8 MiB in all, read with a running cap, and its type is decided by content. Any
 * failure skips that image with a short reason; it never fails the whole.
 */
export async function fetchIssueImages(body: string, o: ImageFetchOpts): Promise<IssueImages> {
  const images: TriageImage[] = [];
  const imagesSkipped: TriageImageSkipped[] = [];
  const skip = (reason: string) => {
    if (imagesSkipped.length < MAX_TRIAGE_IMAGES_SKIPPED) imagesSkipped.push({ reason });
  };
  let total = 0;
  let tried = 0;
  for (const raw of new Set(imageUrls(body))) {
    const url = allowedImageUrl(raw);
    if (!url) {
      skip('host not allowed');
      continue;
    }
    if (tried >= MAX_TRIAGE_IMAGES) {
      skip(`more than ${MAX_TRIAGE_IMAGES} images`);
      continue;
    }
    tried++;
    try {
      const img = await fetchOne(url, o, MAX_TRIAGE_IMAGES_TOTAL_BYTES - total);
      total += Buffer.byteLength(img.base64, 'base64');
      images.push(img);
    } catch (e) {
      skip(e instanceof Skip ? e.message : 'fetch failed');
    }
  }
  return { images, imagesSkipped };
}
