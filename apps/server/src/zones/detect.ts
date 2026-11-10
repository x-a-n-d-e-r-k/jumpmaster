import type { GateSpec, Preset } from '@jumpmaster/protocol';
import type { Forge } from '../forge/github.js';
import { jobNames, runsOnPullRequest } from '../github/workflows.js';
import { DETECT_FILES, detectAs, detectPreset } from '../presets.js';

/**
 * Repository detection, shared by `init`, the setup wizard's project step and `ctl zones add`:
 * GET-only reads, on the default branch root, after the repository name passes `REPO`. The result
 * is a proposal the operator confirms; repository content stays data (§7.1). The owner type and
 * the CI job names (from `.github/workflows/` on the default branch) feed the GitHub guidance.
 */

/** `owner/name` as GitHub spells them; anything else is refused before a request is made. */
export const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export class RepoNameError extends Error {
  constructor(repo: string) {
    super(`the repository must be owner/name, not ${JSON.stringify(repo.slice(0, 100))}`);
  }
}

export type DetectForge = Pick<Forge, 'repoAccess' | 'listDir' | 'getFileAt'>;

export type Detection = {
  visibility: 'public' | 'private';
  defaultBranch: string;
  /** Absent when the root holds no recognised stack, or more than one (see `candidates`). */
  preset?: Preset;
  candidates: Preset[];
  gates: GateSpec[];
  /** The build files the proposal rests on, and what the operator should know about it. */
  evidence: string[];
  problems: string[];
  /** Whether the token's account is an admin of the repository (a personal repository's owner). */
  admin: boolean;
  /** The repository owner's account type. */
  ownerType: 'User' | 'Organization';
  /** The jobs of the workflows that run on pull requests: the checks a ruleset should require. */
  ciJobs: { workflow: string; job: string }[];
};

const WORKFLOWS = '.github/workflows';

/**
 * The jobs of `.github/workflows/*.yml` and `*.yaml` on `branch` whose workflow runs on
 * `pull_request`, and the workflows left out for not running on pull requests.
 */
export async function workflowJobs(
  forge: Pick<Forge, 'listDir' | 'getFileAt'>,
  branch: string,
): Promise<{ ciJobs: Detection['ciJobs']; skipped: string[] }> {
  const names = ((await forge.listDir(branch, WORKFLOWS)) ?? [])
    .filter((n) => /^[\w.-]+\.ya?ml$/.test(n))
    .sort();
  const ciJobs: Detection['ciJobs'] = [];
  const skipped: string[] = [];
  for (const workflow of names) {
    const text = await forge.getFileAt(branch, `${WORKFLOWS}/${workflow}`);
    if (text === null) continue;
    if (!runsOnPullRequest(text)) {
      skipped.push(workflow);
      continue;
    }
    for (const job of jobNames(text)) ciJobs.push({ workflow, job });
  }
  return { ciJobs, skipped };
}

/** A zone id from the repository name: lower case, letters, digits and dashes. */
export const zoneIdOf = (repo: string): string =>
  (repo.split('/')[1] ?? 'main')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '') || 'main';

/** The repository's root build files, as detection reads them. */
export async function rootFiles(
  forge: Pick<Forge, 'listDir' | 'getFileAt'>,
  branch: string,
): Promise<Record<string, string | null>> {
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

export async function detectRepo(
  forge: DetectForge,
  repo: string,
  opts: { preset?: Preset } = {},
): Promise<Detection> {
  if (!REPO.test(repo)) throw new RepoNameError(repo);
  const access = await forge.repoAccess();
  const files = await rootFiles(forge, access.defaultBranch);
  const found = opts.preset ? detectAs(opts.preset, files) : detectPreset(files);
  const ci = await workflowJobs(forge, access.defaultBranch);
  return {
    visibility: access.private ? 'private' : 'public',
    defaultBranch: access.defaultBranch,
    ...(found.preset ? { preset: found.preset } : {}),
    candidates: found.candidates,
    gates: found.gates,
    evidence: [
      ...found.evidence,
      ...(ci.skipped.length > 0
        ? [`${ci.skipped.join(', ')} not run on pull requests, so not proposed as required checks`]
        : []),
    ],
    problems: found.problems,
    admin: access.permissions.admin,
    ownerType: access.ownerType,
    ciJobs: ci.ciJobs,
  };
}

/** Why detection could not read the repository, by HTTP status: never GitHub's text or a token. */
export function detectFailure(e: unknown, repo: string): string {
  const status = (e as { status?: unknown }).status;
  if (status === 401)
    return 'GitHub rejected the author token (401): it is expired, revoked or mistyped';
  if (status === 403 || status === 404)
    return `the author token can't read ${repo} (HTTP ${status}): check the repository name, and that the token's repository access includes it with Contents and Metadata read`;
  return `could not read ${repo} from GitHub (${typeof status === 'number' ? `HTTP ${status}` : 'no HTTP answer'}): check this host reaches api.github.com`;
}

export const NO_AUTHOR =
  "set the GitHub author token first (the setup wizard's forge step, or jumpmaster ctl secrets set githubAuthorToken): detection reads the repository with it";

/** What the GitHub guidance reads about a repository: GET-only, after the REPO pattern. */
export async function detectGuidance(
  forge: Pick<Forge, 'repoAccess' | 'listDir' | 'getFileAt'>,
  repo: string,
  opts: { workflows?: boolean } = {},
): Promise<Pick<Detection, 'visibility' | 'defaultBranch' | 'ownerType' | 'ciJobs'>> {
  if (!REPO.test(repo)) throw new RepoNameError(repo);
  const access = await forge.repoAccess();
  // Without a token nothing uses the job names: two reads instead of one per workflow.
  const { ciJobs } =
    opts.workflows === false ? { ciJobs: [] } : await workflowJobs(forge, access.defaultBranch);
  return {
    visibility: access.private ? 'private' : 'public',
    defaultBranch: access.defaultBranch,
    ownerType: access.ownerType,
    ciJobs,
  };
}
