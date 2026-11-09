// `jumpmaster init`: writes a compose install's config and generated secrets. It runs in the
// server image as the host user (compose profile `init`), with the install directory mounted
// read-write at /install:
//
//   docker compose --profile init run --rm init --repo owner/name [--preset p]
//     [--identity two-bot|starter] [--author-may-be-admin] [--plan p] [--force] [--allow-root]
//     [--offline --preset p [--private]]
//
// It reads the author token from secrets/github_author_token and, with it, the repository's
// visibility and root build files (GET requests only; `--offline` skips GitHub and takes the
// preset and visibility from the flags), then writes:
//   - config/jumpmaster.config.json (the stack preset and its gates, egress monitor, signed images);
//   - secrets/join_token and secrets/operator_token (0600), only when absent;
//   - a block of compose variables in .env, only for starter mode (no reviewer token is mounted)
//     or a private repository (the read token is), removed again when neither applies.
// Token files others can read are tightened to 0600.
//
// Exit codes: 0 done, 1 refused or failed (the reason is printed), 2 usage or ambiguous detection
// without --preset, 3 an existing config without --force, 4 the install directory is not
// writable. No secret value is ever printed.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PRESETS, type Preset } from '@jumpmaster/protocol';
import { IDENTITIES, type Identity, STARTER_WARNING } from './config.js';
import { DOC, identityMap } from './doctor/checks.js';
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
  '         [--offline --preset p [--private]]   (write the config without reading GitHub)',
].join('\n');
const PLANS = ['pro', 'max', 'team_standard', 'team_premium', 'enterprise'] as const;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const CONFIG = 'config/jumpmaster.config.json';
/** init's own lines in .env, between these markers; everything else in .env is the operator's. */
const ENV_BEGIN = '# jumpmaster init: begin (rerun init to change these lines)';
const ENV_END = '# jumpmaster init: end';

type Args = {
  repo: string;
  preset?: Preset;
  identity: Identity;
  plan?: (typeof PLANS)[number];
  authorMayBeAdmin: boolean;
  force: boolean;
  allowRoot: boolean;
  offline: boolean;
  privateRepo: boolean;
  help: boolean;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> &
    Pick<Args, 'authorMayBeAdmin' | 'force' | 'allowRoot' | 'offline' | 'privateRepo' | 'help'> = {
    identity: 'two-bot',
    authorMayBeAdmin: false,
    force: false,
    allowRoot: false,
    offline: false,
    privateRepo: false,
    help: false,
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
      case '--offline':
        args.offline = true;
        break;
      case '--private':
        args.privateRepo = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        return args as Args;
      default:
        throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (!args.repo) throw new UsageError('--repo is required');
  if (args.privateRepo && !args.offline)
    throw new UsageError('--private goes with --offline (online, init reads the visibility)');
  if (args.offline && !args.preset)
    throw new UsageError('--offline needs --preset: without GitHub, init cannot detect the stack');
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

/**
 * The compose variables init keeps in .env: the template mounts the reviewer token and no read
 * token by default; starter mode unmounts the first, a private repository mounts the second.
 * Plain `.env` interpolation, so any Compose v2 reads it.
 */
export function composeEnv(o: { starter: boolean; privateRepo: boolean }): string[] {
  return [
    ...(o.starter ? ['JM_REVIEWER_TOKEN_FILE=', 'JM_REVIEWER_TOKEN_SRC=/dev/null'] : []),
    ...(o.privateRepo
      ? [
          'JM_READ_TOKEN_FILE=/run/secrets/github_read_token',
          'JM_READ_TOKEN_SRC=./secrets/github_read_token',
        ]
      : []),
  ];
}

/** .env with init's block replaced by `lines` (removed when empty); other lines untouched. */
export function withEnvBlock(env: string, lines: string[]): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of env.split('\n')) {
    if (line === ENV_BEGIN) inside = true;
    else if (line === ENV_END) inside = false;
    else if (!inside) kept.push(line);
  }
  let text = kept.join('\n');
  if (text !== '' && !text.endsWith('\n')) text += '\n';
  return lines.length === 0 ? text : `${text}${[ENV_BEGIN, ...lines, ENV_END].join('\n')}\n`;
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
  if (args.help) {
    out(USAGE);
    out(`see ${DOC}#step-5-run-init`);
    return 0;
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
      `refusing to run as root (uid 0): the server holds your GitHub and Claude tokens and runs as the user that owns the install's files, so a bug in it would act as root on the host's files. Set JM_UID and JM_GID in .env to an ordinary user (id -u, id -g). On a host where you only have root, create one first (adduser jumpmaster && usermod -aG docker jumpmaster, then do the install as that user; ${DOC}#step-1-write-env). --allow-root runs as root anyway, and the doctor's config.uid then warns for good.`,
    );
  // Every directory init writes, probed before anything is written: a directory Docker created
  // as root (`up` before `init`) is exit 4 with the fix, not a stack trace halfway through.
  for (const d of ['', 'config', 'data', 'secrets']) {
    const at = join(dir, d);
    try {
      mkdirSync(at, { recursive: true, mode: 0o700 });
      const probe = join(at, `.jumpmaster-init-${process.pid}`);
      writeFileSync(probe, '');
      rmSync(probe);
    } catch (e) {
      const where = d === '' ? 'the install directory' : `${d}/`;
      return fail(
        `can't write to ${where} (${errno(e) ?? 'error'}): mount /install read-write (compose's init service mounts the install directory as .:/install), owned by the JM_UID user. If Docker created it as root (docker compose up before init), run in the install directory: sudo chown -R "$(id -u):$(id -g)" config data secrets`,
        4,
      );
    }
  }
  const configPath = join(dir, CONFIG);
  if (existsSync(configPath) && !args.force)
    return fail(
      `${CONFIG} already exists. --force rewrites the whole config: hand edits (gates, egress.allow, anything else) are lost, so reapply them after; generated secrets are kept`,
      3,
    );

  // Token files only their owner may read; tighten any that others can.
  const secretPath = (name: string) => join(dir, 'secrets', name);
  const tightened: string[] = [];
  for (const name of readdirSync(join(dir, 'secrets'))) {
    try {
      const st = statSync(secretPath(name));
      if (st.isFile() && (st.mode & 0o077) !== 0) {
        chmodSync(secretPath(name), 0o600);
        tightened.push(`secrets/${name}`);
      }
    } catch {
      // not ours to change: readSecret reports it if it matters
    }
  }

  // The author token: read, never shown.
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
  let access: { private: boolean; defaultBranch: string; permissions: { admin: boolean } };
  let files: Record<string, string | null>;
  if (args.offline) {
    access = {
      private: args.privateRepo,
      defaultBranch: '(not read)',
      permissions: { admin: false },
    };
    files = {};
  } else
    try {
      const forge = deps.forge(args.repo, authorToken);
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
  const envLines = composeEnv({
    starter: args.identity === 'starter',
    privateRepo: access.private,
  });

  // Write: generated secrets (only when absent), the config, init's .env block.
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
  const envPath = join(dir, '.env');
  const envBefore = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const envAfter = withEnvBlock(envBefore, envLines);
  if (envAfter !== envBefore)
    writeAtomic(envPath, envAfter, existsSync(envPath) ? statSync(envPath).mode & 0o777 : 0o644);

  // Report: what was written and what is left, never a value.
  if (args.offline)
    out(
      `offline: GitHub was not read; preset ${preset} and visibility ${access.private ? 'private' : 'public'} are from the flags`,
    );
  for (const t of tightened) out(`${t} was readable by other users: set it to 0600`);
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
  if (envAfter !== envBefore)
    out(
      envLines.length
        ? `wrote init's lines in .env (${envLines.map((l) => l.split('=')[0]).join(', ')})`
        : "removed init's lines from .env",
    );
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
