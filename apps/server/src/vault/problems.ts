import type { DropZoneConfig } from '../config.js';
import {
  type CredentialName,
  gateSecretName,
  gateSecretVar,
  MIN_GATE_SECRET,
  type Resolved,
  type ResolvedCredential,
} from './credentials.js';

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

export function credentialProblems(zone: DropZoneConfig, resolved: Resolved): CredentialProblem[] {
  const out: CredentialProblem[] = [];
  const add = (kind: CredentialProblem['kind'], credential: CredentialName, message: string) =>
    out.push({ zoneId: zone.id, kind, credential, message });
  const where = (file: string) => `enter it under Settings, Credentials, or write secrets/${file}`;

  if (!present(resolved.claudeToken))
    add('missing', 'claudeToken', `no Claude token is set: ${where('claude_token')}`);

  const author = resolved.githubAuthorToken;
  if (!present(author))
    add(
      'missing',
      'githubAuthorToken',
      `no GitHub author token is set: ${where('github_author_token')}`,
    );
  else if (zone.identity === 'starter' && !fine(author))
    add(
      'kind',
      'githubAuthorToken',
      `zone ${zone.id} is a starter zone, which merges with the author token: it must be a fine-grained token (github_pat_) limited to the repository`,
    );
  else if (zone.authorMayBeAdmin && !fine(author))
    add(
      'kind',
      'githubAuthorToken',
      `zone ${zone.id} sets authorMayBeAdmin, which needs a fine-grained author token (github_pat_): an admin's classic token could edit the ruleset`,
    );

  if (zone.identity !== 'starter') {
    const reviewer = resolved.githubReviewerToken;
    if (!present(reviewer))
      add(
        'missing',
        'githubReviewerToken',
        `zone ${zone.id} uses two bots, and no GitHub reviewer token is set: ${where('github_reviewer_token')}`,
      );
    else if (present(author)) {
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

  if (zone.reviewReadToken && !present(resolved.githubReadToken))
    add(
      'missing',
      'githubReadToken',
      `zone ${zone.id} sets reviewReadToken, and no GitHub read token is set: ${where('github_read_token')}`,
    );

  for (const name of zone.gateSecrets) {
    const credential = gateSecretName(zone.id, name);
    const r = resolved[credential];
    if (!present(r))
      add(
        'missing',
        credential,
        `gate secret ${name} is not set: enter it under Settings, Credentials, or set ${gateSecretVar(zone.id, name)}`,
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
