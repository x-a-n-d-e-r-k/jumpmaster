import { createHash } from 'node:crypto';
import { containsSecret, redact } from '@jumpmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import type { Config } from '../config.js';
import { openDb } from '../db/open.js';
import { upsertDropZone } from '../db/repo.js';
import { sanitizeCrewText, sanitizeForgeText } from '../outbox.js';
import { makeZone } from '../test/fixtures.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import {
  auditRefusedAuth,
  checkMcpToken,
  listMcpTokens,
  MAX_REFUSED_AUTH_ROWS,
  mintMcpToken,
  revokeMcpToken,
  verifyMcpToken,
} from './tokens.js';

const DAY = 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function db() {
  const d = openDb(tmpDbFile());
  upsertDropZone(d, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
  return d;
}

const auditRows = (d: ReturnType<typeof db>) =>
  d
    .prepare(
      'SELECT token_id AS tokenId, zone_id AS zoneId, tool, args_sha256 AS argsSha, outcome, detail FROM mcp_audit ORDER BY id',
    )
    .all() as {
    tokenId: number | null;
    zoneId: string | null;
    tool: string;
    argsSha: string | null;
    outcome: string;
    detail: string;
  }[];

describe('tokens', () => {
  test('a minted token is jmm_ plus 32 random bytes; the database holds only its hash', () => {
    const d = db();
    const { id, token, expiresAt } = mintMcpToken(
      d,
      { zoneId: 'main', scope: 'write', days: 30, label: 'laptop' },
      t0,
    );
    expect(token).toMatch(/^jmm_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
    expect(expiresAt).toBe(plus(t0, 30 * DAY).toISOString());
    const dump = JSON.stringify(d.prepare('SELECT * FROM mcp_tokens').all());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(4));
    expect(dump).toContain(sha256(token));
    expect(JSON.stringify(auditRows(d))).not.toContain(token);
    expect(verifyMcpToken(d, token, t0)).toEqual({ tokenId: id, zoneId: 'main', scope: 'write' });
    expect(mintMcpToken(d, { zoneId: 'main', scope: 'read', days: 1 }, t0).token).not.toBe(token);
  });

  test('days outside 1..90 or an unknown scope are refused', () => {
    const d = db();
    expect(() => mintMcpToken(d, { zoneId: 'main', scope: 'read', days: 0 }, t0)).toThrow(/days/);
    expect(() => mintMcpToken(d, { zoneId: 'main', scope: 'read', days: 91 }, t0)).toThrow(/days/);
    expect(() => mintMcpToken(d, { zoneId: 'main', scope: 'read', days: 1.5 }, t0)).toThrow(/days/);
    expect(() =>
      mintMcpToken(d, { zoneId: 'main', scope: 'admin' as 'read', days: 1 }, t0),
    ).toThrow(/scope/);
  });

  // Red team §7.11: the expiry boundary, and revocation on the next call.
  test('a token is refused at exactly expires_at, and from the call after its revocation', () => {
    const d = db();
    const { id, token } = mintMcpToken(d, { zoneId: 'main', scope: 'read', days: 1 }, t0);
    const exp = plus(t0, DAY);
    expect(verifyMcpToken(d, token, plus(exp, -1))).not.toBeNull();
    expect(verifyMcpToken(d, token, exp)).toBeNull();
    expect(checkMcpToken(d, token, exp)).toEqual({ ok: false, reason: 'expired', tokenId: id });

    const other = mintMcpToken(d, { zoneId: 'main', scope: 'read', days: 1 }, t0);
    expect(verifyMcpToken(d, other.token, t0)).not.toBeNull();
    expect(revokeMcpToken(d, other.id, t0)).toBe(true);
    expect(verifyMcpToken(d, other.token, t0)).toBeNull();
    expect(checkMcpToken(d, other.token, t0)).toEqual({
      ok: false,
      reason: 'revoked',
      tokenId: other.id,
    });
    expect(revokeMcpToken(d, other.id, t0)).toBe(false);
    expect(revokeMcpToken(d, 999, t0)).toBe(false);
    expect(checkMcpToken(d, 'jmm_nope', t0)).toEqual({
      ok: false,
      reason: 'unknown',
      tokenId: null,
    });
    expect(checkMcpToken(d, undefined, t0)).toEqual({
      ok: false,
      reason: 'missing',
      tokenId: null,
    });
  });

  test('mint and revoke are audited; the list carries last use and never the hash', () => {
    const d = db();
    const { id, token } = mintMcpToken(d, { zoneId: 'main', scope: 'write', days: 7 }, t0);
    verifyMcpToken(d, token, plus(t0, 5000));
    revokeMcpToken(d, id, plus(t0, 9000));
    expect(auditRows(d)).toEqual([
      expect.objectContaining({ tokenId: id, zoneId: 'main', tool: 'mint', outcome: 'ok' }),
      expect.objectContaining({ tokenId: id, zoneId: 'main', tool: 'revoke', outcome: 'ok' }),
    ]);
    const list = listMcpTokens(d);
    expect(list).toEqual([
      {
        id,
        zoneId: 'main',
        scope: 'write',
        label: '',
        createdAt: t0.toISOString(),
        expiresAt: plus(t0, 7 * DAY).toISOString(),
        revokedAt: plus(t0, 9000).toISOString(),
        lastUsedAt: plus(t0, 5000).toISOString(),
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(sha256(token));
  });

  // Red team §7.9: refused authentication stores no token material and stays bounded.
  test('refused-auth audit rows carry no token id or hash and are capped', () => {
    const d = db();
    for (let n = 0; n < MAX_REFUSED_AUTH_ROWS + 25; n++) {
      auditRefusedAuth(d, 'unknown', null, plus(t0, n));
    }
    const rows = auditRows(d);
    expect(rows).toHaveLength(MAX_REFUSED_AUTH_ROWS);
    expect(rows.every((r) => r.tokenId === null && r.argsSha === null)).toBe(true);
    expect(rows[0]).toEqual({
      tokenId: null,
      zoneId: null,
      tool: 'auth',
      argsSha: null,
      outcome: 'refused',
      detail: 'unknown',
    });
    // Tool-call rows are never pruned by the cap.
    const { id } = mintMcpToken(d, { zoneId: 'main', scope: 'read', days: 1 }, t0);
    auditRefusedAuth(d, 'unknown', null, plus(t0, 10 * DAY));
    expect(auditRows(d).filter((r) => r.tool === 'mint')).toEqual([
      expect.objectContaining({ tokenId: id }),
    ]);
  });

  // Red team §7.10 (redaction half).
  test('the real token shape is redacted, refused as a secret, and stripped from forge text', () => {
    const d = db();
    const { token } = mintMcpToken(d, { zoneId: 'main', scope: 'write', days: 1 }, t0);
    expect(redact(`token ${token} here`, [])).toBe('token [REDACTED] here');
    expect(containsSecret(`x ${token} y`, [])).toBe(true);
    expect(sanitizeForgeText(`paste: ${token}`, [])).not.toContain(token.slice(4, 30));
    expect(sanitizeCrewText(`paste: ${token}`, [])).not.toContain(token.slice(4, 30));
    expect(sanitizeForgeText('paste: jmm_short', [])).toBe('paste: jmm_short');
  });
});

// Red team §7.10 (route half) and plan test "the control route returns the token once".
describe('control routes', () => {
  const OP = 'o'.repeat(32);
  const HOST = '127.0.0.1:7420';
  const headers = { authorization: `Bearer ${OP}`, host: HOST };
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function setup(enabled = true) {
    const d = db();
    const config = {
      listen: { host: '127.0.0.1', port: 7420 },
      dataDir: '.',
      pollSeconds: 60,
      dropZones: [makeZone({ id: 'main' })],
      claude: { plan: 'pro', fableWeeklyDropCap: 5 },
      usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
      secrets: { operatorToken: OP },
      mcp: { enabled },
    } as unknown as Config;
    app = createApp({ db: d, config, forgesFor: () => ({}) as never, now: () => t0 });
    return d;
  }

  const mint = (payload: unknown, h: Record<string, string> = headers) =>
    (app as FastifyInstance).inject({
      method: 'POST',
      url: '/api/control/mcp-tokens',
      headers: h,
      payload: payload as object,
    });

  test('mint returns the token once, and the database holds only its hash', async () => {
    const d = setup();
    const r = await mint({ zoneId: 'main', scope: 'read', days: 30, label: 'cli' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { id: number; token: string; zoneId: string; expiresAt: string };
    expect(body).toMatchObject({ zoneId: 'main', scope: 'read', label: 'cli' });
    expect(body.token).toMatch(/^jmm_/);
    expect(JSON.stringify(d.prepare('SELECT * FROM mcp_tokens').all())).not.toContain(body.token);
    expect(JSON.stringify(d.prepare('SELECT * FROM mcp_audit').all())).not.toContain(body.token);
    const list = await app?.inject({ method: 'GET', url: '/api/control/mcp-tokens', headers });
    expect(list?.statusCode).toBe(200);
    expect(list?.body).not.toContain(body.token);
    expect(list?.body).not.toContain(sha256(body.token));
    expect(list?.json()).toEqual({
      tokens: [expect.objectContaining({ id: body.id, zoneId: 'main', scope: 'read' })],
    });
  });

  test('mint validates days, scope and zone; it needs the operator token', async () => {
    setup();
    expect((await mint({ zoneId: 'main', scope: 'read', days: 0 })).statusCode).toBe(400);
    expect((await mint({ zoneId: 'main', scope: 'read', days: 91 })).statusCode).toBe(400);
    expect((await mint({ zoneId: 'main', scope: 'admin', days: 5 })).statusCode).toBe(400);
    expect((await mint({ zoneId: 'other', scope: 'read', days: 5 })).statusCode).toBe(404);
    expect(
      (await mint({ zoneId: 'main', scope: 'read', days: 5 }, { host: HOST })).statusCode,
    ).toBe(401);
  });

  test('revoke takes a token id; an unknown id is 404', async () => {
    const d = setup();
    const { id, token } = (await mint({ zoneId: 'main', scope: 'write', days: 5 })).json() as {
      id: number;
      token: string;
    };
    const del = (n: number | string) =>
      (app as FastifyInstance).inject({
        method: 'DELETE',
        url: `/api/control/mcp-tokens/${n}`,
        headers,
      });
    expect((await del(id)).statusCode).toBe(200);
    expect(verifyMcpToken(d, token, t0)).toBeNull();
    expect((await del(id)).statusCode).toBe(404);
    expect((await del('x')).statusCode).toBe(404);
  });

  test('with mcp disabled the token routes are not registered', async () => {
    setup(false);
    expect((await mint({ zoneId: 'main', scope: 'read', days: 5 })).statusCode).toBe(404);
  });
});
