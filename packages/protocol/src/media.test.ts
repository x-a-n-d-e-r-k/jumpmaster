import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DropPayloadSchema } from './index.js';
import { MAX_TRIAGE_IMAGE_BYTES, sniffMediaType, TriageImageSchema, triageImage } from './media.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR....'),
]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('sniffMediaType', () => {
  test('goes by content', () => {
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffMediaType(Buffer.from('GIF87a....'))).toBe('image/gif');
    expect(sniffMediaType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffMediaType(Buffer.from('{"a":1}'))).toBe('application/json');
  });

  test('refuses SVG and anything else', () => {
    expect(sniffMediaType(Buffer.from('<svg onload=x>'))).toBeNull();
    expect(sniffMediaType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffMediaType(Buffer.from('GIF90a'))).toBeNull();
    expect(sniffMediaType(Buffer.from('{broken'))).toBeNull();
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });
});

describe('TriageImageSchema', () => {
  test('accepts an image whose sha256 and type match its bytes', () => {
    const img = triageImage(PNG, 'image/png');
    expect(img.sha256).toBe(sha(PNG));
    expect(TriageImageSchema.safeParse(img).success).toBe(true);
  });

  test('rejects a mismatched sha256', () => {
    const img = { ...triageImage(PNG, 'image/png'), sha256: sha(Buffer.from('other')) };
    const r = TriageImageSchema.safeParse(img);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('sha256');
  });

  test('rejects a 3 MiB + 1 byte decoded image', () => {
    const big = Buffer.alloc(MAX_TRIAGE_IMAGE_BYTES + 1);
    PNG.copy(big);
    expect(TriageImageSchema.safeParse(triageImage(big, 'image/png')).success).toBe(false);
    // Exactly 3 MiB is allowed.
    const max = big.subarray(0, MAX_TRIAGE_IMAGE_BYTES);
    expect(TriageImageSchema.safeParse(triageImage(max, 'image/png')).success).toBe(true);
  });

  test('rejects a mediaType the bytes are not, SVG, and non-canonical base64', () => {
    expect(TriageImageSchema.safeParse(triageImage(PNG, 'image/jpeg')).success).toBe(false);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(TriageImageSchema.safeParse(triageImage(svg, 'image/png')).success).toBe(false);
    const img = triageImage(PNG, 'image/png');
    expect(TriageImageSchema.safeParse({ ...img, base64: `${img.base64}\n` }).success).toBe(false);
    expect(TriageImageSchema.safeParse({ ...img, mediaType: 'image/svg+xml' }).success).toBe(false);
  });
});

describe('the triage payload', () => {
  const triage = {
    protocol: 1,
    dropId: 'd',
    epoch: 1,
    role: 'triage',
    repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
    model: 'm',
    maxTurns: 10,
    promptVersion: 'v',
    prompt: 'p',
    image: 'img',
    protectedPaths: [],
    credentials: { claudeToken: 't' },
  };

  test('carries checked images and skip reasons', () => {
    const images = [triageImage(PNG, 'image/png')];
    const r = DropPayloadSchema.safeParse({
      ...triage,
      images,
      imagesSkipped: [{ reason: 'host not allowed' }],
    });
    expect(r.success).toBe(true);
    expect(DropPayloadSchema.safeParse(triage).success).toBe(true);
  });

  test('refuses a bad image, more than 4, and images on another crew role', () => {
    const bad = { ...triageImage(PNG, 'image/png'), sha256: '0'.repeat(64) };
    expect(DropPayloadSchema.safeParse({ ...triage, images: [bad] }).success).toBe(false);
    const five = Array.from({ length: 5 }, () => triageImage(PNG, 'image/png'));
    expect(DropPayloadSchema.safeParse({ ...triage, images: five }).success).toBe(false);
    const images = [triageImage(PNG, 'image/png')];
    expect(DropPayloadSchema.safeParse({ ...triage, role: 'refute', images }).success).toBe(false);
  });
});
