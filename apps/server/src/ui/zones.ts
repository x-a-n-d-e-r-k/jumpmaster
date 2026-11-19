import { PRESETS } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withCsrf } from '../auth/guard.js';
import { listBriefings } from '../briefings.js';
import type { ConfigStore } from '../config/store.js';
import { STARTER_WARNING } from '../config.js';
import type { Db } from '../db/open.js';
import { getZoneMode, type ZoneWaits, zoneStopping, zoneWaits } from '../db/repo.js';
import { egressSeen } from '../doctor/checks.js';
import { latestDoctorRun } from '../doctor/run.js';
import { BASE_EGRESS } from '../payloads.js';
import { PRESET_EGRESS } from '../presets.js';
import { FORM_SCRIPT, zoneToForm } from '../zones/form.js';
import { renderFlags } from './flags.js';
import { askButton, escapeHtml, MODE_LABELS, page, zoneBriefingsHref, zoneHref } from './pages.js';
import { getWizard, projectBody } from './setup.js';
import { zoneName, zoneNameText } from './zone-name.js';

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
/** How many drop links one observed host lists; the rest are a link to the zone's drops. */
const OBSERVED_DROP_LINKS = 20;
const COUNT_FORMAT = new Intl.NumberFormat('en-US');
/** A count with en-US thousands separators (`19,510`), whatever the server's locale. */
const formatCount = (n: number): string => COUNT_FORMAT.format(n);
/**
 * The Drops cell of the observed table: the count of distinct drops, then a disclosure linking the
 * newest {@link OBSERVED_DROP_LINKS} (`drops` is oldest first, as `egressSeen` supplies it) and
 * "and M more" to the zone's drops list when there are more.
 */
function dropsCell(zoneId: string, drops: string[]): string {
  const newest = drops.slice(-OBSERVED_DROP_LINKS).reverse();
  const rest = drops.length - newest.length;
  const links = newest
    .map((d) => `<a href="/drops/${encodeURIComponent(d)}">${escapeHtml(d.slice(0, 8))}</a>`)
    .join(' ');
  const more =
    rest > 0
      ? ` <a href="/drops?zone=${encodeURIComponent(zoneId)}">and ${formatCount(rest)} more</a>`
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
  if (r.status === 200) { location.href = '/zones'; return; }
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
        ? `<span class="problem">${escapeHtml(mine[0]?.message)}</span> <a href="/settings/credentials">Fix in Settings, Credentials</a>`
        : '-';
      // Only the moves that apply from the zone's current mode.
      const button = (m: string, label: string) =>
        mode === m
          ? ''
          : `<button class="mode" data-zone="${escapeHtml(z.id)}" data-name="${escapeHtml(name)}" data-mode="${m}">${label}</button> `;
      return `<tr><td><a href="${zoneHref(z.id)}">${zoneName(z, config.dropZones)}</a></td><td>${escapeHtml(MODE_LABELS[mode] ?? mode)}${stopping ? `<br><strong>${escapeHtml(stopping)}</strong>` : ''}</td><td>${escapeHtml(z.preset ?? z.image)}</td><td>${escapeHtml(z.egress?.mode ?? 'off')}</td><td>${escapeHtml(z.identity)}</td><td>${last ? `<a href="/drops/${encodeURIComponent(last.id)}">${escapeHtml(last.role)}, ${escapeHtml(last.state)}</a>` : '-'}</td><td>${fails === undefined ? '-' : `<a href="/doctor">${fails}</a>`}</td><td>${problem}</td><td>${button('paused', 'Pause')}${button('active', 'Resume')}${button('observe', 'Observe')}${fileMode || stopping ? '' : stopButton(z.id, name)}<a href="${zoneHref(z.id)}/github">GitHub</a></td></tr>`;
    })
    .join('');
  return page(
    `<p><a href="/">Home</a></p><h2>Zones</h2><p>A zone is one project: one repository Jumpmaster works on.</p>
${fileMode ? ADOPT_BANNER : '<p><a href="/zones/new">Add a project</a></p>'}
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

/** A section: one form, one Save, or a disabled fieldset in file mode. */
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

const sectionForm = (id: string, title: string, body: string, readOnly: boolean) =>
  `<h3>${title}</h3><form id="${id}" data-section="${id}"><fieldset${readOnly ? ' disabled' : ''}>${body}${readOnly ? '' : `<p><button>Save</button> <span class="out" role="status"></span></p>`}</fieldset></form>`;

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

function zonePage(store: ConfigStore, db: Db, id: string, now: Date): string | undefined {
  const doc = store.document();
  const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
  const index = zones.findIndex((z) => z.id === id);
  const raw = zones[index];
  const resolved = store.current().dropZones.find((z) => z.id === id);
  if (!raw || !resolved) return undefined;
  const all = store.current().dropZones;
  const readOnly = store.mode() === 'file';
  // The forms show what is in effect (defaults filled); the Advanced editor what is stored.
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
    `${hidden}<div id="identity">${field('identity', 'Accounts', `<select name="identity">${identityOptions}</select>`)}<p class="warn" id="starter-warning"${f.identity === 'starter' ? '' : ' hidden'}><strong>Starter mode:</strong> ${escapeHtml(STARTER_WARNING_BODY)}</p></div>${readOnly ? '' : IDENTITY_SCRIPT}
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
    `<p>Zone id: <code>${escapeHtml(id)}</code> <small>(the zone's key in URLs, the API and <code>jumpmaster ctl</code>)</small></p><p>The zone as JSON: models, budgets, crew and every other setting. It is checked as the sections are.</p><p>All settings, one per row: <a href="${zoneHref(id)}/flags">advanced settings</a></p><div id="goals"></div><div id="crew"></div><textarea name="json" rows="24" cols="90">${escapeHtml(JSON.stringify(raw, null, 2))}</textarea><span class="issue" data-issues="advanced"></span>`,
    readOnly,
  );
  const base = zoneHref(id);
  const briefings = listBriefings(db, { zoneId: id, state: 'open' }).length;
  return page(
    `<p><a href="/">Home</a> · <a href="/zones">Zones</a> · <a href="${base}/github">GitHub</a> · <a href="${escapeHtml(zoneBriefingsHref(id))}">Briefings (${briefings} open)</a> · <a href="${base}/goals">Goals</a> · <a href="${base}/issues/new">New issue</a></p>
<h2>${zoneName(resolved, all)}</h2><p>${escapeHtml(MODE_LABELS[mode] ?? mode)}</p>
${askButton({ kind: 'zone', zoneId: id, ref: id })}
${stopping ? `<p><strong>${escapeHtml(stopping)}</strong> <small>Resume or Pause from the Zones list withdraws it.</small></p>` : ''}
${readOnly || stopping ? '' : `<p>${stopButton(id, zoneNameText(resolved, all))}<small>No new work, then removed once drained; open pull requests and history stay.</small> <span id="stop-out" role="status"></span></p>`}
${readOnly ? ADOPT_BANNER : ''}
${backlogSection(id, String(raw.repo))}
<p id="form-out" role="status"></p>
${project}${stack}${egress}${merging}${advanced}
${
  readOnly
    ? ''
    : `<script>
${STOP_SCRIPT}
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
</script>`
}`,
    { title: zoneNameText(resolved, all) },
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
  // A zone's advanced settings: every setting of the catalog, one per row (issue #322).
  app.get<{ Params: { id: string }; Querystring: { saved?: string } }>(
    '/zones/:id/flags',
    async (req, reply) => {
      const saved = /^\d{1,9}$/.test(req.query.saved ?? '') ? Number(req.query.saved) : undefined;
      const body = renderFlags(store, req.params.id, {
        adoptBanner: ADOPT_BANNER,
        forbiddenNote: FORBIDDEN_NOTE,
        ...(saved === undefined ? {} : { saved }),
      });
      if (!body) return reply.code(404).type('text/plain').send('no such zone');
      return html(req, reply, body);
    },
  );
}
