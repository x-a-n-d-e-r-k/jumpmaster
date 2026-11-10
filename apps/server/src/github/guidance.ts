import { type DropZoneConfig, STARTER_WARNING } from '../config.js';
import type { Detection } from '../zones/detect.js';

/**
 * GitHub guidance (§10.3, M4.5): the half of setup that lives on GitHub, met with links and
 * generated text. Nothing here writes to GitHub or holds a credential: the clicks, the import and
 * the commit stay the operator's. Every URL is under https://github.com/.
 *
 * The token template parameters are GitHub's "Pre-filling fine-grained personal access token
 * details using URL parameters" (docs.github.com, managing your personal access tokens): `name`
 * (40 characters at most), `description`, `target_name` (the resource owner), `expires_in` (1 to
 * 366 days) and one parameter per permission. That page documents no parameter for the repository
 * selection, so each link names the repository in its description and the step says to choose it.
 */

const GITHUB = 'https://github.com';

export type PatRole = 'author' | 'reviewer' | 'read';

/** The install runbook's Tokens table, in GitHub's permission parameter names. */
export const PAT_PERMISSIONS: Record<PatRole, Record<string, 'read' | 'write'>> = {
  author: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    metadata: 'read',
    statuses: 'read',
    actions: 'read',
  },
  reviewer: { pull_requests: 'write', contents: 'read', metadata: 'read' },
  read: { contents: 'read', metadata: 'read' },
};

/** Never in a template: Workflows could change CI, Administration the ruleset that guards merges. */
const FORBIDDEN = new Set(['workflows', 'administration']);

/** What the token step says beside every link. */
export const RESOURCE_OWNER_NOTE =
  'check the Resource owner field: for an organization it may not pre-fill, and the link may set only what it shows, so re-select the organization even when it looks selected';
export const REPOSITORY_ACCESS_NOTE =
  'set Repository access to Only select repositories and choose the repository: the link cannot choose it';

/** How long a template's token lasts: the doctor warns two weeks before it expires. */
export const PAT_EXPIRATION_DAYS = 90;
export const EXPIRATION_NOTE = `each link asks for ${PAT_EXPIRATION_DAYS} days; an organization's token lifetime policy may cap it at less, and the doctor warns two weeks before a token expires`;

/** At most 40 characters (GitHub's limit), cut where a reader still sees the repository. */
function tokenName(role: PatRole, name: string): string {
  const full = `jumpmaster-${role}-${name}`;
  if (full.length <= 40) return full;
  const head = full.slice(0, 40);
  const prefix = `jumpmaster-${role}-`.length;
  // The last separator after the role, when cutting there keeps a readable part of the name.
  const at = Math.max(head.lastIndexOf('-'), head.lastIndexOf('_'), head.lastIndexOf('.'));
  const cut = at >= prefix + 4 ? head.slice(0, at) : head;
  return cut.replace(/[-_.]+$/, '');
}

const ROLE_WORDS: Record<PatRole, string> = {
  author: 'author (opens and merges pull requests)',
  reviewer: 'reviewer (approves pull requests)',
  read: 'read (clones a private repository for review, crew and doctor drops)',
};

type Repo = { owner: string; name: string };

export const repoOf = (zone: Pick<DropZoneConfig, 'repo'>): Repo => {
  const [owner = '', name = ''] = zone.repo.split('/');
  return { owner, name };
};

/** The fine-grained token page, pre-filled for `role` on `repo`. */
export function patTemplateUrl(
  role: PatRole,
  repo: Repo,
  opts: { expirationDays?: number } = {},
): string {
  const full = `${repo.owner}/${repo.name}`;
  const q = new URLSearchParams();
  q.set('name', tokenName(role, repo.name));
  q.set(
    'description',
    `Jumpmaster ${ROLE_WORDS[role]} for ${full}. Repository access: Only select repositories, then ${full}. No Workflows or Administration permission.`,
  );
  q.set('target_name', repo.owner);
  if (opts.expirationDays !== undefined) {
    const d = opts.expirationDays;
    if (!Number.isInteger(d) || d < 1 || d > 366)
      throw new Error('a token template expires in 1 to 366 days');
    q.set('expires_in', String(d));
  }
  for (const [permission, level] of Object.entries(PAT_PERMISSIONS[role])) {
    if (FORBIDDEN.has(permission)) throw new Error(`a template never asks for ${permission}`);
    q.set(permission, level);
  }
  return `${GITHUB}/settings/personal-access-tokens/new?${q.toString()}`;
}

/** GitHub Actions, as the source of a required status check. */
const ACTIONS_APP = 15368;

/**
 * The branch ruleset for GitHub's import (Settings → Rules → Rulesets → New ruleset → Import a
 * ruleset): the install runbook's Branch rules JSON, with the detected job names as required
 * checks from GitHub Actions, one approval for two-bot and none for starter, and no bypass. It
 * targets `~DEFAULT_BRANCH`, so a renamed default branch stays covered. With no job detected the
 * status-check rule is left out (GitHub refuses it empty) and the step says to add the checks.
 */
export function rulesetJson(
  zone: Pick<DropZoneConfig, 'identity'>,
  detection: Pick<Detection, 'defaultBranch' | 'ciJobs'>,
): string {
  const contexts = [...new Set(detection.ciJobs.map((j) => j.job))];
  const ruleset = {
    name: 'jumpmaster',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: zone.identity === 'starter' ? 0 : 1,
          dismiss_stale_reviews_on_push: true,
          // Two-bot: GitHub requires a named person's approval for the protected paths (the
          // code owners are people, and Jumpmaster never merges those pull requests itself).
          // Starter: off. The operator is the author and the only code owner, and GitHub never
          // lets an author approve their own pull request; Jumpmaster parks every pull request
          // touching a protected path for a human merge instead (§7.4's "or equivalent").
          require_code_owner_review: zone.identity !== 'starter',
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      ...(contexts.length > 0
        ? [
            {
              type: 'required_status_checks',
              parameters: {
                strict_required_status_checks_policy: false,
                required_status_checks: contexts.map((context) => ({
                  context,
                  integration_id: ACTIONS_APP,
                })),
              },
            },
          ]
        : []),
    ],
  };
  return `${JSON.stringify(ruleset, null, 2)}\n`;
}

export const PRIVATE_PLAN_STOP =
  'rulesets on a private repository need a paid plan: make it public or upgrade before any token is created';
export const PLAN_QUESTION =
  "Is this repository's owner on a paid GitHub plan (GitHub Pro for a personal account, GitHub Team or Enterprise for an organization)? Rulesets on a private repository need one, and GitHub does not show the plan to a token without admin rights.";

export type Recommendation = {
  identity: 'two-bot' | 'starter';
  authorMayBeAdmin: boolean;
  reason: string;
  /** Do not go on: what to change first. */
  stop?: string;
  /** Ask the operator first (the plan of a private repository's owner). */
  ask?: string;
  links?: { label: string; url: string }[];
};

/** The accounts to use, from the repository's owner type and visibility. */
export function recommendIdentity(d: {
  ownerType: 'User' | 'Organization';
  visibility: 'public' | 'private';
  paidPlan?: boolean;
  owner?: string;
}): Recommendation {
  const plan =
    d.visibility === 'private'
      ? d.paidPlan === false
        ? { stop: PRIVATE_PLAN_STOP }
        : d.paidPlan === undefined
          ? { ask: PLAN_QUESTION }
          : {}
      : {};
  if (d.ownerType === 'Organization')
    return {
      identity: 'two-bot',
      authorMayBeAdmin: false,
      reason:
        "This repository belongs to an organization: use two bot accounts, an author and a reviewer, each with the Write role on the repository and a fine-grained token whose resource owner is the organization. The organization must allow fine-grained tokens (the organization's Settings → Personal access tokens → Settings) and may have to approve each token. Neither bot may be an admin.",
      ...plan,
      ...(d.owner && /^[A-Za-z0-9-]+$/.test(d.owner)
        ? {
            links: [
              {
                label: 'the organization (Settings → Personal access tokens)',
                url: `${GITHUB}/${d.owner}`,
              },
            ],
          }
        : {}),
    };
  return {
    identity: 'starter',
    authorMayBeAdmin: true,
    reason: `This repository belongs to a personal account. A fine-grained token cannot serve a collaborator bot on another person's repository, so use your own account as the author in starter mode, with authorMayBeAdmin (you own the repository, so your account is its admin; the token itself gets no Administration permission). What starter mode costs: ${STARTER_WARNING}`,
    ...plan,
  };
}

/** What the CODEOWNERS text puts where no login was given yet. */
export const CODEOWNERS_PLACEHOLDER = '@your-github-login';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEAM = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** A user or team as CODEOWNERS spells it; anything else is refused. */
function owner(who: string): string {
  const bare = who.startsWith('@') ? who.slice(1) : who;
  if (!LOGIN.test(bare) && !TEAM.test(bare))
    throw new Error('a code owner is a GitHub login or an org/team name');
  return `@${bare}`;
}

/**
 * A protected-path glob CODEOWNERS can hold as it is: its gitignore-style patterns share our
 * rules (a pattern without a slash matches the name anywhere, `**` any depth), but have no
 * negation, character classes, escapes or spaces.
 */
const expressible = (p: string): boolean =>
  p !== '' && !/[\s[\]\\]/.test(p) && !p.startsWith('!') && !p.startsWith('#');

/**
 * `.github/CODEOWNERS` for the zone's protected paths: one line per path naming every reviewer,
 * so a change to them asks a human (§7.4). The reviewers are people (the operator types their
 * own login), never the bots.
 */
/** What a comment line may carry: never a line break, which would start a rule of its own. */
const oneLine = (v: string): string => v.replace(/[\r\n]+/g, ' ');

/** What the starter-mode CODEOWNERS and ruleset say in place of GitHub's code-owner review. */
export const STARTER_CODEOWNERS_NOTE =
  'In starter mode GitHub cannot require this review: you are the author and the only code owner, and GitHub never lets an author approve their own pull request. Jumpmaster parks every pull request that touches these paths for you to review and merge by hand.';

export function codeownersText(
  zone: Pick<DropZoneConfig, 'id' | 'protectedPaths' | 'identity'>,
  reviewers: string[],
): string {
  const owners = reviewers.length > 0 ? reviewers.map(owner) : [CODEOWNERS_PLACEHOLDER];
  const ok = zone.protectedPaths.filter(expressible);
  const not = zone.protectedPaths.filter((p) => !expressible(p));
  return [
    `# Jumpmaster zone ${oneLine(zone.id)}: changes to these paths need a human code owner's review.`,
    ...(zone.identity === 'starter' ? [`# ${STARTER_CODEOWNERS_NOTE}`] : []),
    ...(reviewers.length === 0
      ? [`# Replace ${CODEOWNERS_PLACEHOLDER} with your GitHub login before committing.`]
      : []),
    ...ok.map((p) => `${p} ${owners.join(' ')}`),
    ...(not.length > 0 ? [`# not expressible in CODEOWNERS: ${not.map(oneLine).join(', ')}`] : []),
    '',
  ].join('\n');
}

const segments = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/');

/** GitHub's new-file page for `.github/CODEOWNERS` on `branch`. */
export function codeownersNewFileUrl(repo: Repo, branch: string): string {
  const q = new URLSearchParams({ filename: '.github/CODEOWNERS' });
  return `${GITHUB}/${repo.owner}/${repo.name}/new/${segments(branch)}?${q.toString()}`;
}

/** The repository's collaborator page and what to do there, per bot account. */
export function collaboratorChecklist(
  zone: Pick<DropZoneConfig, 'repo' | 'identity'>,
  logins: { author?: string; reviewer?: string },
): { url: string; items: string[] } {
  const repo = repoOf(zone);
  const name = (who: string | undefined, role: string) =>
    who && LOGIN.test(who) ? who : `the ${role} account`;
  const accounts = [
    name(logins.author, 'author'),
    ...(zone.identity === 'starter' ? [] : [name(logins.reviewer, 'reviewer')]),
  ];
  const items = accounts.flatMap((a) =>
    a.toLowerCase() === repo.owner.toLowerCase()
      ? [`nothing to invite: ${a} owns the repository`]
      : [`invite ${a} with the Write role`, `accept the invitation as ${a}`],
  );
  return { url: `${GITHUB}/${repo.owner}/${repo.name}/settings/access`, items };
}

export type ZoneGuidance = {
  recommendation: Recommendation;
  pat: { author: string; reviewer: string; read: string };
  ruleset: { filename: string; text: string; note?: string };
  codeowners: { filename: string; text: string; newFileUrl: string };
  checklist: { url: string; items: string[] };
  /** The repository's rulesets page, where the ruleset file is imported. */
  rulesUrl: string;
};

export type GuidanceZone = Pick<
  DropZoneConfig,
  'id' | 'repo' | 'identity' | 'protectedPaths' | 'reviewReadToken'
>;

/** The five, for one zone: what the page, the route, `ctl github` and the doctor read. */
export function zoneGuidance(
  zone: GuidanceZone,
  detection: Pick<Detection, 'defaultBranch' | 'ciJobs' | 'ownerType' | 'visibility'>,
  logins: { author?: string; reviewer?: string; codeowners?: string[] },
  opts: { paidPlan?: boolean } = {},
): ZoneGuidance {
  const repo = repoOf(zone);
  const days = { expirationDays: PAT_EXPIRATION_DAYS };
  return {
    recommendation: recommendIdentity({
      ownerType: detection.ownerType,
      visibility: detection.visibility,
      owner: repo.owner,
      ...(opts.paidPlan !== undefined ? { paidPlan: opts.paidPlan } : {}),
    }),
    pat: {
      author: patTemplateUrl('author', repo, days),
      reviewer: patTemplateUrl('reviewer', repo, days),
      read: patTemplateUrl('read', repo, days),
    },
    ruleset: {
      filename: `jumpmaster-${zone.id}-ruleset.json`,
      text: rulesetJson(zone, detection),
      ...(detection.ciJobs.length === 0
        ? {
            note: `No workflow that runs on pull requests was found, so this file requires only that a pull request must exist (${zone.identity === 'starter' ? 'with zero approvals' : 'with one approval'}) and no CI check: after importing, add your CI checks under Require status checks to pass, with GitHub Actions as the source.`,
          }
        : {}),
    },
    codeowners: {
      filename: '.github/CODEOWNERS',
      text: codeownersText(zone, logins.codeowners ?? []),
      newFileUrl: codeownersNewFileUrl(repo, detection.defaultBranch),
    },
    checklist: collaboratorChecklist(zone, logins),
    rulesUrl: `${GITHUB}/${repo.owner}/${repo.name}/settings/rules`,
  };
}
