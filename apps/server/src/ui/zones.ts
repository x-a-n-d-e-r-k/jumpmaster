import { PRESETS } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withCsrf } from '../auth/guard.js';
import { listBriefings } from '../briefings.js';
import type { ConfigStore } from '../config/store.js';
import { type Config, type DropZoneConfig, STARTER_WARNING } from '../config.js';
import type { Db } from '../db/open.js';
import { getZoneMode, type ZoneWaits, zoneStopping, zoneWaits } from '../db/repo.js';
import { type DoctorCheck, egressSeen } from '../doctor/checks.js';
import { latestDoctorRun } from '../doctor/run.js';
import { getGoals, objectivesDone } from '../goals.js';
import { BASE_EGRESS } from '../payloads.js';
import { PRESET_EGRESS } from '../presets.js';
import { FORM_SCRIPT, zoneToForm } from '../zones/form.js';
import { renderFlags } from './flags.js';
import { type FloorInputs, floorCounts, listHref, stateSentence } from './floor.js';
import { COPY_SCRIPT, githubReviewerForm } from './github.js';
import {
  ACTIVITY_DROPS_HREF,
  githubSetupHref,
  SYSTEM_CREDENTIALS_HREF,
  SYSTEM_HREF,
} from './links.js';
import {
  badge,
  breadcrumb,
  type Crumb,
  dismissAllForm,
  escapeHtml,
  MODE_LABELS,
  PROJECTS_HREF,
  type ProjectTab,
  page,
  projectHeader,
  projectHref,
  workItemHref,
  zoneHref,
} from './pages.js';
import { getWizard, projectBody } from './setup.js';
import { relativeTime } from './time.js';
import { type ZoneRef, zoneName, zoneNameText } from './zone-name.js';

/**
 * The zones page (§10.3): every zone with its mode, egress, identity, last drop, doctor fails and
 * credential problem; a Setup page per zone, one form whose sections share one save bar that
 * posts one merge patch of every changed field (`PATCH /api/control/config`, zones matched by id)
 * conditional on the revision drawn, and a Danger zone; and the add page. Every write goes through the store's apply, so a change from a browser that
 * weakens a guard lands on the confirmation page, and one a session may never make is answered
 * with where to make it. In file mode every section is read-only under the adopt banner. All text
 * from the config, the forge and the drops is escaped; the page holds no secret.
 */

/**
 * The project header and tab bar (#616) for a project page outside the tabs (GitHub, the GOAL.md
 * stub, New issue, advanced settings): the zone's mode and open briefings from the database.
 */
export function projectHeaderFor(
  db: Db,
  zone: DropZoneConfig,
  zones: readonly ZoneRef[],
  current?: ProjectTab,
  trail: readonly Crumb[] = [],
): string {
  return projectHeader({
    zone,
    zones,
    mode: getZoneMode(db, zone.id, zone.mode),
    openBriefings: listBriefings(db, { zoneId: zone.id, state: 'open' }).length,
    current,
    trail,
  });
}

/** Add a project's breadcrumb (#628). */
const NEW_PROJECT_CRUMBS = breadcrumb([
  { label: 'Projects', href: PROJECTS_HREF },
  { label: 'Add a project' },
]);

const EGRESS_WINDOW_MS = 14 * 86_400_000;
/** How many drop links one observed host lists; the rest are a link to the zone's drops of every kind. */
const OBSERVED_DROP_LINKS = 20;
const COUNT_FORMAT = new Intl.NumberFormat('en-US');
/** A count with en-US thousands separators (`19,510`), whatever the server's locale. */
const formatCount = (n: number): string => COUNT_FORMAT.format(n);
/**
 * The Drops cell of the observed table: the count of distinct drops, then a disclosure linking the
 * newest {@link OBSERVED_DROP_LINKS} (`drops` is oldest first, as `egressSeen` supplies it) and
 * "and M more" to the zone's drops list when there are more. The list shows every kind, since the
 * hosts come from drops of every kind (doctor and crew drops included).
 */
function dropsCell(zoneId: string, drops: string[]): string {
  const newest = drops.slice(-OBSERVED_DROP_LINKS).reverse();
  const rest = drops.length - newest.length;
  const links = newest
    .map((d) => `<a href="/drops/${encodeURIComponent(d)}">${escapeHtml(d.slice(0, 8))}</a>`)
    .join(' ');
  const more =
    rest > 0
      ? ` <a href="${escapeHtml(listHref(ACTIVITY_DROPS_HREF, zoneId))}">and ${formatCount(rest)} more</a>`
      : '';
  return `${formatCount(drops.length)} <details><summary>show ${formatCount(drops.length)}</summary>${links}${more}</details>`;
}

const scriptJson = (v: unknown): string =>
  JSON.stringify(v)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

const html = (req: FastifyRequest, reply: FastifyReply, body: string, code = 200) =>
  reply.code(code).type('text/html; charset=utf-8').send(withCsrf(req, body));

const ADOPT_BANNER = `<div class="warn"><p><strong>Your config file holds these zones.</strong> In file mode the file is the config: edit it and run <code>jumpmaster ctl config reload</code>. To change zones here instead, adopt it into the database (<code>jumpmaster ctl config mode file</code> goes back).</p><p><button id="adopt">Adopt the config file</button> <span id="adopt-out" role="status"></span></p></div>
<script>
document.getElementById('adopt').addEventListener('click', async () => {
  const r = await jmFetch('/api/control/config/adopt', {});
  if (r.ok) location.reload(); else document.getElementById('adopt-out').textContent = 'Not adopted (' + r.status + ').';
});
</script>`;

/** `n thing`, `n things`. */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a stopping zone still waits for, by count. */
const waitsText = (w: ZoneWaits): string =>
  `stopping: waiting for ${count(w.drops, 'running drop', 'running drops')}, ${count(w.pushes, 'pending push', 'pending pushes')}, ${count(w.outbox, 'outbox write', 'outbox writes')}`;

/** The zone's stopping line, or undefined when it is not being stopped. */
const stoppingLine = (db: Db, id: string): string | undefined =>
  zoneStopping(db, id) ? waitsText(zoneWaits(db, id)) : undefined;

/**
 * Stop managing: one confirmed click. The confirmation names the repository and what happens;
 * the click is the removal's DELETE, which sets observe and removes the zone once drained.
 */
const stopButton = (id: string, name: string): string => {
  const confirm = `Stop managing ${name}? Jumpmaster takes no new work for it and sets it to observe, then removes it as soon as its running drops, pending pushes and outbox writes have finished. Open pull requests are left as they are. Its history is kept, for a later Resume.`;
  return `<button class="stop" data-zone="${escapeHtml(id)}" data-name="${escapeHtml(name)}" data-confirm="${escapeHtml(confirm)}">Stop managing</button> `;
};

/** The Stop managing buttons' handler; `#stop-out` holds a refusal. */
const STOP_SCRIPT = `for (const b of document.querySelectorAll('button.stop')) b.addEventListener('click', async () => {
  if (!confirm(b.dataset.confirm)) return;
  const r = await jmFetch('/api/control/zones/' + encodeURIComponent(b.dataset.zone), {}, 'DELETE');
  const j = await r.json().catch(() => ({}));
  // 200: removed now; 202: stopping, removed by the server once drained.
  if (r.status === 200) { location.href = ${scriptJson(PROJECTS_HREF)}; return; }
  if (r.status === 202) { location.reload(); return; }
  document.getElementById('stop-out').textContent = b.dataset.name + ': ' + (j.error || (j.issues || []).map((i) => i.message).join('; ') || ('refused (' + r.status + ')'));
});`;

const FORBIDDEN_NOTE = 'set with <code>jumpmaster ctl</code> or in the config file';

/** The list page. */
function listPage(store: ConfigStore, db: Db): string {
  const config = store.current();
  const fileMode = store.mode() === 'file';
  const problems = store.problems();
  const run = latestDoctorRun(db);
  const rows = config.dropZones
    .map((z) => {
      const mode = getZoneMode(db, z.id, z.mode);
      const last = db
        .prepare(
          'SELECT id, role, state FROM drops WHERE drop_zone_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        )
        .get(z.id) as { id: string; role: string; state: string } | undefined;
      const fails = run
        ? run.checks.filter((c) => c.zoneId === z.id && c.status === 'fail').length
        : undefined;
      const mine = problems.filter((p) => p.zoneId === z.id);
      const stopping = stoppingLine(db, z.id);
      const name = zoneNameText(z, config.dropZones);
      const problem = mine.length
        ? `<span class="problem">${escapeHtml(mine[0]?.message)}</span> <a href="${SYSTEM_CREDENTIALS_HREF}">Fix in System, Credentials</a>`
        : '-';
      // Only the moves that apply from the zone's current mode.
      const button = (m: string, label: string) =>
        mode === m
          ? ''
          : `<button class="mode" data-zone="${escapeHtml(z.id)}" data-name="${escapeHtml(name)}" data-mode="${m}">${label}</button> `;
      return `<tr><td><a href="${zoneHref(z.id)}">${zoneName(z, config.dropZones)}</a></td><td>${escapeHtml(MODE_LABELS[mode] ?? mode)}${stopping ? `<br><strong>${escapeHtml(stopping)}</strong>` : ''}</td><td>${escapeHtml(z.preset ?? z.image)}</td><td>${escapeHtml(z.egress?.mode ?? 'off')}</td><td>${escapeHtml(z.identity)}</td><td>${last ? `<a href="/drops/${encodeURIComponent(last.id)}">${escapeHtml(last.role)}, ${escapeHtml(last.state)}</a>` : '-'}</td><td>${fails === undefined ? '-' : `<a href="${SYSTEM_HREF}">${fails}</a>`}</td><td>${problem}</td><td>${button('paused', 'Pause')}${button('active', 'Resume')}${button('observe', 'Observe')}${fileMode || stopping ? '' : stopButton(z.id, name)}<a href="${escapeHtml(githubSetupHref(z.id))}">GitHub</a></td></tr>`;
    })
    .join('');
  return page(
    `<h2>Projects</h2><p>A project is one repository Jumpmaster works on.</p>
${fileMode ? ADOPT_BANNER : `<p><a href="${PROJECTS_HREF}/new">Add a project</a></p>`}
<table><tr><th>Project</th><th>Mode</th><th>Stack</th><th>Egress</th><th>Accounts</th><th>Last drop</th><th>Doctor fails</th><th>Needs</th><th></th></tr>${rows || '<tr><td colspan="9">No zones yet.</td></tr>'}</table>
<p id="mode-out" role="status"></p><p id="stop-out" role="status"></p>
<script>
${STOP_SCRIPT}
for (const b of document.querySelectorAll('button.mode')) b.addEventListener('click', async () => {
  const r = await jmFetch('/api/control/zones/' + encodeURIComponent(b.dataset.zone), { mode: b.dataset.mode });
  if (r.ok) { location.reload(); return; }
  const j = await r.json().catch(() => ({}));
  document.getElementById('mode-out').textContent = b.dataset.name + ': ' + (j.error || ('refused (' + r.status + ')'));
});
</script>`,
  );
}

/** One field with its label, and the place its schema issues are written. */
const field = (name: string, label: string, control: string, note = ''): string =>
  `<p><label>${label} ${control}</label>${note ? ` <small>${note}</small>` : ''} <span class="issue" data-issues="${name}"></span></p>`;

const input = (fields: Record<string, string | string[]>, name: string, size = 30) =>
  `<input name="${name}" value="${escapeHtml(fields[name] ?? '')}" size="${size}">`;

const textarea = (fields: Record<string, string | string[]>, name: string, rows = 4) =>
  `<textarea name="${name}" rows="${rows}" cols="60">${escapeHtml(fields[name] ?? '')}</textarea>`;

const checkbox = (fields: Record<string, string | string[]>, name: string) =>
  `<input type="hidden" name="bool" value="${name}"><input type="checkbox" name="${name}" value="1"${fields[name] === '1' ? ' checked' : ''}>`;

/** STARTER_WARNING without its own "starter mode: " lead, which the page prints in bold. */
const STARTER_WARNING_BODY = STARTER_WARNING.replace(/^starter mode:\s*/i, '');

/**
 * Shows the Merging section's starter-mode warning only while the Accounts select reads
 * `starter` (#494), in the page, with no round trip.
 */
const IDENTITY_SCRIPT = `<script id="identity-script">
(() => {
  const select = document.querySelector('#identity select[name=identity]');
  const warning = document.getElementById('starter-warning');
  if (!select || !warning) return;
  const sync = () => { warning.hidden = select.value !== 'starter'; };
  select.addEventListener('change', sync);
  sync();
})();
</script>`;

/** The Setup page's sections, in order: each one's anchor and nav label. */
const SETUP_SECTIONS = [
  ['project', 'Repository &amp; labels'],
  ['github', 'GitHub'],
  ['stack', 'Stack &amp; checks'],
  ['egress', 'Egress'],
  ['merging', 'Merging'],
  ['advanced', 'Advanced'],
  ['danger', 'Danger zone'],
] as const;

const SETUP_STYLE = `<style>.setup-layout{display:grid;grid-template-columns:13rem minmax(0,1fr);gap:2rem;align-items:start}.setup-nav{position:sticky;top:4.5rem}.setup-nav ul{list-style:none;padding:0;margin:0}.setup-nav a{display:block;padding:.25rem .5rem}.setup-jump{display:none}.setup-section{scroll-margin-top:4.5rem}#setup-form>fieldset{border:0;padding:0;margin:0;min-width:0}.save-bar{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;padding:.75rem 0;background:var(--bg-white-0);border-top:1px solid var(--stroke-soft-200)}.save-bar #save-out{flex:1}.danger-zone{margin-top:2rem;padding:0 1rem 1rem;border-radius:12px;box-shadow:inset 0 0 0 1px var(--error-base)}@media (max-width:899.98px){.setup-layout{display:block}.setup-nav{display:none}.setup-jump{display:block;position:sticky;top:4.5rem;z-index:1;margin:0 0 1rem}}</style>`;

/** A section of the Setup form: its anchor, its title and its fields. */
const setupSection = (id: string, title: string, body: string) =>
  `<section id="${id}" class="setup-section"><h3>${title}</h3>${body}</section>`;

/** Jumps to a section from the narrow screen's select. */
const JUMP_SCRIPT = `<script>
document.getElementById('setup-jump').addEventListener('change', (e) => { location.hash = e.target.value; });
</script>`;

/**
 * The Setup form's script (#617): one patch for every changed field across the sections, the
 * merge-patch difference between the fields as drawn and as they are now (so a section that was
 * not touched sends nothing); the save bar's count, Discard and the leave-page question; the
 * schema's issues beside their fields; and the Danger zone's typed-name guard. A guarded change
 * goes to the confirmation page with the form untouched.
 */
function setupScript(o: {
  revision: number;
  index: number;
  id: string;
  repo: string;
  base: string;
}): string {
  return `<script id="setup-script">
${FORM_SCRIPT}
(() => {
const REVISION = ${o.revision};
const ZONE_INDEX = ${o.index};
const ZONE_ID = ${scriptJson(o.id)};
const REPO = ${scriptJson(o.repo)};
const BASE = ${scriptJson(o.base)};
const form = document.getElementById('setup-form');
const countEl = document.getElementById('save-count');
const out = document.getElementById('save-out');
const saveBtn = document.getElementById('save');
const discardBtn = document.getElementById('discard');
function fieldsOf(form) {
  const res = {};
  const add = (k, v) => { if (k in res) res[k] = [].concat(res[k], v); else res[k] = v; };
  for (const el of form.elements) {
    if (!el.name || el.name === 'adopt' || el.type === 'button' || el.type === 'submit') continue;
    if (el.type === 'checkbox') { if (el.checked) add(el.name, el.value); continue; }
    add(el.name, el.value);
  }
  for (const k of ['gate.name', 'gate.run', 'gate.timeout', 'bool']) if (k in res && !Array.isArray(res[k])) res[k] = [res[k]];
  return res;
}
const snap = () => [...form.elements].map((el) => ({ el, value: el.value, checked: el.checked }));
let original = fieldsOf(form);
let drawn = snap();
let leaving = false;
// The fields that differ from the drawn ones; the gate rows count as one field, Checks.
function changed() {
  const now = fieldsOf(form);
  const keys = new Set();
  for (const k of new Set([...Object.keys(original), ...Object.keys(now)])) {
    if (k === 'id' || k === 'bool' || k.startsWith('gate.')) continue;
    if (JSON.stringify(original[k]) !== JSON.stringify(now[k])) keys.add(k);
  }
  if (JSON.stringify(formToZone(original).gates) !== JSON.stringify(formToZone(now).gates)) keys.add('gates');
  return [...keys];
}
function refresh() {
  const n = changed().length;
  countEl.textContent = n + (n === 1 ? ' unsaved change' : ' unsaved changes');
  saveBtn.disabled = n === 0;
  discardBtn.disabled = n === 0;
}
function clearIssues() {
  for (const s of document.querySelectorAll('.issue')) s.textContent = '';
  out.textContent = '';
}
function markClean() {
  original = fieldsOf(form);
  drawn = snap();
  refresh();
}
function syncStarter() {
  const select = form.querySelector('select[name=identity]');
  const warning = document.getElementById('starter-warning');
  if (select && warning) warning.hidden = select.value !== 'starter';
}
function discard() {
  const kept = new Set(drawn.map((d) => d.el));
  for (const el of [...form.elements]) if (!kept.has(el)) { const row = el.closest && el.closest('p.gate'); if (row) row.remove(); }
  for (const d of drawn) { d.el.value = d.value; d.el.checked = d.checked; }
  clearIssues();
  syncStarter();
  refresh();
}
function showIssues(issues) {
  let placed = 0;
  let rest = '';
  for (const i of issues) {
    const f = issueField(i.path, ZONE_INDEX);
    const at = f && document.querySelector('[data-issues="' + f + '"]');
    if (at) { at.textContent = i.message; placed++; } else rest += (i.path ? i.path + ': ' : '') + i.message + ' ';
  }
  out.textContent = (placed ? placed + (placed === 1 ? ' field error' : ' field errors') + (rest ? '. ' : '') : '') + rest;
}
async function save() {
  clearIssues();
  const patch = toMergePatch(formToZone(original), formToZone(fieldsOf(form)));
  if (Object.keys(patch).filter((k) => k !== 'id').length === 0) { markClean(); return; }
  saveBtn.disabled = true;
  const r = await jmFetch('/api/control/config', { patch: { dropZones: [patch] }, expectRevision: REVISION, returnTo: BASE, cancelTo: BASE }, 'PATCH');
  const j = await r.json().catch(() => ({}));
  if (r.ok) { markClean(); leaving = true; location.reload(); return; }
  refresh();
  // A change that weakens a guard: the confirmation page, then back here. The form is left as is.
  if (r.status === 409 && j.needsConfirmation) { leaving = true; location.href = j.confirm; return; }
  if (r.status === 409 && j.conflict) { out.textContent = 'The config changed since this page was drawn: reload it and make the change again.'; return; }
  if (r.status === 403 && j.sessionForbidden) { out.innerHTML = 'Not from the browser: ${FORBIDDEN_NOTE.replaceAll("'", "\\'")}. '; const c = document.createElement('code'); c.textContent = j.sessionForbidden.join(', '); out.append(c); return; }
  if (j.issues) { showIssues(j.issues); return; }
  out.textContent = j.error || ('Refused (' + r.status + ')');
}
form.addEventListener('input', refresh);
form.addEventListener('change', refresh);
form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
discardBtn.addEventListener('click', discard);
window.addEventListener('beforeunload', (e) => {
  if (leaving || changed().length === 0) return;
  e.preventDefault();
  e.returnValue = '';
});
const addGate = document.getElementById('add-gate');
if (addGate) addGate.addEventListener('click', () => {
  const p = document.createElement('p'); p.className = 'gate';
  for (const [name, size, ph] of [['gate.name', 20, 'name'], ['gate.run', 40, 'command'], ['gate.timeout', 4, 'min']]) {
    const i = document.createElement('input'); i.name = name; i.size = size; i.placeholder = ph; p.append(i, ' ');
  }
  document.getElementById('gate-rows').append(p);
  refresh();
});
const adopt = document.getElementById('adopt-ticked');
if (adopt) adopt.addEventListener('click', async () => {
  const hosts = [...document.querySelectorAll('input[name=adopt]:checked')].map((i) => i.value);
  const said = document.getElementById('adopt-out');
  if (hosts.length === 0) { said.textContent = 'Tick a host first.'; return; }
  const r = await jmFetch('/api/control/zones/' + encodeURIComponent(ZONE_ID) + '/egress/adopt', { hosts, returnTo: BASE + '#egress', cancelTo: BASE });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { location.reload(); return; }
  if (r.status === 409 && j.needsConfirmation) { location.href = j.confirm; return; }
  said.textContent = j.error || (j.issues || []).map((i) => i.message).join('; ') || ('Refused (' + r.status + ')');
});
// Danger zone: Stop managing waits for the repository's exact name.
const typed = document.getElementById('stop-confirm');
const stop = document.getElementById('stop-managing');
if (typed && stop) {
  const sync = () => { stop.disabled = typed.value !== REPO; };
  typed.addEventListener('input', sync);
  sync();
  stop.addEventListener('click', async () => {
    if (typed.value !== REPO) return;
    stop.disabled = true;
    const r = await jmFetch('/api/control/zones/' + encodeURIComponent(ZONE_ID), {}, 'DELETE');
    const j = await r.json().catch(() => ({}));
    // 200: removed now; 202: stopping, removed by the server once drained.
    if (r.status === 200) { location.href = ${scriptJson(PROJECTS_HREF)}; return; }
    if (r.status === 202) { location.reload(); return; }
    sync();
    document.getElementById('stop-out').textContent = REPO + ': ' + (j.error || (j.issues || []).map((i) => i.message).join('; ') || ('refused (' + r.status + ')'));
  });
}
refresh();
})();
</script>`;
}

/**
 * The Backlog section: open issues with no Jumpmaster label, loaded from the backlog route when the
 * page loads. "Work on it" queues one (the ready label, through the outbox). Shown in file mode
 * too: queueing is a forge write, not a config edit. Rows are built with `textContent`, so an
 * issue title is never read as HTML.
 */
function backlogSection(id: string, repo: string): string {
  return `<section id="backlog"><h3>Backlog</h3><p>Issues with no Jumpmaster label. Work on it puts the ready label on.</p><p id="backlog-out" role="status">Loading…</p><table><tbody id="backlog-rows"></tbody></table></section>
<script id="backlog-script">
(() => {
  const ZONE = ${scriptJson(id)};
  const REPO = ${scriptJson(repo)};
  const base = '/api/control/zones/'+encodeURIComponent(ZONE);
  const rows = document.getElementById('backlog-rows');
  const out = document.getElementById('backlog-out');
  const cell = (tr, text) => { const td = document.createElement('td'); td.textContent = text; tr.append(td); return td; };
  async function queue(b, n, status) {
    b.disabled = true;
    status.textContent = '';
    const r = await jmFetch(base+'/queue', { issue: n });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { b.remove(); status.textContent = 'Queued: the next pass picks it up'; return; }
    status.textContent = j.error || ('Refused ('+r.status+')');
  }
  function row(i) {
    const tr = document.createElement('tr');
    const num = document.createElement('td');
    const a = document.createElement('a');
    a.href = 'https://github.com/'+REPO+'/issues/'+i.number;
    a.textContent = '#'+i.number;
    num.append(a); tr.append(num);
    cell(tr, i.title);
    cell(tr, i.author);
    const act = document.createElement('td');
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    if (i.startable) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'queue'; b.dataset.issue = String(i.number);
      b.textContent = 'Work on it';
      b.addEventListener('click', () => queue(b, i.number, status));
      act.append(b, ' ');
    } else status.textContent = i.reason || 'Not startable';
    act.append(status); tr.append(act);
    return tr;
  }
  (async () => {
    const r = await fetch(base+'/backlog', { headers: { accept: 'application/json' } }).catch(() => undefined);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { out.textContent = j.error || ('The backlog could not be read'+(r ? ' ('+r.status+')' : '')); return; }
    const issues = j.issues || [];
    out.textContent = issues.length ? '' : 'Nothing in the backlog.';
    for (const i of issues) rows.append(row(i));
  })();
})();
</script>`;
}

/** How many work items the Overview's Recent work lists. */
const RECENT_WORK = 10;

/** Doctor statuses, worst first: the Overview's Health names the worst of a project's checks. */
const DOCTOR_WORST_FIRST = ['fail', 'warn', 'info', 'pass', 'skip'] as const;

type RecentItem = {
  id: number;
  dropZoneId: string;
  issueNumber: number;
  title: string;
  state: string;
  updatedAt: string;
};

/**
 * A project's Overview (#616): its state in its floor card's words, what needs you, its recent
 * work, its current objective and its health. Everything comes from the database and the config:
 * no forge call. Every value is escaped.
 */
function overviewPage(
  store: ConfigStore,
  db: Db,
  id: string,
  now: Date,
  floor: FloorInputs | undefined,
): string | undefined {
  const all = store.current().dropZones;
  const zone = all.find((z) => z.id === id);
  if (!zone) return undefined;
  const mode = getZoneMode(db, id, zone.mode);
  const briefings = listBriefings(db, { zoneId: id, state: 'open' });
  const run = latestDoctorRun(db);
  const checks = run ? run.checks.filter((c) => c.zoneId === id) : [];
  const failing = checks.filter((c) => c.status === 'fail');

  const card = floor ? floorCounts(floor, now).zones.find((z) => z.zoneId === id) : undefined;
  const state = `<section id="state"><h3>State</h3><p>${card ? stateSentence(card) : escapeHtml(MODE_LABELS[mode] ?? mode)}</p></section>`;

  const needs = [
    ...briefings.map(
      (b) =>
        `<li><a href="/briefings/${encodeURIComponent(String(b.id))}">${escapeHtml(b.decision)}</a></li>`,
    ),
    ...failing.map(
      (c) => `<li><a href="${SYSTEM_HREF}">${escapeHtml(c.id)}</a>: ${escapeHtml(c.summary)}</li>`,
    ),
  ];
  const needsYou = `<section id="needs-you"><h3>Needs you</h3>${
    needs.length ? `<ul>${needs.join('')}</ul>` : '<p class="empty">Nothing needs you.</p>'
  }${briefings.length > 0 ? dismissAllForm(id, briefings, all) : ''}</section>`;

  const recent = db
    .prepare(
      `SELECT id, drop_zone_id AS dropZoneId, issue_number AS issueNumber, title, state,
         updated_at AS updatedAt FROM work_items WHERE drop_zone_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(id, RECENT_WORK) as RecentItem[];
  const roles = db.prepare(
    'SELECT role FROM drops WHERE work_item_id = ? ORDER BY created_at, rowid',
  );
  const rows = recent
    .map((i) => {
      const chain = (roles.all(i.id) as { role: string }[]).map((r) => r.role).join(' → ');
      return `<li class="recent-item"><a href="${escapeHtml(workItemHref(i))}">#${escapeHtml(i.issueNumber)} ${escapeHtml(i.title)}</a> ${badge(i.state)} <span class="chain">${chain ? escapeHtml(chain) : 'no attempts yet'}</span> ${relativeTime(i.updatedAt, now)}</li>`;
    })
    .join('');
  const work = `<section id="recent-work"><h3>Recent work</h3>${
    rows ? `<ul>${rows}</ul>` : '<p class="empty">No work yet.</p>'
  }</section>`;

  const goals = getGoals(db, id);
  let objective = '';
  if (goals?.parse.ok && goals.parse.objectives.length > 0) {
    const doneKeys = new Set(objectivesDone(db, id).keys());
    const objectives = goals.parse.objectives;
    const done = objectives.filter((o) => o.done || doneKeys.has(o.key)).length;
    const current = objectives.find((o) => !o.done && !doneKeys.has(o.key));
    objective = `<section id="objective"><h3>Objective</h3><p><a href="${escapeHtml(projectHref(id, 'goals'))}">${
      current ? escapeHtml(current.title) : 'Every objective is done'
    }</a>: ${done} of ${objectives.length} done</p></section>`;
  }

  const worst = run
    ? (DOCTOR_WORST_FIRST.find((st) => checks.some((c) => c.status === st)) ?? 'no checks')
    : 'not run yet';
  const health = `<section id="health"><h3>Health</h3><ul><li>Doctor: <a href="${SYSTEM_HREF}">${escapeHtml(worst)}</a></li><li>Egress: ${escapeHtml(zone.egress?.mode ?? 'off')}</li><li>Accounts: ${escapeHtml(zone.identity)}</li></ul></section>`;

  return page(
    projectHeader({
      zone,
      zones: all,
      mode,
      openBriefings: briefings.length,
      current: 'overview',
    }) +
      state +
      needsYou +
      work +
      objective +
      health,
    { title: zoneNameText(zone, all) },
  );
}

/** A project's Setup tab (#617): the Backlog, then one settings form with a section list and a Danger zone. */
function setupPage(
  store: ConfigStore,
  db: Db,
  id: string,
  now: Date,
  /** The GitHub section (#618), rendered by the caller: it reads GitHub. */
  github = '',
): string | undefined {
  const doc = store.document();
  const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
  const index = zones.findIndex((z) => z.id === id);
  const raw = zones[index];
  const resolved = store.current().dropZones.find((z) => z.id === id);
  if (!raw || !resolved) return undefined;
  const all = store.current().dropZones;
  const readOnly = store.mode() === 'file';
  // The forms show what is in effect (defaults filled); the read-only Advanced JSON what is stored.
  const f = zoneToForm(resolved);
  const mode = getZoneMode(db, id, resolved.mode);
  const stopping = stoppingLine(db, id);
  const gates = (f['gate.name'] as string[]).map((name, i) => ({
    name,
    run: (f['gate.run'] as string[])[i] ?? '',
    timeout: (f['gate.timeout'] as string[])[i] ?? '',
  }));
  const gateRow = (g: { name: string; run: string; timeout: string }) =>
    `<p class="gate"><input name="gate.name" value="${escapeHtml(g.name)}" placeholder="name"> <input name="gate.run" value="${escapeHtml(g.run)}" size="40" placeholder="command"> <input name="gate.timeout" value="${escapeHtml(g.timeout)}" size="4" placeholder="min"></p>`;
  const presetOptions = [
    `<option value=""${f.preset === '' ? ' selected' : ''}>(none: the image below)</option>`,
    ...PRESETS.map((p) => `<option value="${p}"${f.preset === p ? ' selected' : ''}>${p}</option>`),
  ].join('');
  const image =
    typeof raw.image === 'string'
      ? `<p>Image: <code>${escapeHtml(raw.image)}</code> <small>(${FORBIDDEN_NOTE}: the image decides what runs with your credentials)</small></p>`
      : '';
  const seen = egressSeen(db, id, new Date(now.getTime() - EGRESS_WINDOW_MS)).hosts;
  const own = ((raw.egress as { allow?: string[] } | undefined)?.allow ?? []).map(String);
  const egressMode = resolved.egress?.mode ?? 'off';
  /**
   * Which of this zone's lists a host is on, as `egressFor` builds the drop's list: the base, the
   * zone's own preset, the zone's own entries (`*.name` covers subdomains). Another preset's host
   * is not on it, and gets a tick box.
   */
  const listedBy = (host: string): string | undefined => {
    if (BASE_EGRESS.includes(host)) return 'every drop (the base list)';
    if (resolved.preset && PRESET_EGRESS[resolved.preset].includes(host))
      return `the ${resolved.preset} preset`;
    if (own.some((e) => e === host || (e.startsWith('*.') && host.endsWith(e.slice(1)))))
      return "this zone's allow list";
    return undefined;
  };
  const adoptControls = readOnly
    ? ''
    : egressMode === 'off'
      ? '<p><small>Egress is off for this zone, so no allow list is used: set the mode to monitor or enforce before adopting hosts.</small></p>'
      : '<p><button type="button" id="adopt-ticked">Adopt ticked</button> <small>Each host you tick is added to the allow list: drops will be able to send data to it, so it asks for confirmation. Each host was reached by one of this zone\'s drops, and a drop that misbehaved may have reached it: adopt only hosts you recognise.</small></p>';
  const observed = seen.length
    ? `<table><tr><th>Host</th><th>Decision</th><th>Connections</th><th>Drops</th><th>Listed</th><th>Adopt</th></tr>${seen
        .map((h) => {
          const by = listedBy(h.host);
          return `<tr><td>${escapeHtml(h.host)}</td><td>${escapeHtml(h.decision)}</td><td>${formatCount(h.count)}</td><td>${dropsCell(id, h.drops)}</td><td>${by ? `listed by ${escapeHtml(by)}` : `<strong>${escapeHtml("not in this zone's lists")}</strong>`}</td><td>${by ? '-' : `<input type="checkbox" name="adopt" value="${escapeHtml(h.host)}">`}</td></tr>`;
        })
        .join('')}</table>${adoptControls}`
    : '<p>Nothing observed yet.</p>';
  const identityOptions = ['two-bot', 'starter']
    .map((i) => `<option value="${i}"${f.identity === i ? ' selected' : ''}>${i}</option>`)
    .join('');
  const egressOptions = ['off', 'monitor', 'enforce']
    .map((m) => `<option value="${m}"${f['egress.mode'] === m ? ' selected' : ''}>${m}</option>`)
    .join('');

  const project = setupSection(
    'project',
    'Repository &amp; labels',
    `<p>Repository: <strong>${escapeHtml(raw.repo)}</strong> <small>(remove and re-add to change)</small></p>
${field('readyLabel', 'Ready label', input(f, 'readyLabel'), 'renaming to a label already on many issues dispatches them all')}
${field('retryLabel', 'Retry label', input(f, 'retryLabel'))}
${field('adoptPulls', 'Open PRs to take over (numbers)', input(f, 'adoptPulls'))}`,
  );
  const stack = setupSection(
    'stack',
    'Stack &amp; checks',
    `<div id="preset">${field('preset', 'Preset', `<select name="preset">${presetOptions}</select>`)}${image}</div>
<h4>Checks (gates)</h4><div id="gate-rows">${gates.map(gateRow).join('')}</div>${readOnly ? '' : '<p><button type="button" id="add-gate">Add a check</button></p>'}<span class="issue" data-issues="gates"></span>
${field('verification', 'Verification (JSON)', textarea(f, 'verification'))}
<div id="services">${field('services', 'Services (JSON)', textarea(f, 'services'), 'each service runs beside every drop')}</div>
${field('limits', 'Limits (JSON)', textarea(f, 'limits', 3))}`,
  );
  const egress = setupSection(
    'egress',
    'Egress',
    `${field('egress.mode', 'Mode', `<select name="egress.mode">${egressOptions}</select>`, 'off: no control; monitor: record what drops reach; enforce: only the lists')}
${field('egress.allow', 'Allow list (one host or *.name per line)', textarea(f, 'egress.allow'))}
<h4>Observed in the last 14 days</h4>${observed}<p id="adopt-out" role="status"></p>`,
  );
  const merging = setupSection(
    'merging',
    'Merging',
    `<div id="identity">${field('identity', 'Accounts', `<select name="identity">${identityOptions}</select>`)}<p class="warn" id="starter-warning"${f.identity === 'starter' ? '' : ' hidden'}><strong>Starter mode:</strong> ${escapeHtml(STARTER_WARNING_BODY)}</p></div>${readOnly ? '' : IDENTITY_SCRIPT}
${field('ciRequired', 'CI must pass', checkbox(f, 'ciRequired'))}
${field('ciDeadlineMinutes', 'CI deadline (minutes)', input(f, 'ciDeadlineMinutes', 6))}
${field('requireBranchProtection', 'Branch rules required', checkbox(f, 'requireBranchProtection'))}
${field('authorMayBeAdmin', 'The author account may be an admin (a personal repository)', checkbox(f, 'authorMayBeAdmin'))}
${field('reviewReadToken', 'Review drops get the read token (a private repository)', checkbox(f, 'reviewReadToken'))}
${field('protectedPaths', 'Protected paths (a person reviews these)', textarea(f, 'protectedPaths', 6))}
${field('overrideApprovers', 'Override approvers (logins)', textarea(f, 'overrideApprovers', 3))}`,
  );
  // Read-only: the JSON has no name, so it is never part of the patch. Edit it on the flags page.
  const advanced = setupSection(
    'advanced',
    'Advanced',
    `<p>Zone id: <code>${escapeHtml(id)}</code> <small>(the zone's key in URLs, the API and <code>jumpmaster ctl</code>)</small></p><p>The zone as stored, as JSON: models, budgets, crew and every other setting. It is read-only here.</p><p>All settings, one per row: <a href="${projectHref(id, 'flags')}">advanced settings</a> <small>(edit them there)</small></p><div id="goals"></div><div id="crew"></div><textarea id="zone-json" readonly rows="24" cols="90" aria-label="The zone as JSON">${escapeHtml(JSON.stringify(raw, null, 2))}</textarea><span class="issue" data-issues="advanced"></span>`,
  );
  const repo = String(raw.repo);
  const name = zoneNameText(resolved, all);
  const confirmText = `Jumpmaster takes no new work for ${escapeHtml(name)} and sets it to observe, then removes it as soon as its running drops, pending pushes and outbox writes have finished. Open pull requests are left as they are. Its history is kept, for a later Resume.`;
  const danger = `<section id="danger" class="setup-section danger-zone"><h3>Danger zone</h3>${
    stopping
      ? `<p><strong>${escapeHtml(stopping)}</strong> <small>Resume or Pause from the Projects list withdraws it.</small></p>`
      : readOnly
        ? '<p>In file mode, stop managing this project by removing it from the config file and running <code>jumpmaster ctl config reload</code>.</p>'
        : `<h4>Stop managing this project</h4><p>${confirmText}</p><p><label>Type <code>${escapeHtml(repo)}</code> to confirm <input id="stop-confirm" autocomplete="off" spellcheck="false" size="30"></label></p><p><button type="button" class="stop danger" id="stop-managing" disabled>Stop managing this project</button> <span id="stop-out" role="status"></span></p>`
  }</section>`;
  const nav = `<nav class="setup-nav" aria-label="Setup sections"><ul>${SETUP_SECTIONS.map(([s, label]) => `<li><a href="#${s}">${label}</a></li>`).join('')}</ul></nav>`;
  const jump = `<select id="setup-jump" class="setup-jump" aria-label="Go to a section">${SETUP_SECTIONS.map(([s, label]) => `<option value="${s}">${label}</option>`).join('')}</select>`;
  const saveBar = readOnly
    ? ''
    : '<div class="save-bar" id="save-bar"><span id="save-count">0 unsaved changes</span> <span id="save-out" role="status"></span> <button type="button" id="discard" disabled>Discard</button> <button id="save" class="primary" disabled>Save</button></div>';
  const base = projectHref(id, 'setup');
  const briefings = listBriefings(db, { zoneId: id, state: 'open' }).length;
  return page(
    `${projectHeader({ zone: resolved, zones: all, mode, openBriefings: briefings, current: 'setup' })}
${readOnly ? ADOPT_BANNER : ''}
${backlogSection(id, repo)}
${SETUP_STYLE}${jump}
<div class="setup-layout">${nav}<div class="setup-body">
<form id="setup-form"><fieldset${readOnly ? ' disabled' : ''}><input type="hidden" name="id" value="${escapeHtml(id)}">
${project}
</fieldset>${github}<fieldset${readOnly ? ' disabled' : ''}>
${stack}${egress}${merging}${advanced}
</fieldset>${saveBar}</form>
${github ? githubReviewerForm(id) : ''}${github ? COPY_SCRIPT : ''}
${danger}
</div></div>
${JUMP_SCRIPT}
${readOnly ? '' : setupScript({ revision: store.revision(), index, id, repo, base })}`,
    { title: name },
  );
}

export function registerZonesPages(
  app: FastifyInstance,
  deps: {
    db: Db;
    store: ConfigStore;
    now(): Date;
    /** The floor's inputs, for the Overview's State sentence (its floor card's words). */
    floor?: (at: Date) => FloorInputs;
    /** Renders the Setup tab's GitHub section (#618) from the latest doctor run's checks. */
    github?: (
      config: Config,
      zone: DropZoneConfig,
      query: unknown,
      checks: readonly DoctorCheck[] | null,
    ) => Promise<string>;
  },
): void {
  const { db, store, now } = deps;
  app.get(PROJECTS_HREF, async (req, reply) => html(req, reply, listPage(store, db)));
  app.get(`${PROJECTS_HREF}/new`, async (req, reply) => {
    if (store.mode() === 'file')
      return html(req, reply, page(`${NEW_PROJECT_CRUMBS}<h2>Add a project</h2>${ADOPT_BANNER}`));
    return html(
      req,
      reply,
      page(
        `${NEW_PROJECT_CRUMBS}${projectBody(getWizard(db).starter ? 'starter' : 'two-bot', {
          returnTo: PROJECTS_HREF,
          cancelTo: `${PROJECTS_HREF}/new`,
          done: PROJECTS_HREF,
        })}`,
      ),
    );
  });
  app.get<{ Params: { id: string } }>(`${PROJECTS_HREF}/:id`, async (req, reply) => {
    const at = now();
    const body = overviewPage(store, db, req.params.id, at, deps.floor?.(at));
    if (!body) return reply.code(404).type('text/plain').send('no such zone');
    return html(req, reply, body);
  });
  app.get<{ Params: { id: string } }>(`${PROJECTS_HREF}/:id/setup`, async (req, reply) => {
    const config = req.jmConfig ?? store.current();
    const zone = config.dropZones.find((z) => z.id === req.params.id);
    const run = zone && deps.github ? latestDoctorRun(db) : null;
    const github =
      zone && deps.github
        ? await deps.github(config, zone, req.query, run ? run.checks : null)
        : '';
    const body = setupPage(store, db, req.params.id, now(), github);
    if (!body) return reply.code(404).type('text/plain').send('no such zone');
    return html(req, reply, body);
  });
  // A zone's advanced settings: every setting of the catalog, one per row (issue #322).
  app.get<{ Params: { id: string }; Querystring: { saved?: string } }>(
    `${PROJECTS_HREF}/:id/flags`,
    async (req, reply) => {
      const saved = /^\d{1,9}$/.test(req.query.saved ?? '') ? Number(req.query.saved) : undefined;
      const body = renderFlags(store, req.params.id, {
        header: (zone, zones) =>
          projectHeaderFor(db, zone, zones, 'setup', [{ label: 'Advanced settings' }]),
        adoptBanner: ADOPT_BANNER,
        forbiddenNote: FORBIDDEN_NOTE,
        ...(saved === undefined ? {} : { saved }),
      });
      if (!body) return reply.code(404).type('text/plain').send('no such zone');
      return html(req, reply, body);
    },
  );
}
