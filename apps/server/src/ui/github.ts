import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type GuidanceForge, githubGuidanceForge, guidanceFor } from '../api/github.js';
import { withCsrf } from '../auth/guard.js';
import type { ConfigStore } from '../config/store.js';
import type { DropZoneConfig } from '../config.js';
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
import { escapeHtml, page } from './pages.js';

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
      : 'Two bot accounts: an author and a reviewer';
  return `<section id="recommendation"><h3>Which accounts</h3>
<p><strong>Recommended: ${escapeHtml(label)}</strong>${rec.authorMayBeAdmin ? ' (the author owns the repository: <code>authorMayBeAdmin</code>)' : ''}.</p>
<p>${escapeHtml(rec.reason)}</p>
${rec.stop ? `<p class="warn" data-stop><strong>Stop here:</strong> ${escapeHtml(rec.stop)}.</p>` : ''}
${rec.ask ? `<p class="warn" data-ask><strong>First:</strong> ${escapeHtml(rec.ask)}</p>` : ''}
${(rec.links ?? []).map((l) => `<p><a href="${gh(l.url)}" rel="noreferrer">${escapeHtml(l.label)}</a></p>`).join('')}
</section>`;
}

/** One pre-filled link per token the zone uses, with the two checks the link cannot make. */
export function tokensSection(pat: ZoneGuidance['pat'], roles: PatRole[]): string {
  const items = roles
    .map(
      (r) =>
        `<li><a href="${gh(pat[r])}" rel="noreferrer" target="_blank">${escapeHtml(ROLE_TITLES[r])}</a><br><small>${escapeHtml(permissionList(r))}; no Workflows, no Administration.</small></li>`,
    )
    .join('');
  return `<section id="tokens"><h3>Create the tokens</h3>
<p>Each link opens GitHub's fine-grained token page, filled in. For each token:</p>
<ol id="token-steps">
<li>Sign in as the account the token is for, then open its link below.</li>
<li>Resource owner: ${escapeHtml(RESOURCE_OWNER_NOTE)}.</li>
<li>Repository access: choose Only select repositories, then the repository (the link cannot choose it).</li>
<li>Click Generate token.</li>
<li>Paste it into Jumpmaster's <a href="/setup/forge">GitHub step</a>: it is tested before it is saved, and never shown back.</li>
</ol>
<p><small>Expiry: ${escapeHtml(EXPIRATION_NOTE)}.</small></p>
<ul>${items}</ul></section>`;
}

/** The collaborator page and what to do there. */
export function checklistSection(checklist: ZoneGuidance['checklist']): string {
  return `<section id="checklist"><h3>Give the accounts access</h3>
<p>On the repository's <a href="${gh(checklist.url)}" rel="noreferrer">collaborators page</a>:</p>
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
<ol><li>Open the repository's <a href="${gh(rulesUrl)}" rel="noreferrer">Rulesets</a>, then New ruleset → Import a ruleset, and choose <code>${escapeHtml(ruleset.filename)}</code>.</li>
<li>Review it and click Create.</li></ol>
<p><small>${escapeHtml(MATRIX_AND_REUSABLE_NOTE)}</small></p>
<p><a href="${escapeHtml(data)}" download="${escapeHtml(ruleset.filename)}">Download ${escapeHtml(ruleset.filename)}</a> <button type="button" data-copy="ruleset-text">Copy</button></p>
<pre id="ruleset-text">${escapeHtml(ruleset.text)}</pre></section>`;
}

/** CODEOWNERS: the reviewer's login, the text, and GitHub's new-file page for it. */
export function codeownersSection(
  codeowners: ZoneGuidance['codeowners'],
  /** The login form, or null where the page has its own (the wizard's project step). */
  form: { action: string; reviewer: string } | null,
): string {
  return `<section id="codeowners"><h3>Code owners for the protected paths</h3>
<p>Changes to the protected paths need a person's review. Name yourself (and anyone else who may approve them) as code owners: each needs the Write role.</p>
${form ? `<form method="get" action="${escapeHtml(form.action)}"><label>Your GitHub login <input name="reviewer" value="${escapeHtml(form.reviewer)}" placeholder="${escapeHtml(CODEOWNERS_PLACEHOLDER.slice(1))}" pattern="[A-Za-z0-9@,._ \\/\\-]+"></label> <button>Show</button></form>` : ''}
<p><a href="${gh(codeowners.newFileUrl)}" rel="noreferrer" target="_blank">Create <code>${escapeHtml(codeowners.filename)}</code> on GitHub</a>, paste the text, and commit it. <button type="button" data-copy="codeowners-text">Copy</button></p>
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

function zonePage(zone: DropZoneConfig, g: ZoneGuidance, reviewer: string): string {
  return page(
    `<h2>GitHub for ${escapeHtml(zone.id)} (${escapeHtml(zone.repo)})</h2>
<p>What Jumpmaster needs on GitHub, as links and files: nothing here changes GitHub; the clicks and the commit are yours. The doctor checks each part.</p>
${recommendationSection(g.recommendation)}
<p>This zone runs as ${escapeHtml(zone.identity)}${zone.authorMayBeAdmin ? ' with authorMayBeAdmin' : ''}${zone.identity === g.recommendation.identity ? '' : ': not the recommendation above. Changing it changes which tokens and rules it needs'}.</p>
${tokensSection(g.pat, rolesOf(zone))}
${checklistSection(g.checklist)}
${rulesetSection(g.ruleset, g.rulesUrl, zone.identity)}
${codeownersSection(g.codeowners, { action: `/zones/${encodeURIComponent(zone.id)}/github`, reviewer })}
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
          : await guidanceFor(store, config, zone, forgeOf, { reviewers, now });
    } catch (e) {
      r = { ok: false, status: 400, error: (e as Error).message };
    }
    if (!r.ok)
      return send(
        r.status,
        page(
          `<h2>GitHub for ${escapeHtml(zone.id)}</h2><p class="warn">${escapeHtml(r.error)}</p><p>Set or replace the tokens in the <a href="/setup/forge">GitHub step</a>, then come back.</p>`,
        ),
      );
    return send(200, zonePage(zone, r.guidance, q.success ? (q.data.reviewer ?? '') : ''));
  });
}
