import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type GuidanceForge, githubGuidanceForge } from '../api/github.js';
import { withCsrf } from '../auth/guard.js';
import type { BootOrigin } from '../config/boot.js';
import { type ConfigStore, type RevisionView, VAULT_DISABLED } from '../config/store.js';
import { type Config, MAX_POLL_SECONDS, MIN_POLL_SECONDS, mcpConfigOf } from '../config.js';
import type { Db } from '../db/open.js';
import { listMcpTokens, MAX_TOKEN_DAYS, type McpTokenInfo } from '../mcp/tokens.js';
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
 * where it comes from and how to change it.
 *
 * Part two (Task 13): **Install** (the install-wide settings through the config routes, guarded
 * ones through the confirmation page, the boot settings read-only with where they are set),
 * **MCP tokens** (§7.5: made with a zone, a scope and an expiry, the value shown once and only
 * after sudo; listed without values; revoked) and **History** (the revisions with their changes,
 * guarded and re-add marks, and Revert, a rollback through the same routes).
 */

export { TOKEN_BANNER_DAYS, tokenAgeBanner } from './pages.js';

const DAY_MS = 86_400_000;

/** The Claude token's age in whole days, when its making is dated (vault, or the config). */
export function claudeTokenDays(store: ConfigStore, now: Date): number | undefined {
  const resolved = store.resolved();
  if (resolved.claudeToken.source === 'missing') return undefined;
  const made = credentialCreatedAt('claudeToken', resolved, store.current().claude);
  const t = made === undefined ? Number.NaN : Date.parse(made);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / DAY_MS) : undefined;
}

/** The tabs: each a path, the current one in bold. `/settings` goes to the first. */
const TABS: [string, string][] = [
  ['credentials', 'Credentials'],
  ['install', 'Install'],
  ['mcp-tokens', 'MCP tokens'],
  ['history', 'History'],
];
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
  // A vault entry that no longer decrypts can be removed too (then entered again).
  const remove =
    c.source === 'vault' || c.undecryptable
      ? ` <button type="button" class="remove" data-name="${n}">Remove</button>`
      : '';
  return `<form class="replace" data-name="${n}"><input type="password" name="value" autocomplete="off" spellcheck="false" aria-label="New value for ${n}">${made} <button>Replace</button> <span class="replace-out" role="status"></span></form>${test}${remove}`;
}

function rowFor(name: CredentialName, c: ResolvedCredential, store: ConfigStore, vaultOn: boolean) {
  const created =
    credentialCreatedAt(name, store.resolved(), store.current().claude) ?? c.declaredCreatedAt;
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
/**
 * Sudo from a page (§7.5): with it held, nothing to do; without it and with no passphrase typed,
 * say why it is asked and touch nothing; else `POST /api/control/sudo` once and clear the field.
 * The Credentials and MCP tokens tabs share it: one sudo mechanism, the guard's.
 */
const SUDO_FN = `async function jmSudo(state, status, why) {
  if (state.sudo) return true;
  if (!state.passphrase) { status.textContent = why || 'Re-enter your passphrase to change a credential.'; return false; }
  const r = await jmFetch('/api/control/sudo', { passphrase: state.passphrase });
  state.passphrase = '';
  if (!r.ok) { status.textContent = 'The passphrase was not accepted (' + r.status + ').'; return false; }
  state.sudo = true;
  return true;
}`;

/** The passphrase prompt the sudo scripts open: hidden until a write asks for it. */
const SUDO_PROMPT = (what: string) =>
  `<div id="sudo-prompt" hidden><p><label>Your passphrase (${what} asks for it again) <input type="password" id="sudo-pass" autocomplete="current-password"></label> Then press the button again.</p></div>`;

export const CREDENTIALS_SCRIPT = `<script>
${SUDO_FN}
async function jmWhy(r) {
  try {
    const j = await r.json();
    if (j.error) return j.error;
    if (j.tested === false) return 'the test failed (' + (j.status == null ? 'no answer' : j.status) + ')' + (j.permission ? ': needs ' + j.permission : '') + (j.problem ? ': ' + j.problem : '');
  } catch (e) {}
  return '';
}
function jmRefreshLink(status) {
  status.insertAdjacentHTML('beforeend', ' <a href="/settings/credentials">Refresh the list</a>');
}
async function jmReplaceCredential(c, state, status) {
  if (!c.value) { status.textContent = 'Enter a token first.'; return 'empty'; }
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
  // The route's running-drops line, only when a drop still carries the previous value.
  status.textContent = 'Saved and tested.' + (j.runningDropsWithPrevious > 0 && j.hint ? ' ' + j.hint : '');
  jmRefreshLink(status);
  return 'saved';
}
async function jmTestCredential(name, state, status) {
  if (!(await jmSudo(state, status))) return 'sudo';
  const r = await jmFetch('/api/control/secrets/' + encodeURIComponent(name) + '/test', {});
  if (!r.ok) { if (r.status === 403) state.sudo = false; status.textContent = name + ': ' + r.status + ' ' + (await jmWhy(r)); return 'refused'; }
  const j = await r.json();
  status.textContent = j.tested ? name + ': ' + j.result + (j.login ? ' (' + j.login + ')' : '') : name + ': ' + (await jmWhy({ json: async () => j }));
  jmRefreshLink(status);
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
    // Beside the button, so an empty field's "Enter a token first." is seen where it was pressed.
    const out = form.querySelector('.replace-out');
    const outcome = await jmReplaceCredential(c, s, out);
    if (outcome !== 'sudo') field.value = '';
    after(s, outcome);
  });
  for (const b of document.querySelectorAll('button.test')) b.addEventListener('click', async () => {
    const s = state(); after(s, await jmTestCredential(b.dataset.name, s, status));
  });
  for (const b of document.querySelectorAll('button.remove')) b.addEventListener('click', async () => {
    if (!confirm('Remove ' + b.dataset.name + ' from the vault? Jumpmaster refuses to remove it while a zone still needs it.')) return;
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
${SUDO_PROMPT('changing a credential')}
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

// ---------------------------------------------------------------------------------------------
// Install: the install-wide settings of the editable document, and the boot settings read-only.

type Kind = 'number' | 'bool' | 'text' | 'select';
type Setting = {
  path: string;
  /** The §4 plain-English words beside the key. */
  label: string;
  kind: Kind;
  value: unknown;
  /** `<input>` attributes for a number (min, max, step). */
  attrs?: string;
  options?: readonly string[];
  /** Read-only even in db mode, with `note` saying where it is changed. */
  locked?: boolean;
  note?: string;
};

const RESTART_NOTE = 'takes effect at the next restart';
const PLANS = ['pro', 'max', 'team_standard', 'team_premium', 'enterprise'] as const;

function installSettings(config: Config): Setting[] {
  const mcp = mcpConfigOf(config);
  const signed = config.requireSignedImages === true;
  return [
    {
      path: 'pollSeconds',
      label: 'seconds between passes (how often Jumpmaster looks at GitHub and the runners)',
      kind: 'number',
      value: config.pollSeconds,
      attrs: `min="${MIN_POLL_SECONDS}" max="${MAX_POLL_SECONDS}" step="1"`,
    },
    {
      path: 'usage.throttleUtilization',
      label: 'the share of the Claude usage window at which dispatch slows (0 to 1)',
      kind: 'number',
      value: config.usage.throttleUtilization,
      attrs: 'min="0" max="1" step="0.01"',
    },
    {
      path: 'usage.stopOnOverage',
      label: 'stop all dispatch when a drop runs on paid usage credits',
      kind: 'bool',
      value: config.usage.stopOnOverage !== false,
      note: 'turning it off asks for confirmation (a briefing is then all that happens)',
    },
    {
      path: 'claude.plan',
      label: 'the Claude plan, as you declare it',
      kind: 'select',
      value: config.claude.plan,
      options: PLANS,
    },
    {
      path: 'claude.fableModel',
      label: 'the model the Fable reviewer runs on (empty: no Fable)',
      kind: 'text',
      value: config.claude.fableModel ?? null,
    },
    {
      path: 'claude.fableWeeklyDropCap',
      label: 'Fable drops allowed in a trailing seven days',
      kind: 'number',
      value: config.claude.fableWeeklyDropCap,
      attrs: 'min="0" step="1"',
    },
    {
      path: 'requireSignedImages',
      label: 'run only signed images (signed image policy): a runner must verify signatures',
      kind: 'bool',
      value: signed,
      locked: signed,
      note: signed
        ? `on: to turn it off, ${SESSION_FORBIDDEN_NOTE}`
        : 'turning it on parks every runner that cannot verify signatures',
    },
    {
      path: 'mcp.enabled',
      label: "Command's MCP server at /mcp (zone-scoped tokens, under MCP tokens)",
      kind: 'bool',
      value: mcp.enabled,
      note: `${RESTART_NOTE}; turning it on asks for confirmation`,
    },
    {
      path: 'mcp.maxBodyBytes',
      label: 'the largest MCP request body, in bytes',
      kind: 'number',
      value: mcp.maxBodyBytes,
      attrs: 'min="1" step="1"',
      note: RESTART_NOTE,
    },
    {
      path: 'mcp.writesPerHour',
      label: 'MCP write calls one token may make in an hour',
      kind: 'number',
      value: mcp.writesPerHour,
      attrs: 'min="0" step="1"',
    },
    {
      path: 'mcp.callsPerHour',
      label: 'MCP calls of any kind one token may make in an hour',
      kind: 'number',
      value: mcp.callsPerHour,
      attrs: 'min="0" step="1"',
    },
    {
      path: 'mcp.maxOpenBriefings',
      label: 'open MCP-raised briefings a zone may hold',
      kind: 'number',
      value: mcp.maxOpenBriefings,
      attrs: 'min="0" step="1"',
    },
  ];
}

/** Where a session may never weaken a guard (§7.5): words for the page. */
const SESSION_FORBIDDEN_NOTE = 'set with <code>jumpmaster ctl</code> or in the config file';

/** The id that ties a setting's control to its `<label for>`. */
const settingId = (path: string): string => `setting-${path.replaceAll('.', '-')}`;

function settingControl(s: Setting): string {
  const data = `id="${settingId(s.path)}" data-path="${s.path}" data-kind="${s.kind}" data-original="${escapeHtml(JSON.stringify(s.value))}"`;
  const lock = s.locked ? ' disabled' : '';
  if (s.kind === 'bool')
    return `<input type="checkbox" ${data}${s.value ? ' checked' : ''}${lock}>`;
  if (s.kind === 'select')
    return `<select ${data}${lock}>${(s.options ?? [])
      .map(
        (o) =>
          `<option value="${escapeHtml(o)}"${o === s.value ? ' selected' : ''}>${escapeHtml(o)}</option>`,
      )
      .join('')}</select>`;
  const value = s.value === null || s.value === undefined ? '' : String(s.value);
  const type = s.kind === 'number' ? `type="number" ${s.attrs ?? ''}` : 'type="text"';
  return `<input ${type} ${data} value="${escapeHtml(value)}"${lock}>`;
}

/** The boot settings, read before the database opens: each value and where it really comes from. */
function bootSection(store: ConfigStore): string {
  const b = store.boot();
  const file = store.status().filePath;
  const fileMode = b.source.listen === 'file';
  // A hand-built boot without origins: the old reading, by the whole section's source.
  const origin =
    b.origin ??
    ({
      host: b.source.listen,
      port: b.source.listen,
      allowedHosts: b.source.listen,
      tlsTerminated: b.listen.tlsTerminated ? 'env' : 'default',
      dataDir: b.source.dataDir,
    } as const);
  const where = (o: BootOrigin, env: string, key: string): string => {
    if (o === 'file') return `the config file <code>${escapeHtml(file ?? '?')}</code>`;
    if (o === 'env') return `the environment: <code>${env}</code>`;
    if (key === 'listen.tlsTerminated')
      return fileMode
        ? `the default; set <code>${env}</code> or <code>${key}</code> in the config file`
        : `the default; set <code>${env}</code>`;
    return fileMode
      ? `the default; set <code>${key}</code> in the config file`
      : `the default; set <code>${env}</code>`;
  };
  const rows: [string, unknown, BootOrigin, string][] = [
    ['listen.host', b.listen.host, origin.host, 'JM_LISTEN_HOST'],
    ['listen.port', b.listen.port, origin.port, 'JM_LISTEN_PORT'],
    [
      'listen.allowedHosts',
      b.listen.allowedHosts.join(', '),
      origin.allowedHosts,
      'JM_ALLOWED_HOSTS',
    ],
    ['listen.tlsTerminated', b.listen.tlsTerminated, origin.tlsTerminated, 'JM_TLS_TERMINATED=1'],
    ['dataDir', b.dataDir, origin.dataDir, 'JM_DATA_DIR'],
  ];
  return `<h3>Boot settings</h3>
<p>Read once, before the database opens: change each where it is set, then restart (<code>docker compose restart jumpmaster</code>).</p>
<table><tr><th>Setting</th><th>Value</th><th>Set in</th></tr>${rows
    .map(
      ([path, value, o, env]) =>
        `<tr data-boot="${path}"><td><code>${path}</code></td><td>${escapeHtml(value)}</td><td>${where(o, env, path)}</td></tr>`,
    )
    .join('')}</table>`;
}

/**
 * The Install tab's script. `jmInstallPatch` turns the form's fields (`{ path, kind, value,
 * original }`) into one merge patch of what changed; `jmSaveInstall` sends it conditional on the
 * revision drawn and follows the answer: applied, the confirmation page (`go`), a conflict, the
 * ctl-or-file note, or the issues by path.
 */
export const INSTALL_SCRIPT = `<script>
function jmInstallPatch(fields) {
  const patch = {};
  for (const f of fields) {
    let v;
    if (f.kind === 'number') {
      if (f.value === '') continue;
      const n = Number(f.value);
      v = Number.isFinite(n) ? n : f.value;
    } else if (f.kind === 'bool') v = !!f.value;
    else if (f.kind === 'text') v = f.value === '' ? null : f.value;
    else v = f.value;
    if (v === (f.original === undefined ? null : f.original)) continue;
    const keys = f.path.split('.');
    let at = patch;
    for (const k of keys.slice(0, -1)) at = at[k] = at[k] || {};
    at[keys[keys.length - 1]] = v;
  }
  return patch;
}
async function jmConfigAnswer(r, status, go) {
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (r.ok) {
    const restart = j.restartNeeded && j.restartNeeded.length ? ' ' + j.restartNeeded.join(', ') + ' ${RESTART_NOTE}.' : '';
    status.textContent = 'Applied as revision ' + j.revision + ': it takes effect at the next pass.' + restart;
    // Drawn again with the saved values, saying which revision it saved (and any restart badge).
    go('/settings/install?saved=' + encodeURIComponent(j.revision));
    return 'saved';
  }
  if (r.status === 409 && j.needsConfirmation) { go(j.confirm); return 'confirm'; }
  if (r.status === 409 && j.conflict) { status.textContent = 'The config changed since this page was drawn: reload it and make the change again.'; return 'conflict'; }
  if (r.status === 403 && j.sessionForbidden) { status.textContent = 'Not from the browser: ' + j.sessionForbidden.join(', ') + ' is set with jumpmaster ctl or in the config file.'; return 'forbidden'; }
  if (j.issues) { status.textContent = j.issues.map((i) => (i.path ? i.path + ': ' : '') + i.message).join('; '); return 'refused'; }
  status.textContent = j.error || ('Refused (' + r.status + ')');
  return 'refused';
}
async function jmSaveInstall(patch, revision, status, go) {
  if (Object.keys(patch).length === 0) { status.textContent = 'Nothing changed.'; return 'unchanged'; }
  const r = await jmFetch('/api/control/config', { patch, expectRevision: revision, returnTo: '/settings/install', cancelTo: '/settings/install' }, 'PATCH');
  return jmConfigAnswer(r, status, go);
}
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('install');
  if (!form || form.dataset.readonly === '1') return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = [...form.querySelectorAll('[data-path]')].filter((el) => !el.disabled).map((el) => ({
      path: el.dataset.path,
      kind: el.dataset.kind,
      value: el.dataset.kind === 'bool' ? el.checked : el.value,
      original: JSON.parse(el.dataset.original),
    }));
    const out = document.getElementById('install-out');
    await jmSaveInstall(jmInstallPatch(fields), Number(form.dataset.revision), out, (to) => { location.href = to; });
  });
});
</script>`;

export function renderInstall(o: {
  store: ConfigStore;
  config: Config;
  /** The revision a Save just applied (`?saved=N`), said at the top. */
  saved?: number;
}): string {
  const { store, config } = o;
  const status = store.status();
  const saved =
    o.saved === undefined
      ? ''
      : `<p class="saved" role="status">Saved as revision ${o.saved}: it takes effect at the next pass.</p>`;
  const fileMode = store.mode() === 'file';
  const restart =
    status.restartPending.length > 0
      ? `<p class="warn restart-pending" role="status"><strong>Restart pending:</strong> ${escapeHtml(status.restartPending.join(', '))} changed since the server started and ${RESTART_NOTE}: run <code>docker compose restart jumpmaster</code>.</p>`
      : '';
  const warnings = status.warnings?.length
    ? `<div class="warn warnings"><p>The config file was read leniently:</p><ul>${status.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
    : '';
  const banner = fileMode
    ? `<p class="warn">These settings are set in the config file <code>${escapeHtml(status.filePath ?? '?')}</code> (file mode), so they are read-only here: edit the file and run <code>jumpmaster ctl config reload</code>, or adopt it into the database (<code>jumpmaster ctl config adopt</code>, or the button on <a href="/zones">Zones</a>) to change them here.</p>`
    : '<p>Each change applies at the next pass, except those marked for the next restart. A change that weakens a guard asks for confirmation first.</p>';
  const rows = installSettings(config)
    .map(
      (s) =>
        `<tr data-setting="${s.path}"><td><label for="${settingId(s.path)}"><code>${s.path}</code></label><br><small>${escapeHtml(s.label)}</small></td><td>${settingControl(s)}</td><td><small>${s.note ?? ''}</small></td></tr>`,
    )
    .join('');
  const save = fileMode
    ? ''
    : '<p><button>Save</button> <span id="install-out" role="status"></span></p>';
  return page(
    `<h2>Settings</h2>${tabs('install')}
${saved}${restart}${warnings}${banner}
<form id="install" data-revision="${store.revision()}" data-readonly="${fileMode ? '1' : '0'}"><fieldset${fileMode ? ' disabled' : ''}>
<table><tr><th>Setting</th><th>Value</th><th></th></tr>${rows}</table>
</fieldset>${save}</form>
${bootSection(store)}
${INSTALL_SCRIPT}`,
  );
}

// ---------------------------------------------------------------------------------------------
// MCP tokens (§7.5): Command's tokens, made here with a zone, a scope and an expiry.

/** The token table's frame, shared by the server's render and the script's redraw (no quotes). */
const NO_TOKENS = '<p>No MCP tokens yet.</p>';
const TOKENS_HEAD =
  '<table><tr><th>#</th><th>Zone</th><th>Scope</th><th>Label</th><th>Made</th><th>Expires</th><th>Last used</th><th></th></tr>';
const TOKENS_TAIL =
  '</table><p><small>A last use you do not recognise means the token is in someone else&#39;s hands: revoke it.</small></p>';

/**
 * The MCP tokens tab's script. `jmMintToken` takes the sudo state (`{ sudo, passphrase }`), a
 * status element and the element the value is shown in once: without sudo and with no passphrase
 * it answers `'sudo'` and sends nothing; the value never reaches the page before the route
 * answers, and only that element holds it. After a mint the list (`list`, the `#token-list`
 * container) is read again and redrawn by `jmTokenTable`, the client's copy of the server's table,
 * so the new token is listed while its value stays shown. `jmRevokeToken` sends one `DELETE`.
 */
export const MCP_TOKENS_SCRIPT = `<script>
${SUDO_FN}
function jmEsc(v) {
  return String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function jmTokenTable(tokens, now) {
  if (tokens.length === 0) return '${NO_TOKENS}';
  const day = (iso) => (iso ? jmEsc(String(iso).slice(0, 10)) : '-');
  const state = (t) => t.revokedAt ? 'revoked ' + day(t.revokedAt) : Date.parse(t.expiresAt) <= now ? 'expired' : '<button type="button" class="revoke" data-id="' + Number(t.id) + '">Revoke</button>';
  const rows = tokens.map((t) => '<tr data-token="' + Number(t.id) + '"><td>' + Number(t.id) + '</td><td>' + jmEsc(t.zoneId) + '</td><td>' + jmEsc(t.scope) + '</td><td>' + (t.label ? jmEsc(t.label) : '-') + '</td><td>' + day(t.createdAt) + '</td><td>' + day(t.expiresAt) + '</td><td>' + (t.lastUsedAt ? day(t.lastUsedAt) : 'never') + '</td><td>' + state(t) + '</td></tr>').join('');
  return '${TOKENS_HEAD}' + rows + '${TOKENS_TAIL}';
}
async function jmRefreshTokens(list) {
  if (!list) return;
  const r = await fetch('/api/control/mcp-tokens');
  if (!r.ok) return;
  const j = await r.json();
  list.innerHTML = jmTokenTable(j.tokens || [], Date.now());
}
async function jmMintToken(c, state, out, reveal, list) {
  if (!(await jmSudo(state, out, 'An MCP token is shown once, so making one asks for your passphrase again.'))) return 'sudo';
  const body = { zoneId: c.zoneId, scope: c.scope, days: Number(c.days) };
  if (c.label) body.label = c.label;
  const r = await jmFetch('/api/control/mcp-tokens', body);
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (r.status === 403 && j.sudo) { state.sudo = false; out.textContent = 'An MCP token is shown once, so making one asks for your passphrase again.'; return 'sudo'; }
  if (!r.ok) { out.textContent = 'No token was made (' + r.status + '): ' + (j.error || ''); return 'refused'; }
  reveal.textContent = j.token;
  reveal.hidden = false;
  out.textContent = 'Token ' + j.id + ' for zone ' + j.zoneId + ' (' + j.scope + '), expires ' + String(j.expiresAt).slice(0, 10) + '. It is shown this once: copy it into a password manager now. Reloading the page clears it.';
  try { await jmRefreshTokens(list); } catch (e) {}
  return 'minted';
}
async function jmRevokeToken(id, status) {
  const r = await jmFetch('/api/control/mcp-tokens/' + encodeURIComponent(id), {}, 'DELETE');
  if (!r.ok) { status.textContent = 'Token ' + id + ' was not revoked (' + r.status + ').'; return 'refused'; }
  status.textContent = 'Token ' + id + ' revoked.';
  return 'revoked';
}
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('mcp-tokens');
  const form = document.getElementById('mint');
  const status = document.getElementById('tokens-status');
  if (form) {
    const prompt = document.getElementById('sudo-prompt');
    const pass = document.getElementById('sudo-pass');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = { sudo: root.dataset.sudo === '1', passphrase: pass.value };
      const c = { zoneId: form.zoneId.value, scope: form.scope.value, days: form.days.value, label: form.label.value };
      const outcome = await jmMintToken(c, s, document.getElementById('mint-out'), document.getElementById('mint-value'), document.getElementById('token-list'));
      pass.value = '';
      if (s.sudo) root.dataset.sudo = '1'; else root.dataset.sudo = '0';
      if (outcome === 'sudo') { prompt.hidden = false; pass.focus(); } else prompt.hidden = true;
    });
  }
  // Delegated, so a row drawn after a mint has a working Revoke too.
  const list = document.getElementById('token-list');
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('button.revoke');
    if (!b) return;
    if (!confirm('Revoke MCP token ' + b.dataset.id + '? Its next call is refused.')) return;
    if ((await jmRevokeToken(b.dataset.id, status)) === 'revoked') await jmRefreshTokens(list);
  });
});
</script>`;

export function renderMcpTokens(o: {
  config: Config;
  tokens: McpTokenInfo[];
  /** Whether this server registered the token routes (mcp.enabled when it started). */
  routes: boolean;
  sudo: boolean;
  now: Date;
}): string {
  const { config, tokens, routes } = o;
  const intro =
    "<p>An MCP token lets Command (a Claude session you run) reach one zone through Jumpmaster's MCP server at <code>/mcp</code>: <strong>read</strong> looks only, <strong>write</strong> may also raise briefings and file work through its tools. Each token expires; the server keeps only its hash, so the value is shown once, when it is made.</p>";
  const enabled = mcpConfigOf(config).enabled;
  const off = routes
    ? ''
    : `<p class="warn">Command's MCP server is off on this server, so no token can be made or used. ${
        enabled
          ? '<code>mcp.enabled</code> is on and takes effect at the next restart: run <code>docker compose restart jumpmaster</code>.'
          : 'Turn on <code>mcp.enabled</code> under <a href="/settings/install">Install</a>; it takes effect at the next restart.'
      }</p>`;
  const zones = config.dropZones
    .map((z) => `<option value="${escapeHtml(z.id)}">${escapeHtml(z.id)}</option>`)
    .join('');
  const mint = !routes
    ? ''
    : config.dropZones.length === 0
      ? '<p>A token belongs to a zone: <a href="/zones/new">add a project</a> first.</p>'
      : `<h3>Make a token</h3>
<form id="mint"><label>Zone <select name="zoneId">${zones}</select></label> <label>Scope <select name="scope"><option value="read" selected>read</option><option value="write">write</option></select></label> <label>Days <input type="number" name="days" min="1" max="${MAX_TOKEN_DAYS}" value="30" required></label> <label>Label <input name="label" maxlength="80" autocomplete="off"></label> <button>Make a token</button></form>
${SUDO_PROMPT('making a token')}
<p id="mint-out" role="status"></p>
<p><code id="mint-value" hidden></code></p>`;
  const at = o.now.getTime();
  const state = (t: McpTokenInfo): string => {
    if (t.revokedAt) return `revoked ${day(t.revokedAt)}`;
    if (Date.parse(t.expiresAt) <= at) return 'expired';
    return routes
      ? `<button type="button" class="revoke" data-id="${t.id}">Revoke</button>`
      : 'active';
  };
  const rows = tokens
    .map(
      (t) =>
        `<tr data-token="${t.id}"><td>${t.id}</td><td>${escapeHtml(t.zoneId)}</td><td>${escapeHtml(t.scope)}</td><td>${t.label ? escapeHtml(t.label) : '-'}</td><td>${day(t.createdAt)}</td><td>${day(t.expiresAt)}</td><td>${t.lastUsedAt ? day(t.lastUsedAt) : 'never'}</td><td>${state(t)}</td></tr>`,
    )
    .join('');
  const list = tokens.length === 0 ? NO_TOKENS : `${TOKENS_HEAD}${rows}${TOKENS_TAIL}`;
  return page(
    `<h2>Settings</h2>${tabs('mcp-tokens')}
<div id="mcp-tokens" data-sudo="${o.sudo ? '1' : '0'}">
${intro}${off}${mint}
<h3>Tokens</h3><div id="token-list">${list}</div>
<p id="tokens-status" role="status"></p>
<p><small>The same from a terminal: <code>jumpmaster ctl mcp-tokens mint &lt;zone&gt; &lt;read|write&gt; --days N</code>, <code>list</code>, <code>revoke &lt;id&gt;</code>.</small></p>
</div>
${MCP_TOKENS_SCRIPT}`,
  );
}

// ---------------------------------------------------------------------------------------------
// History (§10.3): the config revisions, their changes and marks, and Revert.

const VIA_WORDS: Record<string, string> = {
  file: 'the config file',
  ui: 'the browser',
  ctl: 'jumpmaster ctl',
  rollback: 'a revert',
  adopt: 'adoption of the file',
  import: 'an import',
  setup: 'the setup wizard',
};

/** A value in a change line: JSON, cut at 80 characters, escaped by the caller. */
const shortJson = (v: unknown): string => {
  if (v === undefined) return '(unset)';
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

const MAX_CHANGES_SHOWN = 20;
const HISTORY_LIMIT = 50;

/**
 * The History tab's script. `jmRevert` asks first (naming any zone the revert re-adds with its
 * history), then posts a rollback to that revision conditional on the revision drawn; a revert
 * that weakens a guard goes to the confirmation page (`go`), as any session apply does.
 */
export const HISTORY_SCRIPT = `<script>
async function jmRevert(r, status, ask, go) {
  const n = r.readds.length;
  const readds = n === 0 ? '' : ' It re-adds zone' + (n > 1 ? 's ' : ' ') + r.readds.join(', ') + ' with ' + (n > 1 ? 'their' : 'its') + ' history; ' + (n > 1 ? 'they come' : 'it comes') + ' back paused.';
  if (!ask('Revert to revision ' + r.id + '? It is applied as a new revision, and the history is kept.' + readds)) return 'cancelled';
  const res = await jmFetch('/api/control/config/rollback', { id: r.id, expectRevision: r.revision, returnTo: '/settings/history', cancelTo: '/settings/history' });
  let j = {};
  try { j = await res.json(); } catch (e) {}
  if (res.ok) { go('/settings/history'); return 'reverted'; }
  if (res.status === 409 && j.needsConfirmation) { go(j.confirm); return 'confirm'; }
  if (res.status === 409 && j.conflict) { status.textContent = 'The config changed since this page was drawn: reload it and revert again.'; return 'conflict'; }
  if (res.status === 403 && j.sessionForbidden) { status.textContent = 'Not from the browser: ' + j.sessionForbidden.join(', ') + ' is set with jumpmaster ctl or in the config file.'; return 'forbidden'; }
  if (j.issues) { status.textContent = j.issues.map((i) => (i.path ? i.path + ': ' : '') + i.message).join('; '); return 'refused'; }
  status.textContent = j.error || ('Refused (' + res.status + ')');
  return 'refused';
}
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('history');
  const status = document.getElementById('history-status');
  for (const b of document.querySelectorAll('button.revert')) b.addEventListener('click', () =>
    jmRevert({ id: Number(b.dataset.id), revision: Number(root.dataset.revision), readds: JSON.parse(b.dataset.readds) }, status, (q) => confirm(q), (to) => { location.href = to; }));
});
</script>`;

export function renderHistory(o: { store: ConfigStore; revisions: RevisionView[] }): string {
  const { store, revisions } = o;
  const current = store.revision();
  const fileMode = store.mode() === 'file';
  const changes = (r: RevisionView): string => {
    if (r.changes.length === 0) return '<small>no change</small>';
    const shown = r.changes
      .slice(0, MAX_CHANGES_SHOWN)
      .map(
        (c) =>
          `<li><code>${escapeHtml(c.path)}</code>: ${escapeHtml(shortJson(c.from))} → ${escapeHtml(shortJson(c.to))}</li>`,
      )
      .join('');
    const more =
      r.changes.length > MAX_CHANGES_SHOWN
        ? `<li>and ${r.changes.length - MAX_CHANGES_SHOWN} more (<code>jumpmaster ctl config revisions</code>)</li>`
        : '';
    return `<ul>${shown}${more}</ul>`;
  };
  const marks = (r: RevisionView): string =>
    [
      r.guarded.length > 0
        ? `<span class="mark guarded" title="a change that weakened a guard: it needed the operator token, the file, or a confirmation">guarded: ${escapeHtml(r.guarded.join(', '))}</span>`
        : '',
      r.readds.length > 0
        ? `<span class="mark readds">re-added ${escapeHtml(r.readds.join(', '))} with history</span>`
        : '',
    ]
      .filter((m) => m !== '')
      .join('<br>');
  const revert = (r: RevisionView): string => {
    if (r.id === current) return '<small>current</small>';
    if (fileMode) return '';
    const n = r.revertReadds.length;
    const says =
      n > 0
        ? ` <small>re-adds zone${n > 1 ? 's' : ''} ${escapeHtml(r.revertReadds.join(', '))} with ${n > 1 ? 'their' : 'its'} history (paused)</small>`
        : '';
    return `<button type="button" class="revert" data-id="${r.id}" data-readds="${escapeHtml(JSON.stringify(r.revertReadds))}">Revert</button>${says}`;
  };
  const rows = revisions
    .map(
      (r) =>
        `<tr data-revision="${r.id}"><td>#${r.id}</td><td>${escapeHtml(r.createdAt.slice(0, 16).replace('T', ' '))}</td><td>${escapeHtml(VIA_WORDS[r.via] ?? r.via)}</td><td>${r.note ? escapeHtml(r.note) : '-'}</td><td>${changes(r)}</td><td>${marks(r)}</td><td>${revert(r)}</td></tr>`,
    )
    .join('');
  const intro = fileMode
    ? '<p class="warn">In file mode the config file is the config: each reload that changed it is a revision here, and a revert is made by editing the file (or, after adopting it, here).</p>'
    : '<p>Every change to the config is a revision, kept for good. Revert applies an old revision’s content as a new revision; one that weakens a guard asks for confirmation first, and one that brings back a removed zone says so before it runs.</p>';
  return page(
    `<h2>Settings</h2>${tabs('history')}
<div id="history" data-revision="${current}">
${intro}
<table><tr><th>Revision</th><th>When (UTC)</th><th>Made by</th><th>Note</th><th>Changes</th><th>Marks</th><th></th></tr>${rows}</table>
<p id="history-status" role="status"></p>
<p><small>The latest ${HISTORY_LIMIT} revisions; <code>jumpmaster ctl config revisions</code> and <code>jumpmaster ctl config rollback &lt;id&gt;</code> do the same from a terminal.</small></p>
</div>
${HISTORY_SCRIPT}`,
  );
}

const html = (req: FastifyRequest, reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(withCsrf(req, body));

export function registerSettingsPages(
  app: FastifyInstance,
  deps: {
    db: Db;
    store: ConfigStore;
    now(): Date;
    /** Active drops started before a time: the drops that carry a replaced credential's old value. */
    runningSince(since: string): number;
    guidanceForge?: (repo: string, token: string) => GuidanceForge;
  },
): void {
  const { store, now } = deps;
  const forgeOf = deps.guidanceForge ?? githubGuidanceForge;
  // Each tab is a path; Settings opens on the first.
  app.get('/settings', async (_req, reply) => reply.redirect('/settings/credentials', 302));
  app.get<{ Querystring: { saved?: string } }>('/settings/install', async (req, reply) => {
    // Only a revision number is echoed back: anything else says nothing.
    const raw = req.query.saved;
    const saved = typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : undefined;
    return html(
      req,
      reply,
      renderInstall({
        store,
        config: req.jmConfig ?? store.current(),
        ...(saved !== undefined ? { saved } : {}),
      }),
    );
  });
  app.get('/settings/mcp-tokens', async (req, reply) =>
    html(
      req,
      reply,
      renderMcpTokens({
        config: req.jmConfig ?? store.current(),
        tokens: listMcpTokens(deps.db),
        // Registered at start when mcp.enabled was on; a later flip waits for a restart.
        routes: app.hasRoute({ method: 'POST', url: '/api/control/mcp-tokens' }),
        sudo: req.principal?.sudo === true,
        now: now(),
      }),
    ),
  );
  app.get('/settings/history', async (req, reply) =>
    html(req, reply, renderHistory({ store, revisions: store.revisions(HISTORY_LIMIT) })),
  );
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
