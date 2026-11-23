import type { DropZoneConfig } from '../config.js';
import {
  type CredentialName,
  gateSecretName,
  gateSecretVar,
  MIN_GATE_SECRET,
  type Resolved,
  type ResolvedCredential,
} from './credentials.js';
import { appEntryName } from './github-app-entries.js';
import {
  type CredentialResolution,
  credentialFor,
  isAppReviewerZone,
  type ResolvedApps,
} from './resolution.js';

/**
 * The rules that span a zone's config and the credentials (§7.5), judged locally and at once.
 * They are dispatch refusals, not apply-time errors: a zone may exist before its credentials do
 * (the wizard is skippable), and it waits, parked with the problem as its reason, until they
 * arrive. The doctor reports them as `credential.missing`, `credential.kind` and `credential.same`.
 */

export type CredentialProblem = {
  zoneId: string;
  kind: 'missing' | 'kind' | 'same';
  credential: CredentialName;
  /** Plain words and the fix; never a value. */
  message: string;
};

const fine = (r: ResolvedCredential | undefined): boolean =>
  r?.value?.startsWith('github_pat_') === true;
const present = (r: ResolvedCredential | undefined): boolean =>
  r !== undefined && r.value !== undefined && r.value !== '';

/**
 * `apps`: the GitHub App entries as they resolved. An app-reviewer zone's review, crew and doctor
 * drops clone with a reviewer token minted per drop (issue #237), so it needs no read token. A
 * role that resolves to its owner's app (§4.4) needs no PAT; one whose entry won't decrypt stays
 * parked on that role's PAT name, since resolution never falls back to the PAT (issue #458).
 */
export function credentialProblems(
  zone: DropZoneConfig,
  resolved: Resolved,
  apps: ResolvedApps = new Map(),
): CredentialProblem[] {
  const out: CredentialProblem[] = [];
  const add = (kind: CredentialProblem['kind'], credential: CredentialName, message: string) =>
    out.push({ zoneId: zone.id, kind, credential, message });
  const where = (file: string) => `enter it under System, Credentials, or write secrets/${file}`;

  if (!present(resolved.claudeToken))
    add('missing', 'claudeToken', `no Claude token is set: ${where('claude_token')}`);

  const undecryptable = (credential: CredentialName, owner: string, role: 'author' | 'reviewer') =>
    add(
      'missing',
      credential,
      `${appEntryName(owner, role)} is undecryptable: import the entry again, or restore the vault key it was stored with`,
    );
  const appOf = (r: CredentialResolution): string | undefined =>
    r.ref.kind === 'github-app' ? r.ref.owner : undefined;
  const authorRes = credentialFor(zone, 'author', apps);
  const reviewerRes = credentialFor(zone, 'reviewer', apps);
  const authorApp = appOf(authorRes);
  const reviewerApp = appOf(reviewerRes);

  const author = resolved.githubAuthorToken;
  if (authorApp !== undefined) {
    if (authorRes.problem === 'undecryptable')
      undecryptable('githubAuthorToken', authorApp, 'author');
  } else if (!present(author))
    add(
      'missing',
      'githubAuthorToken',
      `no GitHub author token is set: ${where('github_author_token')}`,
    );
  else if (zone.identity === 'starter' && !fine(author))
    add(
      'kind',
      'githubAuthorToken',
      `project ${zone.id} is a starter project, which merges with the author token: it must be a fine-grained token (github_pat_) limited to the repository`,
    );
  else if (zone.authorMayBeAdmin && !fine(author))
    add(
      'kind',
      'githubAuthorToken',
      `project ${zone.id} sets authorMayBeAdmin, which needs a fine-grained author token (github_pat_): an admin's classic token could edit the ruleset`,
    );

  if (zone.identity !== 'starter') {
    const reviewer = resolved.githubReviewerToken;
    if (reviewerApp !== undefined) {
      if (reviewerRes.problem === 'undecryptable')
        undecryptable('githubReviewerToken', reviewerApp, 'reviewer');
    } else if (!present(reviewer))
      add(
        'missing',
        'githubReviewerToken',
        `project ${zone.id} uses two bots, and no GitHub reviewer token is set: ${where('github_reviewer_token')}`,
      );
    else if (authorApp === undefined && present(author)) {
      const sameValue = reviewer?.value === author?.value;
      const sameLogin =
        reviewer?.login !== undefined &&
        author?.login !== undefined &&
        reviewer.login === author.login;
      if (sameValue || sameLogin)
        add(
          'same',
          'githubReviewerToken',
          `the reviewer token belongs to the author's account${sameLogin ? ` (${author?.login})` : ''}: a review must come from another account`,
        );
    }
  }

  if (zone.reviewReadToken && !present(resolved.githubReadToken) && !isAppReviewerZone(zone, apps))
    add(
      'missing',
      'githubReadToken',
      `project ${zone.id} sets reviewReadToken, and no GitHub read token is set: ${where('github_read_token')}`,
    );

  for (const name of zone.gateSecrets) {
    const credential = gateSecretName(zone.id, name);
    const r = resolved[credential];
    if (!present(r))
      add(
        'missing',
        credential,
        `gate secret ${name} is not set: enter it under System, Credentials, or set ${gateSecretVar(zone.id, name)}`,
      );
    else if ((r?.value?.length ?? 0) < MIN_GATE_SECRET)
      add(
        'kind',
        credential,
        `gate secret ${name} is shorter than ${MIN_GATE_SECRET} characters, too short to redact from logs`,
      );
  }
  return out;
}
