import {
  createGitHubAppBroker,
  type GitHubAppBroker,
  GitHubAppError,
} from '../forge/github-app.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import type { GitHubAppEntry } from '../vault/github-app-entries.js';

/**
 * Detection before a zone exists, on GitHub Apps (issue #549). An install that follows the apps
 * path holds no author token, and no zone yet, so the token source (keyed by zone) and the brokers
 * (built for the configured zones' owners) have nothing for the repository. The spec is silent on
 * this read; the least operator work is to read through the owner's author app: the installation
 * on the repository, its id, then one token narrowed to that repository and to `drop-read-author`
 * (`contents: read`), as discovery does. The token serves this one detection: it is registered
 * with redaction, never stored or cached, and revoked once the detection is done.
 */

/** What detection needs of a broker. */
export type DetectAppBroker = Pick<
  GitHubAppBroker,
  'installationFor' | 'repositoryIdOf' | 'mint' | 'revoke'
>;

/** The broker over an app entry: GitHub's, with every key, JWT and token in the scrub set. */
export function defaultDetectAppBroker(
  entry: Pick<GitHubAppEntry, 'appId' | 'pem'>,
): DetectAppBroker {
  return createGitHubAppBroker({
    appId: entry.appId,
    privateKey: entry.pem,
    onSecret: (s) => {
      if (s.includes('-----BEGIN')) serverScrubSet.addPem(s);
      else serverScrubSet.add(s);
    },
  });
}

/** The link that installs an app, from its slug. */
export const appInstallUrl = (slug: string): string =>
  `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

export type AuthorAppToken =
  | { ok: true; token: string; done(): Promise<void> }
  | { ok: false; status: 409 | 502; error: string; installUrl?: string };

/** A one-use `contents: read` token for `repo` from the owner's author app, or why there is none. */
export async function authorAppToken(o: {
  entry: Pick<GitHubAppEntry, 'slug'>;
  broker: DetectAppBroker;
  repo: string;
  log?: (msg: string) => void;
}): Promise<AuthorAppToken> {
  const { entry, broker, repo } = o;
  const [owner, name] = repo.split('/') as [string, string];
  try {
    const inst = await broker.installationFor(owner, name);
    if (!inst.installed) {
      const installUrl = appInstallUrl(entry.slug);
      return {
        ok: false,
        status: 409,
        installUrl,
        error: `the author app ${entry.slug} is not installed on ${repo}: install it on the repository from ${installUrl}, then press Detect again`,
      };
    }
    const repositoryId = await broker.repositoryIdOf(inst.installationId, owner, name);
    const { token } = await broker.mint({
      installationId: inst.installationId,
      repositoryId,
      use: 'drop-read-author',
    });
    serverScrubSet.add(token);
    return {
      ok: true,
      token,
      done: async () => {
        try {
          await broker.revoke(token);
        } catch {
          // It expires within the hour anyway; a failed revoke changes nothing for the operator.
        }
      },
    };
  } catch (e) {
    // The broker's errors are already scrubbed of every key, JWT and token.
    const why = e instanceof GitHubAppError ? e.message : 'asking GitHub failed unexpectedly';
    o.log?.(`detection through the author app ${entry.slug} for ${repo}: ${why}`);
    return {
      ok: false,
      status: 502,
      error: `could not read ${repo} as the author app ${entry.slug}: ${why}`,
    };
  }
}
