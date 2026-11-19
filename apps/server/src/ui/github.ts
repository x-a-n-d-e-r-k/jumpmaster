import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type GuidanceForge,
  githubGuidanceForge,
  guidanceFor,
  type RecommendAnswer,
} from '../api/github.js';
import { withCsrf } from '../auth/guard.js';
import type { ConfigStore } from '../config/store.js';
import type { DropZoneConfig } from '../config.js';
import type { AppTokenSource } from '../forge/app-tokens.js';
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
import { linkTarget } from './links.js';
import { escapeHtml, page } from './pages.js';
import { type ZoneRef, zoneName } from './zone-name.js';

/**
 * The GitHub half of setup, as a page per zone (`/zones/:id/github`) and as sections the setup
 * wizard reuses: links and generated text, never a forge write. Every piece of forge text is
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
<p class="warn" id="apps-vault-off">The vault must be on first: an app's private key is kept only in the encrypted vault. Turn it on in <a href="/settings/credentials">Settings, Credentials</a>, then come back here.</p></section>`;
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
export function checklistSection(checklist: ZoneGuidance['checklist']): string {
  return `<section id="checklist"><h3>Give the accounts access</h3>
<p>On the repository's <a href="${gh(checklist.url)}"${linkTarget(gh(checklist.url))}>collaborators page</a>:</p>
<ul>${checklist.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></section>`;
}

/** The ruleset file: shown, downloadable, copyable, and the two lines that import it. */
export function rulesetSection(
  ruleset: ZoneGuidance['ruleset'],
  rulesUrl: string,
  identity: 'two-bot' | 'starter',
): string {
  const data = `data:application/json;charset=utf-8,${encodeURIComponent(ruleset.text)}`;
  return `<section id="ruleset"><h3>The branch ruleset</h3>
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
  /** The login form, or null where the page has its own (the wizard's project step). */
  form: { action: string; reviewer: string } | null,
  identity: 'two-bot' | 'starter',
): string {
  return `<section id="codeowners"><h3>Code owners for the protected paths</h3>
<p>Changes to the protected paths need a person's review. Name yourself (and anyone else who may approve them) as code owners: each needs the Write role.</p>
${identity === 'starter' ? '' : '<p class="warn">The file starts with the reviewer bot on <code>*</code>, so its approval still merges ordinary pull requests. If your file already has a <code>*</code> line, add the reviewer bot to it, or nothing will merge.</p>'}
${form ? `<form method="get" action="${escapeHtml(form.action)}"><label>Your GitHub login <input name="reviewer" value="${escapeHtml(form.reviewer)}" placeholder="${escapeHtml(CODEOWNERS_PLACEHOLDER.slice(1))}" pattern="[A-Za-z0-9@,._ \\/\\-]+"></label> <button>Show</button></form>` : ''}
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

/** The zone's GitHub page body, from its guidance. */
export function zonePage(
  zone: DropZoneConfig,
  zones: readonly ZoneRef[],
  g: ZoneGuidance,
  reviewer: string,
): string {
  return page(
    `<h2>GitHub for ${zoneName(zone, zones)}</h2>
<p>What Jumpmaster needs on GitHub, as links and files: nothing here changes GitHub; the clicks and the commit are yours. The doctor checks each part.</p>
${recommendationSection(g.recommendation)}
<p>This zone runs as ${escapeHtml(zone.identity)}${zone.authorMayBeAdmin ? ' (the author account owns the repository, so it can merge)' : ''}${zone.identity === g.recommendation.identity ? '' : ': not the recommendation above. Changing it changes which tokens and rules it needs'}.</p>
${zone.identity === 'starter' ? tokensSection(g.pat, rolesOf(zone)) : useTokensInstead(tokensSection(g.pat, rolesOf(zone)))}
${checklistSection(g.checklist)}
${rulesetSection(g.ruleset, g.rulesUrl, zone.identity)}
${g.mergeRuleset ? `${mergeRulesetSection(g.mergeRuleset, g.rulesUrl)}\n` : ''}${codeownersSection(g.codeowners, { action: `/zones/${encodeURIComponent(zone.id)}/github`, reviewer }, zone.identity)}
${COPY_SCRIPT}`,
  );
}

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

export function registerGithubPages(
  app: FastifyInstance,
  deps: {
    store: ConfigStore;
    now(): Date;
    guidanceForge?: (repo: string, token: string) => GuidanceForge;
    /** The app token source: an app-author zone's guidance reads on its author app (§4.4). */
    appTokens?: Pick<AppTokenSource, 'provider'>;
  },
): void {
  const { store, now } = deps;
  const forgeOf = deps.guidanceForge ?? githubGuidanceForge;
  app.get<{ Params: { id: string } }>('/zones/:id/github', async (req, reply) => {
    const config = req.jmConfig ?? store.current();
    const zone = config.dropZones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    const q = Query.safeParse(req.query ?? {});
    const reviewers = q.success ? reviewersOf(q.data.reviewer) : null;
    const send = (status: number, body: string) =>
      reply.code(status).type('text/html; charset=utf-8').send(withCsrf(req, body));
    let r: Awaited<ReturnType<typeof guidanceFor>> | { ok: false; status: 400; error: string };
    try {
      r =
        reviewers === null
          ? { ok: false, status: 400, error: 'a code owner is a GitHub login or an org/team name' }
          : await guidanceFor(store, config, zone, forgeOf, {
              reviewers,
              now,
              ...(deps.appTokens ? { appTokens: deps.appTokens } : {}),
            });
    } catch (e) {
      r = { ok: false, status: 400, error: (e as Error).message };
    }
    if (!r.ok)
      return send(
        r.status,
        page(
          `<h2>GitHub for ${zoneName(zone, config.dropZones)}</h2><p class="warn">${escapeHtml(r.error)}</p><p>Set or replace the tokens in the <a href="/setup/forge">GitHub step</a>, then come back.</p>`,
        ),
      );
    return send(
      200,
      zonePage(zone, config.dropZones, r.guidance, q.success ? (q.data.reviewer ?? '') : ''),
    );
  });
}
