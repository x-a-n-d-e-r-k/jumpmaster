import type { GateSpec, Preset } from '@jumpmaster/protocol';
import type { Forge } from '../forge/github.js';
import { DETECT_FILES, detectAs, detectPreset } from '../presets.js';

/**
 * Repository detection, shared by `init`, the setup wizard's project step and `ctl zones add`:
 * GET-only reads, on the default branch root, after the repository name passes `REPO`. The result
 * is a proposal the operator confirms; repository content stays data (§7.1). Task 7 adds the owner
 * type and the CI job names.
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
};

/** A zone id from the repository name: lower case, letters, digits and dashes. */
export const zoneIdOf = (repo: string): string =>
  (repo.split('/')[1] ?? 'main')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
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
  return {
    visibility: access.private ? 'private' : 'public',
    defaultBranch: access.defaultBranch,
    ...(found.preset ? { preset: found.preset } : {}),
    candidates: found.candidates,
    gates: found.gates,
    evidence: found.evidence,
    problems: found.problems,
    admin: access.permissions.admin,
  };
}
