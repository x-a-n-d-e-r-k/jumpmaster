import { z } from 'zod';
import {
  type GuidanceForge,
  githubGuidanceForge,
  guidanceFor,
  type RecommendAnswer,
} from '../api/github.js';
import type { ConfigStore } from '../config/store.js';
import type { Config, DropZoneConfig } from '../config.js';
import type { DoctorCheck } from '../doctor/checks.js';
import type { AppTokenSource } from '../forge/app-tokens.js';
import { GITLAB_UNSUPPORTED } from '../forge/kind.js';
import {
  CODEOWNERS_PLACEHOLDER,
  EXPIRATION_NOTE,
  PAT_PERMISSIONS,
  type PatRole,
  RESOURCE_OWNER_NOTE,
  type Recommendation,
  STARTER_CODEOWNERS_NOTE,
  type ZoneGuidance,
} from '../github/guidance.js';
import { MATRIX_AND_REUSABLE_NOTE } from '../github/workflows.js';
import type { AppRole } from '../vault/github-app-entries.js';
import { githubSetupHref, linkTarget, SYSTEM_CREDENTIALS_HREF } from './links.js';
import { escapeHtml } from './pages.js';

/**
 * The GitHub half of setup, as the GitHub section of a project's Setup (`/projects/:id/setup#github`,
 * #618) with each step's doctor status, and as sections the setup wizard reuses: links and generated text, never a forge write. Every piece of forge text is
 * escaped here, and an href is rendered only when it is under https://github.com/ (or the
 * generated file as a data URL to download).
 */

/** An href under GitHub, or nothing usable. */
const gh = (url: string): string =>
  escapeHtml(url.startsWith('https://github.com/') ? url : 'https://github.com/');

const PERMISSION_NAMES: Record<string, string> = {
  contents: 'Contents',
  pull_requests: 'Pull requests',
  issues: 'Issues',
  metadata: 'Metadata',
  statuses: 'Commit statuses',
  actions: 'Actions',
};
const LEVEL = { read: 'Read-only', write: 'Read and write' } as const;

const ROLE_TITLES: Record<PatRole, string> = {
  author: 'The author token (the account that opens and merges pull requests)',
  reviewer: 'The reviewer token (a second account, which approves them)',
  read: 'The read token (clones a private repository for review, crew and doctor drops)',
};

const permissionList = (role: PatRole): string =>
  Object.entries(PAT_PERMISSIONS[role])
    .map(([p, l]) => `${PERMISSION_NAMES[p] ?? p}: ${LEVEL[l]}`)
    .join(' · ');

/** The accounts to use, why, and what stops or asks first. */
export function recommendationSection(rec: Recommendation): string {
  const label =
    rec.identity === 'starter'
      ? 'Starter: your own account as the author, no reviewer account'
      : rec.credentials === 'github-apps'
        ? 'Two bot accounts as GitHub Apps: an author app and a reviewer app'
        : 'Two bot accounts: an author and a reviewer';
  return `<section id="recommendation"><h3>Which accounts</h3>
<p><strong>Recommended: ${escapeHtml(label)}</strong>${rec.authorMayBeAdmin ? ' (the author account owns the repository, so it can merge)' : ''}.</p>
<p>${escapeHtml(rec.reason)}</p>
${rec.stop ? `<p class="warn" data-stop><strong>Stop here:</strong> ${escapeHtml(rec.stop)}.</p>` : ''}
${rec.ask ? `<p class="warn" data-ask><strong>First:</strong> ${escapeHtml(rec.ask)}</p>` : ''}
${(rec.links ?? []).map((l) => `<p><a href="${gh(l.url)}"${linkTarget(gh(l.url))}>${escapeHtml(l.label)}</a></p>`).join('')}
</section>`;
}

/** One pre-filled link per token the zone uses, with the two checks the link cannot make. */
export function tokensSection(pat: ZoneGuidance['pat'], roles: PatRole[]): string {
  const items = roles
    .map(
      (r) =>
        `<li><a href="${gh(pat[r])}"${linkTarget(gh(pat[r]))}>${escapeHtml(ROLE_TITLES[r])}</a><br><small>${escapeHtml(permissionList(r))}; no Workflows, no Administration.</small></li>`,
    )
    .join('');
  return `<section id="tokens"><h3>Create the tokens</h3>
<p>Each link opens GitHub's fine-grained token page, filled in. For each token:</p>
<ol id="token-steps">
<li>Sign in as the account the token is for, then open its link below. Make a new token here rather than reusing one made for another tool or install: an older token may have expired, and its permissions may not fit. If this install already has this account's token, edit its repository access instead (the next step).</li>
<li>Resource owner: ${escapeHtml(RESOURCE_OWNER_NOTE)}.</li>
<li>Repository access: choose Only select repositories, then the repository (the link cannot choose it). For another project later, edit this token's repository access on GitHub to add it: no new token, and no account-wide access.</li>
<li>Click Generate token.</li>
<li>Paste it into Jumpmaster's <a href="/setup/forge">GitHub step</a>: it is tested before it is saved, and never shown back.</li>
</ol>
<p><small>Expiry: ${escapeHtml(EXPIRATION_NOTE)}.</small></p>
<ul>${items}</ul></section>`;
}

/** The token links behind a disclosure, where GitHub Apps are the recommendation (spec §6). */
export function useTokensInstead(tokens: string): string {
  return `<details id="use-tokens"><summary>Use tokens instead</summary>
${tokens}</details>`;
}

/**
 * What the GitHub App buttons need from the page: whether the vault is on, whether the session
 * holds sudo, and each role's existing app for the repository's owner. Only a slug: the type has
 * no field for the PEM or the client id, so neither can reach a page.
 */
export type AppCreateOptions = {
  vaultOn: boolean;
  sudo: boolean;
  existing: Partial<Record<AppRole, { slug: string }>>;
};

const APP_ROLE_LABEL: Record<AppRole, string> = { author: 'author', reviewer: 'reviewer' };

/**
 * Keeps each create form's hidden `owner` and `ownerType` in step with the owner choice (the
 * preselected values are already in them, so a form submits right without this), shows the
 * organization note with the organization chosen, and refuses a personal choice with no login.
 * It reads every value from the page: nothing is interpolated into it.
 */
const APP_OWNER_SCRIPT = `<script>
(() => {
  const sec = document.getElementById('github-apps');
  const login = document.getElementById('app-owner-login');
  if (!sec || !login) return;
  const note = document.getElementById('app-org-note');
  const chosen = () => sec.querySelector('input[name=app-owner-type]:checked');
  const sync = () => {
    const c = chosen();
    if (!c) return;
    const owner = c.value === 'Organization' ? c.dataset.owner : login.value.trim();
    for (const f of sec.querySelectorAll('form.app-create')) {
      f.elements.owner.value = owner;
      f.elements.ownerType.value = c.value;
    }
    if (note) note.hidden = c.value !== 'Organization';
  };
  for (const r of sec.querySelectorAll('input[name=app-owner-type]')) r.addEventListener('change', sync);
  login.addEventListener('input', sync);
  login.addEventListener('focus', () => {
    const user = sec.querySelector('input[name=app-owner-type][value=User]');
    if (user && !user.checked) { user.checked = true; sync(); }
  });
  for (const f of sec.querySelectorAll('form.app-create')) f.addEventListener('submit', (e) => {
    sync();
    const c = chosen();
    if (c && c.value === 'User' && !login.reportValidity()) e.preventDefault();
  });
})();
</script>`;

/**
 * Create the author and reviewer GitHub Apps (spec 2026-11-13-github-app-auth §4.1): the owner
 * choice, preselected from the repository's owner type, and one plain form per role posting to
 * `/setup/github-app/start`. A role whose app exists for the owner shows its slug and install
 * link instead. Without sudo each form carries `data-sudo-first`, which the page's own script
 * answers by asking for the passphrase before it submits. With the vault off, no buttons.
 */
export function appCreateSection(
  answer: Pick<RecommendAnswer, 'repo' | 'ownerType'>,
  apps: AppCreateOptions,
): string {
  const head = `<section id="github-apps"><h3>GitHub Apps (recommended for two bots)</h3>
<p>Instead of two tokens, Jumpmaster can act as two GitHub Apps: an author app and a reviewer app, registered under the account that owns the repository. Each button opens GitHub with the app filled in; you confirm it there, then install it on the repository. Its private key goes straight into the encrypted vault and is never shown.</p>`;
  if (!apps.vaultOn)
    return `${head}
<p class="warn" id="apps-vault-off">The vault must be on first: an app's private key is kept only in the encrypted vault. Turn it on in <a href="${SYSTEM_CREDENTIALS_HREF}">System, Credentials</a>, then come back here.</p></section>`;
  const repoOwner = answer.repo.split('/')[0] ?? '';
  const org = answer.ownerType === 'Organization';
  const owner = escapeHtml(repoOwner);
  const ownerType = org ? 'Organization' : 'User';
  const login = org ? '' : owner;
  const sudoFirst = apps.sudo ? '' : ' data-sudo-first';
  const roles = (['author', 'reviewer'] as const).map((role) => {
    const have = apps.existing[role];
    if (have) {
      const install = gh(
        `https://github.com/apps/${encodeURIComponent(have.slug)}/installations/new`,
      );
      return `<p class="app-made" data-role="${role}">The ${APP_ROLE_LABEL[role]} app. Created: <code>${escapeHtml(have.slug)}</code>. <a href="${install}"${linkTarget(install)}>Install it on the repository</a></p>`;
    }
    return `<form method="post" action="/setup/github-app/start" class="app-create"${sudoFirst}><input type="hidden" name="role" value="${role}"><input type="hidden" name="owner" value="${org ? owner : login}"><input type="hidden" name="ownerType" value="${ownerType}"><button>Create the ${APP_ROLE_LABEL[role]} app</button> <small class="app-out" role="status"></small></form>`;
  });
  const toCreate = (['author', 'reviewer'] as const).some((r) => !apps.existing[r]);
  if (!toCreate)
    return `${head}
${roles.join('\n')}</section>`;
  const choice = `<fieldset id="app-owner"><legend>Register the apps under</legend>
<p><label><input type="radio" name="app-owner-type" value="User"${org ? '' : ' checked'}> My personal account</label> <label>Your GitHub login <input id="app-owner-login" value="${login}" pattern="[A-Za-z0-9\\-]{1,39}" required autocomplete="off" spellcheck="false"></label></p>
${org ? `<p><label><input type="radio" name="app-owner-type" value="Organization" data-owner="${owner}" checked> The organization <code>${owner}</code></label></p>` : ''}
</fieldset>
${org ? '<p class="warn" id="app-org-note">Registering an app under an organization needs an owner or app manager of that organization, and installing it on the organization\'s repositories needs an owner, or an owner\'s approval of a member\'s request.</p>' : ''}`;
  return `${head}
${choice}
${apps.sudo ? '' : '<p><small>Creating an app asks for your passphrase again first.</small></p>'}
${roles.join('\n')}
${APP_OWNER_SCRIPT}</section>`;
}

/** The collaborator page and what to do there. */
export function checklistSection(checklist: ZoneGuidance['checklist'], status = ''): string {
  return `<section id="checklist"><h3>Give the accounts access</h3>${status}
<p>On the repository's <a href="${gh(checklist.url)}"${linkTarget(gh(checklist.url))}>collaborators page</a>:</p>
<ul>${checklist.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></section>`;
}

/** The ruleset file: shown, downloadable, copyable, and the two lines that import it. */
export function rulesetSection(
  ruleset: ZoneGuidance['ruleset'],
  rulesUrl: string,
  identity: 'two-bot' | 'starter',
  status = '',
): string {
  const data = `data:application/json;charset=utf-8,${encodeURIComponent(ruleset.text)}`;
  return `<section id="ruleset"><h3>The branch ruleset</h3>${status}
${ruleset.note ? `<p class="warn">${escapeHtml(ruleset.note)}</p>` : ''}
<p>Jumpmaster merges only under a ruleset that requires a pull request and your CI, with no bypass. This file is one, with the checks your workflows report${identity === 'starter' ? '' : ", and a code owner's review on the protected paths"}:</p>
${identity === 'starter' ? `<p>${escapeHtml(STARTER_CODEOWNERS_NOTE)}</p>` : ''}
<ol><li>Open the repository's <a href="${gh(rulesUrl)}"${linkTarget(gh(rulesUrl))}>Rulesets</a>, then New ruleset → Import a ruleset, and choose <code>${escapeHtml(ruleset.filename)}</code>.</li>
<li>Review it and click Create.</li></ol>
<p><small>${escapeHtml(MATRIX_AND_REUSABLE_NOTE)}</small></p>
<p><a href="${escapeHtml(data)}" download="${escapeHtml(ruleset.filename)}">Download ${escapeHtml(ruleset.filename)}</a> <button type="button" data-copy="ruleset-text">Copy</button></p>
<pre id="ruleset-text">${escapeHtml(ruleset.text)}</pre></section>`;
}

/**
 * A two-app zone's second ruleset, `jumpmaster-merge` (spec 2026-11-13-github-app-auth §5.2): its
 * note, the same import steps, and the file. It does have a bypass list (the author app and
 * admins), so it never says otherwise.
 */
export function mergeRulesetSection(
  merge: NonNullable<ZoneGuidance['mergeRuleset']>,
  rulesUrl: string,
): string {
  const data = `data:application/json;charset=utf-8,${encodeURIComponent(merge.text)}`;
  return `<section id="merge-ruleset"><h3>The merge ruleset</h3>
<p>${escapeHtml(merge.note)}</p>
<ol><li>Open the repository's <a href="${gh(rulesUrl)}"${linkTarget(gh(rulesUrl))}>Rulesets</a>, then New ruleset → Import a ruleset, and choose <code>${escapeHtml(merge.filename)}</code>.</li>
<li>Review it and click Create.</li></ol>
<p><a href="${escapeHtml(data)}" download="${escapeHtml(merge.filename)}" id="merge-ruleset-download">Download ${escapeHtml(merge.filename)}</a> <button type="button" data-copy="merge-ruleset-text">Copy</button></p>
<pre id="merge-ruleset-text">${escapeHtml(merge.text)}</pre></section>`;
}

/** CODEOWNERS: the reviewer's login, the text, and GitHub's new-file page for it. */
export function codeownersSection(
  codeowners: ZoneGuidance['codeowners'],
  /**
   * The login form, or null where the page has its own (the wizard's project step). With `formId`
   * the controls belong to that form, drawn elsewhere (a form can't sit inside Setup's form).
   */
  form: { action: string; reviewer: string; formId?: string } | null,
  identity: 'two-bot' | 'starter',
  status = '',
): string {
  const owned = form?.formId ? ` form="${escapeHtml(form.formId)}"` : '';
  const controls = form
    ? `<label>Your GitHub login <input name="reviewer"${owned} value="${escapeHtml(form.reviewer)}" placeholder="${escapeHtml(CODEOWNERS_PLACEHOLDER.slice(1))}" pattern="[A-Za-z0-9@,._ \\/\\-]+"></label> <button${owned}>Show</button>`
    : '';
  return `<section id="codeowners"><h3>Code owners for the protected paths</h3>${status}
<p>Changes to the protected paths need a person's review. Name yourself (and anyone else who may approve them) as code owners: each needs the Write role.</p>
${identity === 'starter' ? '' : '<p class="warn">The file starts with the reviewer bot on <code>*</code>, so its approval still merges ordinary pull requests. If your file already has a <code>*</code> line, add the reviewer bot to it, or nothing will merge.</p>'}
${form ? (form.formId ? `<p>${controls}</p>` : `<form method="get" action="${escapeHtml(form.action)}">${controls}</form>`) : ''}
<p><a href="${gh(codeowners.newFileUrl)}"${linkTarget(gh(codeowners.newFileUrl))}>Create <code>${escapeHtml(codeowners.filename)}</code> on GitHub</a>, paste the text, and commit it. <button type="button" data-copy="codeowners-text">Copy</button></p>
<pre id="codeowners-text">${escapeHtml(codeowners.text)}</pre></section>`;
}

/** Copy buttons: the text of the element a button names. */
export const COPY_SCRIPT = `<script>
document.addEventListener('click', (e) => {
  const id = e.target && e.target.dataset ? e.target.dataset.copy : undefined;
  const el = id ? document.getElementById(id) : null;
  if (el) navigator.clipboard.writeText(el.textContent);
});
</script>`;

/** The roles whose token a zone uses. */
export const rolesOf = (zone: Pick<DropZoneConfig, 'identity' | 'reviewReadToken'>): PatRole[] => [
  'author',
  ...(zone.identity === 'starter' ? [] : (['reviewer'] as const)),
  ...(zone.reviewReadToken ? (['read'] as const) : []),
];

/**
 * The guide's steps the doctor checks (#618), each with the doctor checks that judge it, by id.
 * Access is judged by the accounts' own access to the repository (forge.author, forge.reviewer:
 * the Write role, or the installed app) as well as the clone check, which passes for any public
 * repository whatever the accounts' roles (#679).
 */
export const STEP_CHECKS = {
  access: ['forge.author', 'forge.reviewer', 'forge.private-clone'],
  ruleset: ['forge.branch-rules', 'forge.ci'],
  codeowners: ['forge.codeowners'],
  labels: ['forge.labels'],
} as const satisfies Record<string, readonly string[]>;
export type GithubStep = keyof typeof STEP_CHECKS;

/** The checks a starter zone has no use for: the doctor skips them by design (no reviewer). */
const STARTER_SKIPPED: readonly string[] = ['forge.reviewer'];

/** What a step's chip says: done (pass), missing (fail), check (warn) or not checked. */
export type StepState = 'done' | 'missing' | 'check' | 'not-checked';
export type StepStatus = { state: StepState; findings: string[] };

/**
 * A step's status from the latest doctor run's checks for the zone (`null`: no run). It is done
 * only when every one of its checks is there and passed: a check that is absent, or skipped, is
 * not checked, never done. A fail is missing, with the doctor's finding; a warn (or info) is check.
 * A starter zone (`starter`) is not judged by the checks the doctor skips for it by design.
 */
export function stepStatus(
  checks: readonly DoctorCheck[] | null,
  zoneId: string,
  step: GithubStep,
  starter = false,
): StepStatus {
  const ids: readonly string[] = STEP_CHECKS[step].filter(
    (id: string) => !(starter && STARTER_SKIPPED.includes(id)),
  );
  const mine = (checks ?? []).filter((c) => c.zoneId === zoneId && ids.includes(c.id));
  const findings = (st: string[]) =>
    mine.filter((c) => st.includes(c.status)).map((c) => c.summary);
  if (mine.some((c) => c.status === 'fail'))
    return { state: 'missing', findings: findings(['fail']) };
  if (mine.some((c) => c.status === 'warn' || c.status === 'info'))
    return { state: 'check', findings: findings(['warn', 'info']) };
  const passed = ids.every((id) => mine.some((c) => c.id === id && c.status === 'pass'));
  return passed ? { state: 'done', findings: [] } : { state: 'not-checked', findings: [] };
}

const CHIP_TEXT: Record<StepState, string> = {
  done: 'done',
  missing: 'missing',
  check: 'check',
  'not-checked': 'not checked',
};

/** A step's chip, and the doctor's findings for a missing or check step, escaped. */
export function stepChip(step: GithubStep, s: StepStatus): string {
  const findings = s.findings.length
    ? ` <span class="step-finding">${s.findings.map(escapeHtml).join('; ')}</span>`
    : '';
  return `<p class="step-status" data-step="${step}"><span class="chip chip-${s.state}" data-status="${s.state}">${CHIP_TEXT[s.state]}</span>${findings}</p>`;
}

const STEP_STYLE =
  '<style>.step-status .chip{display:inline-block;padding:0 .5rem;border-radius:999px;font-size:.85em;box-shadow:inset 0 0 0 1px var(--stroke-soft-200)}.step-status .chip-done{box-shadow:inset 0 0 0 1px var(--success-base)}.step-status .chip-missing{box-shadow:inset 0 0 0 1px var(--error-base)}.step-status .chip-check{box-shadow:inset 0 0 0 1px var(--warning-base)}</style>';

const STEP_LABELS: Record<GithubStep, string> = {
  access: 'Give the accounts access',
  ruleset: 'The branch ruleset',
  codeowners: 'Code owners for the protected paths',
  labels: 'Labels',
};

/** The labels step: the doctor's labels check, and where it creates the missing ones. */
const labelsSection = (zone: Pick<DropZoneConfig, 'readyLabel'>, status: string): string =>
  `<section id="labels"><h3>Labels</h3>${status}<p>The labels Jumpmaster works with, the ready label <code>${escapeHtml(zone.readyLabel)}</code> among them, must exist on the repository. The doctor page's Create the missing labels makes them.</p></section>`;

/** The id of the code owners form, drawn outside Setup's form (a form can't hold a form). */
export const GITHUB_REVIEWER_FORM = 'github-reviewer-form';

/** The API's GitLab refusal as a page says it: project, not zone (issue #629). */
const GITLAB_UNSUPPORTED_PAGE = 'GitLab projects are not supported yet';

/**
 * The GitHub section of a project's Setup (#618): the guide (accounts, tokens or apps, access, the
 * ruleset, code owners), each checked step with its doctor status, then labels. Without guidance
 * (GitHub could not be read) it says why, and still shows every step's status.
 */
export function githubSection(
  zone: DropZoneConfig,
  guidance: { ok: true; guidance: ZoneGuidance; reviewer: string } | { ok: false; error: string },
  checks: readonly DoctorCheck[] | null,
): string {
  const chip = (step: GithubStep) =>
    stepChip(step, stepStatus(checks, zone.id, step, zone.identity === 'starter'));
  const head = `<section id="github" class="setup-section"><h3>GitHub</h3>${STEP_STYLE}
<p>What Jumpmaster needs on GitHub, as links and files: nothing here changes GitHub; the clicks and the commit are yours. The doctor checks each part; its last run's result is beside each step.</p>`;
  if (!guidance.ok)
    return `${head}
<p class="warn">${escapeHtml(guidance.error === GITLAB_UNSUPPORTED ? GITLAB_UNSUPPORTED_PAGE : guidance.error)}</p><p>Set or replace the tokens in the <a href="/setup/forge">GitHub step</a>, then come back.</p>
<ul id="github-steps">${(Object.keys(STEP_CHECKS) as GithubStep[]).map((s) => `<li>${escapeHtml(STEP_LABELS[s])} ${chip(s)}</li>`).join('')}</ul>
</section>`;
  const g = guidance.guidance;
  return `${head}
${recommendationSection(g.recommendation)}
<p>This project runs as ${escapeHtml(zone.identity)}${zone.authorMayBeAdmin ? ' (the author account owns the repository, so it can merge)' : ''}${zone.identity === g.recommendation.identity ? '' : ': not the recommendation above. Changing it changes which tokens and rules it needs'}.</p>
${zone.identity === 'starter' ? tokensSection(g.pat, rolesOf(zone)) : useTokensInstead(tokensSection(g.pat, rolesOf(zone)))}
${checklistSection(g.checklist, chip('access'))}
${rulesetSection(g.ruleset, g.rulesUrl, zone.identity, chip('ruleset'))}
${g.mergeRuleset ? `${mergeRulesetSection(g.mergeRuleset, g.rulesUrl)}\n` : ''}${codeownersSection(g.codeowners, { action: githubSetupHref(zone.id), reviewer: guidance.reviewer, formId: GITHUB_REVIEWER_FORM }, zone.identity, chip('codeowners'))}
${labelsSection(zone, chip('labels'))}
</section>`;
}

/** The code owners form, outside Setup's form: its controls name it with `form=`. */
export const githubReviewerForm = (zoneId: string): string =>
  `<form id="${GITHUB_REVIEWER_FORM}" method="get" action="${escapeHtml(githubSetupHref(zoneId))}"></form>`;

const Query = z.object({ reviewer: z.string().max(400).optional() });
const LOGINS = /^[A-Za-z0-9@,/._ -]*$/;

/** The reviewers typed in a form: comma-separated logins, `@` optional. */
export const reviewersOf = (text: string | undefined): string[] | null => {
  if (text === undefined || text.trim() === '') return [];
  if (!LOGINS.test(text)) return null;
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

/** What the GitHub section reads a zone's guidance with (the app's deps). */
export type GithubSectionDeps = {
  store: ConfigStore;
  now(): Date;
  guidanceForge?: (repo: string, token: string) => GuidanceForge;
  /** The app token source: an app-author zone's guidance reads on its author app (§4.4). */
  appTokens?: Pick<AppTokenSource, 'provider'>;
};

/**
 * Renders a zone's GitHub section: its guidance read from GitHub (cached as the API's), with the
 * code owners typed in `query.reviewer`, and each step's status from `checks`. Never throws: a
 * refused read is said in the section.
 */
export function githubSectionRenderer(
  deps: GithubSectionDeps,
): (
  config: Config,
  zone: DropZoneConfig,
  query: unknown,
  checks: readonly DoctorCheck[] | null,
) => Promise<string> {
  const forgeOf = deps.guidanceForge ?? githubGuidanceForge;
  return async (config, zone, query, checks) => {
    const q = Query.safeParse(query ?? {});
    const reviewers = q.success ? reviewersOf(q.data.reviewer) : null;
    let r: Awaited<ReturnType<typeof guidanceFor>> | { ok: false; error: string };
    try {
      r =
        reviewers === null
          ? { ok: false, error: 'a code owner is a GitHub login or an org/team name' }
          : await guidanceFor(deps.store, config, zone, forgeOf, {
              reviewers,
              now: deps.now,
              ...(deps.appTokens ? { appTokens: deps.appTokens } : {}),
            });
    } catch (e) {
      r = { ok: false, error: (e as Error).message };
    }
    return githubSection(
      zone,
      r.ok
        ? { ok: true, guidance: r.guidance, reviewer: q.success ? (q.data.reviewer ?? '') : '' }
        : { ok: false, error: r.error },
      checks,
    );
  };
}
