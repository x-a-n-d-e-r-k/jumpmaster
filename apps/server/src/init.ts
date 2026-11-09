// `jumpmaster init`: writes a compose install's config and generated secrets. It runs in the
// server image as the host user (compose profile `init`), with the install directory mounted
// read-write at /install:
//
//   docker compose --profile init run --rm init --repo owner/name [--preset p]
//     [--identity two-bot|starter] [--author-may-be-admin] [--plan p] [--force] [--allow-root]
//
// It reads the author token from secrets/github_author_token and, with it, the repository's
// visibility and root build files (GET requests only), then writes:
//   - config/jumpmaster.config.json (the stack preset and its gates, egress monitor, signed images);
//   - secrets/join_token and secrets/operator_token (0600), only when absent;
//   - compose.override.yaml, only for starter mode or a private repository (it drops the reviewer
//     token or adds the read token), and removes one it wrote earlier when neither applies.
//
// Exit codes: 0 done, 1 refused or failed (the reason is printed), 2 usage or ambiguous detection
// without --preset, 3 an existing config without --force (or an override file init didn't write),
// 4 the install directory is not writable. No secret value is ever printed.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PRESETS, type Preset } from '@jumpmaster/protocol';
import { IDENTITIES, type Identity, STARTER_WARNING } from './config.js';
import { identityMap } from './doctor/checks.js';
import type { Forge } from './forge/github.js';
import { DETECT_FILES, type Detection, detectAs, detectPreset } from './presets.js';
import { readSecret } from './secrets.js';

export type InitForge = Pick<Forge, 'repoAccess' | 'listDir' | 'getFileAt'>;

export type InitDeps = {
  /** The install directory (`/install` in the init container). */
  dir: string;
  /** `process.getuid()`, or null where there is none. */
  uid: number | null;
  /** `/proc/self/uid_map`, or null off Linux. */
  uidMap: string | null;
  forge(repo: string, token: string): InitForge;
  out(line: string): void;
  err(line: string): void;
};

const USAGE = [
  'usage: jumpmaster init --repo owner/name [--preset node|python|go|jvm]',
  '         [--identity two-bot|starter] [--author-may-be-admin]',
  '         [--plan pro|max|team_standard|team_premium|enterprise] [--force] [--allow-root]',
].join('\n');
const PLANS = ['pro', 'max', 'team_standard', 'team_premium', 'enterprise'] as const;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DOC = 'docs/runbooks/install.md';
/** Marks an override file as init's own, so a rerun may replace or remove it. */
const OVERRIDE_MARK = '# Written by `jumpmaster init`.';
const CONFIG = 'config/jumpmaster.config.json';
const OVERRIDE = 'compose.override.yaml';

type Args = {
  repo: string;
  preset?: Preset;
  identity: Identity;
  plan?: (typeof PLANS)[number];
  authorMayBeAdmin: boolean;
  force: boolean;
  allowRoot: boolean;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> & Pick<Args, 'authorMayBeAdmin' | 'force' | 'allowRoot'> = {
    identity: 'two-bot',
    authorMayBeAdmin: false,
    force: false,
    allowRoot: false,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case '--repo':
        args.repo = value(i++, a);
        if (!REPO.test(args.repo)) throw new UsageError(`--repo must be owner/name`);
        break;
      case '--preset': {
        const p = value(i++, a);
        if (!(PRESETS as readonly string[]).includes(p))
          throw new UsageError(`--preset must be one of ${PRESETS.join(', ')}`);
        args.preset = p as Preset;
        break;
      }
      case '--identity': {
        const v = value(i++, a);
        if (!(IDENTITIES as readonly string[]).includes(v))
          throw new UsageError(`--identity must be ${IDENTITIES.join(' or ')}`);
        args.identity = v as Identity;
        break;
      }
      case '--plan': {
        const v = value(i++, a);
        if (!(PLANS as readonly string[]).includes(v))
          throw new UsageError(`--plan must be one of ${PLANS.join(', ')}`);
        args.plan = v as Args['plan'];
        break;
      }
      case '--author-may-be-admin':
        args.authorMayBeAdmin = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--allow-root':
        args.allowRoot = true;
        break;
      default:
        throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (!args.repo) throw new UsageError('--repo is required');
  return args as Args;
}

const errno = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;

/** A zone id from the repository name: lower case, letters, digits and dashes. */
const zoneIdOf = (repo: string): string =>
  (repo.split('/')[1] ?? 'main')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'main';

/** The repository's root build files, as detection reads them. */
async function rootFiles(forge: InitForge, branch: string): Promise<Record<string, string | null>> {
  const names = new Set((await forge.listDir(branch, '')) ?? []);
  const wanted = [
    ...DETECT_FILES.filter((f) => names.has(f)),
    ...[...names].filter(
      (n) => /^requirements[\w.-]*\.txt$/.test(n) && !DETECT_FILES.includes(n as never),
    ),
  ];
  const files: Record<string, string | null> = {};
  for (const f of wanted) files[f] = await forge.getFileAt(branch, f);
  return files;
}

/** The compose override for starter mode and private repositories, or null when neither. */
export function composeOverride(o: { starter: boolean; privateRepo: boolean }): string | null {
  if (!o.starter && !o.privateRepo) return null;
  const secrets = [
    'claude_token',
    'github_author_token',
    ...(o.starter ? [] : ['github_reviewer_token']),
    ...(o.privateRepo ? ['github_read_token'] : []),
    'join_token',
    'operator_token',
  ];
  return [
    `${OVERRIDE_MARK} Rerun init with --force to regenerate it; don't edit it by hand.`,
    ...(o.starter
      ? ['# Starter mode: there is no reviewer identity, so no reviewer token is mounted.']
      : []),
    ...(o.privateRepo
      ? ['# A private repository: review, crew and doctor drops clone with the read token.']
      : []),
    '# Docker Compose reads this file next to compose.yaml on its own (Compose 2.24 or later).',
    'services:',
    '  jumpmaster:',
    '    environment:',
    ...(o.starter ? ['      JM_GITHUB_REVIEWER_TOKEN_FILE: ""'] : []),
    ...(o.privateRepo ? ['      JM_GITHUB_READ_TOKEN_FILE: /run/secrets/github_read_token'] : []),
    '    secrets: !override',
    ...secrets.map((s) => `      - ${s}`),
    'secrets:',
    ...(o.starter ? ['  github_reviewer_token: !reset null'] : []),
    ...(o.privateRepo ? ['  github_read_token:', '    file: ./secrets/github_read_token'] : []),
    '',
  ].join('\n');
}

/** Writes a file through a temporary name, so a crash never leaves half a config. */
function writeAtomic(path: string, text: string, mode: number): void {
  const tmp = `${path}.init-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

export async function runInit(argv: string[], deps: InitDeps): Promise<number> {
  const { dir, out, err } = deps;
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`jumpmaster init: ${e.message}`);
    err(USAGE);
    return 2;
  }
  const fail = (line: string, code = 1): number => {
    err(`jumpmaster init: ${line}`);
    return code;
  };

  // Who and where it runs.
  if (deps.uidMap !== null && !identityMap(deps.uidMap))
    return fail(
      `rootless Docker is not supported in this release: this container runs in a user namespace, whose uid mapping the install does not support. Install under a rootful Docker Engine (${DOC}#prerequisites).`,
    );
  if (deps.uid === 0 && !args.allowRoot)
    return fail(
      `refusing to run as uid 0: the server would own the data and secret files as root. Set JM_UID and JM_GID in .env to your own user (id -u, id -g; ${DOC}#install), or pass --allow-root if you really mean root.`,
    );
  try {
    const probe = join(dir, `.jumpmaster-init-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe);
  } catch (e) {
    return fail(
      `can't write to ${dir} (${errno(e) ?? 'error'}): mount /install read-write, owned by the JM_UID user (compose's init service mounts the install directory as .:/install)`,
      4,
    );
  }
  const configPath = join(dir, CONFIG);
  if (existsSync(configPath) && !args.force)
    return fail(
      `${CONFIG} already exists; rerun with --force to replace it (generated secrets are kept)`,
      3,
    );
  const overridePath = join(dir, OVERRIDE);
  const ownOverride =
    !existsSync(overridePath) || readFileSync(overridePath, 'utf8').startsWith(OVERRIDE_MARK);

  // The author token: read, never shown.
  const secretPath = (name: string) => join(dir, 'secrets', name);
  let authorToken: string | undefined;
  try {
    authorToken = readSecret(
      { JM_GITHUB_AUTHOR_TOKEN_FILE: secretPath('github_author_token') },
      'JM_GITHUB_AUTHOR_TOKEN',
    );
  } catch (e) {
    const msg = (e as Error).message.replace(dir, '.');
    return fail(
      existsSync(secretPath('github_author_token'))
        ? `secrets/github_author_token: ${msg}`
        : `secrets/github_author_token does not exist: write the author token there first, mode 0600 (${DOC}#tokens)`,
    );
  }
  if (!authorToken) return fail(`secrets/github_author_token is empty (${DOC}#tokens)`);
  if (args.identity === 'starter' && !authorToken.startsWith('github_pat_'))
    return fail(
      `starter mode requires a fine-grained author token (github_pat_…), limited to ${args.repo}, with no Workflows or Administration permission; secrets/github_author_token holds another kind (${DOC}#starter-mode)`,
    );

  // The repository: visibility and its root build files, on the default branch.
  const forge = deps.forge(args.repo, authorToken);
  let access: Awaited<ReturnType<InitForge['repoAccess']>>;
  let files: Record<string, string | null>;
  try {
    access = await forge.repoAccess();
    files = await rootFiles(forge, access.defaultBranch);
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    const why =
      status === 401
        ? 'GitHub rejected the author token (401): it is expired, revoked or mistyped'
        : status === 403 || status === 404
          ? `the author token can't read ${args.repo} (HTTP ${status}): check the repository name, and that the token's repository access includes it with Contents and Metadata read`
          : `could not read ${args.repo} from GitHub (${typeof status === 'number' ? `HTTP ${status}` : 'no HTTP answer'}): check this host reaches api.github.com`;
    return fail(`${why} (${DOC}#tokens)`);
  }
  let found: Detection;
  if (args.preset) found = detectAs(args.preset, files);
  else {
    found = detectPreset(files);
    if (found.preset === null)
      return fail(
        `can't choose a stack preset for ${args.repo} on ${access.defaultBranch}: ${found.problems.join('; ')}. Rerun with --preset ${found.candidates.length ? found.candidates.join('|') : PRESETS.join('|')} (${DOC}#presets)`,
        2,
      );
  }
  const preset = found.preset as Preset;
  const override = composeOverride({
    starter: args.identity === 'starter',
    privateRepo: access.private,
  });
  if (override && !ownOverride)
    return fail(
      `${OVERRIDE} exists and init didn't write it; move it aside (init writes its own for starter mode and private repositories), then rerun`,
      3,
    );

  // Write: directories, generated secrets (only when absent), the config, the override.
  for (const d of ['config', 'data', 'secrets'])
    mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
  const generated: string[] = [];
  for (const name of ['join_token', 'operator_token']) {
    try {
      writeFileSync(secretPath(name), `${randomBytes(32).toString('base64url')}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      generated.push(`secrets/${name}`);
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw e;
    }
  }
  let tokenCreatedAt: string | undefined;
  try {
    tokenCreatedAt = statSync(secretPath('claude_token')).mtime.toISOString().slice(0, 10);
  } catch {
    tokenCreatedAt = undefined;
  }
  const zone = {
    id: zoneIdOf(args.repo),
    repo: args.repo,
    preset,
    gates: found.gates,
    egress: { mode: 'monitor' },
    identity: args.identity,
    ciRequired: true,
    ...(access.private ? { reviewReadToken: true } : {}),
    ...(args.authorMayBeAdmin ? { authorMayBeAdmin: true } : {}),
    crew: { enabled: false },
  };
  const config = {
    listen: { host: '0.0.0.0', port: 7420, allowedHosts: ['127.0.0.1:7420', 'localhost:7420'] },
    dataDir: '/data',
    requireSignedImages: true,
    claude: {
      ...(args.plan ? { plan: args.plan } : {}),
      ...(tokenCreatedAt ? { tokenCreatedAt } : {}),
    },
    dropZones: [zone],
  };
  writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o644);
  if (override) writeAtomic(overridePath, override, 0o644);
  else if (existsSync(overridePath) && ownOverride) rmSync(overridePath);

  // Report: what was written and what is left, never a value.
  out(`wrote ${CONFIG}: zone ${zone.id} for ${args.repo}, preset ${preset}`);
  out(`  evidence: ${found.evidence.join(', ') || 'none'}`);
  for (const g of found.gates) out(`  gate ${g.name}: ${g.run}`);
  for (const p of found.problems) out(`  note: ${p}`);
  if (found.gates.length === 0)
    out(
      `  no gates were written: add the repository's checks to the zone's gates (${DOC}#presets)`,
    );
  out('  egress: monitor (the doctor drop shows the hosts to allow before you switch to enforce)');
  out('  images: signed releases only (requireSignedImages: true)');
  if (access.private) out('  the repository is private: reviewReadToken is on');
  if (generated.length) out(`generated ${generated.join(' and ')} (mode 0600)`);
  if (override) out(`wrote ${OVERRIDE} (compose reads it next to compose.yaml)`);
  if (tokenCreatedAt)
    out(
      `claude.tokenCreatedAt is ${tokenCreatedAt} (the date of secrets/claude_token); correct it in the config if you ran claude setup-token on another day`,
    );
  if (args.identity === 'starter') out(`warning: ${STARTER_WARNING}`);
  if (access.permissions.admin && !args.authorMayBeAdmin)
    out(
      `warning: the author token's account is an admin of ${args.repo}, which the doctor fails (forge.admin). If that account is the owner of a personal repository and the token is fine-grained, rerun with --author-may-be-admin --force (${DOC}#tokens).`,
    );
  const needed = [
    'claude_token',
    ...(args.identity === 'starter' ? [] : ['github_reviewer_token']),
    ...(access.private ? ['github_read_token'] : []),
  ].filter((n) => !existsSync(secretPath(n)));
  out('next:');
  if (needed.length)
    out(
      `  write ${needed.map((n) => `secrets/${n}`).join(', ')} (mode 0600, one line each; ${DOC}#tokens)`,
    );
  out(`  create the labels (${DOC}#labels)`);
  out('  docker compose up -d');
  out('  docker compose exec jumpmaster jumpmaster ctl doctor');
  return 0;
}

/** The real dependencies, for the CLI. */
export async function initMain(argv: string[]): Promise<number> {
  const { GitHubForge } = await import('./forge/github.js');
  let uidMap: string | null = null;
  try {
    uidMap = readFileSync('/proc/self/uid_map', 'utf8');
  } catch {
    uidMap = null;
  }
  return runInit(argv, {
    dir: process.env.JM_INSTALL_DIR || '/install',
    uid: process.getuid?.() ?? null,
    uidMap,
    forge: (repo, token) => {
      const [owner, name] = repo.split('/') as [string, string];
      return new GitHubForge(owner, name, token, { requestTimeoutMs: 30_000 });
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
