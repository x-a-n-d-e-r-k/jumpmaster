import { existsSync, readFileSync } from 'node:fs';
import type { Principal } from '../auth/guard.js';
import {
  assembleSecrets,
  BOOT_MESSAGE,
  type Config,
  type ConfigIssue,
  type DropZoneConfig,
  type EditableConfig,
  formatIssues,
  gateSecretsOf,
  loadMachineSecrets,
  mcpConfigOf,
  parseEditable,
  secretList,
  splitConfigFile,
} from '../config.js';
import type { Db } from '../db/open.js';
import {
  deleteZoneControls,
  ensureZoneMode,
  setZoneMode,
  zoneDrained,
  zoneHasHistory,
  zoneHistoryRepo,
} from '../db/repo.js';
import {
  type CredentialName,
  type Resolved,
  type ResolvedCredential,
  resolveCredentials,
} from '../vault/credentials.js';
import { type CredentialProblem, credentialProblems } from '../vault/problems.js';
import { fingerprintOf, type Vault, type VaultMeta } from '../vault/vault.js';
import type { BootConfig } from './boot.js';
import { RESTART_PATHS } from './boot.js';
import { Confirmations, type ConsumeFailure } from './confirm.js';
import { type Change, diff } from './diff.js';
import { type Classification, classify } from './guarded.js';
import {
  canonicalJson,
  deleteSetting,
  getRevision,
  getRevisions,
  getSetting,
  hashOf,
  insertRevision,
  latestRevisionVia,
  listRevisions,
  MAX_NOTE,
  type RevisionVia,
  setSetting,
} from './revisions.js';
import type { ConfigMode, ConfigSource, ConfigStatus } from './source.js';

/**
 * The config store (§10.3 live config). The database holds config revisions; the running system
 * reads `current()` at the top of every pass and request, so a change applies without a restart.
 *
 * An install is in **file mode** (the config file is the truth, re-read on `reload`; the UI and
 * `ctl` cannot write) or **db mode** (no file, or the file was adopted: `apply` writes revisions).
 * Every write validates the whole document first and then changes the revision row and the
 * current pointer in one transaction, and only then swaps the in-memory config: a revision that
 * fails validation or storage changes nothing.
 */

export type { ConfigMode, ConfigSource, ConfigStatus } from './source.js';

export type ApplyMeta = {
  via: 'ui' | 'ctl' | 'import' | 'rollback';
  principal: Principal;
  note?: string;
  expectRevision?: number;
  /**
   * A session's confirmation of a pending guarded change: the token the confirmation page minted,
   * naming the pending change it confirms. Only the confirm page's POST sets it, after the
   * passphrase; no API body carries it.
   */
  confirmation?: { pendingId: string; token: string };
  /** Zone ids with history the operator chose to resume (`ctl zones add --resume`). */
  resume?: string[];
  /** Where the confirm page goes after applying a pending change (a path on this host). */
  returnTo?: string;
};

/** Mode switches and rollbacks: the via is the operation's own. */
export type OpMeta = { principal: Principal; note?: string; expectRevision?: number };

export type ApplyResult =
  | {
      ok: true;
      revision: number;
      changed: string[];
      restartNeeded: string[];
      /** Zones added back with their history (resumed, or re-added by a rollback); when any. */
      readds?: string[];
      /** The guarded paths this apply changed (token, file or confirmed); when any. */
      guarded?: string[];
    }
  | { ok: false; issues: ConfigIssue[] }
  | { ok: false; conflict: { expected: number; actual: number } }
  | {
      ok: false;
      needsConfirmation: {
        pendingId: string;
        guarded: Classification['guarded'];
        /** The revision the change was judged against. */
        expectRevision: number;
      };
    }
  | { ok: false; sessionForbidden: string[] }
  | { ok: false; confirmation: ConsumeFailure };

export type RevisionView = {
  id: number;
  parentId: number | null;
  createdAt: string;
  via: RevisionVia;
  note: string | null;
  changes: Change[];
};

export type StoreOptions = {
  db: Db;
  boot: BootConfig;
  /** The config file's path (`serve <path>` or `JM_CONFIG`); it need not exist. */
  filePath?: string;
  env: NodeJS.ProcessEnv;
  now(): Date;
  imageLockPath?: string;
  log?: (msg: string) => void;
  /**
   * The vault (Task 4): credentials neither a variable nor a file under the secrets directory
   * supplies. Absent: `'disabled'`.
   */
  vault?: Vault | 'disabled';
  /**
   * A test seam: the secrets for a set of zones, instead of resolving them from the environment,
   * the secrets directory and the vault.
   */
  secretsFor?: (zones: readonly DropZoneConfig[]) => Config['secrets'];
};

/** How many replaced secret values the log and audit scrub keep redacting. */
const MAX_RETIRED = 32;

const TOKEN_ONLY = 'this needs the operator token: run it with jumpmaster ctl';
const unchanged = (revision: number, restartNeeded: string[] = []): ApplyResult => ({
  ok: true,
  revision,
  changed: [],
  restartNeeded,
});
const refused = (message: string, path = ''): ApplyResult => ({
  ok: false,
  issues: [{ path, message }],
});
const tooLong = (note: string | undefined): boolean => note !== undefined && note.length > MAX_NOTE;
const noteRefused = (): ApplyResult => refused(`a note is at most ${MAX_NOTE} characters`, 'note');
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The effective value of each restart-only path. */
const restartValues = (c: EditableConfig): Record<(typeof RESTART_PATHS)[number], unknown> => ({
  'mcp.enabled': mcpConfigOf(c).enabled,
  'mcp.maxBodyBytes': mcpConfigOf(c).maxBodyBytes,
});

type Valid = {
  editable: EditableConfig;
  resolved: Resolved;
  secrets: Config['secrets'];
  warnings?: string[];
};

/**
 * The document as it will be stored, read back from its canonical JSON: own data properties
 * only, so what is validated, what is stored and what runs are one document (nothing can come
 * from a prototype the stored text does not hold).
 */
const asStored = (doc: unknown): unknown =>
  doc === undefined ? undefined : (JSON.parse(canonicalJson(doc)) as unknown);

export class ConfigStore implements ConfigSource {
  private modeValue: ConfigMode = 'db';
  private rev = 0;
  private doc: Record<string, unknown> = {};
  private cfg!: Config;
  /** The editable config this process started with: restart-only paths are judged against it. */
  private running!: EditableConfig;
  /** Boot settings a reload found changed in the file (a restart applies them). */
  private bootPending: string[] = [];
  private fileProblem: ConfigIssue[] | undefined;
  /** What the lenient read of the file adjusted (an out-of-range pollSeconds), while it runs. */
  private warnings: string[] | undefined;
  private readonly subscribers = new Set<(c: Config, rev: number, changes: Change[]) => void>();
  /** Guarded changes from sessions waiting for the confirmation page (in memory only). */
  readonly confirmations: Confirmations;
  private resolvedValue!: Resolved;
  private readonly retiredValues = new Set<string>();
  private readonly warned = new Set<string>();

  private constructor(private readonly o: StoreOptions) {
    this.confirmations = new Confirmations(o.now);
  }

  /**
   * Decides the mode and loads the current revision. The mode is the stored one; else a config
   * file present means file mode (revision 1 recorded `via: 'file'` when its content is new) and
   * no file means db mode (revision 1 = the defaults with no zones, `via: 'setup'`). An invalid
   * file, or file mode without its file, stops the start.
   */
  static open(o: StoreOptions): ConfigStore {
    const s = new ConfigStore(o);
    const { db } = o;
    const stored = getSetting(db, 'config.mode');
    const fileExists = s.fileExists();
    const now = o.now();
    if (stored === 'file' || (stored === undefined && fileExists)) {
      if (!fileExists)
        throw new Error(
          `config mode is file, but ${o.filePath ?? 'the config file'} does not exist: restore it, or start with the file it was exported to`,
        );
      const doc = s.readFileDoc();
      const v = s.validate(doc);
      if ('issues' in v) throw new Error(`Invalid config ${o.filePath}: ${formatIssues(v.issues)}`);
      const cur = s.storedCurrent();
      const hash = hashOf(canonicalJson(doc));
      db.transaction(() => {
        if (!cur || cur.sourceHash !== hash) {
          const id = insertRevision(db, { parentId: cur?.id ?? null, doc, via: 'file' }, now);
          setSetting(db, 'config.current', id, now);
        }
        setSetting(db, 'config.mode', 'file', now);
      })();
      s.modeValue = 'file';
      s.load(doc, v);
    } else {
      let cur = s.storedCurrent();
      // An install already in db mode never starts empty: that would drop every zone.
      if (!cur && stored === 'db')
        throw new Error(
          'config mode is db, but the current revision is missing: restore the data directory from a backup, or the config file from `ctl config export`',
        );
      if (!cur) {
        db.transaction(() => {
          const id = insertRevision(db, { parentId: null, doc: {}, via: 'setup' }, now);
          setSetting(db, 'config.current', id, now);
          setSetting(db, 'config.mode', 'db', now);
        })();
        cur = s.storedCurrent();
      }
      if (!cur) throw new Error('the config store could not record its first revision');
      if (stored === undefined) setSetting(db, 'config.mode', 'db', now);
      const v = s.validate(cur.doc);
      if ('issues' in v)
        throw new Error(
          `the stored config (revision ${cur.id}) is invalid: ${formatIssues(v.issues)}; roll back with jumpmaster ctl config rollback once the server runs, or restore the data directory`,
        );
      s.modeValue = 'db';
      s.load(cur.doc, v);
      const ignored = s.status().fileIgnored;
      if (ignored) o.log?.(ignored);
    }
    s.running = s.cfg;
    // A fresh start runs with every setting: nothing waits for a restart.
    deleteSetting(db, 'config.restart_pending');
    for (const zone of s.cfg.dropZones) ensureZoneMode(db, zone.id, zone.mode, now);
    return s;
  }

  current(): Config {
    return this.cfg;
  }

  mode(): ConfigMode {
    return this.modeValue;
  }

  revision(): number {
    return this.rev;
  }

  /** The current editable document as stored (what a merge patch applies to). */
  document(): Record<string, unknown> {
    return structuredClone(this.doc);
  }

  boot(): BootConfig {
    return this.o.boot;
  }

  status(): ConfigStatus {
    const { filePath } = this.o;
    let ignored: { fileIgnored: string; fileMatchesExport: boolean } | undefined;
    if (this.modeValue === 'db' && this.fileExists()) {
      const adopted = latestRevisionVia(this.o.db, 'adopt');
      let mirror = false;
      try {
        mirror = hashOf(readFileSync(filePath as string, 'utf8')) === hashOf(this.exportJson());
      } catch {
        mirror = false;
      }
      ignored = {
        fileIgnored: adopted
          ? `config file ignored: adopted on ${adopted.createdAt}`
          : 'config file ignored: this install keeps its config in the database',
        fileMatchesExport: mirror,
      };
    }
    return {
      mode: this.modeValue,
      revision: this.rev,
      ...(filePath ? { filePath } : {}),
      ...(this.fileProblem ? { fileProblem: this.fileProblem } : {}),
      ...(ignored ?? {}),
      ...(this.warnings ? { warnings: this.warnings } : {}),
      restartPending: this.pending(this.cfg),
    };
  }

  subscribe(fn: (c: Config, rev: number, changes: Change[]) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Validates `next` as the whole editable document and stores it as a new revision. Before it
   * commits, the change is classified (guarded.ts): a `repo` change on an existing zone is refused
   * for everyone; a removed zone must be drained in observe; an added id with history needs
   * `resume` (a rollback implies it). From a session, a session-forbidden change is refused
   * whatever else the set carries, and a guarded one is held as a pending change until the
   * confirmation page confirms it (`meta.confirmation`). The token is the operator's business.
   */
  apply(next: unknown, meta: ApplyMeta): ApplyResult {
    if (tooLong(meta.note)) return noteRefused();
    if (this.modeValue === 'file')
      return refused(
        `config is managed by the file at ${this.o.filePath}: edit it and run \`jumpmaster ctl config reload\`, or adopt it into the UI`,
      );
    // A confirmed change reports a moved revision as a stale confirmation, below.
    if (!meta.confirmation && meta.expectRevision !== undefined && meta.expectRevision !== this.rev)
      return { ok: false, conflict: { expected: meta.expectRevision, actual: this.rev } };
    const doc = asStored(next) as Record<string, unknown>;
    const v = this.validate(doc, true);
    if ('issues' in v) return { ok: false, issues: v.issues };
    let c: Classification;
    try {
      c = classify(this.doc, doc);
    } catch (e) {
      // Fail closed: what cannot be judged is not applied.
      return refused(`the change could not be judged: ${(e as Error).message}`);
    }
    if (c.refused.length > 0) return { ok: false, issues: c.refused };
    const zones = this.zoneRules(doc, c, meta);
    if ('issues' in zones) return { ok: false, issues: zones.issues };
    const p = meta.principal;
    if (p.via === 'session') {
      if (c.sessionForbidden.length > 0) return { ok: false, sessionForbidden: c.sessionForbidden };
      const sid = p.sessionId;
      if ((meta.confirmation || c.guarded.length > 0) && !sid)
        return refused('a session without an id cannot confirm a change');
      if (meta.confirmation && sid) {
        // Spent whether or not the change still weakens anything: a confirmation is single-use.
        const used = this.confirmations.consumeFor(meta.confirmation, doc, sid, this.rev);
        if (!used.ok) return { ok: false, confirmation: used.reason };
      } else if (c.guarded.length > 0 && sid) {
        const { confirmation: _c, returnTo, ...kept } = meta;
        const pending = this.confirmations.addPending({
          sessionIdHash: sid,
          patch: doc,
          expectRevision: this.rev,
          meta: kept,
          ...(returnTo ? { returnTo } : {}),
          guarded: c.guarded,
          notes: c.notes,
        });
        return {
          ok: false,
          needsConfirmation: {
            pendingId: pending.id,
            guarded: c.guarded,
            expectRevision: pending.expectRevision,
          },
        };
      }
    }
    if (hashOf(canonicalJson(doc)) === hashOf(canonicalJson(this.doc))) return unchanged(this.rev);
    const r = this.commit(doc, v, meta.via, meta.note, undefined, c.removed, zones.readds);
    if (r.ok) {
      if (zones.readds.length > 0) r.readds = zones.readds;
      const guarded = [...new Set(c.guarded.map((g) => g.path))];
      if (guarded.length > 0) r.guarded = guarded;
    }
    return r;
  }

  /**
   * The zone rules every principal meets: a removed zone is drained in observe; an added id with
   * history is resumed (`meta.resume`, or a rollback, which re-adds what it restores) and only with
   * the repository its history was recorded against.
   */
  private zoneRules(
    doc: Record<string, unknown>,
    c: Classification,
    meta: ApplyMeta,
  ): { readds: string[] } | { issues: ConfigIssue[] } {
    const { db } = this.o;
    const issues: ConfigIssue[] = [];
    for (const id of c.removed)
      if (!zoneDrained(db, id))
        issues.push({
          path: 'dropZones',
          message: `zone ${id} can't be removed until it is drained: set it to observe and let its drops and forge writes finish`,
        });
    const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as {
      id?: unknown;
      repo?: unknown;
    }[];
    const readds: string[] = [];
    for (const id of c.added) {
      if (!zoneHasHistory(db, id)) continue;
      const i = zones.findIndex((z) => z.id === id);
      const at = `dropZones.${i}.id`;
      if (meta.via !== 'rollback' && !meta.resume?.includes(id)) {
        issues.push({ path: at, message: 'this zone has history: pick another id, or resume it' });
        continue;
      }
      const repo = zoneHistoryRepo(db, id);
      if (repo !== undefined && repo !== zones[i]?.repo) {
        issues.push({
          path: at,
          message: `zone ${id}'s history is for ${repo}: resume it with that repository, or pick another id`,
        });
        continue;
      }
      readds.push(id);
    }
    return issues.length > 0 ? { issues } : { readds };
  }

  /**
   * An import: the exported document, boot settings included. A boot setting equal to the running
   * one is dropped; a different one is refused at its path.
   */
  importDoc(json: unknown, meta: ApplyMeta): ApplyResult {
    const s = this.withoutBoot(json);
    if ('issues' in s) return { ok: false, issues: s.issues };
    return this.apply(s.doc, meta);
  }

  /**
   * What an import would change, why it would be refused, and what of it is guarded or
   * session-forbidden (judged only when it is valid), without applying anything.
   */
  preview(json: unknown): {
    changes: Change[];
    issues: ConfigIssue[];
    guarded: Classification['guarded'];
    sessionForbidden: string[];
  } {
    const none = { guarded: [], sessionForbidden: [] };
    const s = this.withoutBoot(json);
    if ('issues' in s) return { changes: [], issues: s.issues, ...none };
    const doc = asStored(s.doc) as Record<string, unknown>;
    const v = this.validate(doc, true);
    if ('issues' in v) return { changes: diff(this.doc, doc), issues: v.issues, ...none };
    const c = classify(this.doc, doc);
    return {
      changes: diff(this.doc, doc),
      issues: c.refused,
      guarded: c.guarded,
      sessionForbidden: c.sessionForbidden,
    };
  }

  private withoutBoot(json: unknown): { doc: Record<string, unknown> } | { issues: ConfigIssue[] } {
    if (!isObject(json))
      return { issues: [{ path: '', message: 'the config must be a JSON object' }] };
    const { listen, dataDir, ...doc } = json;
    const exported = this.exportDoc();
    const issues: ConfigIssue[] = [];
    if (listen !== undefined && canonicalJson(listen) !== canonicalJson(exported.listen))
      issues.push({ path: 'listen', message: BOOT_MESSAGE });
    if (dataDir !== undefined && dataDir !== exported.dataDir)
      issues.push({ path: 'dataDir', message: BOOT_MESSAGE });
    return issues.length > 0 ? { issues } : { doc };
  }

  /**
   * Judges `next` exactly as `apply` would (strict schema, rules, secrets) and changes nothing:
   * the seam for a caller that must look at the validated document before applying it (Task 3's
   * guarded-path classifier).
   */
  validateOnly(
    next: unknown,
  ): { ok: true; config: EditableConfig } | { ok: false; issues: ConfigIssue[] } {
    const v = this.validate(asStored(next), true);
    return 'issues' in v ? { ok: false, issues: v.issues } : { ok: true, config: v.editable };
  }

  /**
   * Re-reads the secrets for the current zones (Task 4: a credential replaced or a secrets
   * reload) and swaps them in with no new revision; subscribers hear it with no changes, so the
   * forge pairs rebuild at the next pass. A failed read keeps the old secrets.
   */
  refreshSecrets(): ApplyResult {
    const v = this.validate(this.doc);
    if ('issues' in v) return { ok: false, issues: v.issues };
    this.load(this.doc, v);
    this.notify([]);
    return unchanged(this.rev);
  }

  /** Every credential as it resolved: source, path, fingerprint, dates and the value. */
  resolved(): Resolved {
    return this.resolvedValue;
  }

  /** The vault, or `'disabled'` when there is no key file. */
  vault(): Vault | 'disabled' {
    return this.o.vault ?? 'disabled';
  }

  /** The credential problems of every zone (dispatch refusals; doctor `credential.*`). */
  problems(): CredentialProblem[] {
    return this.cfg.dropZones.flatMap((z) => credentialProblems(z, this.resolvedValue));
  }

  /** Secret values replaced while this process ran: logs and audit rows keep redacting them. */
  retired(): string[] {
    return [...this.retiredValues];
  }

  /**
   * Stores a credential in the vault and swaps it in. When the new set does not load (a value
   * equal to the operator token, say), the previous entry is put back exactly as it was and the
   * old credential stays in effect.
   */
  putCredential(
    name: CredentialName,
    value: string,
    o: { declaredCreatedAt?: string; note?: string; test?: { result: string; login?: string } },
  ): { ok: true; meta: VaultMeta } | { ok: false; issues: ConfigIssue[] } {
    const vault = this.vault();
    if (vault === 'disabled') return { ok: false, issues: [{ path: '', message: VAULT_DISABLED }] };
    const before = vault.snapshot(name);
    const now = this.o.now();
    const meta = vault.put(name, value, { now, ...o });
    if (o.test) vault.recordTest(name, { at: now, ...o.test });
    const r = this.refreshSecrets();
    if (!r.ok) {
      vault.restore(name, before);
      return { ok: false, issues: 'issues' in r ? r.issues : [] };
    }
    return { ok: true, meta: vault.meta(name) ?? meta };
  }

  /** Removes a vault entry and swaps the credentials; refused when the vault is off. */
  deleteCredential(
    name: CredentialName,
  ): { ok: true; deleted: boolean } | { ok: false; issues: ConfigIssue[] } {
    const vault = this.vault();
    if (vault === 'disabled') return { ok: false, issues: [{ path: '', message: VAULT_DISABLED }] };
    const before = vault.snapshot(name);
    const deleted = vault.delete(name);
    const r = this.refreshSecrets();
    if (!r.ok) {
      vault.restore(name, before);
      return { ok: false, issues: 'issues' in r ? r.issues : [] };
    }
    return { ok: true, deleted };
  }

  /** A new revision with an old revision's content; history is never deleted. */
  rollback(id: number, meta: OpMeta): ApplyResult {
    const old = getRevision(this.o.db, id);
    if (!old) return refused(`no revision ${id}`, 'id');
    return this.apply(old.doc, {
      ...meta,
      via: 'rollback',
      note: meta.note ?? `rollback to ${id}`,
    });
  }

  /**
   * File mode: re-reads the file. Invalid → the old config stays and the doctor reports it; valid
   * and changed → a new revision; a changed boot setting is listed as needing a restart. In db
   * mode the file is ignored and this changes nothing.
   */
  reload(): ApplyResult {
    if (this.modeValue === 'db') return unchanged(this.rev);
    let text: string;
    let split: ReturnType<typeof splitConfigFile>;
    try {
      text = readFileSync(this.o.filePath as string, 'utf8');
      split = splitConfigFile(this.o.filePath as string, text);
    } catch (e) {
      this.fileProblem = [{ path: '', message: (e as Error).message }];
      return { ok: false, issues: this.fileProblem };
    }
    const v = this.validate(split.editable);
    if ('issues' in v) {
      this.fileProblem = v.issues;
      return { ok: false, issues: v.issues };
    }
    this.fileProblem = undefined;
    this.bootPending = this.bootChanges(split.boot);
    const doc = split.editable;
    if (hashOf(canonicalJson(doc)) === hashOf(canonicalJson(this.doc))) {
      this.storePending(this.cfg);
      return unchanged(this.rev, [...this.bootPending]);
    }
    const r = this.commit(doc, v, 'file');
    if (r.ok) r.restartNeeded = [...this.bootPending, ...r.restartNeeded];
    return r;
  }

  /** File mode → db mode: the file as it is now becomes a revision `via: 'adopt'`. */
  adopt(meta: OpMeta): ApplyResult {
    if (this.modeValue === 'db') return refused('config is already in the database (db mode)');
    // Before the reload, which may itself record a revision.
    if (tooLong(meta.note)) return noteRefused();
    const r = this.reload();
    if (!r.ok) return r;
    const v = this.validate(this.doc, true);
    if ('issues' in v) return { ok: false, issues: v.issues };
    const done = this.commit(this.doc, v, 'adopt', meta.note, 'db');
    if (done.ok) done.restartNeeded = r.restartNeeded;
    return done;
  }

  /**
   * Db mode → file mode, with the operator token only: refused unless the file's bytes equal
   * `exportJson()`, so nothing in the database is lost on the way.
   */
  toFileMode(meta: OpMeta): ApplyResult {
    if (meta.principal.via !== 'token') return refused(TOKEN_ONLY);
    if (this.modeValue === 'file') return refused('config is already managed by the file');
    if (!this.o.filePath)
      return refused(
        'no config file path is set (JM_CONFIG, or jumpmaster serve <path>): set one and write `ctl config export` to it first',
      );
    if (!this.fileExists())
      return refused(
        `there is no config file at ${this.o.filePath}: write \`ctl config export\` to it first`,
      );
    const text = readFileSync(this.o.filePath, 'utf8');
    if (hashOf(text) !== hashOf(this.exportJson()))
      return refused(
        'the file differs from the current config: write `ctl config export` to it first',
      );
    const v = this.validate(this.doc, true);
    if ('issues' in v) return { ok: false, issues: v.issues };
    return this.commit(this.doc, v, 'ctl', 'to file mode', 'file');
  }

  /** The editable document plus the boot settings, without secrets, as byte-stable JSON. */
  exportJson(): string {
    return canonicalJson(this.exportDoc());
  }

  revisions(limit: number): RevisionView[] {
    const { db } = this.o;
    const list = listRevisions(db, limit);
    // Parents in one query: most are in the list itself, the oldest one's usually is not.
    const parents = new Map(list.map((r) => [r.id, r.doc]));
    const missing = list.flatMap((r) =>
      r.parentId !== null && !parents.has(r.parentId) ? [r.parentId] : [],
    );
    for (const p of getRevisions(db, missing)) parents.set(p.id, p.doc);
    return list.map((r) => {
      const parent = r.parentId === null ? undefined : parents.get(r.parentId);
      return {
        id: r.id,
        parentId: r.parentId,
        createdAt: r.createdAt,
        via: r.via,
        note: r.note,
        changes: diff(parent ?? {}, r.doc),
      };
    });
  }

  // -------------------------------------------------------------------------------------------

  private notify(changes: Change[]): void {
    for (const fn of this.subscribers) {
      try {
        fn(this.cfg, this.rev, changes);
      } catch (e) {
        this.o.log?.(`config subscriber failed: ${(e as Error).message}`);
      }
    }
  }

  private exportDoc(): Record<string, unknown> {
    const { listen, dataDir } = this.o.boot;
    return {
      ...this.doc,
      listen: {
        host: listen.host,
        port: listen.port,
        allowedHosts: listen.allowedHosts,
        ...(listen.tlsTerminated ? { tlsTerminated: true } : {}),
      },
      dataDir,
    };
  }

  private fileExists(): boolean {
    return this.o.filePath !== undefined && existsSync(this.o.filePath);
  }

  private readFileDoc(): Record<string, unknown> {
    const path = this.o.filePath as string;
    return splitConfigFile(path, readFileSync(path, 'utf8')).editable;
  }

  private storedCurrent() {
    const id = getSetting(this.o.db, 'config.current');
    return typeof id === 'number' ? getRevision(this.o.db, id) : undefined;
  }

  /**
   * `strict` (every write from the UI, ctl, an import or an adopt) refuses keys the schema does
   * not know. The file as file mode reads it, and a stored revision at start, are read as M4 read
   * the file: unknown keys ignored.
   */
  private validate(doc: unknown, strict = false): Valid | { issues: ConfigIssue[] } {
    const parsed = parseEditable(doc, {
      ...(this.o.imageLockPath ? { imageLockPath: this.o.imageLockPath } : {}),
      devImages: this.o.env.JM_DEV_IMAGES === '1',
      strict,
    });
    if (!parsed.ok) return { issues: parsed.issues };
    // No credential rule here (they are dispatch refusals: vault/problems.ts). Only a secret that
    // cannot be read at all (a file's mode, a variable set both ways) stops the change.
    try {
      const zones = parsed.config.dropZones;
      let resolved: Resolved;
      let secrets: Config['secrets'];
      if (this.o.secretsFor) {
        secrets = this.o.secretsFor(zones);
        resolved = resolvedFromSecrets(secrets, zones);
      } else {
        resolved = resolveCredentials(this.o.env, this.o.boot.secretsDir, this.vault(), {
          gateSecrets: gateSecretsOf(zones),
          warn: (m) => this.warnOnce(m),
        });
        secrets = assembleSecrets(resolved, loadMachineSecrets(this.o.env, resolved), zones);
      }
      return {
        editable: parsed.config,
        resolved,
        secrets,
        ...(parsed.warnings ? { warnings: parsed.warnings } : {}),
      };
    } catch (e) {
      return { issues: [{ path: '', message: (e as Error).message }] };
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.o.log?.(`warning: ${msg}`);
  }

  private load(doc: Record<string, unknown>, v: Valid): void {
    const id = getSetting(this.o.db, 'config.current');
    this.rev = typeof id === 'number' ? id : 0;
    this.doc = doc;
    this.warnings = v.warnings;
    for (const w of v.warnings ?? []) this.o.log?.(`config: ${w}`);
    const { listen, dataDir } = this.o.boot;
    // A replaced value stays in the scrub lists: a running drop and a log line may still carry it.
    if (this.cfg) {
      const now = new Set(secretList(v.secrets));
      for (const old of secretList(this.cfg.secrets))
        if (!now.has(old)) this.retiredValues.add(old);
      while (this.retiredValues.size > MAX_RETIRED) {
        this.retiredValues.delete(this.retiredValues.values().next().value as string);
        this.o.log?.(
          `warning: a replaced secret left the redaction list (it keeps the latest ${MAX_RETIRED}); restart the server once the drops that carried it are done`,
        );
      }
    }
    this.resolvedValue = v.resolved;
    this.cfg = { listen, dataDir, ...v.editable, secrets: v.secrets };
  }

  /** Restart-only paths whose new value differs from the one this process runs with. */
  private pending(c: EditableConfig): string[] {
    if (!this.running) return [...this.bootPending];
    const was = restartValues(this.running);
    const now = restartValues(c);
    return [...this.bootPending, ...RESTART_PATHS.filter((p) => was[p] !== now[p])];
  }

  private storePending(c: EditableConfig): void {
    const list = this.pending(c);
    if (list.length > 0) setSetting(this.o.db, 'config.restart_pending', list, this.o.now());
    else deleteSetting(this.o.db, 'config.restart_pending');
  }

  private bootChanges(file: Pick<Config, 'listen' | 'dataDir'>): string[] {
    const run = this.o.boot;
    const out: string[] = [];
    const listen = {
      host: file.listen.host,
      port: file.listen.port,
      allowedHosts: file.listen.allowedHosts,
      tlsTerminated: run.listen.tlsTerminated || file.listen.tlsTerminated === true,
    };
    const running = {
      host: run.listen.host,
      port: run.listen.port,
      allowedHosts: run.listen.allowedHosts,
      tlsTerminated: run.listen.tlsTerminated,
    };
    if (run.source.listen !== 'file' || canonicalJson(listen) !== canonicalJson(running))
      out.push('listen');
    if (run.source.dataDir !== 'file' || file.dataDir !== run.dataDir) out.push('dataDir');
    return out;
  }

  /**
   * One transaction: the revision row, the current pointer, the new zones' mode rows, the
   * restart marker and (for a mode switch) the mode. Then the in-memory swap, then subscribers.
   */
  private commit(
    doc: Record<string, unknown>,
    v: Valid,
    via: RevisionVia,
    note?: string,
    mode?: ConfigMode,
    /** Zones this revision removes: their mode rows go with it (their history stays). */
    removed: string[] = [],
    /** Zones re-added with their history: they come back paused, never dispatching at once. */
    readds: string[] = [],
  ): ApplyResult {
    // Every path checks the note first; this keeps a long one a refusal, never a storage error.
    if (tooLong(note)) return noteRefused();
    const { db } = this.o;
    const now = this.o.now();
    const before = this.cfg.dropZones.map((z) => z.id);
    const was = restartValues(this.cfg);
    const id = db.transaction(() => {
      const rid = insertRevision(
        db,
        { parentId: this.rev || null, doc, via, ...(note !== undefined ? { note } : {}) },
        now,
      );
      setSetting(db, 'config.current', rid, now);
      for (const zone of v.editable.dropZones)
        if (!before.includes(zone.id)) ensureZoneMode(db, zone.id, zone.mode, now);
      // A re-added zone is paused whatever row it left behind: a file-mode removal (or an M4
      // hand edit) keeps a stale row, which ensureZoneMode would leave as it is.
      for (const id of readds) setZoneMode(db, id, 'paused', now);
      for (const id of removed) deleteZoneControls(db, id);
      this.storePending(v.editable);
      if (mode) setSetting(db, 'config.mode', mode, now);
      return rid;
    })();
    const changes = diff(this.doc, doc);
    if (mode) this.modeValue = mode;
    this.load(doc, v);
    const after = restartValues(v.editable);
    const restartNeeded = RESTART_PATHS.filter((p) => was[p] !== after[p]);
    this.notify(changes);
    return { ok: true, revision: id, changed: changes.map((c) => c.path), restartNeeded };
  }
}

export const VAULT_DISABLED =
  'the vault is off: set JM_VAULT_KEY_FILE (a 32-byte key file under ./secrets), or write the credential to its file under secrets/';

/** The test seam's secrets as resolved credentials (source `env`). */
function resolvedFromSecrets(
  s: Config['secrets'],
  zones: readonly { id: string; gateSecrets: string[] }[],
): Resolved {
  const one = (value: string | undefined, path: string): ResolvedCredential =>
    value
      ? { value, source: 'env', path, fingerprint: fingerprintOf(value) }
      : { source: 'missing' };
  const out = {
    claudeToken: one(s.claudeToken, 'JM_CLAUDE_TOKEN'),
    githubAuthorToken: one(s.githubAuthorToken, 'JM_GITHUB_AUTHOR_TOKEN'),
    githubReviewerToken: one(s.githubReviewerToken, 'JM_GITHUB_REVIEWER_TOKEN'),
    githubReadToken: one(s.githubReadToken, 'JM_GITHUB_READ_TOKEN'),
  } as Resolved;
  for (const z of zones)
    for (const name of z.gateSecrets) {
      const v =
        s.zoneSecrets && Object.hasOwn(s.zoneSecrets, z.id)
          ? s.zoneSecrets[z.id]?.[name]
          : undefined;
      Object.defineProperty(out, `zone:${z.id}:${name}`, { value: one(v, name), enumerable: true });
    }
  return out;
}
