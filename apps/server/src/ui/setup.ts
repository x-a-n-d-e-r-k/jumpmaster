import { PRESETS } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
 * and the route's message; the value never leaves the field except in the request body.
 */
const SAVE_CREDENTIALS = `<script>
async function jmSaveCredentials(form, out) {
  out.textContent = '';
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
  return true;
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
  if (!(await jmSaveCredentials(form, out))) return;
  const plan = form.querySelector('select[name=plan]');
  if (plan && plan.value !== ${scriptJson(config.claude.plan)}) {
    const r = await jmFetch('/api/control/config', { patch: { claude: { plan: plan.value } }, expectRevision: ${store.revision()} }, 'PATCH');
    if (!r.ok) { out.textContent = 'The plan was not saved (' + r.status + ').'; return; }
  }
  document.getElementById('advance').querySelector('button[value=continue]').click();
});
</script>`,
  );
}

function forgePage(store: ConfigStore, sudo: boolean, wizard: Wizard): string {
  const r = store.resolved();
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
<p>Jumpmaster works on GitHub as an <strong>author</strong> account (opens and merges the agents' pull requests) and, in two-bot mode, a separate <strong>reviewer</strong> account (approves them). Use fine-grained tokens limited to your repositories. Each token is tested with GitHub before it is saved, and never shown back.</p>
<h4>Author</h4>${credentialLine('githubAuthorToken', r.githubAuthorToken)}
<h4>Reviewer</h4>${credentialLine('githubReviewerToken', r.githubReviewerToken)}
<h4>Read token</h4>${credentialLine('githubReadToken', r.githubReadToken)}
<form id="forge">${fields}
<p><label><input type="checkbox" name="starter" value="1"${wizard.starter ? ' checked' : ''}> Starter mode: one GitHub account, no reviewer</label></p>
<p class="warn" id="starter-warning"><strong>What starter mode costs:</strong> ${escapeHtml(STARTER_WARNING)}</p>
${fields ? sudoField(sudo) : ''}<p><button>Save</button> <span id="forge-out" role="status"></span></p></form>
${SAVE_CREDENTIALS}
<script>
document.getElementById('forge').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target; const out = document.getElementById('forge-out');
  if (!(await jmSaveCredentials(form, out))) return;
  const adv = document.getElementById('advance');
  adv.querySelector('input[name=starter]').value = form.querySelector('input[name=starter]').checked ? '1' : '';
  adv.querySelector('button[value=continue]').click();
});
</script>`,
    {
      advance: advanceForm(
        'forge',
        `<input type="hidden" name="starter" value="${wizard.starter ? '1' : ''}">`,
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
  const identity = wizard.starter ? 'starter' : 'two-bot';
  const presets = PRESETS.map((p) => `<option value="${p}">${p}</option>`).join('');
  return frame(
    'project',
    `<h3>Add a project</h3>
<p>Name the GitHub repository. Jumpmaster reads its default branch's root (nothing else, and writes nothing) to propose a stack and the checks to run, for you to review.</p>
<form id="detect"><p><label>Repository <input name="repo" placeholder="owner/name" pattern="[A-Za-z0-9-]+/[A-Za-z0-9._-]+" required></label> <button>Detect</button> <span id="detect-out" role="status"></span></p></form>
<form id="project" hidden>
<p id="found"></p>
<p><label>Stack <select name="preset">${presets}</select></label></p>
<p><small>For information: drops in this project are expected to reach <span id="hosts"></span>. Egress starts in <strong>monitor</strong>: nothing is blocked, and the doctor shows what drops reached before you enforce a list.</small></p>
<h4>Checks (gates) every change must pass</h4><div id="gates"></div><p><button type="button" id="add-gate">Add a check</button></p>
<p>Accounts: <label><input type="radio" name="identity" value="two-bot"${identity === 'two-bot' ? ' checked' : ''}> two bots (author and reviewer)</label> <label><input type="radio" name="identity" value="starter"${identity === 'starter' ? ' checked' : ''}> starter (one account)</label></p>
<p><label><input type="checkbox" name="authorMayBeAdmin" value="1"> The author token belongs to the repository's owner (a personal repository)</label></p>
<p><button>Create the project</button> <span id="project-out" role="status"></span></p></form>
<script>
const HOSTS = ${scriptJson(presetHosts())};
let found = null;
const gates = document.getElementById('gates');
function gateRow(g) {
  const p = document.createElement('p');
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
  if (!r.ok) { out.textContent = j.error || ('Not read (' + r.status + ')'); return; }
  out.textContent = '';
  found = { repo, ...j };
  document.getElementById('found').textContent = repo + ': ' + j.visibility + ', default branch ' + j.defaultBranch + (j.evidence && j.evidence.length ? '; found ' + j.evidence.join(', ') : '') + (j.problems && j.problems.length ? '. Note: ' + j.problems.join('; ') : '');
  if (j.preset) document.querySelector('select[name=preset]').value = j.preset;
  document.querySelector('input[name=authorMayBeAdmin]').checked = !!j.admin;
  gates.textContent = ''; (j.gates && j.gates.length ? j.gates : [{}]).forEach(gateRow);
  showHosts();
  document.getElementById('project').hidden = false;
});
document.getElementById('project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target; const out = document.getElementById('project-out');
  const names = [...form.querySelectorAll('input[name=gate-name]')].map((i) => i.value.trim());
  const runs = [...form.querySelectorAll('input[name=gate-run]')].map((i) => i.value.trim());
  const zone = {
    repo: found.repo,
    preset: form.preset.value,
    gates: names.map((name, i) => ({ name, run: runs[i] })).filter((g) => g.name && g.run),
    identity: form.querySelector('input[name=identity]:checked').value,
    egress: { mode: 'monitor' },
  };
  if (form.authorMayBeAdmin.checked) zone.authorMayBeAdmin = true;
  if (found.visibility === 'private') zone.reviewReadToken = true;
  const r = await jmFetch('/api/control/zones', { zone, returnTo: '/setup/doctor' });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { location.href = '/setup/doctor'; return; }
  // A guarded add (every new project, from a browser): the confirmation page, then the doctor.
  if (r.status === 409 && j.needsConfirmation) { location.href = j.confirm; return; }
  out.textContent = j.error || (j.issues || []).map((i) => (i.path ? i.path + ': ' : '') + i.message).join('; ') || ('Refused (' + r.status + ')');
});
</script>`,
  );
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

const AdvanceBody = z.object({
  from: z.enum(STEPS),
  starter: z.string().max(1).optional(),
  how: z.string().max(20).optional(),
});

const html = (req: FastifyRequest, reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(withCsrf(req, body));

export function registerSetupPages(
  app: FastifyInstance,
  deps: { db: Db; store: ConfigStore; now(): Date },
): void {
  const { db, store, now } = deps;
  const sudoOf = (req: FastifyRequest) => req.principal?.sudo === true;

  app.get('/setup/next', async (req, reply) => {
    const config = req.jmConfig ?? store.current();
    const w = getWizard(db);
    if (!wizardActive(db, config) || w.step === 'done') return reply.redirect('/', 302);
    return reply.redirect(`/setup/${w.step}`, 302);
  });

  // A GET never moves the progress: only Continue and Do this later do (and a page may be
  // prefetched). Landing on a step through a link is just a visit.
  app.get('/setup/claude', async (req, reply) => html(req, reply, claudePage(store, sudoOf(req))));
  app.get('/setup/forge', async (req, reply) =>
    html(req, reply, forgePage(store, sudoOf(req), getWizard(db))),
  );
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
