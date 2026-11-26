// Adding a stick with one pasted line, and removing one (issue #138), through the whole app.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { listAudit } from '../auth/audit.js';
import {
  findStick,
  getDrop,
  insertDrop,
  insertStick,
  setWorkItemState,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { expireLeases } from '../leases.js';
import { t0 } from '../test/helpers.js';
import {
  CODE,
  closeInstallWorld,
  DAY,
  HOST,
  installWorld,
  JOIN,
  PUBLIC,
  sha,
  TOKEN,
  TRUSTED_ROOT,
} from '../test/install-world.js';

// Wrapped so a test can replay a racing Remove: findStick answering with a stick already removed.
vi.mock('../db/repo.js', async (actual) => {
  const repo = await actual<typeof import('../db/repo.js')>();
  return { ...repo, findStick: vi.fn(repo.findStick) };
});

afterEach(async () => {
  await closeInstallWorld();
  vi.restoreAllMocks();
});
const world = installWorld;

describe('making an invite (Add a stick)', () => {
  test('without sudo it is refused with 403, and nothing is made or audited', async () => {
    const w = await world();
    const r = await w.add({ name: 'vps-1', slots: 'auto' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ sudo: 'required' });
    expect(r.body).not.toMatch(CODE);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM stick_invites').get()).toEqual({ n: 0 });
    expect(listAudit(w.db).filter((a) => a.action.startsWith('stick.'))).toEqual([]);
  });

  test('a name with a space, a duplicate name and an out-of-range count are refused', async () => {
    const w = await world();
    w.sudo();
    expect((await w.add({ name: 'a b', slots: 'auto' })).statusCode).toBe(400);
    expect((await w.add({ name: 'x'.repeat(65), slots: 'auto' })).statusCode).toBe(400);
    expect((await w.add({ name: 'vps-1', slots: 0 })).statusCode).toBe(400);
    expect((await w.add({ name: 'vps-1', slots: 65 })).statusCode).toBe(400);
    insertStick(w.db, { id: 's1', name: 'taken', tokenHash: 'h', slots: 1 });
    const dup = await w.add({ name: 'taken', slots: 'auto' });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toContain('already named taken');
    // A pending invite holds its name too.
    expect((await w.add({ name: 'vps-1', slots: 2 })).statusCode).toBe(200);
    expect((await w.add({ name: 'vps-1', slots: 2 })).statusCode).toBe(400);
  });

  test('with server.publicUrl unset it is refused with the link to Settings', async () => {
    const w = await world({ publicUrl: false });
    w.sudo();
    const r = await w.add({ name: 'vps-1', slots: 'auto' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ settings: '/system/server#other-machines' });
    expect(r.json().error).toContain('/system/server#other-machines');
    // The page offers the link instead of the form.
    expect(await w.page()).toContain('<a href="/system/server#other-machines">');
  });

  test('the result page shows the line once, never cached; only a hash is stored and the audit row has no code', async () => {
    const w = await world();
    w.sudo();
    const r = await w.add({ name: 'vps-1', slots: 3 });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const code = CODE.exec(r.body)?.[0] as string;
    expect(code).toBeDefined();
    // The URL is one single-quoted shell word (issue #254), HTML-escaped on the page.
    expect(r.body).toContain(
      `curl -fsSL &#39;${PUBLIC}/install/stick.sh&#39; | sudo sh -s -- ${code}`,
    );
    // Only the chosen form (issue #269): the line by default, no cloud-config.
    expect(r.body).not.toContain('#cloud-config');
    expect(r.body).toContain('works once');
    expect(r.body).toContain("won't be shown again");
    const row = w.db.prepare('SELECT * FROM stick_invites').get() as Record<string, unknown>;
    expect(row.code_hash).not.toBe(code);
    expect(row.code_hash).toBe(sha(code));
    expect(row).toMatchObject({ name: 'vps-1', slots: 3 });
    expect(Date.parse(row.expires_at as string) - t0.getTime()).toBe(DAY);
    expect(JSON.stringify(w.db.prepare('SELECT * FROM stick_invites').all())).not.toContain(code);
    const audits = listAudit(w.db).filter((a) => a.action === 'stick.invite');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ via: 'session', detail: { name: 'vps-1', slots: 3 } });
    expect(JSON.stringify(listAudit(w.db))).not.toContain(code);
    // Registered with the server's scrub set.
    expect(w.scrub.values()).toContain(code);
  });
});

describe('enrolling with a code', () => {
  test('a valid code enrolls the invite name and count; Auto leaves the count unset and the ceiling governs', async () => {
    const w = await world();
    const fixed = await w.invite('vps-3', 3);
    const auto = await w.invite('vps-auto', 'auto');
    const a = await w.enroll({ enrollCode: fixed });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().name).toBe('vps-3');
    const b = await w.enroll({ enrollCode: auto });
    expect(b.json().name).toBe('vps-auto');
    const rows = w.db
      .prepare('SELECT name, desired_slots AS d, auto_slots AS a FROM sticks ORDER BY name')
      .all();
    expect(rows).toEqual([
      { name: 'vps-3', d: 3, a: 0 },
      { name: 'vps-auto', d: null, a: 1 },
    ]);
    // Marked used, with the stick it made.
    expect(
      w.db
        .prepare(
          'SELECT name, used_at IS NOT NULL AS used, stick_id AS s FROM stick_invites ORDER BY name',
        )
        .all(),
    ).toEqual([
      { name: 'vps-3', used: 1, s: a.json().stickId },
      { name: 'vps-auto', used: 1, s: b.json().stickId },
    ]);
    // The Auto stick runs at the ceiling it reports.
    const lease = await w.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: { ...w.proto, authorization: `Bearer ${b.json().stickToken}` },
      payload: { freeSlots: 0, capabilities: [], maxSlots: 6, slots: 1 },
    });
    expect(lease.headers['x-jumpmaster-slots']).toBe('6');
  });

  test('a second use, an expired code and an unknown code get 401 with the wrong join token body', async () => {
    const w = await world();
    const wrong = await w.enroll({ joinToken: 'not-the-join-token' });
    expect(wrong.statusCode).toBe(401);
    const code = await w.invite('vps-1');
    expect((await w.enroll({ enrollCode: code })).statusCode).toBe(200);
    const again = await w.enroll({ enrollCode: code });
    expect(again.statusCode).toBe(401);
    expect(again.body).toBe(wrong.body);
    expect(again.headers['content-type']).toBe(wrong.headers['content-type']);
    const unknown = await w.enroll({ enrollCode: `jm_enroll_${'A'.repeat(43)}` });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    expect((await w.enroll({ enrollCode: 'garbage' })).body).toBe(wrong.body);
    const late = await w.invite('vps-2');
    w.setClock(new Date(t0.getTime() + DAY + 1000));
    const expired = await w.enroll({ enrollCode: late });
    expect(expired.statusCode).toBe(401);
    expect(expired.body).toBe(wrong.body);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM sticks WHERE name = 'vps-2'").get()).toEqual({
      n: 0,
    });
  });

  test('two concurrent uses of one code enroll exactly one stick', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    const results = await Promise.all([
      w.enroll({ enrollCode: code }),
      w.enroll({ enrollCode: code }),
      w.enroll({ enrollCode: code }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401, 401]);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM sticks').get()).toEqual({ n: 1 });
  });

  test('an invite whose name a live stick took since refuses clearly and stays unused', async () => {
    const w = await world();
    const code = await w.invite('a');
    // Another stick enrolls as `a` with the join token after the invite was made.
    const joined = await w.inject({
      method: 'POST',
      url: '/api/sticks/enroll',
      headers: w.proto,
      payload: { joinToken: JOIN, name: 'a', slots: 1, capabilities: [] },
    });
    expect(joined.statusCode, joined.body).toBe(200);
    const r = await w.enroll({ enrollCode: code });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('a stick named a is already enrolled');
    expect(r.body).not.toContain(code);
    expect(
      w.db
        .prepare("SELECT COUNT(*) AS n FROM sticks WHERE name = 'a' AND removed_at IS NULL")
        .get(),
    ).toEqual({ n: 1 });
    expect(w.db.prepare('SELECT used_at, stick_id FROM stick_invites').get()).toEqual({
      used_at: null,
      stick_id: null,
    });
  });

  test('the join token enrolls as ever, with the stick name it sends', async () => {
    const w = await world();
    const r = await w.enroll({ joinToken: JOIN });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(['stickId', 'stickToken']);
    expect(w.db.prepare('SELECT name, auto_slots AS a FROM sticks').all()).toEqual([
      { name: 'stick', a: 0 },
    ]);
  });
});

describe('the installer downloads', () => {
  test('a valid code downloads the stick image and cosign without being consumed', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    const tar = await w.image(code);
    expect(tar.statusCode, tar.body).toBe(200);
    expect(tar.headers['content-type']).toBe('application/x-tar');
    expect(tar.rawPayload.subarray(0, 9).toString()).toBe('oci-layou');
    const cosign = await w.inject({
      method: 'GET',
      url: '/install/cosign?platform=linux/amd64',
      headers: { host: 'any.example', authorization: `Bearer ${code}` },
    });
    expect(cosign.statusCode).toBe(200);
    expect(cosign.body).toBe('fake-cosign');
    // Still good for the enrollment.
    expect((await w.enroll({ enrollCode: code })).statusCode).toBe(200);
  });

  test('a used or expired code, or none, gets 401', async () => {
    const w = await world();
    expect((await w.image()).statusCode).toBe(401);
    const used = await w.invite('vps-1');
    await w.enroll({ enrollCode: used });
    expect((await w.image(used)).statusCode).toBe(401);
    const old = await w.invite('vps-2');
    w.setClock(new Date(t0.getTime() + DAY + 1000));
    expect((await w.image(old)).statusCode).toBe(401);
    const cosign = await w.inject({ method: 'GET', url: '/install/cosign?platform=linux/amd64' });
    expect(cosign.statusCode).toBe(401);
  });

  test('the script is served without auth, on any Host, parses with sh -n, and holds no secret', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    const r = await w.inject({
      method: 'GET',
      url: '/install/stick.sh',
      headers: { host: 'jm.tail1234.ts.net' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(r.body).toContain(`JM_SERVER_URL='${PUBLIC}'`);
    expect(r.body).toContain(w.images.digest);
    expect(spawnSync('sh', ['-n'], { input: r.body }).status).toBe(0);
    const secrets = Object.values(w.store.current().secrets).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of [...secrets, code]) expect(r.body).not.toContain(s);
  });
});

describe('the trusted root download (issue #167)', () => {
  const root = (
    w: { inject: (o: object) => Promise<{ statusCode: number; body: string }> },
    code?: string,
  ) =>
    w.inject({
      method: 'GET',
      url: '/install/trusted-root.json',
      headers: { host: 'any.example', ...(code ? { authorization: `Bearer ${code}` } : {}) },
    });

  test('a valid code downloads it without being consumed', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    const r = await root(w, code);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(TRUSTED_ROOT);
    expect((await w.enroll({ enrollCode: code })).statusCode).toBe(200);
  });

  test('no code, a used one or an expired one gets 401', async () => {
    const w = await world();
    expect((await root(w)).statusCode).toBe(401);
    const used = await w.invite('vps-1');
    await w.enroll({ enrollCode: used });
    expect((await root(w, used)).statusCode).toBe(401);
    const old = await w.invite('vps-2');
    w.setClock(new Date(t0.getTime() + DAY + 1000));
    expect((await root(w, old)).statusCode).toBe(401);
  });

  test("the script pins the sha256 of the server's own copy, the one it serves", async () => {
    const w = await world();
    const script = await w.inject({
      method: 'GET',
      url: '/install/stick.sh',
      headers: { host: 'jm.tail1234.ts.net' },
    });
    expect(script.body).toContain(`TRUSTED_ROOT_SHA256='${sha(TRUSTED_ROOT)}'`);
    // A server without its copy cannot pin one: the script says so instead of installing.
    rmSync(w.trustedRootFile);
    const none = await w.inject({
      method: 'GET',
      url: '/install/stick.sh',
      headers: { host: 'jm.tail1234.ts.net' },
    });
    expect(none.body).toContain("TRUSTED_ROOT_SHA256=''");
    expect(none.body).toContain('no Sigstore trusted root');
    const code = await w.invite('vps-1');
    expect((await root(w, code)).statusCode).toBe(404);
  });
});

describe('removing a stick and cancelling an invite', () => {
  test('Remove needs sudo; it revokes the token, requeues an unstarted drop and writes one audit row', async () => {
    const w = await world();
    const e = await w.enroll({ joinToken: JOIN });
    const { stickId, stickToken } = e.json() as { stickId: string; stickToken: string };
    upsertDropZone(w.db, {
      id: 'main',
      repo: 'octo/demo',
      defaultBranch: 'main',
      configJson: '{}',
    });
    const wi = upsertWorkItem(w.db, {
      dropZoneId: 'main',
      issueNumber: 7,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    setWorkItemState(w.db, wi.id, 'in_flight');
    insertDrop(w.db, {
      id: 'd1',
      dropZoneId: 'main',
      workItemId: wi.id,
      role: 'implement',
      state: 'leased',
      stickId,
      epoch: 1,
      leaseExpiresAt: new Date(t0.getTime() + 600_000).toISOString(),
      createdAt: t0.toISOString(),
    });
    const remove = () =>
      w.inject({
        method: 'POST',
        url: `/api/control/sticks/${stickId}/remove`,
        headers: w.session,
        payload: {},
      });
    const refused = await remove();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ sudo: 'required' });
    w.sudo();
    const r = await remove();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: stickId, name: 'stick', removed: true });
    const lease = await w.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: { ...w.proto, authorization: `Bearer ${stickToken}` },
      payload: { freeSlots: 1, capabilities: [] },
    });
    expect(lease.statusCode).toBe(401);
    // The lost-stick path: the drop is lost now, and its item goes back to ready after the grace.
    expect(getDrop(w.db, 'd1')?.state).toBe('lost');
    expireLeases(w.db, new Date(t0.getTime() + 10 * 60_000));
    expect(
      (w.db.prepare('SELECT state FROM work_items WHERE id = ?').get(wi.id) as { state: string })
        .state,
    ).toBe('ready');
    const audits = listAudit(w.db).filter((a) => a.action === 'stick.remove');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target: stickId, detail: { name: 'stick' } });
    expect(await w.page()).not.toContain(`data-stick="${stickId}"`);
    // Gone: a second removal finds nothing.
    expect((await remove()).statusCode).toBe(404);
  });

  test('a racing second Remove that removes nothing gets 404 and writes no audit row', async () => {
    const w = await world();
    await w.enroll({ joinToken: JOIN });
    const remove = () =>
      w.inject({
        method: 'POST',
        url: '/api/control/sticks/stick/remove',
        headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
    const stale = findStick(w.db, 'stick');
    expect((await remove()).statusCode).toBe(200);
    // The second request passed findStick before the first committed: removeStick finds nothing.
    vi.mocked(findStick).mockImplementationOnce(() => stale);
    const second = await remove();
    expect(second.statusCode).toBe(404);
    expect(listAudit(w.db).filter((a) => a.action === 'stick.remove')).toHaveLength(1);
  });

  test('ctl reaches Remove with the operator token (always sudo)', async () => {
    const w = await world();
    await w.enroll({ joinToken: JOIN });
    const r = await w.inject({
      method: 'POST',
      url: '/api/control/sticks/stick/remove',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(listAudit(w.db).filter((a) => a.action === 'stick.remove')).toHaveLength(1);
  });

  test('Cancel needs sudo, removes the pending row, stops the code and is audited by name', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    const id = (w.db.prepare('SELECT id FROM stick_invites').get() as { id: string }).id;
    const page = await w.page();
    expect(page).toContain('vps-1: waiting for it to check in (expires 2026-');
    expect(page).toContain(`data-cancel="/api/control/sticks/invites/${id}/cancel"`);
    w.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
    const cancel = () =>
      w.inject({
        method: 'POST',
        url: `/api/control/sticks/invites/${id}/cancel`,
        headers: w.session,
        payload: {},
      });
    expect((await cancel()).statusCode).toBe(403);
    w.sudo();
    const r = await cancel();
    expect(r.statusCode, r.body).toBe(200);
    expect(await w.page()).not.toContain('waiting for it to check in');
    expect((await w.enroll({ enrollCode: code })).statusCode).toBe(401);
    const audits = listAudit(w.db).filter((a) => a.action === 'stick.invite_cancel');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target: id, detail: { name: 'vps-1' } });
    expect(JSON.stringify(listAudit(w.db))).not.toContain(code);
    // The name is free again.
    expect((await w.add({ name: 'vps-1', slots: 'auto' })).statusCode).toBe(200);
  });
});

describe('the code stays secret', () => {
  test('no log line across invite, download and enroll carries the code', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    const writes: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown, ...rest: unknown[]) => {
      writes.push(String(c));
      return out(c as string, ...(rest as []));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown, ...rest: unknown[]) => {
      writes.push(String(c));
      return err(c as string, ...(rest as []));
    });
    const w = await world();
    const code = await w.invite('vps-1');
    await w.image(code);
    await w.image(`${code.slice(0, -1)}x`);
    await w.enroll({ enrollCode: code });
    await w.enroll({ enrollCode: code });
    for (const l of [...lines, ...writes]) expect(l).not.toContain(code);
  });
});

describe('the sticks page from invite to live', () => {
  test('pending, then fetching images, then live with its health; names are escaped', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    expect(await w.page()).toMatch(/<li data-invite="[^"]+" data-poll>/);
    const e = await w.enroll({ enrollCode: code });
    const token = (e.json() as { stickToken: string }).stickToken;
    const lease = (extra: Record<string, unknown>) =>
      w.inject({
        method: 'POST',
        url: '/api/sticks/lease',
        headers: { ...w.proto, authorization: `Bearer ${token}` },
        payload: { freeSlots: 0, capabilities: ['egress-v1', 'image-verify-v1'], ...extra },
      });
    let page = await w.page();
    expect(page).not.toContain('waiting for it to check in');
    const row = () => page.match(/<tr[^>]*data-stick="[^"]*">(?:(?!<\/tr>).)*<\/tr>/)?.[0] ?? '';
    expect(row()).toContain('never seen');
    expect(row()).toMatch(/^<tr data-poll data-stick=/);
    await lease({
      imageFetch: {
        ref: `ghcr.io/o/jumpmaster-egress@sha256:${'e'.repeat(64)}`,
        done: 1,
        total: 9e6,
      },
      health: { docker: '27.3.1', freeBytes: 50_000_000_000 },
    });
    page = await w.page();
    expect(row()).toContain('Fetching images');
    expect(row()).toContain('fetching jumpmaster-egress');
    expect(row()).toMatch(/^<tr data-poll data-stick=/);
    await lease({ imageFetch: null, health: { docker: '27.3.1', freeBytes: 50_000_000_000 } });
    page = await w.page();
    expect(row()).toContain('<span class="stage">Live</span>');
    expect(row()).toContain(
      'Docker 27.3.1, egress-v1 yes, image-verify-v1 yes, clone-v1 no, egress-private-v1 no, egress-ports-v1 no, 50.0 GB free',
    );
    expect(row()).not.toContain('data-poll');
    expect(row()).toContain('vps-1');
    expect(row()).toMatch(/data-remove="\/api\/control\/sticks\/[^"]+\/remove"/);
    // A stick enrolled with the join token under any name is escaped.
    insertStick(w.db, { id: 's-x', name: '<b>x</b>', tokenHash: 'hx', slots: 1 });
    page = await w.page();
    expect(page).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(page).not.toContain('<b>x</b>');
    // The page polls while a row isn't live.
    expect(page).toContain('setTimeout');
  });
});
