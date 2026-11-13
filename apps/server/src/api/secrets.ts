import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditDetail } from '../auth/audit.js';
import { type ConfigStore, VAULT_DISABLED } from '../config/store.js';
import type { Db } from '../db/open.js';
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
  testCredential,
} from '../vault/credentials.js';
import { credentialProblems } from '../vault/problems.js';
import { fingerprintOf } from '../vault/vault.js';

/**
 * The credential routes (§7.5): list, replace, test, remove and reload. No route ever returns,
 * logs or audits a value: the list carries fingerprints and dates; a failed test returns the HTTP
 * status and the permission GitHub names, and nothing else; audit details are built from named
 * fields only (`{ name, fingerprint, result }`), never from the request body.
 */

export type SecretRouteDeps = {
  db: Db;
  store: ConfigStore;
  now(): Date;
  audit(req: FastifyRequest, action: string, detail: AuditDetail, target?: string): void;
  /** A forge on a token for a repository, for tests on entry (default: GitHub, with a deadline). */
  credentialForge?: TestDeps['forge'];
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
        `SELECT COUNT(*) AS n FROM drops WHERE state IN ('leased', 'running')
           AND started_at IS NOT NULL AND started_at < ?`,
      )
      .get(since) as { n: number }
  ).n;
}

export function registerSecretRoutes(scope: FastifyInstance, deps: SecretRouteDeps): void {
  const { db, store, audit } = deps;
  const forge = deps.credentialForge ?? defaultForge;
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
      ...(r.source === 'vault' ? { runningDropsWithPrevious: runningSince(db, r.setAt) } : {}),
    };
  };

  scope.get('/api/control/secrets', async () => {
    const vault = store.vault();
    return {
      vault: vault === 'disabled' ? 'disabled' : 'on',
      ...(vault === 'disabled' ? { hint: VAULT_DISABLED } : { keyId: vault.keyId }),
      credentials: (
        Object.entries(store.resolved()) as [CredentialName, Resolved[CredentialName]][]
      ).map(([n, r]) => view(n, r)),
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
      if (current?.source === 'file' || current?.source === 'env')
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
        tested: true,
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
              error: t.problem ?? refusalWords(t.status, t.permission),
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
      if (r?.source !== 'vault' && !r?.undecryptable)
        return reply.code(409).send({
          error:
            r?.source === 'missing'
              ? 'the vault holds no such credential'
              : `managed by ${r?.path}: remove the file and run \`ctl secrets reload\``,
        });
      // Refused when it would leave a zone without a credential it needs.
      const without = { ...store.resolved(), [name]: { source: 'missing' } } as Resolved;
      const created = store
        .current()
        .dropZones.flatMap((z) => credentialProblems(z, without))
        .filter((p) => p.credential === name && p.kind === 'missing');
      if (created.length > 0)
        return reply.code(409).send({
          error: `zones need ${name}: removing it would park them`,
          problems: created,
        });
      const done = store.deleteCredential(name);
      if (!done.ok) return reply.code(400).send({ issues: done.issues });
      audit(req, 'secret.remove', { name, fingerprint: r.fingerprint ?? null, result: 'removed' });
      return { removed: done.deleted, problems: store.problems() };
    });
  });

  scope.post('/api/control/secrets/reload', async (req, reply) => {
    const r = store.refreshSecrets();
    if (!r.ok) return reply.code(400).send({ issues: 'issues' in r ? r.issues : [] });
    audit(req, 'secret.reload', { result: 'reloaded' });
    return { problems: store.problems() };
  });
}
