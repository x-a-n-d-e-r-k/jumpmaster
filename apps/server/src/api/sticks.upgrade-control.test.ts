// Issue #428: Command upgrades a stick by hand, from the sticks page or ctl, through the real app,
// its control routes and the real database.
import { describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import {
  getStickUpgrade,
  insertStick,
  removeStick,
  type Stick,
  settleStickUpgrade,
} from '../db/repo.js';
import { fakeMirror, type Harness, harness } from '../test/flowHarness.js';
import { operatorSession } from '../test/helpers.js';
import { REINSTALL_REASON, SIGNED_POLICY_REASON } from './stick-upgrade.js';

type StickAdvert = Pick<Stick, 'capabilities' | 'imagePolicy' | 'version'>;

const ELIGIBLE: Partial<StickAdvert> = {
  capabilities: ['push-v1', 'upgrade-v1'],
  imagePolicy: 'signed',
  version: '0.5.1',
};

type Opts = Parameters<typeof harness>[0];

/** Server 0.6.0 with the stick image mirrored and auto-upgrade off; the harness stick removed. */
async function world(
  o: Opts = {},
): Promise<Harness & { sudo(): void; headers: Record<string, string> }> {
  const h = await harness({
    version: '0.6.0',
    images: fakeMirror(),
    sticks: { autoUpgrade: false },
    ...o,
  });
  removeStick(h.db, h.stickId, h.now());
  const s = operatorSession(h.db, h.now());
  return Object.assign(h, {
    headers: s.headers,
    sudo: () => {
      h.db
        .prepare('UPDATE sessions SET sudo_until = ?')
        .run(new Date(h.now().getTime() + 60_000).toISOString());
    },
  });
}

function stick(h: Harness, id: string, advert: Partial<StickAdvert> = ELIGIBLE): void {
  insertStick(h.db, { id, name: id, tokenHash: `hash-${id}`, slots: 1, ...advert });
}

const rows = (h: Harness): number =>
  (h.db.prepare('SELECT COUNT(*) AS n FROM stick_upgrades').get() as { n: number }).n;
const audits = (h: Harness) => listAudit(h.db).filter((a) => a.action === 'stick.upgrade');

const post = (h: Harness & { headers: Record<string, string> }, url: string) =>
  h.app.inject({ method: 'POST', url, headers: h.headers, payload: {} });
const upgrade = (h: Harness & { headers: Record<string, string> }, id: string) =>
  post(h, `/api/control/sticks/${encodeURIComponent(id)}/upgrade`);

describe('POST /api/control/sticks/:id/upgrade', () => {
  test('without sudo: 403 asking for it, no row and no audit; with sudo: a pending command row, audited', async () => {
    const h = await world();
    stick(h, 'kidney');
    const refused = await upgrade(h, 'kidney');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ sudo: 'required' });
    expect(rows(h)).toBe(0);
    expect(audits(h)).toEqual([]);

    h.sudo();
    const r = await upgrade(h, 'kidney');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: 'kidney', name: 'kidney', target: '0.6.0' });
    expect(getStickUpgrade(h.db, 'kidney')).toMatchObject({
      targetVersion: '0.6.0',
      state: 'pending',
      requestedBy: 'command',
    });
    const a = audits(h);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ target: 'kidney', detail: { name: 'kidney', version: '0.6.0' } });
  });

  test('upgrade-all without sudo is refused too', async () => {
    const h = await world();
    stick(h, 'kidney');
    const r = await post(h, '/api/control/sticks/upgrade-all');
    expect(r.statusCode).toBe(403);
    expect(rows(h)).toBe(0);
    expect(audits(h)).toEqual([]);
  });

  test.each([
    [
      'no target (a dev server)',
      { version: 'dev' },
      ELIGIBLE,
      'the server has no release to offer',
    ],
    [
      'no target (no stick image)',
      { images: fakeMirror({ stick: false }) },
      ELIGIBLE,
      'the server has no release to offer',
    ],
    ['not behind', {}, { ...ELIGIBLE, version: '0.6.0' }, 'already on v0.6.0'],
    [
      'without upgrade-v1',
      {},
      { ...ELIGIBLE, capabilities: ['push-v1'], version: '0.4.4' },
      REINSTALL_REASON,
    ],
    [
      'under allowlist',
      {},
      { ...ELIGIBLE, imagePolicy: 'allowlist' as const },
      SIGNED_POLICY_REASON,
    ],
  ])('%s: 409 with the reason, and no row', async (_what, o, advert, reason) => {
    const h = await world(o as Opts);
    stick(h, 'kidney', advert);
    h.sudo();
    const r = await upgrade(h, 'kidney');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: reason });
    expect(rows(h)).toBe(0);
    expect(audits(h)).toEqual([]);
  });

  test('the reinstall and policy reasons say exactly what the issue says', () => {
    expect(REINSTALL_REASON).toBe(
      'this stick is older than in-place upgrades: reinstall it once with a new code',
    );
    expect(SIGNED_POLICY_REASON).toBe('in-place upgrade needs the signed image policy');
  });

  test('an unknown stick is 404', async () => {
    const h = await world();
    h.sudo();
    expect((await upgrade(h, 'nobody')).statusCode).toBe(404);
  });

  test('a failed row: the page offers Retry, and posting it replaces the row with pending', async () => {
    const h = await world();
    stick(h, 'kidney');
    h.sudo();
    expect((await upgrade(h, 'kidney')).statusCode).toBe(200);
    settleStickUpgrade(
      h.db,
      'kidney',
      '0.5.1',
      { version: '0.6.0', result: 'failed', reason: 'the new stick did not start' },
      h.now(),
    );
    const page = (await h.view('/sticks')).body;
    expect(page).toContain('upgrade to v0.6.0 failed: the new stick did not start');
    expect(page).toContain('data-upgrade="/api/control/sticks/kidney/upgrade"');
    expect(page).toMatch(/<button[^>]*data-upgrade="[^"]*kidney\/upgrade"[^>]*>Retry<\/button>/);
    const r = await upgrade(h, 'kidney');
    expect(r.statusCode, r.body).toBe(200);
    expect(getStickUpgrade(h.db, 'kidney')).toMatchObject({ state: 'pending', reason: null });
    expect((await h.view('/sticks')).body).toContain('upgrading to v0.6.0');
  });
});

describe('POST /api/control/sticks/upgrade-all', () => {
  test('requests every eligible, behind stick and skips the rest with their reasons', async () => {
    const h = await world();
    stick(h, 'kidney');
    stick(h, 'liver', { ...ELIGIBLE, version: '0.5.0' });
    stick(h, 'crucible', { ...ELIGIBLE, capabilities: ['push-v1'], version: '0.4.4' });
    stick(h, 'spleen', { ...ELIGIBLE, version: '0.6.0' });
    stick(h, 'lung', { ...ELIGIBLE, imagePolicy: 'allowlist' });
    h.sudo();
    const r = await post(h, '/api/control/sticks/upgrade-all');
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json() as { requested: string[]; skipped: { name: string; reason: string }[] };
    expect([...b.requested].sort()).toEqual(['kidney', 'liver']);
    expect([...b.skipped].sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: 'crucible', reason: REINSTALL_REASON },
      { name: 'lung', reason: SIGNED_POLICY_REASON },
      { name: 'spleen', reason: 'already on v0.6.0' },
    ]);
    expect(rows(h)).toBe(2);
    expect(getStickUpgrade(h.db, 'kidney')?.requestedBy).toBe('command');
    expect(
      audits(h)
        .map((a) => a.target)
        .sort(),
    ).toEqual(['kidney', 'liver']);
  });

  test('a stick already upgrading is skipped, not asked again', async () => {
    const h = await world();
    stick(h, 'kidney');
    h.sudo();
    await upgrade(h, 'kidney');
    const r = await post(h, '/api/control/sticks/upgrade-all');
    expect(r.json()).toEqual({
      requested: [],
      skipped: [{ name: 'kidney', reason: 'already upgrading to v0.6.0' }],
    });
  });

  test('with no target: 409 with the reason, and no row', async () => {
    const h = await world({ version: 'dev' });
    stick(h, 'kidney');
    h.sudo();
    const r = await post(h, '/api/control/sticks/upgrade-all');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'the server has no release to offer' });
    expect(rows(h)).toBe(0);
  });
});

describe('the read API and the sticks page', () => {
  async function mixed(o: Opts = {}) {
    const h = await world(o);
    stick(h, 'kidney');
    stick(h, 'crucible', { ...ELIGIBLE, capabilities: ['push-v1'], version: '0.4.4' });
    stick(h, 'spleen', { ...ELIGIBLE, version: '0.6.0' });
    stick(h, 'liver', { ...ELIGIBLE, version: '0.5.0' });
    stick(h, 'lung', { ...ELIGIBLE, version: '0.5.0' });
    h.sudo();
    await upgrade(h, 'liver');
    await upgrade(h, 'lung');
    settleStickUpgrade(
      h.db,
      'lung',
      '0.5.0',
      { version: '0.6.0', result: 'refused', reason: 'bad signature' },
      h.now(),
    );
    return h;
  }
  const byName = (body: { sticks: { name: string }[] }) =>
    Object.fromEntries(body.sticks.map((s) => [s.name, s]));

  test('GET /api/control/sticks carries each stick version and upgrade', async () => {
    const h = await mixed();
    const r = await h.app.inject({ method: 'GET', url: '/api/control/sticks', headers: h.headers });
    const s = byName(r.json());
    expect(s.kidney).toMatchObject({
      version: '0.5.1',
      upgrade: { status: 'available', target: '0.6.0', reason: null, requestedBy: null },
    });
    expect(s.crucible).toMatchObject({
      version: '0.4.4',
      upgrade: {
        status: 'needs-reinstall',
        target: '0.6.0',
        reason: REINSTALL_REASON,
        requestedBy: null,
      },
    });
    expect(s.spleen).toMatchObject({
      upgrade: { status: 'up-to-date', target: '0.6.0', reason: null, requestedBy: null },
    });
    expect(s.liver).toMatchObject({
      upgrade: { status: 'upgrading', target: '0.6.0', reason: null, requestedBy: 'command' },
    });
    expect(s.lung).toMatchObject({
      upgrade: {
        status: 'refused',
        target: '0.6.0',
        reason: 'bad signature',
        requestedBy: 'command',
      },
    });
  });

  test('with no target the API says null', async () => {
    const h = await world({ version: 'dev' });
    stick(h, 'kidney');
    const r = await h.app.inject({ method: 'GET', url: '/api/control/sticks', headers: h.headers });
    expect(byName(r.json()).kidney).toMatchObject({ version: '0.5.1', upgrade: null });
  });

  test('the page shows each status in words, with buttons only where stated', async () => {
    const h = await mixed();
    const page = (await h.view('/sticks')).body;
    const row = (id: string) => {
      const m = new RegExp(`<tr[^>]*data-stick="${id}"[^>]*>.*?</tr>`).exec(page);
      expect(m, id).not.toBeNull();
      return (m as RegExpExecArray)[0];
    };
    expect(row('kidney')).toContain('update available: v0.6.0');
    expect(row('kidney')).toMatch(
      /data-upgrade="\/api\/control\/sticks\/kidney\/upgrade">Upgrade to v0.6.0<\/button>/,
    );
    expect(row('crucible')).toContain('older than in-place upgrades: reinstall to upgrade');
    expect(row('crucible')).not.toContain('data-upgrade');
    expect(row('spleen')).toContain('up to date');
    expect(row('spleen')).not.toContain('data-upgrade');
    expect(row('liver')).toContain('upgrading to v0.6.0');
    expect(row('liver')).not.toContain('data-upgrade');
    expect(row('lung')).toContain('upgrade to v0.6.0 refused: bad signature');
    expect(row('lung')).toMatch(/data-upgrade="[^"]*lung\/upgrade">Retry<\/button>/);
  });

  test('a capable stick under the allowlist policy is told what it needs, with no button', async () => {
    const h = await world();
    stick(h, 'kidney', { ...ELIGIBLE, imagePolicy: 'allowlist' });
    const page = (await h.view('/sticks')).body;
    expect(page).toContain(SIGNED_POLICY_REASON);
    expect(page).not.toContain('data-upgrade=');
  });

  test('with no target the page shows no status line and no button', async () => {
    const h = await world({ version: 'dev' });
    stick(h, 'kidney');
    const page = (await h.view('/sticks')).body;
    expect(page).toContain('data-stick="kidney"');
    expect(page).not.toContain('data-upgrade=');
    expect(page).not.toMatch(/up to date|update available|upgrading to|older than in-place/);
  });
});
