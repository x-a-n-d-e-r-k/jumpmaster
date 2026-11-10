import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Principal } from '../auth/guard.js';
import { loadConfig, parseEditable, secretList } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import {
  getZoneMode,
  insertDrop,
  setZoneMode,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import { type BootConfig, loadBoot, RESTART_PATHS } from './boot.js';
import { mergePatch } from './diff.js';
import { canonicalJson, getSetting, hashOf } from './revisions.js';
import { ConfigStore, type StoreOptions } from './store.js';

const env: NodeJS.ProcessEnv = {
  JM_CLAUDE_TOKEN: 'claude-secret-value-1',
  JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
  JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
  JM_JOIN_TOKEN: 'join-secret-value-4',
  JM_OPERATOR_TOKEN: 'o'.repeat(32),
};
const token: Principal = { kind: 'operator', via: 'token', sudo: true };
const session: Principal = { kind: 'operator', via: 'session', sessionId: 'h', sudo: false };
const noLock = join(tmpdir(), 'jm-no-such-lock.json');

const zone = (id = 'main', extra: Record<string, unknown> = {}) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
  ...extra,
});

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'jm-store-'));
}

function writeConfig(path: string, doc: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ dataDir: './data', ...doc }));
}

type World = {
  db: Db;
  file: string;
  logs: string[];
  clock: { now: Date };
  open(extra?: Partial<StoreOptions>): ConfigStore;
};

/** A database and a config path (the file is written only when `doc` is given). */
function world(doc?: Record<string, unknown>): World {
  const d = dir();
  const file = join(d, 'jumpmaster.config.json');
  if (doc) writeConfig(file, doc);
  const dbFile = tmpDbFile();
  const w: World = {
    db: openDb(dbFile),
    file,
    logs: [],
    clock: { now: t0 },
    open(extra = {}) {
      const boot = loadBoot(env, file);
      return ConfigStore.open({
        db: w.db,
        boot,
        filePath: file,
        env,
        now: () => w.clock.now,
        imageLockPath: noLock,
        log: (m) => w.logs.push(m),
        ...extra,
      });
    },
  };
  return w;
}

const revCount = (db: Db) =>
  (db.prepare('SELECT COUNT(*) AS c FROM config_revisions').get() as { c: number }).c;
const revVia = (db: Db) =>
  (db.prepare('SELECT via FROM config_revisions ORDER BY id').all() as { via: string }[]).map(
    (r) => r.via,
  );

describe('modes at start', () => {
  test('a server started with a file is in file mode and records revision 1 via file', () => {
    const w = world({ pollSeconds: 30, dropZones: [zone()] });
    const store = w.open();
    expect(store.mode()).toBe('file');
    expect(store.revision()).toBe(1);
    expect(revVia(w.db)).toEqual(['file']);
    expect(store.current().pollSeconds).toBe(30);
    expect(store.current().dropZones.map((z) => z.id)).toEqual(['main']);
    expect(store.current().secrets.claudeToken).toBe(env.JM_CLAUDE_TOKEN);
    // The same file at the next start records nothing; a changed one records revision 2.
    w.open();
    expect(revCount(w.db)).toBe(1);
    writeConfig(w.file, { pollSeconds: 20, dropZones: [zone()] });
    const again = w.open();
    expect(again.revision()).toBe(2);
    expect(revVia(w.db)).toEqual(['file', 'file']);
  });

  test('a server started without a file is in db mode with defaults, no zones and revision 1 via setup', () => {
    const w = world();
    const store = w.open();
    expect(store.mode()).toBe('db');
    expect(store.revision()).toBe(1);
    expect(revVia(w.db)).toEqual(['setup']);
    expect(store.current().dropZones).toEqual([]);
    expect(store.current().pollSeconds).toBe(60);
    expect(store.current().dataDir).toBe('./data');
    expect(getSetting(w.db, 'config.mode')).toBe('db');
    // A restart keeps the revision.
    expect(w.open().revision()).toBe(1);
    expect(revCount(w.db)).toBe(1);
  });

  test('an invalid file at start stops the server, as it always has', () => {
    const w = world({ dropZones: [zone('main', { repo: 'nope' })] });
    expect(() => w.open()).toThrow(/Invalid config .*dropZones\.0\.repo/);
  });

  test('db mode whose current revision is missing or dangling stops the server rather than starting empty', () => {
    for (const damage of [
      "DELETE FROM settings WHERE key = 'config.current'",
      "UPDATE settings SET value_json = '99' WHERE key = 'config.current'",
    ]) {
      const w = world();
      const store = w.open();
      store.apply({ dropZones: [zone()] }, { via: 'ctl', principal: token });
      w.db.exec(damage);
      expect(() => w.open()).toThrow(
        /config mode is db, but the current revision is missing: restore the data directory/,
      );
      expect(revCount(w.db)).toBe(2);
    }
  });

  test('file mode with its file gone stops the server rather than starting empty', () => {
    const w = world({ dropZones: [zone()] });
    w.open();
    rmSync(w.file);
    expect(() => w.open({ boot: loadBoot(env, undefined) })).toThrow(
      /config mode is file, but .*jumpmaster\.config\.json does not exist/,
    );
  });
});

describe('file mode', () => {
  test('in file mode a UI or ctl apply is refused with the reload-or-adopt message and nothing changes', () => {
    const w = world({ dropZones: [zone()] });
    const store = w.open();
    for (const [via, principal] of [
      ['ui', session],
      ['ctl', token],
    ] as const) {
      const r = store.apply({ pollSeconds: 5 }, { via, principal, expectRevision: 1 });
      expect(r).toEqual({
        ok: false,
        issues: [
          {
            path: '',
            message: `config is managed by the file at ${w.file}: edit it and run \`jumpmaster ctl config reload\`, or adopt it into the UI`,
          },
        ],
      });
    }
    expect(store.revision()).toBe(1);
    expect(store.current().pollSeconds).toBe(60);
  });

  test('reload records a revision only when the file hash changed and keeps the old config when the new file is invalid', () => {
    const w = world({ dropZones: [zone()] });
    const store = w.open();
    // Same content, different bytes: no revision.
    writeFileSync(w.file, JSON.stringify({ dropZones: [zone()], dataDir: './data' }, null, 4));
    expect(store.reload()).toEqual({ ok: true, revision: 1, changed: [], restartNeeded: [] });
    writeConfig(w.file, { pollSeconds: 15, dropZones: [zone()] });
    expect(store.reload()).toEqual({
      ok: true,
      revision: 2,
      changed: ['pollSeconds'],
      restartNeeded: [],
    });
    expect(store.current().pollSeconds).toBe(15);
    // An invalid file: the old config stays, and the status says why.
    writeConfig(w.file, { pollSeconds: -1, dropZones: [zone()] });
    const bad = store.reload();
    expect(bad.ok).toBe(false);
    expect(store.revision()).toBe(2);
    expect(store.current().pollSeconds).toBe(15);
    expect(store.status().fileProblem).toEqual([expect.objectContaining({ path: 'pollSeconds' })]);
    writeFileSync(w.file, '{ not json');
    expect(store.reload().ok).toBe(false);
    expect(store.status().fileProblem?.[0]?.message).toMatch(/not JSON/);
    writeConfig(w.file, { pollSeconds: 15, dropZones: [zone()] });
    expect(store.reload().ok).toBe(true);
    expect(store.status().fileProblem).toBeUndefined();
  });

  test('a reload that changes a boot setting lists it as needing a restart', () => {
    const w = world({ dropZones: [zone()] });
    const store = w.open();
    writeFileSync(
      w.file,
      JSON.stringify({ dataDir: './data', listen: { port: 9000 }, dropZones: [zone()] }),
    );
    const r = store.reload();
    expect(r).toEqual({ ok: true, revision: 1, changed: [], restartNeeded: ['listen'] });
    expect(store.status().restartPending).toEqual(['listen']);
    // The running listen setting is unchanged until the restart.
    expect(store.current().listen.port).toBe(7420);
  });

  test('adopt switches to db mode and records via adopt, and a later reload is a no-op the doctor reports', () => {
    const w = world({ dropZones: [zone()] });
    const store = w.open();
    expect(store.adopt({ principal: session })).toEqual({
      ok: true,
      revision: 2,
      changed: [],
      restartNeeded: [],
    });
    expect(store.mode()).toBe('db');
    expect(revVia(w.db)).toEqual(['file', 'adopt']);
    expect(store.adopt({ principal: session }).ok).toBe(false);
    writeConfig(w.file, { pollSeconds: 9, dropZones: [zone()] });
    expect(store.reload()).toEqual({ ok: true, revision: 2, changed: [], restartNeeded: [] });
    expect(store.current().pollSeconds).toBe(60);
    expect(store.status().fileIgnored).toBe(`config file ignored: adopted on ${t0.toISOString()}`);
    // At the next start the file is still ignored, loudly.
    const next = w.open();
    expect(next.mode()).toBe('db');
    expect(next.current().pollSeconds).toBe(60);
    expect(w.logs).toContain(`config file ignored: adopted on ${t0.toISOString()}`);
    // A UI apply now works.
    expect(
      next.apply({ pollSeconds: 5, dropZones: [zone()] }, { via: 'ui', principal: session }).ok,
    ).toBe(true);
  });

  test('adopt takes the file as it is now, and refuses an invalid one', () => {
    const w = world({ dropZones: [zone()] });
    const store = w.open();
    writeConfig(w.file, { pollSeconds: 12, dropZones: [zone()] });
    expect(store.adopt({ principal: token }).ok).toBe(true);
    expect(revVia(w.db)).toEqual(['file', 'file', 'adopt']);
    expect(store.current().pollSeconds).toBe(12);

    const v = world({ dropZones: [zone()] });
    const s2 = v.open();
    writeConfig(v.file, { pollSeconds: -1, dropZones: [zone()] });
    expect(s2.adopt({ principal: token }).ok).toBe(false);
    expect(s2.mode()).toBe('file');
  });
});

describe('back to file mode and export', () => {
  test('mode file needs the Bearer token, refuses when the file differs from the export, and switches back when it matches', () => {
    const w = world({ dropZones: [zone()] });
    const store = w.open();
    store.adopt({ principal: token });
    store.apply({ pollSeconds: 7, dropZones: [zone()] }, { via: 'ctl', principal: token });
    expect(store.toFileMode({ principal: session })).toEqual({
      ok: false,
      issues: [{ path: '', message: 'this needs the operator token: run it with jumpmaster ctl' }],
    });
    expect(store.toFileMode({ principal: token })).toEqual({
      ok: false,
      issues: [
        {
          path: '',
          message:
            'the file differs from the current config: write `ctl config export` to it first',
        },
      ],
    });
    expect(store.mode()).toBe('db');
    writeFileSync(w.file, store.exportJson());
    const r = store.toFileMode({ principal: token });
    expect(r).toEqual({ ok: true, revision: 4, changed: [], restartNeeded: [] });
    expect(store.mode()).toBe('file');
    expect(revVia(w.db)).toEqual(['file', 'adopt', 'ctl', 'ctl']);
    const last = w.db
      .prepare('SELECT note FROM config_revisions ORDER BY id DESC LIMIT 1')
      .get() as { note: string };
    expect(last.note).toBe('to file mode');
    // The file is the truth again, and the next start agrees without a new revision.
    expect(store.apply({ pollSeconds: 1 }, { via: 'ctl', principal: token }).ok).toBe(false);
    const next = w.open();
    expect(next.mode()).toBe('file');
    expect(next.current().pollSeconds).toBe(7);
    expect(revCount(w.db)).toBe(4);
  });

  test('mode file without a file says so', () => {
    const w = world();
    const store = w.open();
    expect(store.toFileMode({ principal: token })).toEqual({
      ok: false,
      issues: [
        {
          path: '',
          message: `there is no config file at ${w.file}: write \`ctl config export\` to it first`,
        },
      ],
    });
  });

  test('exportJson is byte-stable and equals the current config with boot settings and without secrets, and re-imports unchanged', () => {
    const w = world();
    const store = w.open();
    store.apply(
      { dropZones: [zone('b'), zone('a')], pollSeconds: 30, mcp: { enabled: false } },
      { via: 'ctl', principal: token },
    );
    const out = store.exportJson();
    expect(out).toBe(store.exportJson());
    expect(out.endsWith('}\n')).toBe(true);
    expect(out).not.toContain('\r');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(out).toBe(canonicalJson(parsed));
    expect(parsed.listen).toEqual({
      host: '127.0.0.1',
      port: 7420,
      allowedHosts: ['127.0.0.1:7420', 'localhost:7420'],
    });
    expect(parsed.dataDir).toBe('./data');
    expect(parsed.pollSeconds).toBe(30);
    for (const s of secretList(store.current().secrets)) expect(out).not.toContain(s);
    // Re-importing the export (boot settings included, unchanged) is no change at all.
    const r = store.importDoc(parsed, { via: 'import', principal: token });
    expect(r).toEqual({ ok: true, revision: 2, changed: [], restartNeeded: [] });
    // A changed boot setting in an import is refused at its path.
    const moved = store.importDoc(
      { ...parsed, listen: { host: '0.0.0.0', port: 7420 } },
      { via: 'import', principal: token },
    );
    expect(moved).toEqual({
      ok: false,
      issues: [
        { path: 'listen', message: 'set in the config file or the environment; restart to change' },
      ],
    });
  });
});

describe('apply', () => {
  test('apply validates with the editable schema and returns issues by path, applying nothing on failure', () => {
    const w = world();
    const store = w.open();
    const seen: number[] = [];
    store.subscribe((_c, rev) => seen.push(rev));
    const r = store.apply(
      { dropZones: [zone('a'), zone('b', { repo: 'bad' })] },
      { via: 'ui', principal: session },
    );
    expect(r).toEqual({
      ok: false,
      issues: [expect.objectContaining({ path: 'dropZones.1.repo' })],
    });
    expect(store.revision()).toBe(1);
    expect(store.current().dropZones).toEqual([]);
    expect(revCount(w.db)).toBe(1);
    expect(seen).toEqual([]);
    // A rule that needs a credential is an issue too (until Task 4 makes it a dispatch refusal).
    const starter = store.apply(
      { dropZones: [zone('a', { identity: 'starter' })] },
      { via: 'ctl', principal: token },
    );
    expect(starter).toEqual({
      ok: false,
      issues: [{ path: '', message: expect.stringMatching(/starter identity/) }],
    });
    expect(revCount(w.db)).toBe(1);
  });

  test('apply with a stale expectRevision returns a conflict and changes nothing', () => {
    const w = world();
    const store = w.open();
    expect(
      store.apply({ pollSeconds: 10 }, { via: 'ui', principal: session, expectRevision: 1 }),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(
      store.apply({ pollSeconds: 20 }, { via: 'ui', principal: session, expectRevision: 1 }),
    ).toEqual({ ok: false, conflict: { expected: 1, actual: 2 } });
    expect(store.current().pollSeconds).toBe(10);
    expect(revCount(w.db)).toBe(2);
  });

  test('apply is atomic: the revision row and config.current change together or not at all', () => {
    const w = world();
    const store = w.open();
    // The pointer write fails after the revision row is in: both roll back.
    w.db.exec(`CREATE TRIGGER fail_pointer BEFORE UPDATE ON settings
      WHEN NEW.key = 'config.current' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    expect(() => store.apply({ pollSeconds: 10 }, { via: 'ctl', principal: token })).toThrow(
      /disk full/,
    );
    expect(revCount(w.db)).toBe(1);
    expect(getSetting(w.db, 'config.current')).toBe(1);
    expect(store.revision()).toBe(1);
    expect(store.current().pollSeconds).toBe(60);
    w.db.exec('DROP TRIGGER fail_pointer');
    expect(store.apply({ pollSeconds: 10 }, { via: 'ctl', principal: token })).toMatchObject({
      ok: true,
      revision: 2,
    });
  });

  test('a document identical to the current one records nothing', () => {
    const w = world();
    const store = w.open();
    store.apply({ pollSeconds: 10 }, { via: 'ctl', principal: token });
    expect(store.apply({ pollSeconds: 10 }, { via: 'ctl', principal: token })).toEqual({
      ok: true,
      revision: 2,
      changed: [],
      restartNeeded: [],
    });
    expect(revCount(w.db)).toBe(2);
  });

  test('subscribers see the whole new config after it is stored, with its changes', () => {
    const w = world();
    const store = w.open();
    const seen: { rev: number; poll: number; stored: unknown; paths: string[] }[] = [];
    const off = store.subscribe((c, rev, changes) =>
      seen.push({
        rev,
        poll: c.pollSeconds,
        stored: getSetting(w.db, 'config.current'),
        paths: changes.map((x) => x.path),
      }),
    );
    store.subscribe(() => {
      throw new Error('a broken subscriber');
    });
    store.apply({ pollSeconds: 10 }, { via: 'ctl', principal: token });
    off();
    store.apply({ pollSeconds: 11 }, { via: 'ctl', principal: token });
    expect(seen).toEqual([{ rev: 2, poll: 10, stored: 2, paths: ['pollSeconds'] }]);
    expect(w.logs.some((l) => /subscriber failed: a broken subscriber/.test(l))).toBe(true);
  });

  test('a new zone gets its mode row on apply', () => {
    const w = world();
    const store = w.open();
    store.apply(
      { dropZones: [zone('a'), zone('b', { mode: 'observe' })] },
      { via: 'ctl', principal: token },
    );
    expect(getZoneMode(w.db, 'a', 'paused')).toBe('active');
    expect(getZoneMode(w.db, 'b', 'paused')).toBe('observe');
    // A config edit never flips a zone's stored mode.
    store.apply(
      { dropZones: [zone('a', { mode: 'paused' }), zone('b')] },
      { via: 'ctl', principal: token },
    );
    expect(getZoneMode(w.db, 'a', 'observe')).toBe('active');
  });

  test('a change to mcp.enabled is accepted, listed in restartNeeded and sets restart_pending', () => {
    const w = world();
    const store = w.open();
    const r = store.apply({ mcp: { enabled: true } }, { via: 'ctl', principal: token });
    expect(r).toEqual({
      ok: true,
      revision: 2,
      changed: ['mcp'],
      restartNeeded: ['mcp.enabled'],
      guarded: ['mcp.enabled'],
    });
    expect(getSetting(w.db, 'config.restart_pending')).toEqual(['mcp.enabled']);
    expect(store.status().restartPending).toEqual(['mcp.enabled']);
    // Another change leaves it pending; turning it back clears it.
    store.apply({ mcp: { enabled: true }, pollSeconds: 5 }, { via: 'ctl', principal: token });
    expect(store.status().restartPending).toEqual(['mcp.enabled']);
    store.apply({ mcp: { enabled: false } }, { via: 'ctl', principal: token });
    expect(store.status().restartPending).toEqual([]);
    expect(getSetting(w.db, 'config.restart_pending')).toBeUndefined();
    // Set again, then the next start runs with it: nothing pending.
    store.apply({ mcp: { enabled: true } }, { via: 'ctl', principal: token });
    expect(w.open().status().restartPending).toEqual([]);
    expect(getSetting(w.db, 'config.restart_pending')).toBeUndefined();
  });

  test('RESTART_PATHS names exactly the MCP route settings, and nothing else waits for a restart', () => {
    expect([...RESTART_PATHS]).toEqual(['mcp.enabled', 'mcp.maxBodyBytes']);
    const w = world();
    const store = w.open();
    const r = store.apply(
      {
        pollSeconds: 5,
        usage: { throttleUtilization: 0.5 },
        claude: { plan: 'max' },
        requireSignedImages: false,
        mcp: { writesPerHour: 1, maxBodyBytes: 1024 },
        dropZones: [zone()],
      },
      { via: 'ctl', principal: token },
    );
    expect(r).toMatchObject({ ok: true, restartNeeded: ['mcp.maxBodyBytes'] });
  });

  test('an apply that carries listen or dataDir is refused at that path', () => {
    const w = world();
    const store = w.open();
    expect(
      store.apply({ listen: { port: 1 }, dataDir: '/x' }, { via: 'ctl', principal: token }),
    ).toEqual({
      ok: false,
      issues: [
        { path: 'listen', message: 'set in the config file or the environment; restart to change' },
        {
          path: 'dataDir',
          message: 'set in the config file or the environment; restart to change',
        },
      ],
    });
  });

  test('a revision note over 500 characters is refused and a stored note is kept as data', () => {
    const w = world();
    const store = w.open();
    expect(
      store.apply({ pollSeconds: 5 }, { via: 'ctl', principal: token, note: 'x'.repeat(501) }),
    ).toEqual({
      ok: false,
      issues: [{ path: 'note', message: 'a note is at most 500 characters' }],
    });
    store.apply({ pollSeconds: 5 }, { via: 'ctl', principal: token, note: '<script>x</script>' });
    expect(store.revisions(10)[0]?.note).toBe('<script>x</script>');
  });
});

describe('unknown keys', () => {
  test('an apply carrying an unknown key is refused at its path: nothing is stored without effect', () => {
    const w = world();
    const store = w.open();
    expect(store.apply({ pollseconds: 10 }, { via: 'ctl', principal: token })).toEqual({
      ok: false,
      issues: [{ path: 'pollseconds', message: 'unknown key: it would have no effect' }],
    });
    expect(revCount(w.db)).toBe(1);
  });

  test('a file with an unknown key still runs in file mode, as in M4, but adopting it names the key', () => {
    const w = world({ dropZones: [zone('main', { readylabel: 'x' })] });
    const store = w.open();
    expect(store.mode()).toBe('file');
    const r = store.adopt({ principal: token });
    expect(r).toEqual({
      ok: false,
      issues: [{ path: 'dropZones.0.readylabel', message: 'unknown key: it would have no effect' }],
    });
    expect(store.mode()).toBe('file');
    expect(revVia(w.db)).toEqual(['file']);
  });
});

describe('seams for Tasks 3 and 4', () => {
  test('validateOnly judges a document as apply would and changes nothing', () => {
    const w = world();
    const store = w.open();
    const ok = store.validateOnly({ dropZones: [zone('a')] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.dropZones.map((z) => z.id)).toEqual(['a']);
    expect(store.validateOnly({ pollseconds: 9 })).toEqual({
      ok: false,
      issues: [{ path: 'pollseconds', message: 'unknown key: it would have no effect' }],
    });
    expect(store.revision()).toBe(1);
    expect(store.current().dropZones).toEqual([]);
  });

  test('refreshSecrets swaps in re-read secrets with no new revision, tells subscribers, and keeps the old ones on failure', () => {
    const w = world();
    let author = 'author-before-0001';
    let fail = false;
    const secrets = () => {
      if (fail) throw new Error('JM_GITHUB_AUTHOR_TOKEN_FILE is unreadable');
      return {
        claudeToken: 'claude-x-0001',
        githubAuthorToken: author,
        githubReviewerToken: 'reviewer-x-0001',
        joinToken: 'join-x-0001',
        operatorToken: 'o'.repeat(32),
      };
    };
    const store = w.open({ secretsFor: secrets });
    const seen: { rev: number; author: string; changes: number }[] = [];
    store.subscribe((c, rev, changes) =>
      seen.push({ rev, author: c.secrets.githubAuthorToken, changes: changes.length }),
    );
    author = 'author-after-0002';
    expect(store.refreshSecrets()).toEqual({
      ok: true,
      revision: 1,
      changed: [],
      restartNeeded: [],
    });
    expect(store.current().secrets.githubAuthorToken).toBe('author-after-0002');
    expect(seen).toEqual([{ rev: 1, author: 'author-after-0002', changes: 0 }]);
    expect(revCount(w.db)).toBe(1);
    fail = true;
    expect(store.refreshSecrets()).toEqual({
      ok: false,
      issues: [{ path: '', message: 'JM_GITHUB_AUTHOR_TOKEN_FILE is unreadable' }],
    });
    expect(store.current().secrets.githubAuthorToken).toBe('author-after-0002');
    expect(seen).toHaveLength(1);
  });
});

describe('history', () => {
  test('rollback creates a new revision with the old content and never deletes history', () => {
    const w = world();
    const store = w.open();
    store.apply({ pollSeconds: 10 }, { via: 'ctl', principal: token });
    store.apply({ pollSeconds: 20, dropZones: [zone()] }, { via: 'ui', principal: token });
    w.clock.now = plus(t0, 60_000);
    // Removing the zone needs it drained in observe (Task 3).
    setZoneMode(w.db, 'main', 'observe', t0);
    const r = store.rollback(2, { principal: token });
    expect(r).toEqual({
      ok: true,
      revision: 4,
      changed: ['dropZones[main]', 'pollSeconds'],
      restartNeeded: [],
    });
    expect(store.current().pollSeconds).toBe(10);
    expect(store.current().dropZones).toEqual([]);
    expect(revVia(w.db)).toEqual(['setup', 'ctl', 'ui', 'rollback']);
    const list = store.revisions(10);
    expect(list.map((x) => x.id)).toEqual([4, 3, 2, 1]);
    expect(list[0]).toMatchObject({ parentId: 3, via: 'rollback', note: 'rollback to 2' });
    expect(list[0]?.changes.map((c) => c.path)).toEqual(['dropZones[main]', 'pollSeconds']);
    expect(store.rollback(99, { principal: token })).toEqual({
      ok: false,
      issues: [{ path: 'id', message: 'no revision 99' }],
    });
  });

  test('diff matches zones by id and contains no secret value', () => {
    const w = world();
    const store = w.open();
    store.apply({ dropZones: [zone('a'), zone('b')] }, { via: 'ctl', principal: token });
    store.apply(
      { dropZones: [zone('b', { readyLabel: 'go' }), zone('a')] },
      { via: 'ctl', principal: token },
    );
    const [latest] = store.revisions(1);
    expect(latest?.changes).toEqual([
      { path: 'dropZones[b].readyLabel', from: undefined, to: 'go' },
    ]);
    const everything = JSON.stringify([
      store.revisions(10),
      store.exportJson(),
      w.db.prepare('SELECT * FROM config_revisions').all(),
      w.db.prepare('SELECT * FROM settings').all(),
    ]);
    for (const s of secretList(store.current().secrets)) expect(everything).not.toContain(s);
  });
});

describe('boot settings', () => {
  test('the boot values come from the file when it exists, else from the environment', () => {
    const d = dir();
    const file = join(d, 'jumpmaster.config.json');
    writeFileSync(
      file,
      JSON.stringify({ dataDir: '/srv/jm', listen: { host: '0.0.0.0', port: 7500 } }),
    );
    const fromFile: BootConfig = loadBoot({ JM_LISTEN_PORT: '9999', JM_DATA_DIR: '/x' }, file);
    expect(fromFile.listen).toEqual({
      host: '0.0.0.0',
      port: 7500,
      allowedHosts: ['127.0.0.1:7500', 'localhost:7500'],
      tlsTerminated: false,
    });
    expect(fromFile.dataDir).toBe('/srv/jm');
    expect(fromFile.source).toEqual({ listen: 'file', dataDir: 'file' });

    const fromEnv = loadBoot(
      {
        JM_LISTEN_HOST: '0.0.0.0',
        JM_LISTEN_PORT: '8000',
        JM_ALLOWED_HOSTS: 'jm.example:8000, localhost:8000',
        JM_DATA_DIR: '/data',
        JM_TLS_TERMINATED: '1',
        JM_SECRETS_DIR: '/secrets',
      },
      join(d, 'missing.json'),
    );
    expect(fromEnv.listen).toEqual({
      host: '0.0.0.0',
      port: 8000,
      allowedHosts: ['jm.example:8000', 'localhost:8000'],
      tlsTerminated: true,
    });
    expect(fromEnv.dataDir).toBe('/data');
    expect(fromEnv.secretsDir).toBe('/secrets');
    expect(fromEnv.source).toEqual({ listen: 'env', dataDir: 'env' });

    const defaults = loadBoot({}, undefined);
    expect(defaults.listen).toEqual({
      host: '127.0.0.1',
      port: 7420,
      allowedHosts: ['127.0.0.1:7420', 'localhost:7420'],
      tlsTerminated: false,
    });
    expect(defaults.dataDir).toBe('./data');
    // The environment's TLS and secrets settings apply in file mode too.
    expect(loadBoot({ JM_TLS_TERMINATED: '1', JM_SECRETS_DIR: '/s' }, file)).toMatchObject({
      listen: { tlsTerminated: true },
      secretsDir: '/s',
    });
    expect(() => loadBoot({ JM_LISTEN_PORT: 'eighty' }, undefined)).toThrow(/JM_LISTEN_PORT/);
  });

  test('an M4 install upgrades with zero steps: its file means file mode and the same config', () => {
    const w = world({
      listen: { host: '0.0.0.0', port: 7420 },
      pollSeconds: 45,
      requireSignedImages: false,
      dropZones: [zone('main', { identity: 'two-bot', readyLabel: 'go' })],
    });
    const store = w.open();
    expect(store.status()).toMatchObject({ mode: 'file', filePath: w.file, revision: 1 });
    // What the M4 loader made of the same file and environment, plus the one new boot field.
    const m4 = loadConfig(w.file, env, { imageLockPath: noLock });
    expect(store.current()).toEqual({ ...m4, listen: { ...m4.listen, tlsTerminated: false } });
    expect(readFileSync(w.file, 'utf8')).toContain('"pollSeconds":45');
  });
});

describe('prototype keys', () => {
  const probes = [
    '{"__proto__":{"pollSeconds":86400}}',
    `{"__proto__":{"dropZones":[${JSON.stringify(zone('phantom'))}]}}`,
  ];

  test("the review's probes are refused, directly and through a merge patch, and leave nothing behind", () => {
    const w = world();
    const store = w.open();
    for (const probe of probes) {
      for (const doc of [JSON.parse(probe), mergePatch(store.document(), JSON.parse(probe))]) {
        const r = store.apply(doc, { via: 'ctl', principal: token });
        expect(r).toEqual({
          ok: false,
          issues: [
            { path: '__proto__', message: 'a key named __proto__ is not allowed in the config' },
          ],
        });
      }
    }
    expect(store.revision()).toBe(1);
    expect(store.current().pollSeconds).toBe(60);
    expect(store.current().dropZones).toEqual([]);
    // Nested, and the other two names.
    for (const [doc, path] of [
      [JSON.parse('{"usage":{"__proto__":{"stopOnOverage":false}}}'), 'usage.__proto__'],
      [{ dropZones: [{ ...zone(), constructor: { x: 1 } }] }, 'dropZones.0.constructor'],
      [{ claude: { prototype: 1 } }, 'claude.prototype'],
    ] as const) {
      const r = store.apply(doc, { via: 'ctl', principal: token });
      expect(r.ok).toBe(false);
      if (!r.ok && 'issues' in r) expect(r.issues[0]?.path).toBe(path);
    }
    // The prototype of plain objects is untouched.
    expect(({} as Record<string, unknown>).pollSeconds).toBeUndefined();
  });

  test('a merge patch never sets a prototype: the key stays an own property for validation to refuse', () => {
    const merged = mergePatch(
      { a: 1 },
      JSON.parse('{"__proto__":{"pollSeconds":86400}}'),
    ) as Record<string, unknown>;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.pollSeconds).toBeUndefined();
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
  });

  test('invariant: after any apply, current() is a fresh parse of the stored canonical document', () => {
    const w = world();
    const store = w.open();
    const docs: unknown[] = [
      { pollSeconds: 30, dropZones: [zone('a'), zone('b', { readyLabel: 'go' })] },
      { usage: { throttleUtilization: 0.5 }, mcp: { enabled: true } },
      ...probes.map((p) => JSON.parse(p)),
      // As PATCH builds it: the probe merged into the current document, beside a real change (an
      // unchanged document is a no-op before validation).
      ...probes.map(
        (p, i) => () =>
          mergePatch(
            store.document(),
            JSON.parse(`${p.slice(0, -1)},"usage":{"throttleUtilization":0.${6 + i}}}`),
          ),
      ),
      { dropZones: [zone('c', { egress: { mode: 'monitor', allow: ['x.example.com'] } })] },
    ];
    for (const d of docs) {
      store.apply(typeof d === 'function' ? d() : d, { via: 'ctl', principal: token });
      const row = w.db
        .prepare('SELECT config_json AS j FROM config_revisions WHERE id = ?')
        .get(store.revision()) as { j: string };
      const fresh = parseEditable(JSON.parse(row.j), { imageLockPath: noLock });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) continue;
      const { listen, dataDir, secrets, ...editable } = store.current();
      expect(editable).toEqual(fresh.config);
      expect(row.j).toBe(canonicalJson(store.document()));
    }
  });
});

describe('pollSeconds out of range in an M4 file', () => {
  test('the file still starts, clamped and warned; a write with the same value is refused', () => {
    const w = world({ pollSeconds: 1, dropZones: [zone()] });
    const store = w.open();
    expect(store.current().pollSeconds).toBe(5);
    const warning = 'pollSeconds 1 is outside 5..86400: running with 5; set it in range';
    expect(w.logs).toContain(`config: ${warning}`);
    expect(store.status().warnings).toEqual([warning]);
    // A reload of a file with the value in range clears it.
    writeConfig(w.file, { pollSeconds: 100000, dropZones: [zone()] });
    expect(store.reload().ok).toBe(true);
    expect(store.current().pollSeconds).toBe(86400);
    writeConfig(w.file, { pollSeconds: 30, dropZones: [zone()] });
    store.reload();
    expect(store.status().warnings).toBeUndefined();
    // Writes stay strict: adopting the out-of-range file names the value.
    writeConfig(w.file, { pollSeconds: 2.5, dropZones: [zone()] });
    expect(store.adopt({ principal: token }).ok).toBe(false);
    expect(store.mode()).toBe('file');
  });
});

describe('guarded paths and confirmation (Task 3)', () => {
  const sessionB: Principal = { kind: 'operator', via: 'session', sessionId: 'other', sudo: true };
  const enforced = (extra: Record<string, unknown> = {}) =>
    zone('main', { egress: { mode: 'enforce', allow: [] }, ...extra });
  /** A db-mode store with zone main, put there by the token. */
  function seeded() {
    const w = world();
    const store = w.open();
    expect(store.apply({ dropZones: [enforced()] }, { via: 'ctl', principal: token }).ok).toBe(
      true,
    );
    return { w, store };
  }
  const weakened = () => ({ dropZones: [enforced({ ciRequired: false })] });
  const needs = (r: ReturnType<ConfigStore['apply']>) => {
    if (r.ok || !('needsConfirmation' in r))
      throw new Error(`expected needsConfirmation: ${JSON.stringify(r)}`);
    return r.needsConfirmation;
  };
  const confirmFor = (store: ConfigStore, pendingId: string, sessionId = 'h') => {
    const p = store.confirmations.pending(pendingId, sessionId);
    if (!p) throw new Error('no pending');
    return { pending: p, token: store.confirmations.mintConfirmation(p, sessionId) };
  };

  test('a session cannot change a guarded path without the confirmation page, and the token can', () => {
    const { store } = seeded();
    const r = store.apply(weakened(), { via: 'ui', principal: session, expectRevision: 2 });
    expect(needs(r).guarded).toEqual([
      {
        path: 'dropZones[main].ciRequired',
        consequence: 'Agent PRs in main will merge without CI',
      },
    ]);
    expect(store.revision()).toBe(2);
    expect(store.current().dropZones[0]?.ciRequired).toBe(true);
    const t = store.apply(weakened(), { via: 'ctl', principal: token, expectRevision: 2 });
    expect(t).toMatchObject({ ok: true, revision: 3, guarded: ['dropZones[main].ciRequired'] });
    // A change that weakens nothing goes straight through from a session.
    const plain = store.apply(
      { dropZones: [enforced({ ciRequired: false, maxTurns: 9 })] },
      { via: 'ui', principal: session },
    );
    expect(plain).toEqual({
      ok: true,
      revision: 4,
      changed: ['dropZones[main].maxTurns'],
      restartNeeded: [],
    });
  });

  test('a minted confirmation applies the pending change once; a replay is refused as used', () => {
    const { store } = seeded();
    const { pendingId } = needs(store.apply(weakened(), { via: 'ui', principal: session }));
    const { pending, token: t } = confirmFor(store, pendingId);
    const meta = {
      ...pending.meta,
      expectRevision: pending.expectRevision,
      confirmation: { pendingId, token: t },
    };
    const ok = store.apply(pending.patch, meta);
    expect(ok).toMatchObject({ ok: true, revision: 3, guarded: ['dropZones[main].ciRequired'] });
    expect(store.current().dropZones[0]?.ciRequired).toBe(false);
    expect(store.apply(pending.patch, meta)).toEqual({ ok: false, confirmation: 'used' });
  });

  test('a made-up token, another session, a changed set and a stale revision are each refused', () => {
    const { store } = seeded();
    const { pendingId } = needs(store.apply(weakened(), { via: 'ui', principal: session }));
    const { pending, token: t } = confirmFor(store, pendingId);
    const meta = (over: Record<string, unknown> = {}) => ({
      ...pending.meta,
      expectRevision: pending.expectRevision,
      confirmation: { pendingId, token: t },
      ...over,
    });
    expect(
      store.apply(pending.patch, meta({ confirmation: { pendingId, token: 'x'.repeat(43) } })),
    ).toEqual({
      ok: false,
      confirmation: 'unknown',
    });
    expect(store.apply(pending.patch, meta({ principal: sessionB }))).toEqual({
      ok: false,
      confirmation: 'session',
    });
    // The same confirmation offered for a different change set.
    const swapped = { dropZones: [enforced({ ciRequired: false, gateCi: false })] };
    expect(store.apply(swapped, meta())).toEqual({ ok: false, confirmation: 'changed' });
    expect(store.revision()).toBe(2);
    // Another apply moves the revision: the confirmation was for revision 2.
    store.apply({ dropZones: [enforced()], pollSeconds: 30 }, { via: 'ctl', principal: token });
    expect(store.apply(pending.patch, meta())).toEqual({ ok: false, confirmation: 'stale' });
    expect(store.current().dropZones[0]?.ciRequired).toBe(true);
  });

  test('an expired confirmation and an expired pending change are refused', () => {
    const { w, store } = seeded();
    const { pendingId } = needs(store.apply(weakened(), { via: 'ui', principal: session }));
    const { pending, token: t } = confirmFor(store, pendingId);
    w.clock.now = plus(t0, 5 * 60_000);
    const meta = { ...pending.meta, expectRevision: 2, confirmation: { pendingId, token: t } };
    expect(store.apply(pending.patch, meta)).toEqual({ ok: false, confirmation: 'expired' });
    w.clock.now = plus(t0, 10 * 60_000);
    expect(store.confirmations.pending(pendingId, 'h')).toBeUndefined();
  });

  test('requireSignedImages weakening and a zone image, on an existing or an added zone, are refused from a session with or without a confirmation', () => {
    const w = world();
    const store = w.open();
    store.apply(
      {
        requireSignedImages: true,
        dropZones: [enforced({ image: `jm-trooper@sha256:${'a'.repeat(64)}` })],
      },
      { via: 'ctl', principal: token },
    );
    const forbidden = [
      [
        { dropZones: [enforced({ image: `jm-trooper@sha256:${'a'.repeat(64)}` })] },
        ['requireSignedImages', 'dropZones[main].requireSignedImages'],
      ],
      [
        {
          requireSignedImages: true,
          dropZones: [enforced({ image: `other@sha256:${'b'.repeat(64)}` })],
        },
        ['dropZones[main].image'],
      ],
      [
        {
          requireSignedImages: true,
          dropZones: [
            enforced({ image: `jm-trooper@sha256:${'a'.repeat(64)}` }),
            zone('new', {
              image: `x@sha256:${'c'.repeat(64)}`,
              egress: { mode: 'monitor', allow: [] },
            }),
          ],
        },
        ['dropZones[new].image'],
      ],
    ] as const;
    for (const [next, paths] of forbidden) {
      expect(store.apply(next, { via: 'ui', principal: session })).toEqual({
        ok: false,
        sessionForbidden: paths,
      });
      // A confirmation from another pending change does not open it.
      const { pendingId } = needs(
        store.apply(
          {
            requireSignedImages: true,
            dropZones: [
              enforced({ image: `jm-trooper@sha256:${'a'.repeat(64)}`, ciRequired: false }),
            ],
          },
          { via: 'ui', principal: session },
        ),
      );
      const { token: t } = confirmFor(store, pendingId);
      expect(
        store.apply(next, { via: 'ui', principal: session, confirmation: { pendingId, token: t } }),
      ).toEqual({ ok: false, sessionForbidden: paths });
    }
    expect(store.revision()).toBe(2);
    // The token may.
    expect(store.apply(forbidden[1][0], { via: 'ctl', principal: token }).ok).toBe(true);
  });

  test('repo on an existing zone is refused for every principal with the remove-and-re-add message', () => {
    const { store } = seeded();
    for (const principal of [token, session]) {
      expect(
        store.apply(
          { dropZones: [enforced({ repo: 'octo/elsewhere' })] },
          { via: 'ctl', principal },
        ),
      ).toEqual({
        ok: false,
        issues: [
          {
            path: 'dropZones[main].repo',
            message: "the repository of a zone can't change: remove the zone and add a new one",
          },
        ],
      });
    }
  });

  test('a rollback that weakens a guarded path needs the confirmation page, and one that sets an image is refused from a session', () => {
    const { store } = seeded();
    store.apply(weakened(), { via: 'ctl', principal: token }); // 3: ciRequired false
    store.apply({ dropZones: [enforced()] }, { via: 'ctl', principal: token }); // 4
    const r = store.rollback(3, { principal: session });
    expect(needs(r).guarded.map((g) => g.path)).toEqual(['dropZones[main].ciRequired']);
    const p = store.confirmations.pending(needs(r).pendingId, 'h');
    expect(p?.meta).toMatchObject({ via: 'rollback', note: 'rollback to 3' });
    store.apply(
      { dropZones: [enforced({ image: 'jm-trooper:other' })] },
      { via: 'ctl', principal: token },
    ); // 5
    expect(store.rollback(4, { principal: session })).toEqual({
      ok: false,
      sessionForbidden: ['dropZones[main].image'],
    });
  });
});

describe('zone removal, history and Resume (Task 3)', () => {
  const needsOf = (r: ReturnType<ConfigStore['apply']>) =>
    !r.ok && 'needsConfirmation' in r ? r.needsConfirmation.guarded : r;
  function seeded(zones = [zone('main')]) {
    const w = world();
    const store = w.open();
    expect(store.apply({ dropZones: zones }, { via: 'ctl', principal: token }).ok).toBe(true);
    upsertDropZone(w.db, {
      id: 'main',
      repo: 'octo/main',
      defaultBranch: 'main',
      configJson: '{}',
    });
    return { w, store };
  }
  const work = (db: Db, state: 'running' | 'succeeded') => {
    const wi = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 1,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    insertDrop(db, {
      id: `d-${state}`,
      dropZoneId: 'main',
      workItemId: wi.id,
      role: 'implement',
      state,
      createdAt: t0.toISOString(),
    });
  };
  const modeRow = (db: Db) =>
    db.prepare("SELECT mode FROM zone_controls WHERE zone_id = 'main'").get();
  const count = (db: Db, table: string) =>
    (
      db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE drop_zone_id = 'main'`).get() as {
        c: number;
      }
    ).c;

  test('removing a zone with active work, or not in observe, is refused; a drained observe zone is removed with its mode row only', () => {
    const { w, store } = seeded();
    work(w.db, 'running');
    const refusal = {
      ok: false,
      issues: [
        {
          path: 'dropZones',
          message:
            "zone main can't be removed until it is drained: set it to observe and let its drops and forge writes finish",
        },
      ],
    };
    // Active, with a running drop.
    expect(store.apply({ dropZones: [] }, { via: 'ctl', principal: token })).toEqual(refusal);
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(store.apply({ dropZones: [] }, { via: 'ctl', principal: token })).toEqual(refusal);
    w.db.prepare("UPDATE drops SET state = 'succeeded'").run();
    const r = store.apply({ dropZones: [] }, { via: 'ui', principal: session });
    expect(r).toMatchObject({ ok: true, changed: ['dropZones[main]'] });
    expect(modeRow(w.db)).toBeUndefined();
    // Its history stays.
    expect(count(w.db, 'work_items')).toBe(1);
    expect(count(w.db, 'drops')).toBe(1);
  });

  test('re-adding an id with history is refused without resume, and resumed with it', () => {
    const { w, store } = seeded();
    work(w.db, 'succeeded');
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(store.apply({ dropZones: [] }, { via: 'ctl', principal: token }).ok).toBe(true);
    const back = { dropZones: [zone('main')] };
    expect(store.apply(back, { via: 'ctl', principal: token })).toEqual({
      ok: false,
      issues: [
        { path: 'dropZones.0.id', message: 'this zone has history: pick another id, or resume it' },
      ],
    });
    const r = store.apply(back, { via: 'ctl', principal: token, resume: ['main'] });
    expect(r).toMatchObject({ ok: true, readds: ['main'] });
    // A resumed zone comes back paused, whatever its config mode: the operator resumes it.
    expect(modeRow(w.db)).toEqual({ mode: 'paused' });
    expect(count(w.db, 'work_items')).toBe(1);
  });

  test('resume is refused when the history belongs to another repository', () => {
    const { w, store } = seeded();
    work(w.db, 'succeeded');
    setZoneMode(w.db, 'main', 'observe', t0);
    store.apply({ dropZones: [] }, { via: 'ctl', principal: token });
    expect(
      store.apply(
        { dropZones: [zone('main', { repo: 'octo/other' })] },
        { via: 'ctl', principal: token, resume: ['main'] },
      ),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: 'dropZones.0.id',
          message:
            "zone main's history is for octo/main: resume it with that repository, or pick another id",
        },
      ],
    });
  });

  test('a rollback that re-adds a zone runs the add path and lists it in readds', () => {
    const { w, store } = seeded();
    work(w.db, 'succeeded');
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(store.apply({ dropZones: [] }, { via: 'ctl', principal: token }).ok).toBe(true);
    const r = store.rollback(2, { principal: token });
    expect(r).toMatchObject({ ok: true, revision: 4, readds: ['main'] });
    // A rollback never restarts work as a side effect: the re-added zone is paused.
    expect(modeRow(w.db)).toEqual({ mode: 'paused' });
    // From a session the re-added zone is judged against the add baseline: its image is refused.
    setZoneMode(w.db, 'main', 'observe', t0);
    store.apply({ dropZones: [] }, { via: 'ctl', principal: token });
    expect(store.rollback(2, { principal: session })).toEqual({
      ok: false,
      sessionForbidden: ['dropZones[main].image'],
    });
  });

  test('an added zone is judged against the add baseline through the PATCH route, Resume, rollback and an import alike', () => {
    // A zone added with egress off (the baseline is monitor) and no image (a preset): guarded.
    const added = zone('main', {
      image: undefined,
      preset: 'node',
      egress: { mode: 'off', allow: [] },
    });
    const expected = [
      {
        path: 'dropZones[main].repo',
        consequence:
          'A new project, octo/main: its code will run in drops with your Claude credentials, and Jumpmaster will act on its issues and PRs with the forge tokens',
      },
      {
        path: 'dropZones[main].egress.mode',
        consequence: 'Drops in main will be able to reach any host on the internet',
      },
    ];
    const fresh = () => {
      const w = world();
      return { w, store: w.open({ env: { ...env, JM_DEV_IMAGES: '1' } }) };
    };
    // The wizard's PATCH.
    const a = fresh();
    expect(
      needsOf(a.store.apply({ dropZones: [added] }, { via: 'ui', principal: session })),
    ).toEqual(expected);
    // An import of the advanced JSON.
    const b = fresh();
    expect(
      needsOf(b.store.importDoc({ dropZones: [added] }, { via: 'import', principal: session })),
    ).toEqual(expected);
    // Resume and rollback, after the zone ran and was removed.
    const c = fresh();
    c.store.apply({ dropZones: [added] }, { via: 'ctl', principal: token }); // 2
    upsertDropZone(c.w.db, {
      id: 'main',
      repo: 'octo/main',
      defaultBranch: 'main',
      configJson: '{}',
    });
    work(c.w.db, 'succeeded');
    setZoneMode(c.w.db, 'main', 'observe', t0);
    c.store.apply({ dropZones: [] }, { via: 'ctl', principal: token }); // 3
    expect(
      needsOf(
        c.store.apply({ dropZones: [added] }, { via: 'ui', principal: session, resume: ['main'] }),
      ),
    ).toEqual(expected);
    expect(needsOf(c.store.rollback(2, { principal: session }))).toEqual(expected);
  });

  test('a file reload is the file: it removes and re-adds zones without the drained or history rules', () => {
    const w = world({ dropZones: [zone('main')] });
    const store = w.open();
    upsertDropZone(w.db, {
      id: 'main',
      repo: 'octo/main',
      defaultBranch: 'main',
      configJson: '{}',
    });
    work(w.db, 'running');
    writeConfig(w.file, { dropZones: [] });
    expect(store.reload().ok).toBe(true);
    writeConfig(w.file, { dropZones: [zone('main', { ciRequired: false })] });
    expect(store.reload().ok).toBe(true);
    expect(store.current().dropZones[0]?.ciRequired).toBe(false);
  });
});
