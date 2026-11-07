import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { listArtifacts, storeArtifact } from './artifacts.js';
import { harness, toPrOpen } from './test/flowHarness.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rule = { name: 'ui', paths: ['web/**'], run: 'x', artifacts: 'shots/**', timeoutMinutes: 5 };
const upload = (epoch: number, over: Record<string, unknown> = {}) => ({
  epoch,
  rule: 'ui',
  name: 'shots/a.png',
  mediaType: 'image/png',
  sha256: sha(PNG),
  dataBase64: PNG.toString('base64'),
  ...over,
});

async function reviewing(zone = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jm-art-'));
  const h = await harness({ zone: { verification: [rule], ...zone }, dataDir });
  await toPrOpen(h, 'sha1');
  await h.reconcile();
  const { dropId, epoch } = await h.lease();
  const post = (body: unknown, headers = h.stickHeaders()) =>
    h.app.inject({
      method: 'POST',
      url: `/api/drops/${dropId}/artifacts`,
      headers,
      payload: body as object,
    });
  return { h, dropId, epoch, post, dataDir };
}

const gateOk = { name: 'test', exitCode: 0, durationMs: 1, timedOut: false, outputTail: '' };
const approved = {
  status: 'completed' as const,
  verdict: { decision: 'approve' as const, summary: 'ok', findings: [] },
  gates: [gateOk],
};

describe('artifact storage', () => {
  test('a hostile name cannot escape the artifact directory', async () => {
    const { h, dropId, dataDir } = await reviewing();
    const row = storeArtifact(h.db, dataDir, dropId, {
      rule: 'ui',
      name: '../../../etc/passwd',
      mediaType: 'image/png',
      bytes: PNG,
    });
    expect(readdirSync(join(dataDir, 'artifacts', dropId))).toEqual([`${row.sha256}.png`]);
    expect(existsSync(join(dataDir, 'etc'))).toBe(false);
  });

  test('a disallowed media type or oversized file is refused', async () => {
    const { h, dropId, dataDir } = await reviewing();
    const base = { rule: 'ui', name: 'a', bytes: PNG };
    expect(() =>
      storeArtifact(h.db, dataDir, dropId, { ...base, mediaType: 'image/svg+xml' }),
    ).toThrow(/media type/);
    expect(() =>
      storeArtifact(h.db, dataDir, dropId, {
        ...base,
        mediaType: 'image/png',
        bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
      }),
    ).toThrow(/too large/);
  });
});

describe('artifact routes', () => {
  test('a valid upload is stored; a 5 MB file fits the body limit', async () => {
    const { h, dropId, epoch, post } = await reviewing();
    expect((await post(upload(epoch))).statusCode).toBe(204);
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 - PNG.length)]);
    const res = await post(
      upload(epoch, { name: 'big.png', sha256: sha(big), dataBase64: big.toString('base64') }),
    );
    expect(res.statusCode).toBe(204);
    expect(listArtifacts(h.db, dropId)).toHaveLength(2);
  });

  test('an upload with a stale epoch or wrong stick is refused', async () => {
    const { h, dropId, epoch, post } = await reviewing();
    expect((await post(upload(epoch + 1))).statusCode).toBe(409);
    const stranger = await h.app.inject({
      method: 'POST',
      url: '/api/sticks/enroll',
      headers: { 'x-jumpmaster-protocol': '1' },
      payload: { joinToken: 'join', name: 'other', slots: 1 },
    });
    const token = stranger.json().stickToken as string;
    const res = await post(upload(epoch), {
      'x-jumpmaster-protocol': '1',
      authorization: `Bearer ${token}`,
    });
    expect(res.statusCode).toBe(409);
    expect(listArtifacts(h.db, dropId)).toEqual([]);
  });

  test('a corrupt upload is refused', async () => {
    const { h, dropId, epoch, post } = await reviewing();
    expect((await post(upload(epoch, { sha256: 'f'.repeat(64) }))).statusCode).toBe(400);
    expect(listArtifacts(h.db, dropId)).toEqual([]);
  });

  test('artifacts are served with nosniff and a sandbox CSP', async () => {
    const { h, dropId, epoch, post } = await reviewing();
    await post(upload(epoch));
    const [row] = listArtifacts(h.db, dropId);
    const res = await h.app.inject({ method: 'GET', url: `/artifacts/${row?.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect((await h.app.inject({ method: 'GET', url: '/artifacts/999' })).statusCode).toBe(404);
  });
});

describe('the drop page', () => {
  test('links stored artifacts, with their names escaped', async () => {
    const { h, dropId, epoch, post } = await reviewing();
    await post(upload(epoch, { name: '<b>a</b>.png' }));
    const [row] = listArtifacts(h.db, dropId);
    const res = await h.app.inject({ method: 'GET', url: `/drops/${dropId}` });
    expect(res.body).toContain(`href="/artifacts/${row?.id}"`);
    expect(res.body).toContain('&lt;b&gt;a');
  });
});

describe('the server checks for itself', () => {
  const touchWeb = (h: Awaited<ReturnType<typeof harness>>) => {
    const pr = [...h.forge.state.pulls.values()][0];
    h.forge.state.pullFiles.set(pr?.number ?? 0, {
      files: [{ path: 'web/a.tsx' }],
      complete: true,
    });
  };

  test('an approve with no stored artifact for a matching PR becomes request_changes', async () => {
    const { h, dropId, epoch } = await reviewing();
    touchWeb(h);
    await h.postResult(dropId, epoch, approved);
    const v = h.db.prepare('SELECT decision, forced FROM verdicts').get();
    expect(v).toEqual({ decision: 'request_changes', forced: 1 });
    expect(h.forge.state.reviews[0]?.state).toBe('CHANGES_REQUESTED');
    expect(h.forge.state.reviews[0]?.body).toMatch(/verification ui/);
  });

  test('an approve with its artifact stands', async () => {
    const { h, dropId, epoch, post } = await reviewing();
    touchWeb(h);
    await post(upload(epoch));
    await h.postResult(dropId, epoch, approved);
    expect(h.forge.state.reviews[0]?.state).toBe('APPROVED');
  });

  test('a PR outside the rule needs no artifact', async () => {
    const { h, dropId, epoch } = await reviewing();
    await h.postResult(dropId, epoch, approved);
    expect(h.forge.state.reviews[0]?.state).toBe('APPROVED');
  });

  test('an unreadable file list fails closed', async () => {
    const { h, dropId, epoch } = await reviewing();
    h.forge.author.listPullFiles = async () => {
      throw new Error('boom');
    };
    await h.postResult(dropId, epoch, approved);
    expect(h.forge.state.reviews[0]?.state).toBe('CHANGES_REQUESTED');
  });
});
