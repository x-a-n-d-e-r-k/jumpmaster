import { describe, expect, test } from 'vitest';
import { secretList } from '../config.js';
import {
  AUTHOR_TOKEN,
  CLAUDE_TOKEN,
  READ_TOKEN,
  REVIEWER_TOKEN,
  world,
} from '../test/doctorWorld.js';
import { FORGE_WRITES } from '../test/fakes.js';
import { DoctorBusyError, latestDoctorRun, runDoctor, summarize } from './run.js';

describe('runDoctor', () => {
  test('a full doctor run makes zero forge write calls', async () => {
    const w = world({ readToken: true, zone: { reviewReadToken: true } });
    w.f.state.access.author.private = true;
    // Problems everywhere, so every check reads all it can.
    w.f.state.labels = [];
    const run = await runDoctor(w.deps);
    expect(run.checks.length).toBeGreaterThan(20);
    const calls = [...w.f.author.calls, ...w.f.reviewer.calls, ...w.read.author.calls];
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((c) => FORGE_WRITES.includes(c.method as never))).toEqual([]);
  });

  test('no secret value appears in any stored or returned check', async () => {
    const w = world({ readToken: true, zone: { reviewReadToken: true } });
    w.f.state.access.author.private = true;
    // Errors that quote tokens, as a proxy or a misbehaving library might.
    w.f.author.failNext('listLabels', { status: 500, message: `upstream said ${AUTHOR_TOKEN}` });
    w.f.reviewer.failNext('viewerLogin', { status: 502, message: `bad ${REVIEWER_TOKEN}` });
    w.read.author.failNext('listDir', {
      status: 500,
      message: `read ${READ_TOKEN} ${CLAUDE_TOKEN}`,
    });
    const run = await runDoctor(w.deps);
    const stored = w.db.prepare('SELECT results_json AS r FROM doctor_runs').all() as {
      r: string;
    }[];
    const texts = [JSON.stringify(run), ...stored.map((s) => s.r)];
    for (const secret of secretList(w.config.secrets))
      for (const t of texts) expect(t).not.toContain(secret);
    // The redaction left the rest of the message readable.
    expect(JSON.stringify(run)).toContain('upstream said [REDACTED]');
  });

  test('one doctor run at a time', async () => {
    const w = world();
    const first = runDoctor(w.deps);
    await expect(runDoctor(w.deps)).rejects.toBeInstanceOf(DoctorBusyError);
    await first;
    await expect(runDoctor(w.deps)).resolves.toMatchObject({ checks: expect.any(Array) });
  });

  test('I-3: a run older than the lock lifetime no longer holds the doctor at 409', async () => {
    const hung = world();
    let at = hung.deps.now().getTime();
    hung.deps.now = () => new Date(at);
    // A check that never answers, with no deadline in force: the first run hangs.
    let answer: (labels: string[]) => void = () => {};
    hung.f.author.listLabels = () => new Promise<string[]>((resolve) => (answer = resolve));
    const first = runDoctor(hung.deps);
    await expect(runDoctor(hung.deps)).rejects.toBeInstanceOf(DoctorBusyError);
    at += 11 * 60_000;
    const ok = world();
    ok.deps.now = () => new Date(at);
    await expect(runDoctor(ok.deps)).resolves.toMatchObject({ finishedAt: expect.any(String) });
    // Let the stalled run finish, so no timer or promise outlives the test; the lock is free.
    answer(['agent-ready', 'agent-retry']);
    await first;
    await expect(runDoctor(ok.deps)).resolves.toMatchObject({ finishedAt: expect.any(String) });
  });

  test('a run is stored, the latest is read back, and a zone filter limits the zone checks', async () => {
    const w = world();
    expect(latestDoctorRun(w.db)).toBeNull();
    const all = await runDoctor(w.deps);
    const only = await runDoctor(w.deps, { zoneId: 'nope' });
    expect(only.checks.some((c) => c.zoneId !== null)).toBe(false);
    const latest = latestDoctorRun(w.db);
    expect(latest?.id).toBe(only.id);
    expect(latest?.id).toBeGreaterThan(all.id);
    expect(latest?.finishedAt).toBeTruthy();
    expect(summarize(all.checks)).toEqual({
      pass: all.checks.length - 3,
      warn: 0,
      fail: 0,
      skip: 3,
    });
  });

  test('a check that throws becomes a fail with a redacted message, and the run goes on', async () => {
    const w = world();
    w.deps.forges = () => {
      throw new Error(`no forge for ${AUTHOR_TOKEN}`);
    };
    const run = await runDoctor(w.deps);
    const forge = run.checks.filter((c) => c.id.startsWith('forge.'));
    expect(forge.length).toBeGreaterThan(5);
    expect(forge.filter((c) => c.status === 'pass')).toEqual([]);
    expect(forge.every((c) => /could not/.test(c.summary))).toBe(true);
    expect(JSON.stringify(run)).not.toContain(AUTHOR_TOKEN);
    expect(run.checks.find((c) => c.id === 'config.listen')?.status).toBe('pass');
  });
});
