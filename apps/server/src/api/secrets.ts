import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditDetail } from '../auth/audit.js';
import { type ConfigStore, VAULT_DISABLED } from '../config/store.js';
import type { Db } from '../db/open.js';
import { ACTIVE_STATES_SQL } from '../db/repo.js';
import { GitHubForge } from '../forge/github.js';
import { forgeKind } from '../forge/kind.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import { MAX_SECRET_FILE_BYTES } from '../secrets.js';
import {
  APP_ID_MISMATCH,
  APP_SLUG_MISMATCH,
  CREDENTIAL_ROLES,
  type CredentialName,
  isCredentialName,
  isInstallCredential,
  type OtherSource,
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
  type GitHubAppEntry,
  isPrivateKeyPem,
  parseAppEntryName,
  serializeAppEntry,
} from '../vault/github-app-entries.js';
import {
  GITLAB_PAT_ROLES,
  GITLAB_READ_BAD_VALUE,
  type GitLabPatRole,
  type GitLabPatZone,
  gitlabPatEntryName,
  gitlabReadEntryName,
  parseGitlabPatEntryName,
  parseGitlabReadEntryName,
  parseGitlabReadValue,
  testGitlabPatEntry,
  testGitlabReadEntry,
} from '../vault/gitlab-pat-entries.js';
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
  /** The test of a GitLab zone's token (default: `testGitlabPatEntry`, `GET /user` on its instance). */
  testGitlabPat?: (value: string, zone: GitLabPatZone) => ReturnType<typeof testGitlabPatEntry>;
  /**
   * The test of a GitLab zone's read deploy token (default: `testGitlabReadEntry`, the smart-HTTP
   * `info/refs` probe, its secret forms in the server scrub set).
   */
  testGitlabRead?: (value: string, zone: GitLabPatZone) => ReturnType<typeof testGitlabReadEntry>;
};

const TEST_TIMEOUT_MS = 30_000;

/**
 * The 409 for removing a credential some project still needs (a vault entry or a GitLab token).
 * Prose System, Credentials shows as it is (and ctl prints), so it says projects; nothing parses
 * it (#872).
 */
export const neededCredentialError = (name: string): string =>
  `projects need ${name}: removing it would park them`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PutBody = z.strictObject({
  value: z.string().min(1).max(MAX_SECRET_FILE_BYTES),
  declaredCreatedAt: z
    .string()
    .refine((s) => DATE.test(s) && Number.isFinite(Date.parse(s)))
    .optional(),
  note: z.string().max(500).optional(),
});

/** A Replace key body (#487): one PEM, multi-line, at most 64 KiB. */
const KeyBody = z.strictObject({ pem: z.string().min(1).max(MAX_SECRET_FILE_BYTES) });

/** A pasted PEM with LF line ends, no surrounding whitespace, and exactly one final newline. */
function canonicalPem(pem: string): string {
  return `${pem.replace(/\r\n/g, '\n').trim()}\n`;
}
/** Said after a key is replaced: both keys stay valid on GitHub until the old one is deleted. */
export const DELETE_OLD_KEY =
  "The new key is stored and in use. Now delete the old key on the app's GitHub page, under Private keys: until then both keys stay valid.";
const BAD_APP_NAME =
  'an app entry is github-app/<owner>/<role>: a lowercase GitHub owner name, and author or reviewer';

const BAD_GITLAB_NAME =
  'a GitLab token is gitlab-pat/<zone>/<role>: a project id, and author, reviewer or read';
const UNKNOWN_GITLAB_ZONE = 'unknown GitLab project';
const STARTER_NO_REVIEWER = 'a starter project has no reviewer token';
/** A GitLab token's body: one line, the token only. */
const GitlabPatBody = z.strictObject({ value: z.string().min(1).max(MAX_SECRET_FILE_BYTES) });

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

/** An app entry as the list and the Credentials tab show it (§4.4). */
export type AppEntryView = {
  owner: string;
  role: AppRole;
  name: string;
  source: AppEntryRead['source'];
  undecryptable?: true;
  appId?: string;
  slug?: string;
  importedAt?: string;
  fingerprint?: string;
  path?: string;
  overriding?: { source: OtherSource['source']; path?: string }[];
  testedAt?: string;
  testResult?: string;
};

/**
 * An app entry as the list shows it (§4.4): where it comes from and what identifies it, never
 * its PEM or client id.
 */
function appEntryView(
  store: Pick<ConfigStore, 'vault'>,
  owner: string,
  role: AppRole,
  r: AppEntryRead,
): AppEntryView {
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
        ? { undecryptable: true as const }
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
}

/**
 * Each owner of the configured two-bot zones, sorted, with both roles' entries: what
 * `GET /api/control/secrets` lists as `apps` and the Credentials tab shows (#375).
 */
export function appEntryViews(store: Pick<ConfigStore, 'vault' | 'resolvedApps'>): AppEntryView[] {
  return [...store.resolvedApps().entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([owner, reads]) =>
      APP_ROLES.map((role) => appEntryView(store, owner, role, reads[role])),
    );
}

/** A GitLab zone's `gitlab-pat` entry as the list shows it (issue #776): never its value. */
export type GitlabPatView = {
  zone: string;
  /** `read` is the zone's read deploy token `gitlab-pat/<zone>/read` (issue #875). */
  role: GitLabPatRole | 'read';
  name: string;
  set: boolean;
  undecryptable?: true;
  fingerprint?: string;
  setAt?: string;
  testedAt?: string;
  testResult?: string;
};

/**
 * Each GitLab zone's `gitlab-pat` entries, in zone order: the author, and the reviewer of a
 * two-bot zone, or of a starter zone whose vault still holds one (a leftover from two-bot mode,
 * which resolution skips, so it is read from the vault's metadata), then the optional read deploy
 * token `gitlab-pat/<zone>/read` of every GitLab zone (issue #875). Never a value or a username.
 */
export function gitlabPatViews(
  store: Pick<ConfigStore, 'vault' | 'current' | 'resolvedGitlabPats'>,
): GitlabPatView[] {
  const vault = store.vault();
  const resolved = store.resolvedGitlabPats();
  return store
    .current()
    .dropZones.filter((z) => forgeKind(z) === 'gitlab')
    .flatMap((z) =>
      [...GITLAB_PAT_ROLES, 'read' as const].flatMap((role): GitlabPatView[] => {
        const name = role === 'read' ? gitlabReadEntryName(z.id) : gitlabPatEntryName(z.id, role);
        const meta = vault === 'disabled' ? undefined : vault.meta(name);
        const starterReviewer = role === 'reviewer' && z.identity === 'starter';
        if (starterReviewer && !meta) return [];
        const set = starterReviewer ? true : resolved.get(z.id)?.[role] !== undefined;
        return [
          {
            zone: z.id,
            role,
            name,
            set,
            ...(meta && !set ? { undecryptable: true as const } : {}),
            ...(meta
              ? {
                  fingerprint: meta.fingerprint,
                  setAt: meta.createdAt,
                  ...(meta.testedAt ? { testedAt: meta.testedAt } : {}),
                  ...(meta.testResult ? { testResult: meta.testResult } : {}),
                }
              : {}),
          },
        ];
      }),
    );
}

export function registerSecretRoutes(scope: FastifyInstance, deps: SecretRouteDeps): void {
  const { db, store, audit } = deps;
  const forge = deps.credentialForge ?? defaultForge;
  const testApp = deps.testApp ?? testAppEntry;
  const testGitlabPat = deps.testGitlabPat ?? ((value, zone) => testGitlabPatEntry(value, zone));
  const testGitlabRead =
    deps.testGitlabRead ??
    ((value, zone) => testGitlabReadEntry(value, zone, { scrub: serverScrubSet }));
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
  const zones = () =>
    store.current().dropZones.map((z) => ({
      id: z.id,
      repo: z.repo,
      ...(z.forge === undefined ? {} : { forge: z.forge }),
    }));

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
      apps: appEntryViews(store),
      gitlabPats: gitlabPatViews(store),
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
      if (!parsed) return reply.code(400).send({ error: BAD_APP_NAME });
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

  /**
   * Replace key on an app entry (#487, ruling 103): the new PEM is tested with `GET /app` against
   * the entry's app id and slug before anything is stored; on success it is stored with a fresh
   * `importedAt`, and the operator then deletes the old key on GitHub. Neither PEM is answered,
   * logged or audited: both stay in the scrub set.
   */
  scope.put<{ Params: { owner: string; role: string } }>(
    '/api/control/secrets/github-app/:owner/:role/key',
    async (req, reply) => {
      if (sudoRefused(req, reply, 'replacing a key')) return reply;
      const parsed = parseAppEntryName(`github-app/${req.params.owner}/${req.params.role}`);
      if (!parsed) return reply.code(400).send({ error: BAD_APP_NAME });
      const { owner, role } = parsed;
      const name = `github-app/${owner}/${role}`;
      if (!store.resolvedApps().has(owner))
        return reply.code(404).send({ error: 'unknown app entry' });
      const body = KeyBody.safeParse(req.body ?? {});
      // The message is ours: a zod issue could quote the key.
      if (!body.success)
        return reply
          .code(400)
          .send({ error: 'invalid body: {"pem": "<the PEM text, at most 64 KiB>"}' });
      // Copying from an editor or a terminal adds blank lines, spaces or CRLF line ends (#559):
      // the key is checked and stored in its canonical form. Both texts stay scrubbed.
      const received = body.data.pem;
      serverScrubSet.addPem(received);
      const pem = canonicalPem(received);
      serverScrubSet.addPem(pem);
      if (!isPrivateKeyPem(pem))
        return reply.code(400).send({
          error:
            'the key is not a private-key PEM: paste the whole .pem file GitHub downloaded, from -----BEGIN to -----END',
        });
      return serialized(name, async () => {
        if (store.vault() === 'disabled') return reply.code(409).send({ error: VAULT_DISABLED });
        const r = store.resolvedApps().get(owner)?.[role];
        if (!r) return reply.code(404).send({ error: 'unknown app entry' });
        if (r.source === 'missing')
          return reply.code(409).send({
            error: r.undecryptable
              ? 'the app entry does not decrypt with this vault key'
              : 'the app entry is not set',
          });
        if (r.source === 'file')
          return reply.code(409).send({
            error: `managed by ${r.path}: replace the key in that file and run \`ctl secrets reload\``,
          });
        // The old key stays scrubbed: a log line about it may still be written.
        serverScrubSet.addPem(r.entry.pem);
        const candidate: GitHubAppEntry = {
          appId: r.entry.appId,
          slug: r.entry.slug,
          clientId: r.entry.clientId,
          pem,
          importedAt: deps.now().toISOString(),
        };
        const fingerprint = fingerprintOf(serializeAppEntry(candidate));
        const t = await testApp(candidate);
        if (!t.ok) {
          audit(req, 'secret.replace', {
            name,
            fingerprint,
            result: `test failed (${t.status ?? 'no answer'})`,
          });
          // A key for a different app is a conflict with the entry, not a failed test of its key.
          const otherApp = t.problem === APP_ID_MISMATCH || t.problem === APP_SLUG_MISMATCH;
          return reply.code(otherApp ? 409 : 422).send({
            tested: false,
            status: t.status,
            ...(t.problem ? { problem: t.problem } : {}),
            error: t.problem ?? refusalWords(t.status),
          });
        }
        const stored = store.putAppEntry(owner, role, candidate);
        if (!stored.ok) {
          audit(req, 'secret.replace', { name, fingerprint, result: 'refused' });
          return reply.code(400).send({ issues: stored.issues });
        }
        const vault = store.vault();
        if (vault !== 'disabled') {
          vault.recordTest(name, { at: deps.now(), result: t.result });
          store.refreshSecrets();
        }
        audit(req, 'secret.replace', { name, fingerprint, result: 'stored' });
        return {
          replaced: true,
          result: t.result,
          ...(t.login ? { login: t.login } : {}),
          fingerprint,
          importedAt: candidate.importedAt,
          hint: DELETE_OLD_KEY,
        };
      });
    },
  );

  /**
   * Removes the vault copy of an app entry that a file also sets (issue #599): the way to keep the
   * file and clear `credential.shadowed`. Refused while no file on disk sets the entry (read at the
   * request, not from the last reload, #611: the role would lose its entry) and while the vault
   * holds no copy. Answers and audits names and fingerprints only.
   */
  scope.delete<{ Params: { owner: string; role: string } }>(
    '/api/control/secrets/github-app/:owner/:role',
    async (req, reply) => {
      if (req.principal?.via === 'session' && !req.principal.sudo)
        return reply.code(403).send({
          error: 'removing a credential asks for your passphrase again',
          sudo: 'required',
        });
      const parsed = parseAppEntryName(`github-app/${req.params.owner}/${req.params.role}`);
      if (!parsed) return reply.code(400).send({ error: BAD_APP_NAME });
      const { owner, role } = parsed;
      const name = `github-app/${owner}/${role}`;
      if (!store.resolvedApps().has(owner))
        return reply.code(404).send({ error: 'unknown app entry' });
      return serialized(name, async () => {
        const vault = store.vault();
        if (vault === 'disabled') return reply.code(409).send({ error: VAULT_DISABLED });
        const entry = vault.meta(name);
        if (!entry) return reply.code(409).send({ error: 'the vault holds no such app entry' });
        // Read from disk, not the cached resolution: a file deleted or broken since the last
        // reload must not let the only copy go (issue #611).
        const noFile = {
          error: `no file sets ${name}: the vault entry is its only copy, so it stays (replace its key on System, Credentials instead)`,
        };
        const file = store.appFileOnDisk(owner, role);
        if (!file) return reply.code(409).send(noFile);
        const done = store.deleteAppEntry(owner, role);
        if (!done.ok) {
          audit(req, 'secret.remove', { name, fingerprint: entry.fingerprint, result: 'refused' });
          // The file went between the read and the remove: the entry was put back.
          if (!store.appFileOnDisk(owner, role)) return reply.code(409).send(noFile);
          return reply.code(400).send({ issues: done.issues });
        }
        audit(req, 'secret.remove', { name, fingerprint: entry.fingerprint, result: 'removed' });
        return { removed: done.deleted, name, file, problems: store.problems() };
      });
    },
  );

  /**
   * A GitLab zone's `gitlab-pat/<zone>/<role>` token (issue #776, §9) and its read deploy token
   * `gitlab-pat/<zone>/read` (`<username>:<token>`, issue #866): set, test and remove. The
   * zone and role are parsed first and every refusal is fixed text, never the input (a token in
   * the wrong slot would leak); answers and audits carry names and fingerprints only.
   */
  type GitlabParams = { Params: { zone: string; role: string } };
  const gitlabTarget = (req: FastifyRequest<GitlabParams>, reply: FastifyReply) => {
    const raw = `gitlab-pat/${req.params.zone}/${req.params.role}`;
    // The read deploy token (issue #866) is not a role: it has its own value form and test.
    const read = parseGitlabReadEntryName(raw);
    const parsed = read
      ? { zoneId: read.zoneId, role: 'read' as const }
      : parseGitlabPatEntryName(raw);
    if (!parsed) {
      void reply.code(400).send({ error: BAD_GITLAB_NAME });
      return undefined;
    }
    const zone = store.current().dropZones.find((z) => z.id === parsed.zoneId);
    if (!zone || forgeKind(zone) !== 'gitlab') {
      void reply.code(404).send({ error: UNKNOWN_GITLAB_ZONE });
      return undefined;
    }
    return {
      zone,
      role: parsed.role,
      name:
        parsed.role === 'read'
          ? gitlabReadEntryName(parsed.zoneId)
          : gitlabPatEntryName(parsed.zoneId, parsed.role),
      starterReviewer: parsed.role === 'reviewer' && zone.identity === 'starter',
    };
  };
  const gitlabRefusal = (t: { status: number | null; problem?: string }) => ({
    tested: false,
    status: t.status,
    ...(t.problem ? { problem: t.problem } : {}),
    error: t.problem ?? `GitLab did not accept the test (HTTP ${t.status}): try again in a moment.`,
  });

  scope.put<GitlabParams>('/api/control/secrets/gitlab-pat/:zone/:role', async (req, reply) => {
    if (sudoRefused(req, reply, 'saving a credential')) return reply;
    const target = gitlabTarget(req, reply);
    if (!target) return reply;
    const body = GitlabPatBody.safeParse(req.body ?? {});
    // The message is ours: a zod issue could quote the value.
    if (!body.success)
      return reply
        .code(400)
        .send({ error: 'invalid body: {"value": "<one line, at most 64 KiB>"}' });
    const { value } = body.data;
    if (/\s/.test(value))
      return reply.code(400).send({ error: 'a credential is one line with no whitespace' });
    const { zone, role, name } = target;
    if (role === 'read' && !parseGitlabReadValue(value))
      return reply.code(400).send({ error: GITLAB_READ_BAD_VALUE });
    return serialized(name, async () => {
      if (store.vault() === 'disabled') return reply.code(409).send({ error: VAULT_DISABLED });
      if (target.starterReviewer) return reply.code(409).send({ error: STARTER_NO_REVIEWER });
      // A read value's fingerprint is of `<username>:<token>`, as resolution computes it.
      const fingerprint = fingerprintOf(value);
      const t = await (role === 'read' ? testGitlabRead : testGitlabPat)(value, zone);
      if (!t.ok) {
        audit(req, 'secret.set', {
          name,
          fingerprint,
          result: `test failed (${t.status ?? 'no answer'})`,
        });
        return reply.code(422).send(gitlabRefusal(t));
      }
      const stored =
        role === 'read'
          ? store.putGitlabRead(zone.id, value, { result: t.result })
          : store.putGitlabPat(zone.id, role, value, {
              result: t.result,
              ...(t.login ? { login: t.login } : {}),
            });
      if (!stored.ok) {
        audit(req, 'secret.set', { name, fingerprint, result: 'refused' });
        return reply.code(400).send({ issues: stored.issues });
      }
      audit(req, 'secret.set', { name, fingerprint, result: 'stored' });
      return {
        name,
        fingerprint,
        tested: true,
        result: t.result,
        ...(t.login ? { login: t.login } : {}),
        setAt: stored.meta.createdAt,
        problems: store.problems(),
      };
    });
  });

  scope.post<GitlabParams>(
    '/api/control/secrets/gitlab-pat/:zone/:role/test',
    async (req, reply) => {
      if (sudoRefused(req, reply, 'testing a credential')) return reply;
      const target = gitlabTarget(req, reply);
      if (!target) return reply;
      const { zone, role, name } = target;
      return serialized(name, async () => {
        const vault = store.vault();
        if (vault === 'disabled') return reply.code(409).send({ error: VAULT_DISABLED });
        if (target.starterReviewer) return reply.code(409).send({ error: STARTER_NO_REVIEWER });
        const pats = store.resolvedGitlabPats().get(zone.id);
        const read = pats?.read;
        const value =
          role === 'read' ? (read ? `${read.username}:${read.token}` : undefined) : pats?.[role];
        const meta = vault.meta(name);
        if (value === undefined || !meta)
          return reply.code(409).send({
            error: meta ? 'the token does not decrypt with this vault key' : 'the token is not set',
          });
        const t = await (role === 'read' ? testGitlabRead : testGitlabPat)(value, zone);
        const words = t.ok ? t.result : `failed (${t.status ?? 'no answer'})`;
        vault.recordTest(name, {
          at: deps.now(),
          result: words,
          ...(t.ok && t.login ? { login: t.login } : {}),
        });
        store.refreshSecrets();
        audit(req, 'secret.test', { name, fingerprint: meta.fingerprint, result: words });
        return t.ok
          ? { tested: true, result: t.result, ...(t.login ? { login: t.login } : {}) }
          : gitlabRefusal(t);
      });
    },
  );

  scope.delete<GitlabParams>('/api/control/secrets/gitlab-pat/:zone/:role', async (req, reply) => {
    if (sudoRefused(req, reply, 'removing a credential')) return reply;
    const target = gitlabTarget(req, reply);
    if (!target) return reply;
    const { zone, role, name } = target;
    return serialized(name, async () => {
      const vault = store.vault();
      if (vault === 'disabled') return reply.code(409).send({ error: VAULT_DISABLED });
      const entry = vault.meta(name);
      if (!entry) return reply.code(409).send({ error: 'the vault holds no such token' });
      if (role === 'read') {
        // Never refused for parking: without it the clone fetches with the author token.
        const done = store.deleteGitlabRead(zone.id);
        if (!done.ok) {
          audit(req, 'secret.remove', { name, fingerprint: entry.fingerprint, result: 'refused' });
          return reply.code(400).send({ issues: done.issues });
        }
        audit(req, 'secret.remove', { name, fingerprint: entry.fingerprint, result: 'removed' });
        return { removed: done.deleted, name, problems: store.problems() };
      }
      // Refused while a zone needs the entry: judged on the resolved tokens without it.
      const pats = store.resolvedGitlabPats();
      const { [role]: _gone, ...rest } = pats.get(zone.id) ?? {};
      const without = new Map(pats).set(zone.id, rest);
      const created = credentialProblems(
        zone,
        store.resolved(),
        store.resolvedApps(),
        without,
      ).filter((p) => p.credential === name && p.kind === 'missing');
      if (created.length > 0)
        return reply.code(409).send({
          error: neededCredentialError(name),
          problems: created,
        });
      const done = store.deleteGitlabPat(zone.id, role);
      if (!done.ok) {
        audit(req, 'secret.remove', { name, fingerprint: entry.fingerprint, result: 'refused' });
        return reply.code(400).send({ issues: done.issues });
      }
      audit(req, 'secret.remove', { name, fingerprint: entry.fingerprint, result: 'removed' });
      return { removed: done.deleted, name, problems: store.problems() };
    });
  });

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
          error: neededCredentialError(name),
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
