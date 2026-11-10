import { PRESETS } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withCsrf } from '../auth/guard.js';
import type { ConfigStore } from '../config/store.js';
import { STARTER_WARNING } from '../config.js';
import type { Db } from '../db/open.js';
import { getZoneMode } from '../db/repo.js';
import { egressSeen } from '../doctor/checks.js';
import { latestDoctorRun } from '../doctor/run.js';
import { BASE_EGRESS } from '../payloads.js';
import { PRESET_EGRESS } from '../presets.js';
import { FORM_SCRIPT, zoneToForm } from '../zones/form.js';
import { escapeHtml, MODE_LABELS, page } from './pages.js';
import { getWizard, projectBody } from './setup.js';

/**
 * The zones page (§10.3): every zone with its mode, egress, identity, last drop, doctor fails and
 * credential problem; a page per zone whose five sections each post one merge patch for that
 * zone (`PATCH /api/control/config`, zones matched by id) conditional on the revision drawn; and
 * the add page. Every write goes through the store's apply, so a change from a browser that
 * weakens a guard lands on the confirmation page, and one a session may never make is answered
 * with where to make it. In file mode every section is read-only under the adopt banner. All text
 * from the config, the forge and the drops is escaped; the page holds no secret.
 */

const EGRESS_WINDOW_MS = 14 * 86_400_000;

const scriptJson = (v: unknown): string =>
  JSON.stringify(v)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

const html = (req: FastifyRequest, reply: FastifyReply, body: string, code = 200) =>
  reply.code(code).type('text/html; charset=utf-8').send(withCsrf(req, body));

const zoneHref = (id: string) => `/zones/${encodeURIComponent(id)}`;

const ADOPT_BANNER = `<div class="warn"><p><strong>Your config file holds these zones.</strong> In file mode the file is the config: edit it and run <code>jumpmaster ctl config reload</code>. To change zones here instead, adopt it into the database (<code>jumpmaster ctl config mode file</code> goes back).</p><p><button id="adopt">Adopt the config file</button> <span id="adopt-out" role="status"></span></p></div>
<script>
document.getElementById('adopt').addEventListener('click', async () => {
  const r = await jmFetch('/api/control/config/adopt', {});
  if (r.ok) location.reload(); else document.getElementById('adopt-out').textContent = 'Not adopted (' + r.status + ').';
});
</script>`;

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
      const problem = mine.length
        ? `<span class="problem">${escapeHtml(mine[0]?.message)}</span> <a href="/settings/credentials">Fix in Settings, Credentials</a>`
        : '-';
      // Only the moves that apply from the zone's current mode.
      const button = (m: string, label: string) =>
        mode === m
          ? ''
          : `<button class="mode" data-zone="${escapeHtml(z.id)}" data-mode="${m}">${label}</button> `;
      return `<tr><td><a href="${zoneHref(z.id)}">${escapeHtml(z.id)}</a></td><td>${escapeHtml(z.repo)}</td><td>${escapeHtml(MODE_LABELS[mode] ?? mode)}</td><td>${escapeHtml(z.preset ?? z.image)}</td><td>${escapeHtml(z.egress?.mode ?? 'off')}</td><td>${escapeHtml(z.identity)}</td><td>${last ? `<a href="/drops/${encodeURIComponent(last.id)}">${escapeHtml(last.role)}, ${escapeHtml(last.state)}</a>` : '-'}</td><td>${fails === undefined ? '-' : `<a href="/doctor">${fails}</a>`}</td><td>${problem}</td><td>${button('paused', 'Pause')}${button('active', 'Resume')}${button('observe', 'Observe')}<a href="${zoneHref(z.id)}/github">GitHub</a></td></tr>`;
    })
    .join('');
  return page(
    `<p><a href="/">Home</a></p><h2>Zones</h2><p>A zone is one project: one repository Jumpmaster works on.</p>
${fileMode ? ADOPT_BANNER : '<p><a href="/zones/new">Add a project</a></p>'}
<table><tr><th>Zone</th><th>Repository</th><th>Mode</th><th>Stack</th><th>Egress</th><th>Accounts</th><th>Last drop</th><th>Doctor fails</th><th>Needs</th><th></th></tr>${rows || '<tr><td colspan="10">No zones yet.</td></tr>'}</table>
<p id="mode-out" role="status"></p>
<script>
for (const b of document.querySelectorAll('button.mode')) b.addEventListener('click', async () => {
  const r = await jmFetch('/api/control/zones/' + encodeURIComponent(b.dataset.zone), { mode: b.dataset.mode });
  if (r.ok) { location.reload(); return; }
  const j = await r.json().catch(() => ({}));
  document.getElementById('mode-out').textContent = b.dataset.zone + ': ' + (j.error || ('refused (' + r.status + ')'));
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

/** A section: one form, one Save, or a disabled fieldset in file mode. */
const sectionForm = (id: string, title: string, body: string, readOnly: boolean) =>
  `<h3>${title}</h3><form id="${id}" data-section="${id}"><fieldset${readOnly ? ' disabled' : ''}>${body}${readOnly ? '' : `<p><button>Save</button> <span class="out" role="status"></span></p>`}</fieldset></form>`;

function zonePage(store: ConfigStore, db: Db, id: string, now: Date): string | undefined {
  const doc = store.document();
  const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
  const index = zones.findIndex((z) => z.id === id);
  const raw = zones[index];
  const resolved = store.current().dropZones.find((z) => z.id === id);
  if (!raw || !resolved) return undefined;
  const readOnly = store.mode() === 'file';
  // The forms show what is in effect (defaults filled); the Advanced editor what is stored.
  const f = zoneToForm(resolved);
  const mode = getZoneMode(db, id, resolved.mode);
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
    ? `<table><tr><th>Host</th><th>Drops that reached it</th><th>Listed</th><th>Adopt</th></tr>${seen
        .map((h) => {
          const by = listedBy(h.host);
          return `<tr><td>${escapeHtml(h.host)} <small>(${escapeHtml(h.decision)}, ${h.count}x)</small></td><td>${h.drops.map((d) => `<a href="/drops/${encodeURIComponent(d)}">${escapeHtml(d.slice(0, 8))}</a>`).join(' ')}</td><td>${by ? `listed by ${escapeHtml(by)}` : `<strong>${escapeHtml("not in this zone's lists")}</strong>`}</td><td>${by ? '-' : `<input type="checkbox" name="adopt" value="${escapeHtml(h.host)}">`}</td></tr>`;
        })
        .join('')}</table>${adoptControls}`
    : '<p>Nothing observed yet.</p>';
  const identityOptions = ['two-bot', 'starter']
    .map((i) => `<option value="${i}"${f.identity === i ? ' selected' : ''}>${i}</option>`)
    .join('');
  const egressOptions = ['off', 'monitor', 'enforce']
    .map((m) => `<option value="${m}"${f['egress.mode'] === m ? ' selected' : ''}>${m}</option>`)
    .join('');
  const hidden = `<input type="hidden" name="id" value="${escapeHtml(id)}">`;

  const project = sectionForm(
    'project',
    'Project',
    `${hidden}<p>Repository: <strong>${escapeHtml(raw.repo)}</strong> <small>(remove and re-add to change)</small></p>
${field('readyLabel', 'Ready label', input(f, 'readyLabel'), 'renaming to a label already on many issues dispatches them all')}
${field('retryLabel', 'Retry label', input(f, 'retryLabel'))}
${field('adoptPulls', 'Open PRs to take over (numbers)', input(f, 'adoptPulls'))}`,
    readOnly,
  );
  const stack = sectionForm(
    'stack',
    'Stack',
    `${hidden}<div id="preset">${field('preset', 'Preset', `<select name="preset">${presetOptions}</select>`)}${image}</div>
<h4>Checks (gates)</h4><div id="gate-rows">${gates.map(gateRow).join('')}</div>${readOnly ? '' : '<p><button type="button" id="add-gate">Add a check</button></p>'}<span class="issue" data-issues="gates"></span>
${field('verification', 'Verification (JSON)', textarea(f, 'verification'))}
<div id="services">${field('services', 'Services (JSON)', textarea(f, 'services'), 'each service runs beside every drop')}</div>
${field('limits', 'Limits (JSON)', textarea(f, 'limits', 3))}`,
    readOnly,
  );
  const egress = sectionForm(
    'egress',
    'Egress',
    `${hidden}${field('egress.mode', 'Mode', `<select name="egress.mode">${egressOptions}</select>`, 'off: no control; monitor: record what drops reach; enforce: only the lists')}
${field('egress.allow', 'Allow list (one host or *.name per line)', textarea(f, 'egress.allow'))}
<h4>Observed in the last 14 days</h4>${observed}`,
    readOnly,
  );
  const merging = sectionForm(
    'merging',
    'Merging',
    `${hidden}<div id="identity">${field('identity', 'Accounts', `<select name="identity">${identityOptions}</select>`)}<p class="warn"><strong>Starter mode:</strong> ${escapeHtml(STARTER_WARNING)}</p></div>
${field('ciRequired', 'CI must pass', checkbox(f, 'ciRequired'))}
${field('ciDeadlineMinutes', 'CI deadline (minutes)', input(f, 'ciDeadlineMinutes', 6))}
${field('requireBranchProtection', 'Branch rules required', checkbox(f, 'requireBranchProtection'))}
${field('authorMayBeAdmin', 'The author account may be an admin (a personal repository)', checkbox(f, 'authorMayBeAdmin'))}
${field('reviewReadToken', 'Review drops get the read token (a private repository)', checkbox(f, 'reviewReadToken'))}
${field('protectedPaths', 'Protected paths (a person reviews these)', textarea(f, 'protectedPaths', 6))}
${field('overrideApprovers', 'Override approvers (logins)', textarea(f, 'overrideApprovers', 3))}`,
    readOnly,
  );
  const advanced = sectionForm(
    'advanced',
    'Advanced',
    `<p>The zone as JSON: models, budgets, crew and every other setting. It is checked as the sections are.</p><div id="goals"></div><div id="crew"></div><textarea name="json" rows="24" cols="90">${escapeHtml(JSON.stringify(raw, null, 2))}</textarea><span class="issue" data-issues="advanced"></span>`,
    readOnly,
  );
  const base = zoneHref(id);
  return page(
    `<p><a href="/">Home</a> · <a href="/zones">Zones</a> · <a href="${base}/github">GitHub</a></p>
<h2>Zone ${escapeHtml(id)}</h2><p>${escapeHtml(MODE_LABELS[mode] ?? mode)}</p>
${readOnly ? ADOPT_BANNER : ''}
<p id="form-out" role="status"></p>
${project}${stack}${egress}${merging}${advanced}
${
  readOnly
    ? ''
    : `<h3>Remove</h3><p>A zone is removed once it is drained: set it to observe and let its drops and GitHub writes finish. Its history stays, for a later Resume.</p><p><button type="button" id="remove">Remove ${escapeHtml(id)}</button> <span id="remove-out" role="status"></span></p>
<script>
${FORM_SCRIPT}
const REVISION = ${store.revision()};
const ZONE_INDEX = ${index};
const ZONE_ID = ${scriptJson(id)};
const ORIGINAL = ${scriptJson(raw)};
function fieldsOf(form) {
  const out = {};
  const add = (k, v) => { if (k in out) out[k] = [].concat(out[k], v); else out[k] = v; };
  for (const el of form.elements) {
    if (!el.name || el.name === 'adopt' || el.type === 'button' || el.type === 'submit') continue;
    if (el.type === 'checkbox') { if (el.checked) add(el.name, el.value); continue; }
    add(el.name, el.value);
  }
  for (const k of ['gate.name', 'gate.run', 'gate.timeout', 'bool']) if (k in out && !Array.isArray(out[k])) out[k] = [out[k]];
  return out;
}
function showIssues(form, issues) {
  for (const i of issues) {
    const f = issueField(i.path, ZONE_INDEX);
    const at = f && document.querySelector('[data-issues="' + f + '"]');
    if (at) at.textContent = i.message; else form.querySelector('.out').textContent += (i.path ? i.path + ': ' : '') + i.message + ' ';
  }
}
async function save(form, section, patch) {
  for (const s of document.querySelectorAll('.issue')) s.textContent = '';
  const out = form.querySelector('.out'); out.textContent = '';
  const r = await jmFetch('/api/control/config', { patch: { dropZones: [patch] }, expectRevision: REVISION, returnTo: ${scriptJson(`${base}#`)} + section, cancelTo: ${scriptJson(base)} }, 'PATCH');
  const j = await r.json().catch(() => ({}));
  if (r.ok) { location.hash = section; location.reload(); return; }
  // A change that weakens a guard: the confirmation page, then back to this section.
  if (r.status === 409 && j.needsConfirmation) { location.href = j.confirm; return; }
  if (r.status === 409 && j.conflict) { out.textContent = 'The config changed since this page was drawn: reload it and make the change again.'; return; }
  if (r.status === 403 && j.sessionForbidden) { out.innerHTML = 'Not from the browser: ${FORBIDDEN_NOTE.replaceAll("'", "\\'")}. '; const c = document.createElement('code'); c.textContent = j.sessionForbidden.join(', '); out.append(c); return; }
  if (j.issues) { showIssues(form, j.issues); return; }
  out.textContent = j.error || ('Refused (' + r.status + ')');
}
for (const form of document.querySelectorAll('form[data-section]')) form.addEventListener('submit', (e) => {
  e.preventDefault();
  const section = form.dataset.section;
  if (section === 'advanced') {
    let edited;
    try { edited = JSON.parse(form.json.value); } catch (err) { form.querySelector('.issue').textContent = 'Not JSON: ' + err.message; return; }
    if (!edited || edited.id !== ZONE_ID) { form.querySelector('.issue').textContent = 'Keep "id": ' + JSON.stringify(ZONE_ID) + ' (a zone is renamed by removing it and adding it again).'; return; }
    save(form, section, toMergePatch(ORIGINAL, edited));
    return;
  }
  save(form, section, formToZone(fieldsOf(form)));
});
const addGate = document.getElementById('add-gate');
if (addGate) addGate.addEventListener('click', () => {
  const p = document.createElement('p'); p.className = 'gate';
  for (const [name, size, ph] of [['gate.name', 20, 'name'], ['gate.run', 40, 'command'], ['gate.timeout', 4, 'min']]) {
    const i = document.createElement('input'); i.name = name; i.size = size; i.placeholder = ph; p.append(i, ' ');
  }
  document.getElementById('gate-rows').append(p);
});
const adopt = document.getElementById('adopt-ticked');
if (adopt) adopt.addEventListener('click', async () => {
  const hosts = [...document.querySelectorAll('input[name=adopt]:checked')].map((i) => i.value);
  const out = document.querySelector('#egress .out');
  if (hosts.length === 0) { out.textContent = 'Tick a host first.'; return; }
  const r = await jmFetch('/api/control/zones/' + encodeURIComponent(ZONE_ID) + '/egress/adopt', { hosts, returnTo: ${scriptJson(`${base}#egress`)}, cancelTo: ${scriptJson(base)} });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { location.reload(); return; }
  if (r.status === 409 && j.needsConfirmation) { location.href = j.confirm; return; }
  out.textContent = j.error || (j.issues || []).map((i) => i.message).join('; ') || ('Refused (' + r.status + ')');
});
document.getElementById('remove').addEventListener('click', async () => {
  const out = document.getElementById('remove-out');
  const r = await jmFetch('/api/control/zones/' + encodeURIComponent(ZONE_ID), {}, 'DELETE');
  const j = await r.json().catch(() => ({}));
  // A removal is not a guarded change (the drained rule is the guard): applied, or refused.
  if (r.ok) { location.href = '/zones'; return; }
  out.textContent = j.error || (j.issues || []).map((i) => i.message).join('; ') || ('Refused (' + r.status + ')');
});
</script>`
}`,
  );
}

export function registerZonesPages(
  app: FastifyInstance,
  deps: { db: Db; store: ConfigStore; now(): Date },
): void {
  const { db, store, now } = deps;
  app.get('/zones', async (req, reply) => html(req, reply, listPage(store, db)));
  app.get('/zones/new', async (req, reply) => {
    if (store.mode() === 'file')
      return html(
        req,
        reply,
        page(`<p><a href="/zones">Zones</a></p><h2>Add a project</h2>${ADOPT_BANNER}`),
      );
    return html(
      req,
      reply,
      page(
        `<p><a href="/">Home</a> · <a href="/zones">Zones</a></p>${projectBody(
          getWizard(db).starter ? 'starter' : 'two-bot',
          { returnTo: '/zones', cancelTo: '/zones/new', done: '/zones' },
        )}`,
      ),
    );
  });
  app.get<{ Params: { id: string } }>('/zones/:id', async (req, reply) => {
    const body = zonePage(store, db, req.params.id, now());
    if (!body) return reply.code(404).type('text/plain').send('no such zone');
    return html(req, reply, body);
  });
}
