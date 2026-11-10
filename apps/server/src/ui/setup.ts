import { PRESETS } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type GuidanceForge,
  githubGuidanceForge,
  type RecommendAnswer,
  recommendFor,
} from '../api/github.js';
import { withCsrf } from '../auth/guard.js';
import { getSetting, setSetting } from '../config/revisions.js';
import type { ConfigStore } from '../config/store.js';
import { type Config, STARTER_WARNING } from '../config.js';
import type { Db } from '../db/open.js';
import { listSticks } from '../db/repo.js';
import { latestDoctorRun } from '../doctor/run.js';
import { BASE_EGRESS } from '../payloads.js';
import { PRESET_EGRESS } from '../presets.js';
import type { CredentialName, ResolvedCredential } from '../vault/credentials.js';
import {
  COPY_SCRIPT,
  checklistSection,
  codeownersSection,
  recommendationSection,
  reviewersOf,
  rulesetSection,
  tokensSection,
} from './github.js';
import { escapeHtml, page } from './pages.js';

/**
 * The setup wizard (§10.3, M4.5): after the passphrase, five steps, each a thin frame over a
 * handler that already exists. Credentials go through the secret routes (tested before saving,
 * sudo for a session), the project through `POST /api/control/zones` (the apply path, so a
 * guarded add goes to the confirmation page with `returnTo` set), the doctor through its route.
 * The pages hold no secret: a credential shows as its source and fingerprint.
 *
 * Progress is `settings.setup.step`: the furthest step reached, whether the operator chose starter
 * mode on the forge step, and whether the wizard was dismissed. The frame shows on home until a
 * zone exists or it is dismissed; the steps stay reachable for their controls afterwards.
 */

export const STEPS = ['claude', 'forge', 'stick', 'project', 'doctor'] as const;
export type Step = (typeof STEPS)[number];

export type Wizard = { step: Step | 'done'; starter?: boolean; dismissed?: boolean };

const TITLES: Record<Step, string> = {
  claude: 'Claude',
  forge: 'GitHub',
  stick: 'Runner',
  project: 'Project',
  doctor: 'Doctor',
};

const WizardSchema = z.object({
  step: z.enum([...STEPS, 'done']),
  starter: z.boolean().optional(),
  dismissed: z.boolean().optional(),
});

export function getWizard(db: Db): Wizard {
  const parsed = WizardSchema.safeParse(getSetting(db, 'setup.step'));
  return parsed.success ? parsed.data : { step: 'claude' };
}

function setWizard(db: Db, w: Wizard, now: Date): void {
  setSetting(db, 'setup.step', w, now);
}

const rank = (s: Step | 'done'): number => (s === 'done' ? STEPS.length : STEPS.indexOf(s));

/** Moves the progress forward to `to`, never back. */
function reach(db: Db, to: Step | 'done', now: Date, extra: Partial<Wizard> = {}): Wizard {
  const w = getWizard(db);
  const next: Wizard = { ...w, ...extra, step: rank(to) > rank(w.step) ? to : w.step };
  setWizard(db, next, now);
  return next;
}

/** Whether home shows the "Finish setting up" frame: no zone yet, and not dismissed. */
export function wizardActive(db: Db, config: Pick<Config, 'dropZones'>): boolean {
  return config.dropZones.length === 0 && getWizard(db).dismissed !== true;
}

/** The first step whose work the install still lacks (the wizard is active, so no zone exists). */
export function firstUnfinished(store: ConfigStore, db: Db): Step {
  const r = store.resolved();
  if (r.claudeToken.source === 'missing') return 'claude';
  if (r.githubAuthorToken.source === 'missing') return 'forge';
  if (!listSticks(db).some((s) => s.lastSeenAt !== null)) return 'stick';
  return 'project';
}

/** JSON inside a `<script>`: no `</script>` or comment opener can close it early. */
const scriptJson = (v: unknown): string =>
  JSON.stringify(v)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

const ANTHROPIC_TERMS = 'https://www.anthropic.com/legal/consumer-terms';
const CLAUDE_CODE_LEGAL = 'https://code.claude.com/docs/en/legal-and-compliance';

/** One credential's state as the page may show it: source, fingerprint, login, dates. */
function credentialLine(name: CredentialName, c: ResolvedCredential | undefined): string {
  if (!c || c.source === 'missing')
    return `<p data-credential="${name}">Not set yet${c?.undecryptable ? ' (the stored value does not decrypt with the vault key: enter it again)' : ''}.</p>`;
  const where =
    c.source === 'vault'
      ? 'kept in the encrypted vault'
      : `managed by ${escapeHtml(c.path ?? c.source)}: replace that file and run <code>jumpmaster ctl secrets reload</code> to change it`;
  return `<p data-credential="${name}">Set: fingerprint <code>${escapeHtml(c.fingerprint ?? '?')}</code>${c.login ? `, account ${escapeHtml(c.login)}` : ''}${c.setAt ? `, saved ${escapeHtml(c.setAt.slice(0, 10))}` : ''}; ${where}.</p>`;
}

/** A credential field, or nothing when the credential is a file's or the environment's. */
function credentialField(
  name: CredentialName,
  label: string,
  c: ResolvedCredential | undefined,
): string {
  if (c && (c.source === 'file' || c.source === 'env')) return '';
  return `<p><label>${escapeHtml(label)} <input type="password" name="${name}" autocomplete="off" spellcheck="false"></label></p>`;
}

/** The re-entered passphrase a credential write needs from a session without sudo. */
const sudoField = (sudo: boolean): string =>
  sudo
    ? ''
    : '<p><label>Your passphrase (saving a credential asks for it again) <input type="password" name="sudo" autocomplete="current-password"></label></p>';

/**
 * The script that saves the filled credential fields: sudo first when asked for, then one `PUT`
 * per field to the secret routes, which test each before storing it. A failure shows the status
 * and the route's message; the value never leaves the field except in the request body. It answers
 * `'empty'` (nothing was filled: "Enter a token first."), `'saved'` or `false`. Save never moves
 * the wizard on: only Continue and Do this later do.
 */
export const SAVE_CREDENTIALS = `<script>
async function jmSaveCredentials(form, out) {
  out.textContent = '';
  const filled = [...form.querySelectorAll('input[type=password]:not([name=sudo])')].filter((f) => f.value);
  if (filled.length === 0) { out.textContent = 'Enter a token first.'; return 'empty'; }
  const sudo = form.querySelector('input[name=sudo]');
  if (sudo && sudo.value) {
    const r = await jmFetch('/api/control/sudo', { passphrase: sudo.value });
    sudo.value = '';
    if (!r.ok) { out.textContent = 'The passphrase was not accepted (' + r.status + ').'; return false; }
  }
  for (const field of form.querySelectorAll('input[type=password]:not([name=sudo])')) {
    if (!field.value) continue;
    const body = { value: field.value };
    const created = form.querySelector('input[name=declaredCreatedAt]');
    if (field.name === 'claudeToken' && created && created.value) body.declaredCreatedAt = created.value;
    const r = await jmFetch('/api/control/secrets/' + field.name, body, 'PUT');
    field.value = '';
    if (!r.ok) {
      let why = '';
      try { const j = await r.json(); why = j.error || (j.tested === false ? 'GitHub refused it' + (j.permission ? ' (needs ' + j.permission + ')' : '') : ''); } catch (e) {}
      out.textContent = field.name + ' was not saved (' + r.status + '): ' + why;
      return false;
    }
  }
  out.textContent = 'Saved and tested.';
  return 'saved';
}
</script>`;

const advanceForm = (step: Step, extra = ''): string =>
  `<form method="post" action="/setup/advance" id="advance" class="setup-advance"><input type="hidden" name="from" value="${step}">${extra}<button name="how" value="continue">Continue</button> <button name="how" value="later">Do this later</button></form>`;

/** The frame every step shares: where you are, the step, and the way out. */
function frame(step: Step, body: string, opts: { advance?: string } = {}): string {
  const nav = STEPS.map((s, i) => {
    const label = `${i + 1}. ${TITLES[s]}`;
    return s === step ? `<strong>${label}</strong>` : `<a href="/setup/${s}">${label}</a>`;
  }).join(' · ');
  return page(
    `<h2>Set up Jumpmaster</h2><p class="setup-steps">${nav}</p>${body}${opts.advance ?? advanceForm(step)}<form method="post" action="/setup/dismiss" style="margin-top:2rem"><button>Dismiss setup</button> <small>Every step stays at its address; home links “Add a project”.</small></form>`,
  );
}

function claudePage(store: ConfigStore, sudo: boolean): string {
  const c = store.resolved().claudeToken;
  const config = store.current();
  const fileMode = store.mode() === 'file';
  const plans = ['pro', 'max', 'team_standard', 'team_premium', 'enterprise']
    .map(
      (p) =>
        `<option value="${p}"${config.claude.plan === p ? ' selected' : ''}>${escapeHtml(p)}</option>`,
    )
    .join('');
  const field = credentialField('claudeToken', 'Claude token', c);
  return frame(
    'claude',
    `<h3>Connect Claude</h3>
<p>Jumpmaster runs Claude Code with <strong>your own</strong> subscription token. Make it on your own computer with <code>claude setup-token</code> (it lasts a year) and paste it here. Jumpmaster never asks Anthropic for it on your behalf, and it is never shown back: you will see its fingerprint.</p>
<p>Your use stays under Anthropic's terms: <a href="${ANTHROPIC_TERMS}" rel="noreferrer">Consumer Terms</a> and <a href="${CLAUDE_CODE_LEGAL}" rel="noreferrer">Claude Code legal and compliance</a>.</p>
${credentialLine('claudeToken', c)}
<form id="claude">${field}${field ? '<p><label>Made on (optional) <input type="date" name="declaredCreatedAt"></label></p>' : ''}
<p><label>Plan ${fileMode ? `<strong>${escapeHtml(config.claude.plan)}</strong> (set in the config file)` : `<select name="plan">${plans}</select>`}</label></p>
${field ? sudoField(sudo) : ''}<p><button>Save</button> <span id="claude-out" role="status"></span></p></form>
${SAVE_CREDENTIALS}
<script>
document.getElementById('claude').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target; const out = document.getElementById('claude-out');
  const plan = form.querySelector('select[name=plan]');
  let planSaved = false;
  if (plan) {
    // The revision and the plan as they are now, not as they were when the page was drawn.
    const now = await (await fetch('/api/control/config')).json();
    const current = (now.config && now.config.claude && now.config.claude.plan) || 'pro';
    if (plan.value !== current) {
      const r = await jmFetch('/api/control/config', { patch: { claude: { plan: plan.value } }, expectRevision: now.revision }, 'PATCH');
      if (!r.ok) { out.textContent = 'The plan was not saved (' + r.status + ').'; return; }
      planSaved = true;
    }
  }
  const saved = await jmSaveCredentials(form, out);
  if (saved === 'empty' && planSaved) out.textContent = 'Plan saved.';
});
</script>`,
  );
}

/** What the forge step shows for a named repository: the recommendation, or why it could not. */
export type ForgeGuide = {
  repo: string;
  paidPlan: string;
  answer?: RecommendAnswer;
  error?: string;
};

/**
 * The recommendation for the repository a GET names (`repo`, `paidPlan`), read from GitHub without
 * writing; undefined when none is named. The forge step and the Credentials tab share it.
 */
export async function forgeGuideFor(
  store: ConfigStore,
  config: Config,
  query: unknown,
  forgeOf: (repo: string, token: string) => GuidanceForge,
  now: () => Date,
): Promise<ForgeGuide | undefined> {
  const q = ForgeQuery.safeParse(query ?? {});
  const repo = q.success ? q.data.repo : undefined;
  if (!q.success || repo === undefined || repo === '') return undefined;
  const paidPlan = q.data.paidPlan ?? '';
  if (!REPO_PARAM.test(repo)) return { repo, paidPlan, error: 'the repository must be owner/name' };
  const r = await recommendFor(
    store,
    config,
    { repo, ...(paidPlan ? { paidPlan: paidPlan === 'yes' } : {}) },
    forgeOf,
    now,
  );
  return r.ok ? { repo, paidPlan, answer: r.answer } : { repo, paidPlan, error: r.error };
}

/**
 * The forge step's first part: which repository, then the accounts to use and the pre-filled
 * token links (unless the recommendation stops first), and the collaborator checklist once the
 * author token resolves a login. All of it is read from GitHub without writing, and escaped.
 */
export function guideSection(guide: ForgeGuide | undefined, action = '/setup/forge'): string {
  const repo = guide?.repo ?? '';
  const plan = guide?.paidPlan ?? '';
  const option = (v: string, label: string) =>
    `<option value="${v}"${plan === v ? ' selected' : ''}>${label}</option>`;
  const form = `<form method="get" action="${action}" id="recommend-form"><p><label>Repository <input name="repo" value="${escapeHtml(repo)}" placeholder="owner/name" pattern="[A-Za-z0-9\\-]+/[A-Za-z0-9._\\-]+" required></label> <label>Paid GitHub plan (matters for a private repository) <select name="paidPlan">${option('', 'I don’t know')}${option('yes', 'Yes')}${option('no', 'No')}</select></label> <button>Recommend</button></p></form>`;
  if (!guide)
    return `<h4>Which repository?</h4><p>Name the repository first: Jumpmaster reads its owner and visibility (without a token if it has none yet) to recommend the accounts and fill in the token pages.</p>${form}`;
  if (guide.error) return `${form}<p class="warn">${escapeHtml(guide.error)}</p>`;
  const a = guide.answer;
  if (!a) return form;
  const roles = [
    'author' as const,
    ...(a.recommendation.identity === 'starter' ? [] : (['reviewer'] as const)),
    ...(a.visibility === 'private' ? (['read'] as const) : []),
  ];
  return `${form}<p>${escapeHtml(a.repo)}: ${a.visible ? escapeHtml(a.visibility) : 'not visible without a token (private, or not there)'}, owned by ${a.ownerType === 'Organization' ? 'an organization' : 'a personal account'}.</p>
${recommendationSection(a.recommendation)}
${a.recommendation.stop ? '' : tokensSection(a.pat, roles)}
${a.logins.author ? checklistSection(a.checklist) : ''}`;
}

function forgePage(store: ConfigStore, sudo: boolean, wizard: Wizard, guide?: ForgeGuide): string {
  const r = store.resolved();
  const recommended = guide?.answer?.recommendation.identity;
  const starter = wizard.starter ?? recommended === 'starter';
  const fields = [
    credentialField('githubAuthorToken', 'Author token', r.githubAuthorToken),
    credentialField('githubReviewerToken', 'Reviewer token (two-bot mode)', r.githubReviewerToken),
    credentialField(
      'githubReadToken',
      'Read token (only for a private repository)',
      r.githubReadToken,
    ),
  ].join('');
  return frame(
    'forge',
    `<h3>Connect GitHub</h3>
${guideSection(guide)}
<h4>The tokens</h4>
<p>Jumpmaster works on GitHub as an <strong>author</strong> account (opens and merges the agents' pull requests) and, in two-bot mode, a separate <strong>reviewer</strong> account (approves them). Use fine-grained tokens limited to your repositories. Each token is tested with GitHub before it is saved, and never shown back.</p>
<h4>Author</h4>${credentialLine('githubAuthorToken', r.githubAuthorToken)}
<h4>Reviewer</h4>${credentialLine('githubReviewerToken', r.githubReviewerToken)}
<h4>Read token</h4>${credentialLine('githubReadToken', r.githubReadToken)}
<form id="forge">${fields}
${fields ? sudoField(sudo) : ''}<p><button>Save</button> <span id="forge-out" role="status"></span></p></form>
${guide?.answer?.recommendation.identity === 'starter' ? '' : `<p class="warn" id="starter-warning"><strong>What starter mode costs:</strong> ${escapeHtml(STARTER_WARNING)}</p>`}
${SAVE_CREDENTIALS}
<script>
document.getElementById('forge').addEventListener('submit', async (e) => {
  e.preventDefault();
  await jmSaveCredentials(e.target, document.getElementById('forge-out'));
});
</script>`,
    {
      // The account choice goes with Continue (the project step offers it), never with Save.
      advance: advanceForm(
        'forge',
        `<p><label><input type="checkbox" name="starter" value="1"${starter ? ' checked' : ''}> Starter mode: one GitHub account, no reviewer</label></p>`,
      ),
    },
  );
}

function stickPage(db: Db): string {
  const seen = listSticks(db).filter((s) => s.lastSeenAt !== null);
  const body = seen.length
    ? `<p><strong>Your runner has checked in.</strong></p><ul>${seen.map((s) => `<li>${escapeHtml(s.name)}, last seen ${escapeHtml(s.lastSeenAt)}${s.version ? `, version ${escapeHtml(s.version)}` : ''}</li>`).join('')}</ul>`
    : '<p>No runner has checked in yet. Under Docker Compose it starts beside the server; <code>docker compose logs stick</code> shows what it is doing, or why it cannot reach the server.</p><p><a href="/setup/stick">Check again</a></p>';
  return frame(
    'stick',
    `<h3>The runner</h3><p>The runner (the “stick”) starts the containers that do the work.</p>${body}`,
  );
}

/** Each preset's base egress hosts: what a monitor zone's drops are expected to reach. */
const presetHosts = (): Record<string, string[]> =>
  Object.fromEntries(PRESETS.map((p) => [p, [...BASE_EGRESS, ...PRESET_EGRESS[p]]]));

function projectPage(store: ConfigStore, wizard: Wizard): string {
  if (store.mode() === 'file') {
    const zones = store.current().dropZones;
    return frame(
      'project',
      `<h3>Your project</h3><p>Your config file holds ${zones.length} zone${zones.length === 1 ? '' : 's'}${zones.length ? `: ${zones.map((z) => `${escapeHtml(z.id)} (${escapeHtml(z.repo)})`).join(', ')}` : ''}. In file mode the file is the config: edit it and run <code>jumpmaster ctl config reload</code>.</p>
<p>To manage the config here instead, adopt it: the file's contents become the first revision in the database, and from then on this page and <code>jumpmaster ctl config</code> change it. <code>jumpmaster ctl config mode file</code> goes back.</p>
<p><button id="adopt">Adopt the config file</button> <span id="adopt-out" role="status"></span></p>
<script>
document.getElementById('adopt').addEventListener('click', async () => {
  const r = await jmFetch('/api/control/config/adopt', {});
  if (r.ok) location.reload(); else document.getElementById('adopt-out').textContent = 'Not adopted (' + r.status + ').';
});
</script>`,
    );
  }
  return frame(
    'project',
    projectBody(wizard.starter ? 'starter' : 'two-bot', {
      returnTo: '/setup/doctor',
      cancelTo: '/setup/project',
      done: '/setup/doctor',
    }),
  );
}

/**
 * The add-a-project form, shared by the wizard's project step and the zones page's `/zones/new`:
 * detect, review, create through `POST /api/control/zones`. A guarded add goes to the confirmation
 * page (back to `returnTo`, or `cancelTo`); an id with history shows what Resume brings back.
 */
export function projectBody(
  identity: 'two-bot' | 'starter',
  opts: { returnTo: string; cancelTo: string; done: string },
): string {
  const presets = PRESETS.map((p) => `<option value="${p}">${p}</option>`).join('');
  return `<h3>Add a project</h3>
<p>Name the GitHub repository. Jumpmaster reads its default branch's root (nothing else, and writes nothing) to propose a stack and the checks to run, for you to review.</p>
<form id="detect"><p><label>Repository <input name="repo" placeholder="owner/name" pattern="[A-Za-z0-9\\-]+/[A-Za-z0-9._\\-]+" required></label> <button>Detect</button> <span id="detect-out" role="status"></span></p></form>
<form id="project" hidden>
<p id="found"></p>
<p><label>Zone id <input name="id" placeholder="from the repository name" pattern="[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?"></label> <small>lower case letters, digits and dashes; blank takes the repository's name</small></p>
<p><label>Stack <select name="preset">${presets}</select></label></p>
<p><small>For information: drops in this project are expected to reach <span id="hosts"></span>. Egress starts in <strong>monitor</strong>: nothing is blocked, and the doctor shows what drops reached before you enforce a list.</small></p>
<h4>Checks (gates) every change must pass</h4><div id="gates"></div><p><button type="button" id="add-gate">Add a check</button></p>
<p>Accounts: <label><input type="radio" name="identity" value="two-bot"${identity === 'two-bot' ? ' checked' : ''}> two bots (author and reviewer)</label> <label><input type="radio" name="identity" value="starter"${identity === 'starter' ? ' checked' : ''}> starter (one account)</label></p>
<p><label><input type="checkbox" name="authorMayBeAdmin" value="1"> The author token belongs to the repository's owner (a personal repository)</label></p>
<p><button>Create the project</button> <span id="project-out" role="status"></span></p></form>
<div id="guidance-box" hidden><h4>On GitHub: the ruleset and the code owners</h4>
<p>Jumpmaster merges only under a branch ruleset, and the protected paths need a person's review. Both files are made from what was detected; nothing is written to GitHub.</p>
<p><label>Your GitHub login (a code owner) <input id="codeowners-reviewer" placeholder="your-github-login" pattern="[A-Za-z0-9@,._ \\/\\-]+"></label> <button type="button" id="guidance-refresh">Show</button></p>
<div id="guidance"></div></div>
${COPY_SCRIPT}
<script>
const HOSTS = ${scriptJson(presetHosts())};
let found = null;
const gates = document.getElementById('gates');
function gateRow(g) {
  const p = document.createElement('p');
  // What the review does not show (a detected timeout) travels with the row.
  const { name: _n, run: _r, ...rest } = g; p.dataset.extra = JSON.stringify(rest);
  const name = document.createElement('input'); name.name = 'gate-name'; name.value = g.name || ''; name.placeholder = 'name';
  const run = document.createElement('input'); run.name = 'gate-run'; run.value = g.run || ''; run.size = 50; run.placeholder = 'command';
  p.append(name, ' ', run); gates.append(p);
}
function showHosts() {
  const p = document.querySelector('select[name=preset]').value;
  document.getElementById('hosts').textContent = (HOSTS[p] || []).join(', ');
}
document.querySelector('select[name=preset]').addEventListener('change', showHosts);
document.getElementById('add-gate').addEventListener('click', () => gateRow({}));
document.getElementById('detect').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('detect-out'); out.textContent = 'Reading the repository…';
  const repo = e.target.repo.value.trim();
  const r = await jmFetch('/api/control/detect', { repo });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    out.textContent = (j.error || ('Not read (' + r.status + ')')) + ' ';
    if (r.status === 409) { const a = document.createElement('a'); a.href = '/setup/forge'; a.textContent = 'Go to the GitHub step'; out.append(a); }
    return;
  }
  out.textContent = '';
  found = { repo, ...j };
  document.getElementById('found').textContent = repo + ': ' + j.visibility + ', default branch ' + j.defaultBranch + (j.evidence && j.evidence.length ? '; found ' + j.evidence.join(', ') : '') + (j.problems && j.problems.length ? '. Note: ' + j.problems.join('; ') : '');
  if (j.preset) document.querySelector('select[name=preset]').value = j.preset;
  document.querySelector('input[name=authorMayBeAdmin]').checked = !!j.admin;
  gates.textContent = ''; (j.gates && j.gates.length ? j.gates : [{}]).forEach(gateRow);
  showHosts();
  document.getElementById('project').hidden = false;
  loadGuidance();
});
// The ruleset file and CODEOWNERS for the detected repository and the chosen accounts, rendered
// (and escaped) by the server.
async function loadGuidance() {
  if (!found) return;
  const identity = document.querySelector('input[name=identity]:checked').value;
  const reviewer = document.getElementById('codeowners-reviewer').value.trim();
  const q = new URLSearchParams({ repo: found.repo, identity, reviewer });
  const r = await fetch('/setup/project/github?' + q.toString());
  document.getElementById('guidance').innerHTML = await r.text();
  document.getElementById('guidance-box').hidden = false;
}
document.getElementById('guidance-refresh').addEventListener('click', loadGuidance);
for (const radio of document.querySelectorAll('input[name=identity]')) radio.addEventListener('change', loadGuidance);
document.getElementById('project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target; const out = document.getElementById('project-out');
  const rows = [...gates.querySelectorAll('p')];
  const names = rows.map((p) => p.querySelector('input[name=gate-name]').value.trim());
  const runs = rows.map((p) => p.querySelector('input[name=gate-run]').value.trim());
  const extras = rows.map((p) => JSON.parse(p.dataset.extra || '{}'));
  const zone = {
    repo: found.repo,
    preset: form.preset.value,
    gates: names.map((name, i) => ({ ...extras[i], name, run: runs[i] })).filter((g) => g.name && g.run),
    identity: form.querySelector('input[name=identity]:checked').value,
    egress: { mode: 'monitor' },
  };
  if (form.authorMayBeAdmin.checked) zone.authorMayBeAdmin = true;
  if (found.visibility === 'private') zone.reviewReadToken = true;
  if (form.id.value.trim()) zone.id = form.id.value.trim();
  if (zone.gates.length === 0) { out.textContent = 'Add at least one check.'; return; }
  await createZone(zone, false, out);
});
async function createZone(zone, resume, out) {
  const r = await jmFetch('/api/control/zones', { zone, returnTo: ${scriptJson(opts.returnTo)}, cancelTo: ${scriptJson(opts.cancelTo)}, ...(resume ? { resume: true } : {}) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { location.href = ${scriptJson(opts.done)}; return; }
  // A guarded add (every new project, from a browser): the confirmation page, then on.
  if (r.status === 409 && j.needsConfirmation) { location.href = j.confirm; return; }
  out.textContent = j.error || (j.issues || []).map((i) => (i.path ? i.path + ': ' : '') + i.message).join('; ') || ('Refused (' + r.status + ')');
  // An id with history: what Resume brings back, and the button to bring it back (paused).
  if (j.history) {
    const h = j.history;
    const p = document.createElement('p');
    p.textContent = ' Resume brings back its history (paused): ' + h.workItems + ' issues, ' + h.drops + ' drops, ' + h.outbox + ' GitHub writes, ' + h.crewIssues + ' crew issues, ' + h.goals + ' goals. ';
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Resume ' + (zone.id || 'it');
    b.addEventListener('click', () => createZone(zone, true, out));
    p.append(b); out.append(p);
  }
}
</script>`;
}

function doctorPage(db: Db): string {
  const run = latestDoctorRun(db);
  const order = { fail: 0, warn: 1, skip: 2, pass: 3 } as const;
  const checks = run ? [...run.checks].sort((a, b) => order[a.status] - order[b.status]) : [];
  const rows = checks
    .map(
      (c) =>
        `<li class="${c.status}"><strong>${c.status.toUpperCase()}</strong> ${escapeHtml(c.zoneId ?? '')} <code>${escapeHtml(c.id)}</code>: ${escapeHtml(c.summary)}${c.status !== 'pass' && c.fix ? `<br><small>Fix: ${escapeHtml(c.fix)}</small>` : ''}${c.status !== 'pass' && c.doc ? ` <a href="${escapeHtml(c.doc)}" rel="noreferrer">how</a>` : ''}</li>`,
    )
    .join('');
  const fails = checks.filter((c) => c.status === 'fail').length;
  return frame(
    'doctor',
    `<h3>Check everything</h3><p>The doctor reads your setup (it never changes anything) and says what is missing, with the fix for each.</p>
<p><button id="run">Run the doctor</button> <span id="run-out" role="status"></span></p>
${run ? `<p>Run ${run.id} (${escapeHtml(run.finishedAt ?? 'unfinished')}): ${fails ? `${fails} to fix` : 'nothing to fix'}.</p><ul>${rows}</ul>` : ''}
<form method="post" action="/setup/dismiss"><button>Go to the factory floor</button></form>
<script>
document.getElementById('run').addEventListener('click', async () => {
  const out = document.getElementById('run-out'); out.textContent = 'Running…';
  const r = await jmFetch('/api/control/doctor', {});
  if (r.ok) location.reload(); else out.textContent = 'The doctor did not run (' + r.status + ').';
});
</script>`,
  );
}

const REPO_PARAM = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const ForgeQuery = z.object({
  repo: z.string().max(200).optional(),
  paidPlan: z.enum(['', 'yes', 'no']).optional(),
});
const ProjectGuideQuery = z.object({
  repo: z.string().max(200).regex(REPO_PARAM),
  identity: z.enum(['two-bot', 'starter']),
  reviewer: z.string().max(400).optional(),
});

const AdvanceBody = z.object({
  from: z.enum(STEPS),
  starter: z.string().max(1).optional(),
  how: z.string().max(20).optional(),
});

const html = (req: FastifyRequest, reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(withCsrf(req, body));

export function registerSetupPages(
  app: FastifyInstance,
  deps: {
    db: Db;
    store: ConfigStore;
    now(): Date;
    /** The forge the GitHub guidance reads through (tests); default GitHub. */
    guidanceForge?: (repo: string, token: string) => GuidanceForge;
  },
): void {
  const { db, store, now } = deps;
  const forgeOf = deps.guidanceForge ?? githubGuidanceForge;
  const sudoOf = (req: FastifyRequest) => req.principal?.sudo === true;

  // Resumes at the first step the install still lacks, judged from its state: a deferred step
  // whose work is not done comes back first, and one done elsewhere (ctl, a file) is passed.
  app.get('/setup/next', async (req, reply) => {
    const config = req.jmConfig ?? store.current();
    if (!wizardActive(db, config)) return reply.redirect('/', 302);
    return reply.redirect(`/setup/${firstUnfinished(store, db)}`, 302);
  });

  // A GET never moves the progress: only Continue and Do this later do (and a page may be
  // prefetched). Landing on a step through a link is just a visit.
  app.get('/setup/claude', async (req, reply) => html(req, reply, claudePage(store, sudoOf(req))));
  // A named repository: the recommendation and the token links, read from GitHub (GET only).
  app.get('/setup/forge', async (req, reply) => {
    const guide = await forgeGuideFor(
      store,
      req.jmConfig ?? store.current(),
      req.query,
      forgeOf,
      now,
    );
    return html(req, reply, forgePage(store, sudoOf(req), getWizard(db), guide));
  });

  // The project step's GitHub files for the repository it detected: an HTML fragment, escaped here.
  app.get('/setup/project/github', async (req, reply) => {
    const q = ProjectGuideQuery.safeParse(req.query ?? {});
    const reviewers = q.success ? reviewersOf(q.data.reviewer) : null;
    const frag = (status: number, body: string) =>
      reply.code(status).type('text/html; charset=utf-8').send(body);
    if (!q.success || reviewers === null)
      return frag(
        400,
        '<p class="warn">Name the repository as owner/name, and code owners as GitHub logins.</p>',
      );
    let r: Awaited<ReturnType<typeof recommendFor>>;
    try {
      r = await recommendFor(
        store,
        req.jmConfig ?? store.current(),
        { repo: q.data.repo, identity: q.data.identity, reviewers },
        forgeOf,
        now,
      );
    } catch (e) {
      return frag(400, `<p class="warn">${escapeHtml((e as Error).message)}</p>`);
    }
    if (!r.ok) return frag(r.status, `<p class="warn">${escapeHtml(r.error)}</p>`);
    const g = r.answer.guidance;
    if (!g)
      return frag(
        200,
        '<p>Set the author token in the <a href="/setup/forge">GitHub step</a> to get the ruleset file and CODEOWNERS for this repository.</p>',
      );
    return frag(
      200,
      `${rulesetSection(g.ruleset, g.rulesUrl, q.data.identity)}${codeownersSection(g.codeowners, null, q.data.identity)}`,
    );
  });
  app.get('/setup/stick', async (req, reply) => html(req, reply, stickPage(db)));
  app.get('/setup/project', async (req, reply) =>
    html(req, reply, projectPage(store, getWizard(db))),
  );
  app.get('/setup/doctor', async (req, reply) => html(req, reply, doctorPage(db)));

  // "Continue" and "Do this later" both move on: the step is optional either way.
  app.post('/setup/advance', async (req, reply) => {
    const body = AdvanceBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).type('text/plain').send('which step?');
    const { from, starter } = body.data;
    const i = STEPS.indexOf(from);
    const next = STEPS[i + 1] ?? 'done';
    reach(db, next, now(), from === 'forge' ? { starter: starter === '1' } : {});
    return reply.redirect(next === 'done' ? '/' : `/setup/${next}`, 303);
  });

  app.post('/setup/dismiss', async (_req, reply) => {
    setWizard(db, { ...getWizard(db), dismissed: true }, now());
    return reply.redirect('/', 303);
  });
}
