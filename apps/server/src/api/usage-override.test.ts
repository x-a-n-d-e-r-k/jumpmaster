import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import type { Config } from '../config.js';
import { ctlRequest } from '../ctl.js';
import { openDb } from '../db/open.js';
import {
  getUsageState,
  recordUsageWindows,
  setKilled,
  setUsageState,
  setZoneMode,
  upsertDropZone,
} from '../db/repo.js';
import { mintMcpToken } from '../mcp/tokens.js';
import { statusInputOf, statusOf } from '../status.js';
import { makeZone } from '../test/fixtures.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { dispatchGate, setUsageOverride } from '../usage.js';
import { type ControlDeps, registerControlRoutes } from './control.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const URL_ = '/api/control/usage/override';
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };
const H = 3_600_000;
const iso = (ms: number) => new Date(t0.getTime() + ms).toISOString();

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(throttle = true) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
  const config = {
    listen: { host: '127.0.0.1', port: 7420 },
    dropZones: [makeZone({ id: 'main' })],
    usage: { throttleUtilization: 0.9, probeJitterSeconds: [0, 0] },
    secrets: { operatorToken: TOKEN },
  } as unknown as Config;
  if (throttle)
    setUsageState(
      db,
      {
        status: 'allowed_warning',
        warningWindow: 'five_hour',
        warningAt: iso(0),
        sevenDayUtil: 0.81,
        sevenDayResetsAt: iso(36 * H),
      },
      t0,
    );
  const a = Fastify();
  const deps = { db, config, now: () => t0 } as ControlDeps;
  registerGuard(a, deps);
  registerControlRoutes(a, deps);
  app = a;
  const send = (
    method: 'POST' | 'DELETE',
    payload?: object,
    headers: Record<string, string> = auth,
  ) => a.inject({ method, url: URL_, headers, ...(payload === undefined ? {} : { payload }) });
  return { db, config, send };
}

describe('POST and DELETE /api/control/usage/override (#728)', () => {
  test('the defaults, with no body: 5 starts for 3 hours, the gate overridden and the change audited', async () => {
    const { db, config, send } = setup();
    const r = await send('POST');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ startsLeft: 5, starts: 5, until: iso(3 * H) });
    expect(dispatchGate(db, config.usage, t0)).toBe('override');
    expect(listAudit(db)).toHaveLength(1);
    expect(listAudit(db)[0]).toMatchObject({ via: 'token', action: 'usage.override' });
    expect(listAudit(db)[0]?.detail).toEqual({ starts: 5, hours: 3 });
  });

  test('its own starts and hours; a second one replaces the first', async () => {
    const { db, send } = setup();
    expect((await send('POST', { starts: 2, hours: 1 })).json()).toEqual({
      startsLeft: 2,
      starts: 2,
      until: iso(H),
    });
    expect((await send('POST', { starts: 20, hours: 12 })).statusCode).toBe(200);
    expect(getUsageState(db)).toMatchObject({ overrideStarts: 20, overrideStartsLeft: 20 });
  });

  test.each([
    { starts: 0 },
    { starts: 21 },
    { starts: 1.5 },
    { hours: 0 },
    { hours: 13 },
    { starts: '5' },
    { ceiling: 1 },
  ])('out of bounds or unknown is refused: %j', async (body) => {
    const { db, send } = setup();
    expect((await send('POST', body)).statusCode).toBe(400);
    expect(getUsageState(db).overrideUntil).toBeNull();
  });

  test('with the throttle not holding, or a stronger gate in force, there is nothing to override', async () => {
    const open = setup(false);
    const r = await open.send('POST');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/nothing to override/);
    expect(getUsageState(open.db).overrideUntil).toBeNull();
    await app?.close();
    const paused = setup();
    setUsageState(paused.db, { pausedUntil: iso(H) }, t0);
    expect((await paused.send('POST')).statusCode).toBe(409);
    expect(listAudit(paused.db)).toHaveLength(0);
  });

  test('usage already at the ceiling is refused rather than set and never in force', async () => {
    const { db, send } = setup();
    recordUsageWindows(db, { seven_day: { utilization: 0.95 } }, t0, null);
    const r = await send('POST');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/95%/);
    expect(getUsageState(db).overrideUntil).toBeNull();
  });

  test('DELETE ends it and is audited', async () => {
    const { db, config, send } = setup();
    await send('POST');
    const r = await send('DELETE');
    expect(r.statusCode).toBe(200);
    expect(dispatchGate(db, config.usage, t0)).toBe('finishing_only');
    expect(
      listAudit(db)
        .map((a) => a.action)
        .sort(),
    ).toEqual(['usage.override', 'usage.override.clear']);
  });

  test('no credentials, a wrong token and an MCP token are each refused, setting nothing', async () => {
    const { db, send } = setup();
    const mcp = mintMcpToken(db, { zoneId: 'main', scope: 'write', days: 1, label: 'x' }, t0);
    for (const headers of [
      { host: HOST },
      { host: HOST, authorization: 'Bearer nope' },
      { host: HOST, authorization: `Bearer ${mcp.token}` },
    ]) {
      expect((await send('POST', {}, headers)).statusCode).toBe(401);
      expect((await send('DELETE', undefined, headers)).statusCode).toBe(401);
    }
    expect(getUsageState(db).overrideUntil).toBeNull();
  });

  test('a browser session sets it, recorded as a session; without the CSRF header it is refused', async () => {
    const { db, send } = setup();
    const session = operatorSession(db).headers;
    const r0 = await send('POST', {}, { host: HOST, cookie: session.cookie });
    expect(r0.statusCode).toBe(403);
    expect(getUsageState(db).overrideUntil).toBeNull();
    const r = await send('POST', {}, { host: HOST, ...session });
    expect(r.statusCode, r.body).toBe(200);
    expect(getUsageState(db).overrideBy).toBe('session');
  });

  test('no chat or MCP module reaches the setter', () => {
    for (const f of [
      '../mcp/chat-actions.ts',
      '../mcp/chat-tools.ts',
      '../mcp/tools.ts',
      '../mcp/kit.ts',
    ]) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(s, f).not.toMatch(/setUsageOverride|clearUsageOverride|usage\/override/);
    }
  });
});

describe('ctl usage override (#728)', () => {
  test('its forms', () => {
    expect(ctlRequest(['usage', 'override'])).toEqual({ path: URL_, method: 'POST', body: {} });
    expect(ctlRequest(['usage', 'override', '--starts', '3', '--hours', '2'])).toEqual({
      path: URL_,
      method: 'POST',
      body: { starts: 3, hours: 2 },
    });
    expect(ctlRequest(['usage', 'override', '--clear'])).toEqual({ path: URL_, method: 'DELETE' });
  });

  test.each([
    ['usage'],
    ['usage', 'over'],
    ['usage', 'override', '--starts'],
    ['usage', 'override', '--starts', 'x'],
    ['usage', 'override', '--starts', '-1'],
    ['usage', 'override', '--starts', '1', '--starts', '2'],
    ['usage', 'override', '--clear', '--starts', '1'],
    ['usage', 'override', 'now'],
  ])('a typo is a usage error: %j', (...args) => {
    expect(ctlRequest(args.flat())).toBeNull();
  });
});

describe('the status says an override is on (#728)', () => {
  test('while in force, as another line; not otherwise', () => {
    const { db, config } = setup();
    const status = () =>
      statusOf(
        statusInputOf({
          db,
          config,
          now: t0,
          pages: { zones: true, settings: true, credentials: true },
        }),
        t0,
      );
    const said = () =>
      status()
        .also?.map((a) => a.text)
        .join('\n') ?? '';
    expect(said()).not.toContain('Usage override');
    setUsageOverride(db, { starts: 5, hours: 3, by: 'token' }, t0);
    setUsageState(db, { overrideStartsLeft: 3 }, t0);
    expect(said()).toContain(
      `Usage override: 3 of 5 starts left, until ${iso(3 * H).slice(11, 16)} UTC`,
    );
    // Where it lifts nothing it is not said: every project paused, the kill switch, or no throttle.
    setZoneMode(db, 'main', 'paused', t0);
    expect(said()).not.toContain('Usage override');
    setZoneMode(db, 'main', 'active', t0);
    setKilled(db, true, t0);
    expect(said()).not.toContain('Usage override');
    setKilled(db, false, t0);
    setUsageState(db, { status: 'allowed', warningWindow: null, warningAt: null }, t0);
    expect(said()).not.toContain('Usage override');
    setUsageState(
      db,
      {
        status: 'allowed_warning',
        warningWindow: 'five_hour',
        warningAt: iso(0),
        overrideStartsLeft: 0,
      },
      t0,
    );
    expect(dispatchGate(db, config.usage, t0)).toBe('finishing_only');
    expect(said()).not.toContain('Usage override');
  });
});
