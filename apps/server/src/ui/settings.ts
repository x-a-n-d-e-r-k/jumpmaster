import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type GuidanceForge, githubGuidanceForge } from '../api/github.js';
import { withCsrf } from '../auth/guard.js';
import { type ConfigStore, VAULT_DISABLED } from '../config/store.js';
import type { Config } from '../config.js';
import {
  CREDENTIAL_ROLES,
  type CredentialName,
  credentialCreatedAt,
  isInstallCredential,
  parseGateSecretName,
  type ResolvedCredential,
} from '../vault/credentials.js';
import { escapeHtml, page, tokenAgeBanner } from './pages.js';
import { forgeGuideFor, guideSection } from './setup.js';

/**
 * Settings, part one: the Credentials tab (§7.5, §10.3). A page over Task 4's secret routes, with
 * no route of its own: every write is a `PUT`, a `POST …/test` or a `DELETE` there, behind the
 * session's CSRF header and sudo. The page holds no value: each credential shows as its source,
 * fingerprint, login and dates. A file's or the environment's credential is read-only here, with
 * where it comes from and how to change it. Task 13 adds the Install, MCP tokens and History tabs.
 */

export { TOKEN_BANNER_DAYS, tokenAgeBanner } from './pages.js';

const DAY_MS = 86_400_000;

/** The Claude token's age in whole days, when its making is dated (vault, or the config). */
export function claudeTokenDays(store: ConfigStore, now: Date): number | undefined {
  const resolved = store.resolved();
  if (resolved.claudeToken.source === 'missing') return undefined;
  const made = credentialCreatedAt('claudeToken', resolved, store.mode(), store.current().claude);
  const t = made === undefined ? Number.NaN : Date.parse(made);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / DAY_MS) : undefined;
}

/** The tabs, as Task 13 grows them: each a path, the current one in bold. */
const TABS: [string, string][] = [['credentials', 'Credentials']];
const tabs = (current: string): string =>
  `<nav class="settings-tabs">${TABS.map(([path, label]) =>
    path === current ? `<strong>${label}</strong>` : `<a href="/settings/${path}">${label}</a>`,
  ).join(' · ')}</nav>`;

const day = (iso: string | undefined): string => (iso ? escapeHtml(iso.slice(0, 10)) : '-');

function roleOf(name: CredentialName): string {
  if (isInstallCredential(name)) return CREDENTIAL_ROLES[name];
  const g = parseGateSecretName(name);
  return `gate secret ${g?.name ?? '?'} for zone ${g?.zoneId ?? '?'}: gate steps can read it`;
}

function sourceCell(c: ResolvedCredential): string {
  if (c.source === 'vault') return 'vault (encrypted)';
  if (c.source === 'file') return `file <code>${escapeHtml(c.path ?? '?')}</code>`;
  if (c.source === 'env') return `environment variable <code>${escapeHtml(c.path ?? '?')}</code>`;
  return c.undecryptable
    ? 'not set: the stored value does not decrypt with the vault key (enter it again)'
    : 'not set';
}

/** Replace, Test and Remove for one credential, or why Replace is not this page's to do. */
function actionsCell(
  name: CredentialName,
  c: ResolvedCredential,
  vaultOn: boolean,
  claudeDated: boolean,
): string {
  const n = escapeHtml(name);
  const test = c.value ? ` <button type="button" class="test" data-name="${n}">Test</button>` : '';
  const disabled = (why: string) =>
    `<button type="button" disabled>Replace</button>${test} <small>${why}</small>`;
  if (c.source === 'file')
    return disabled(
      `managed by ${escapeHtml(c.path ?? '?')}: replace that file and run <code>jumpmaster ctl secrets reload</code> to change it`,
    );
  if (c.source === 'env')
    return disabled(
      `set by the environment variable ${escapeHtml(c.path ?? '?')}: change it where the server's environment is set, and restart the server`,
    );
  if (!vaultOn) return disabled(escapeHtml(VAULT_DISABLED));
  const made = claudeDated
    ? ' <label>Made on <input type="date" name="declaredCreatedAt"></label>'
    : '';
  const remove =
    c.source === 'vault'
      ? ` <button type="button" class="remove" data-name="${n}">Remove</button>`
      : '';
  return `<form class="replace" data-name="${n}"><input type="password" name="value" autocomplete="off" spellcheck="false" aria-label="New value for ${n}">${made} <button>Replace</button></form>${test}${remove}`;
}

function rowFor(name: CredentialName, c: ResolvedCredential, store: ConfigStore, vaultOn: boolean) {
  const created =
    credentialCreatedAt(name, store.resolved(), store.mode(), store.current().claude) ??
    c.declaredCreatedAt;
  const test = c.testResult ? `${escapeHtml(c.testResult)} <small>${day(c.testedAt)}</small>` : '-';
  return `<tr data-credential="${escapeHtml(name)}"><td><code>${escapeHtml(name)}</code><br><small>${escapeHtml(roleOf(name))}</small></td><td data-col="source">${sourceCell(c)}</td><td data-col="fingerprint">${c.fingerprint ? `<code>${escapeHtml(c.fingerprint)}</code>` : '-'}</td><td data-col="login">${c.login ? escapeHtml(c.login) : '-'}</td><td data-col="set">${day(c.setAt)}</td><td data-col="created">${day(created)}</td><td data-col="test">${test}</td><td data-col="actions">${actionsCell(name, c, vaultOn, name === 'claudeToken')}</td></tr>`;
}

/** The Claude plan, as the wizard's Claude step offers it: a choice in db mode, the file's otherwise. */
function planSection(store: ConfigStore, config: Config): string {
  if (store.mode() === 'file')
    return `<p>Plan <strong>${escapeHtml(config.claude.plan)}</strong> (set in the config file)</p>`;
  const plans = ['pro', 'max', 'team_standard', 'team_premium', 'enterprise']
    .map(
      (p) =>
        `<option value="${p}"${config.claude.plan === p ? ' selected' : ''}>${escapeHtml(p)}</option>`,
    )
    .join('');
  return `<form id="plan"><label>Plan <select name="plan">${plans}</select></label> <button>Save the plan</button></form>`;
}

/**
 * The tab's script. `jmReplaceCredential`, `jmTestCredential` and `jmRemoveCredential` take the
 * sudo state the page knows (`{ sudo, passphrase }`) and a status element: without sudo and with
 * no passphrase they answer `'sudo'` and touch nothing (the page then shows the prompt); with one,
 * they `POST /api/control/sudo` first. The value travels in a `PUT` body only, never a URL, and the
 * field is cleared at once. The page's own wiring is at the end.
 */
export const CREDENTIALS_SCRIPT = `<script>
async function jmSudo(state, status) {
  if (state.sudo) return true;
  if (!state.passphrase) { status.textContent = 'Re-enter your passphrase to change a credential.'; return false; }
  const r = await jmFetch('/api/control/sudo', { passphrase: state.passphrase });
  state.passphrase = '';
  if (!r.ok) { status.textContent = 'The passphrase was not accepted (' + r.status + ').'; return false; }
  state.sudo = true;
  return true;
}
async function jmWhy(r) {
  try {
    const j = await r.json();
    if (j.error) return j.error;
    if (j.tested === false) return 'the test failed (' + (j.status == null ? 'no answer' : j.status) + ')' + (j.permission ? ': needs ' + j.permission : '') + (j.problem ? ': ' + j.problem : '');
  } catch (e) {}
  return '';
}
async function jmReplaceCredential(c, state, status) {
  if (!c.value) { status.textContent = 'Enter the new value first.'; return 'empty'; }
  if (!(await jmSudo(state, status))) return 'sudo';
  const body = { value: c.value };
  if (c.declaredCreatedAt) body.declaredCreatedAt = c.declaredCreatedAt;
  const r = await jmFetch('/api/control/secrets/' + encodeURIComponent(c.name), body, 'PUT');
  if (!r.ok) {
    if (r.status === 403) state.sudo = false;
    status.textContent = c.name + ' was not saved (' + r.status + '): ' + (await jmWhy(r));
    return 'refused';
  }
  const j = await r.json();
  status.textContent = 'Saved and tested. ' + (j.hint || '');
  return 'saved';
}
async function jmTestCredential(name, state, status) {
  if (!(await jmSudo(state, status))) return 'sudo';
  const r = await jmFetch('/api/control/secrets/' + encodeURIComponent(name) + '/test', {});
  if (!r.ok) { if (r.status === 403) state.sudo = false; status.textContent = name + ': ' + r.status + ' ' + (await jmWhy(r)); return 'refused'; }
  const j = await r.json();
  status.textContent = j.tested ? name + ': ' + j.result + (j.login ? ' (' + j.login + ')' : '') : name + ': ' + (await jmWhy({ json: async () => j }));
  return j.tested ? 'ok' : 'failed';
}
async function jmRemoveCredential(name, state, status) {
  if (!(await jmSudo(state, status))) return 'sudo';
  const r = await jmFetch('/api/control/secrets/' + encodeURIComponent(name), {}, 'DELETE');
  if (!r.ok) { if (r.status === 403) state.sudo = false; status.textContent = name + ' was not removed (' + r.status + '): ' + (await jmWhy(r)); return 'refused'; }
  status.textContent = name + ' removed.';
  return 'removed';
}
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('credentials');
  const status = document.getElementById('credentials-status');
  const prompt = document.getElementById('sudo-prompt');
  const pass = document.getElementById('sudo-pass');
  const state = () => ({ sudo: root.dataset.sudo === '1', passphrase: pass.value });
  const after = (s, outcome) => {
    pass.value = '';
    if (s.sudo) root.dataset.sudo = '1';
    if (outcome === 'sudo') { prompt.hidden = false; pass.focus(); }
    else prompt.hidden = true;
  };
  for (const form of document.querySelectorAll('form.replace')) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const field = form.querySelector('input[name=value]');
    const date = form.querySelector('input[name=declaredCreatedAt]');
    const s = state();
    const c = { name: form.dataset.name, value: field.value, declaredCreatedAt: date ? date.value : '' };
    const outcome = await jmReplaceCredential(c, s, status);
    if (outcome !== 'sudo') field.value = '';
    after(s, outcome);
    if (outcome === 'saved') status.insertAdjacentHTML('beforeend', ' <a href="/settings/credentials">Refresh the list</a>');
  });
  for (const b of document.querySelectorAll('button.test')) b.addEventListener('click', async () => {
    const s = state(); after(s, await jmTestCredential(b.dataset.name, s, status));
  });
  for (const b of document.querySelectorAll('button.remove')) b.addEventListener('click', async () => {
    if (!confirm('Remove ' + b.dataset.name + ' from the vault? Zones that need it park until it is set again.')) return;
    const s = state(); const outcome = await jmRemoveCredential(b.dataset.name, s, status); after(s, outcome);
    if (outcome === 'removed') location.reload();
  });
  const plan = document.getElementById('plan');
  if (plan) plan.addEventListener('submit', async (e) => {
    e.preventDefault();
    const now = await (await fetch('/api/control/config')).json();
    const r = await jmFetch('/api/control/config', { patch: { claude: { plan: plan.querySelector('select').value } }, expectRevision: now.revision }, 'PATCH');
    status.textContent = r.ok ? 'Plan saved.' : 'The plan was not saved (' + r.status + ').';
  });
});
</script>`;

export function renderCredentials(o: {
  store: ConfigStore;
  config: Config;
  sudo: boolean;
  now: Date;
  runningSince?: (since: string) => number;
  guide?: Awaited<ReturnType<typeof forgeGuideFor>>;
}): string {
  const { store, config } = o;
  const vault = store.vault();
  const vaultOn = vault !== 'disabled';
  const resolved = store.resolved();
  const rows = (Object.entries(resolved) as [CredentialName, ResolvedCredential][])
    .map(([name, c]) => rowFor(name, c, store, vaultOn))
    .join('');
  // Active drops leased before a vault credential was replaced still carry the previous value.
  const running = (Object.entries(resolved) as [CredentialName, ResolvedCredential][])
    .filter(([, c]) => c.source === 'vault')
    .map(([name, c]) => ({ name, n: runningBefore(o.runningSince, c.setAt) }))
    .filter((r) => r.n > 0)
    .map(
      (r) =>
        `<p class="warn running">${r.n} running drop${r.n === 1 ? '' : 's'} still carr${r.n === 1 ? 'ies' : 'y'} the previous ${escapeHtml(r.name)}: revoke the old one with its provider once ${r.n === 1 ? 'it finishes' : 'they finish'}.</p>`,
    )
    .join('');
  const problems = store.problems();
  const problemList =
    problems.length === 0
      ? '<p>No zone is missing a credential it needs.</p>'
      : `<ul class="problems">${problems
          .map(
            (p) =>
              `<li><strong>${escapeHtml(p.zoneId)}</strong> (${escapeHtml(p.credential)}, ${escapeHtml(p.kind)}): ${escapeHtml(p.message)}</li>`,
          )
          .join('')}</ul>`;
  const vaultLine = vaultOn
    ? '<p>The vault is on: a credential entered here is tested, encrypted and never shown back. A file under <code>secrets/</code> with the credential’s name wins over the vault.</p>'
    : `<p class="warn">${escapeHtml(VAULT_DISABLED)}</p>`;
  return page(
    `<h2>Settings</h2>${tabs('credentials')}${tokenAgeBanner(claudeTokenDays(store, o.now))}
<div id="credentials" data-sudo="${o.sudo ? '1' : '0'}">
${vaultLine}${running}
<table><tr><th>Credential</th><th>Source</th><th>Fingerprint</th><th>Login</th><th>Set</th><th>Created</th><th>Last test</th><th></th></tr>${rows}</table>
<div id="sudo-prompt" hidden><p><label>Your passphrase (changing a credential asks for it again) <input type="password" id="sudo-pass" autocomplete="current-password"></label> Then press the button again.</p></div>
<p id="credentials-status" role="status"></p>
<h3>Zone problems</h3>${problemList}
<h3>Claude</h3>
<p>Make the token on your own computer with <code>claude setup-token</code> (it lasts a year) and replace it above; its “Made on” date starts the expiry reminder.</p>
${planSection(store, config)}
<h3>GitHub</h3>
${guideSection(o.guide, '/settings/credentials')}
</div>
${CREDENTIALS_SCRIPT}`,
  );
}

/** Active drops leased before `since` (Task 4's running-drops count), via the injected reader. */
const runningBefore = (reader: ((since: string) => number) | undefined, since?: string): number =>
  reader && since ? reader(since) : 0;

const html = (req: FastifyRequest, reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(withCsrf(req, body));

export function registerSettingsPages(
  app: FastifyInstance,
  deps: {
    store: ConfigStore;
    now(): Date;
    /** Active drops started before a time: the drops that carry a replaced credential's old value. */
    runningSince(since: string): number;
    guidanceForge?: (repo: string, token: string) => GuidanceForge;
  },
): void {
  const { store, now } = deps;
  const forgeOf = deps.guidanceForge ?? githubGuidanceForge;
  // The other tabs arrive with Task 13; until then Settings is its Credentials tab.
  app.get('/settings', async (_req, reply) => reply.redirect('/settings/credentials', 302));
  app.get('/settings/credentials', async (req, reply) => {
    const config = req.jmConfig ?? store.current();
    const guide = await forgeGuideFor(store, config, req.query, forgeOf, now);
    return html(
      req,
      reply,
      renderCredentials({
        store,
        config,
        sudo: req.principal?.sudo === true,
        now: now(),
        runningSince: deps.runningSince,
        ...(guide ? { guide } : {}),
      }),
    );
  });
}
