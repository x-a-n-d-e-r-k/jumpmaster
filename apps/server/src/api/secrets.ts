import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditDetail } from '../auth/audit.js';
import { type ConfigStore, VAULT_DISABLED } from '../config/store.js';
import type { Db } from '../db/open.js';
import { ACTIVE_STATES_SQL } from '../db/repo.js';
import { GitHubForge } from '../forge/github.js';
import { MAX_SECRET_FILE_BYTES } from '../secrets.js';
import {
  CREDENTIAL_ROLES,
  type CredentialName,
  isCredentialName,
  isInstallCredential,
  parseGateSecretName,
  type Resolved,
  refusalWords,
  type TestDeps,
  testAppEntry,
  testCredential,
} from '../vault/credentials.js';
import {
  APP_ROLES,
  type AppEntryRead,
  type AppRole,
  parseAppEntryName,
} from '../vault/github-app-entries.js';
import { credentialProblems } from '../vault/problems.js';
import { fingerprintOf } from '../vault/vault.js';

/**
 * The credential routes (§7.5): list, replace, test, remove and reload; and the vault's switches
 * (#101): turn it on or off, prefer it over variables and files, copy a credential into it. No route ever returns,
 * logs or audits a value: the list carries fingerprints and dates; a failed test returns the HTTP
 * status, the permission GitHub names and `refusalWords`' sentence built from those two (never
 * GitHub's message); audit details are built from named
 * fields only (`{ name, fingerprint, result }`), never from the request body.
 */

export type SecretRouteDeps = {
  db: Db;
  store: ConfigStore;
  now(): Date;
  audit(req: FastifyRequest, action: string, detail: AuditDetail, target?: string): void;
  /** A forge on a token for a repository, for tests on entry (default: GitHub, with a deadline). */
  credentialForge?: TestDeps['forge'];
  /** The test of a GitHub App entry (default: `testAppEntry`, a JWT sent to `GET /app`). */
  testApp?: typeof testAppEntry;
};

const TEST_TIMEOUT_MS = 30_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PutBody = z.strictObject({
  value: z.string().min(1).max(MAX_SECRET_FILE_BYTES),
  declaredCreatedAt: z
    .string()
    .refine((s) => DATE.test(s) && Number.isFinite(Date.parse(s)))
    .optional(),
  note: z.string().max(500).optional(),
});

const PreferBody = z.strictObject({ prefer: z.boolean() });
/** The queue the vault switches share (no credential is named this). */
const VAULT_QUEUE = '#vault';

const defaultForge: TestDeps['forge'] = (token, repo) => {
  const [owner = '', name = ''] = repo.split('/');
  return new GitHubForge(owner, name, token, { requestTimeoutMs: TEST_TIMEOUT_MS });
};

/** Active drops leased before `since`: they carry the credential as it was then. */
export function runningSince(db: Db, since: string | undefined): number {
  if (!since) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM drops WHERE state IN (${ACTIVE_STATES_SQL})
           AND started_at IS NOT NULL AND started_at < ?`,
      )
      .get(since) as { n: number }
  ).n;
}

export function registerSecretRoutes(scope: FastifyInstance, deps: SecretRouteDeps): void {
  const { db, store, audit } = deps;
  const forge = deps.credentialForge ?? defaultForge;
  const testApp = deps.testApp ?? testAppEntry;
  /** One write per name at a time: a PUT's test, store and swap finish before the next begins. */
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    queues.set(name, tail);
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name);
    });
    return next;
  };

  /** The names this install knows: the four, and every gate secret a zone declares. */
  const known = (): CredentialName[] => Object.keys(store.resolved()) as CredentialName[];
  const nameOf = (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
    const n = req.params.name;
    if (!isCredentialName(n) || !known().includes(n)) {
      void reply.code(404).send({ error: 'unknown credential' });
      return undefined;
    }
    return n;
  };
  const zones = () => store.current().dropZones.map((z) => ({ id: z.id, repo: z.repo }));

  const view = (name: CredentialName, r: Resolved[CredentialName]) => {
    const gate = parseGateSecretName(name);
    return {
      name,
      role: isInstallCredential(name)
        ? CREDENTIAL_ROLES[name]
        : `gate secret ${gate?.name} for zone ${gate?.zoneId}: gate steps can read it`,
      source: r.source,
      ...(r.path && r.source === 'file' ? { path: r.path } : {}),
      ...(r.path && r.source === 'env' ? { variable: r.path } : {}),
      ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}),
      ...(r.login ? { login: r.login } : {}),
      ...(r.setAt ? { setAt: r.setAt } : {}),
      ...(r.declaredCreatedAt ? { declaredCreatedAt: r.declaredCreatedAt } : {}),
      ...(r.testedAt ? { testedAt: r.testedAt } : {}),
      ...(r.testResult ? { testResult: r.testResult } : {}),
      ...(r.undecryptable ? { undecryptable: true } : {}),
      ...(r.overriding
        ? {
            overriding: r.overriding.map((o) => ({
              source: o.source,
              ...(o.path && o.source === 'file' ? { path: o.path } : {}),
              ...(o.path && o.source === 'env' ? { variable: o.path } : {}),
            })),
          }
        : {}),
      ...(r.source === 'vault' ? { runningDropsWithPrevious: runningSince(db, r.setAt) } : {}),
    };
  };
  /**
   * An app entry as the list shows it (§4.4): where it comes from and what identifies it, never
   * its PEM or client id.
   */
  const appView = (owner: string, role: AppRole, r: AppEntryRead) => {
    const name = `github-app/${owner}/${role}`;
    const vault = store.vault();
    const meta = r.source === 'vault' && vault !== 'disabled' ? vault.meta(name) : undefined;
    return {
      owner,
      role,
      name,
      source: r.source,
      ...(r.source === 'missing'
        ? r.undecryptable
          ? { undecryptable: true }
          : {}
        : {
            appId: r.entry.appId,
            slug: r.entry.slug,
            importedAt: r.entry.importedAt,
            fingerprint: r.fingerprint,
            ...(r.source === 'file' && r.path ? { path: r.path } : {}),
            ...(r.overriding
              ? {
                  overriding: r.overriding.map((o) => ({
                    source: o.source,
                    ...(o.path && o.source === 'file' ? { path: o.path } : {}),
                  })),
                }
              : {}),
          }),
      ...(meta?.testedAt ? { testedAt: meta.testedAt } : {}),
      ...(meta?.testResult ? { testResult: meta.testResult } : {}),
    };
  };
  const apps = () =>
    [...store.resolvedApps().entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([owner, reads]) => APP_ROLES.map((role) => appView(owner, role, reads[role])));

  /** A session needs sudo for a vault write, as for a credential; the Bearer token never does. */
  const sudoRefused = (req: FastifyRequest, reply: FastifyReply, what: string) => {
    if (req.principal?.via !== 'session' || req.principal.sudo) return false;
    void reply
      .code(403)
      .send({ error: `${what} asks for your passphrase again`, sudo: 'required' });
    return true;
  };

  scope.get('/api/control/secrets', async () => {
    const vault = store.vault();
    const from = store.vaultKeyFrom();
    return {
      vault: vault === 'disabled' ? 'disabled' : 'on',
      ...(vault === 'disabled' ? { hint: VAULT_DISABLED } : { keyId: vault.keyId }),
      ...(from ? { vaultKeyFrom: from } : {}),
      ...(vault === 'disabled' ? {} : { entries: vault.count() }),
      preferVault: store.preferVault(),
      credentials: (
        Object.entries(store.resolved()) as [CredentialName, Resolved[CredentialName]][]
      ).map(([n, r]) => view(n, r)),
      apps: apps(),
      problems: store.problems(),
    };
  });

  scope.put<{ Params: { name: string } }>('/api/control/secrets/:name', async (req, reply) => {
    const name = nameOf(req, reply);
    if (!name) return reply;
    // Proof of presence: the token holds the secrets directory; a session re-enters the passphrase.
    if (req.principal?.via === 'session' && !req.principal.sudo)
      return reply.code(403).send({
        error: 'saving a credential asks for your passphrase again',
        sudo: 'required',
      });
    const body = PutBody.safeParse(req.body ?? {});
    // The message is ours: a zod issue could quote the value.
    if (!body.success)
      return reply.code(400).send({
        error:
          'invalid body: {"value": "<one line, at most 64 KiB>", "declaredCreatedAt"?: "YYYY-MM-DD", "note"?: "…"}',
      });
    const { value, declaredCreatedAt, note } = body.data;
    if (/\s/.test(value))
      return reply.code(400).send({ error: 'a credential is one line with no whitespace' });
    return serialized(name, async () => {
      const current = store.resolved()[name];
      // With the vault preferred, an entry stored here wins over the variable or file.
      if ((current?.source === 'file' || current?.source === 'env') && !store.preferVault())
        return reply.code(409).send({
          error: `managed by ${current.path}: replace the file and run \`ctl secrets reload\``,
        });
      if (store.vault() === 'disabled') return reply.code(409).send({ error: VAULT_DISABLED });
      const fingerprint = fingerprintOf(value);
      const t = await testCredential(name, value, { zones: zones(), forge });
      if (!t.ok) {
        audit(req, 'secret.set', {
          name,
          fingerprint,
          result: `test failed (${t.status ?? 'no answer'})`,
        });
        return reply.code(422).send({
          tested: false,
          status: t.status,
          ...(t.permission ? { permission: t.permission } : {}),
          ...(t.problem ? { problem: t.problem } : {}),
          error: t.problem ?? refusalWords(t.status, t.permission),
        });
      }
      const stored = store.putCredential(name, value, {
        ...(declaredCreatedAt ? { declaredCreatedAt } : {}),
        ...(note ? { note } : {}),
        test: { result: t.result, ...(t.login ? { login: t.login } : {}) },
      });
      if (!stored.ok) {
        audit(req, 'secret.set', { name, fingerprint, result: 'refused' });
        // Store issues name variables and paths, never a value.
        return reply.code(400).send({ issues: stored.issues });
      }
      audit(req, 'secret.set', { name, fingerprint, result: 'stored' });
      const running = runningSince(db, stored.meta.createdAt);
      return {
        fingerprint,
        // Only a check against the provider (GitHub) is a test; a Claude token's form is not.
        tested: t.live === true,
        result: t.result,
        ...(t.login ? { login: t.login } : {}),
        setAt: stored.meta.createdAt,
        problems: store.problems(),
        runningDropsWithPrevious: running,
        // A pass in flight keeps the forge pair it started with until it ends.
        hint: `${running} running drops still carry the previous token, and the pass running now keeps it until it ends: revoke it on GitHub after they finish`,
      };
    });
  });

  scope.post<{ Params: { name: string } }>(
    '/api/control/secrets/:name/test',
    async (req, reply) => {
      const name = nameOf(req, reply);
      if (!name) return reply;
      // A test rewrites what the list and the rules read (the result, the login): sudo, as a replace.
      if (req.principal?.via === 'session' && !req.principal.sudo)
        return reply.code(403).send({
          error: 'testing a credential asks for your passphrase again',
          sudo: 'required',
        });
      return serialized(name, async () => {
        const r = store.resolved()[name];
        if (!r?.value) return reply.code(409).send({ error: 'the credential is not set' });
        const t = await testCredential(name, r.value, { zones: zones(), forge });
        const vault = store.vault();
        if (r.source === 'vault' && vault !== 'disabled') {
          vault.recordTest(name, {
            at: deps.now(),
            result: t.ok ? t.result : `failed (${t.status ?? 'no answer'})`,
            ...(t.ok && t.login ? { login: t.login } : {}),
          });
          store.refreshSecrets();
        }
        audit(req, 'secret.test', {
          name,
          fingerprint: r.fingerprint ?? null,
          result: t.ok ? 'ok' : `failed (${t.status ?? 'no answer'})`,
        });
        return t.ok
          ? { tested: true, result: t.result, ...(t.login ? { login: t.login } : {}) }
          : {
              tested: false,
              status: t.status,
              ...(t.permission ? { permission: t.permission } : {}),
              ...(t.problem ? { problem: t.problem } : {}),
              error: t.problem ?? refusalWords(t.status, t.permission, r),
            };
      });
    },
  );

  // A GitHub App entry's test (§4.4): a JWT signed with its key, sent to `GET /app`.
  scope.post<{ Params: { owner: string; role: string } }>(
    '/api/control/secrets/github-app/:owner/:role/test',
    async (req, reply) => {
      if (sudoRefused(req, reply, 'testing a credential')) return reply;
      // Fixed words: an owner or role in the wrong slot could be a secret.
      const parsed = parseAppEntryName(`github-app/${req.params.owner}/${req.params.role}`);
      if (!parsed)
        return reply.code(400).send({
          error:
            'an app entry is github-app/<owner>/<role>: a lowercase GitHub owner name, and author or reviewer',
        });
      const { owner, role } = parsed;
      const name = `github-app/${owner}/${role}`;
      if (!store.resolvedApps().has(owner))
        return reply.code(404).send({ error: 'unknown app entry' });
      return serialized(name, async () => {
        const r = store.resolvedApps().get(owner)?.[role];
        if (!r) return reply.code(404).send({ error: 'unknown app entry' });
        if (r.source === 'missing')
          return reply.code(409).send({
            error: r.undecryptable
              ? 'the app entry does not decrypt with this vault key'
              : 'the app entry is not set',
          });
        const t = await testApp(r.entry);
        const words = t.ok ? t.result : `failed (${t.status ?? 'no answer'})`;
        const vault = store.vault();
        if (r.source === 'vault' && vault !== 'disabled') {
          vault.recordTest(name, { at: deps.now(), result: words });
          store.refreshSecrets();
        }
        audit(req, 'secret.test', {
          name,
          fingerprint: r.fingerprint,
          result: t.ok ? 'ok' : words,
        });
        return t.ok
          ? { tested: true, result: t.result, ...(t.login ? { login: t.login } : {}) }
          : {
              tested: false,
              status: t.status,
              ...(t.problem ? { problem: t.problem } : {}),
              error: t.problem ?? refusalWords(t.status),
            };
      });
    },
  );

  scope.delete<{ Params: { name: string } }>('/api/control/secrets/:name', async (req, reply) => {
    const name = nameOf(req, reply);
    if (!name) return reply;
    if (req.principal?.via === 'session' && !req.principal.sudo)
      return reply.code(403).send({
        error: 'removing a credential asks for your passphrase again',
        sudo: 'required',
      });
    return serialized(name, async () => {
      const r = store.resolved()[name];
      const vault = store.vault();
      // The vault's own entry, in use or behind a variable or file (a copy, #101).
      const entry = vault === 'disabled' ? undefined : vault.meta(name);
      if (!entry && r?.source !== 'vault' && !r?.undecryptable)
        return reply.code(409).send({
          error:
            r?.source === 'missing'
              ? 'the vault holds no such credential'
              : `managed by ${r?.path}: remove the file and run \`ctl secrets reload\``,
        });
      // Refused when it would leave a zone without a credential it needs; a variable or file that
      // also holds it takes over, so its zones keep it.
      const without = store.resolvedWithoutVaultEntry(name);
      const created = store
        .current()
        .dropZones.flatMap((z) => credentialProblems(z, without, store.resolvedApps()))
        .filter((p) => p.credential === name && p.kind === 'missing');
      if (created.length > 0)
        return reply.code(409).send({
          error: `zones need ${name}: removing it would park them`,
          problems: created,
        });
      const done = store.deleteCredential(name);
      if (!done.ok) return reply.code(400).send({ issues: done.issues });
      audit(req, 'secret.remove', {
        name,
        fingerprint: entry?.fingerprint ?? r?.fingerprint ?? null,
        result: 'removed',
      });
      return { removed: done.deleted, problems: store.problems() };
    });
  });

  // The vault switches (#101). One at a time, behind the same queue as a credential's writes.
  scope.post('/api/control/secrets/vault/on', async (req, reply) => {
    if (sudoRefused(req, reply, 'turning the vault on')) return reply;
    return serialized(VAULT_QUEUE, async () => {
      const r = store.turnOnVault();
      if (!r.ok) return reply.code(409).send({ error: r.message });
      // The key id is a hash prefix of the key; the key itself is never answered or audited.
      audit(req, 'vault.on', { keyId: r.keyId, result: 'on' });
      return { vault: 'on', keyId: r.keyId, keyFile: r.keyFile, problems: store.problems() };
    });
  });

  scope.post('/api/control/secrets/vault/off', async (req, reply) => {
    if (sudoRefused(req, reply, 'turning the vault off')) return reply;
    return serialized(VAULT_QUEUE, async () => {
      const r = store.turnOffVault();
      if (!r.ok) return reply.code(409).send({ error: r.message });
      audit(req, 'vault.off', { result: 'off' });
      return { vault: 'disabled', problems: store.problems() };
    });
  });

  scope.post('/api/control/secrets/vault/prefer', async (req, reply) => {
    if (sudoRefused(req, reply, 'changing which source wins')) return reply;
    const body = PreferBody.safeParse(req.body ?? {});
    if (!body.success)
      return reply.code(400).send({ error: 'invalid body: {"prefer": true|false}' });
    return serialized(VAULT_QUEUE, async () => {
      const r = store.setPreferVault(body.data.prefer);
      if (!r.ok) return reply.code(400).send({ issues: r.issues });
      audit(req, 'vault.prefer', { prefer: body.data.prefer, result: 'saved' });
      return { preferVault: store.preferVault(), problems: store.problems() };
    });
  });

  scope.post<{ Params: { name: string } }>(
    '/api/control/secrets/:name/copy-to-vault',
    async (req, reply) => {
      const name = nameOf(req, reply);
      if (!name) return reply;
      if (sudoRefused(req, reply, 'copying a credential into the vault')) return reply;
      return serialized(name, async () => {
        // The value is read and stored here, server-side; the answer carries its fingerprint.
        const r = store.copyToVault(name);
        if (!r.ok) return reply.code(409).send({ error: r.message });
        audit(req, 'secret.copy', { name, fingerprint: r.fingerprint, result: 'stored' });
        return {
          name,
          from: r.from,
          fingerprint: r.fingerprint,
          inUse: store.resolved()[name]?.source === 'vault',
          problems: store.problems(),
        };
      });
    },
  );

  scope.post('/api/control/secrets/reload', async (req, reply) => {
    const r = store.refreshSecrets();
    if (!r.ok) return reply.code(400).send({ issues: 'issues' in r ? r.issues : [] });
    audit(req, 'secret.reload', { result: 'reloaded' });
    return { problems: store.problems() };
  });
}
