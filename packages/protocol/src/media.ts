import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The image types an issue image may be: decided by content, never by a header or extension. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export const isImageMediaType = (t: string | null): t is ImageMediaType =>
  (IMAGE_MEDIA_TYPES as readonly (string | null)[]).includes(t);

/** The file extension for each type `sniffMediaType` can return. */
export const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/json': 'json',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * The media type by content; an extension or a `content-type` proves nothing. PNG, JPEG, GIF and
 * WebP by their magic bytes, or a JSON object or array. Null for anything else, SVG included. One
 * function for the server and the trooper, so both sides classify the same bytes the same way.
 */
export function sniffMediaType(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (b.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg';
  const head = b.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  try {
    const parsed: unknown = JSON.parse(b.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? 'application/json' : null;
  } catch {
    return null;
  }
}

/** The most images a triage drop carries. */
export const MAX_TRIAGE_IMAGES = 4;
/** The most one triage image may weigh, decoded. */
export const MAX_TRIAGE_IMAGE_BYTES = 3 * 1024 * 1024;
/** The most a triage drop's images may weigh together, decoded. */
export const MAX_TRIAGE_IMAGES_TOTAL_BYTES = 8 * 1024 * 1024;
/** The most skipped-image entries a triage drop carries. */
export const MAX_TRIAGE_IMAGES_SKIPPED = 100;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_BASE64_CHARS = Math.ceil(MAX_TRIAGE_IMAGE_BYTES / 3) * 4;

/**
 * One issue image the server fetched and checked. The schema checks it again: canonical base64,
 * at most `MAX_TRIAGE_IMAGE_BYTES` decoded, `sha256` over the decoded bytes, and a `mediaType`
 * that is what the bytes are.
 */
export const TriageImageSchema = z
  .strictObject({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    mediaType: z.enum(IMAGE_MEDIA_TYPES),
    base64: z.string(),
  })
  .superRefine((v, ctx) => {
    // Length first: nothing past the cap is ever decoded.
    if (v.base64.length > MAX_BASE64_CHARS || !BASE64.test(v.base64)) {
      ctx.addIssue({ code: 'custom', path: ['base64'], message: 'not base64 of at most 3 MiB' });
      return;
    }
    const bytes = Buffer.from(v.base64, 'base64');
    // Canonical only: the bytes must encode back to exactly this text.
    if (bytes.toString('base64') !== v.base64) {
      ctx.addIssue({ code: 'custom', path: ['base64'], message: 'not canonical base64' });
      return;
    }
    if (bytes.length > MAX_TRIAGE_IMAGE_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['base64'], message: 'over 3 MiB decoded' });
      return;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== v.sha256) {
      ctx.addIssue({ code: 'custom', path: ['sha256'], message: 'does not match the bytes' });
    }
    if (sniffMediaType(bytes) !== v.mediaType) {
      ctx.addIssue({ code: 'custom', path: ['mediaType'], message: 'does not match the bytes' });
    }
  });
export type TriageImage = z.infer<typeof TriageImageSchema>;

export const TriageImageSkippedSchema = z.strictObject({ reason: z.string().max(200) });
export type TriageImageSkipped = z.infer<typeof TriageImageSkippedSchema>;

/** A triage image as the server builds it from fetched bytes. */
export function triageImage(bytes: Buffer, mediaType: ImageMediaType): TriageImage {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType,
    base64: bytes.toString('base64'),
  };
}
