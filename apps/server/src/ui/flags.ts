import { type FlagGroup, type FlagRow, flagRows } from '../config/catalog.js';
import type { ConfigStore } from '../config/store.js';
import { escapeHtml, page } from './pages.js';
import { CONFIG_ANSWER_FN, settingControl, settingId } from './setting-controls.js';
import { zoneName, zoneNameText } from './zone-name.js';

/**
 * A zone's advanced settings page (issue #322): every zone setting of the catalog, one per row,
 * grouped, with its plain words, a control, whether the zone sets it and a Reset. One Save sends
 * one merge patch of what changed through `PATCH /api/control/config`, as the zone's JSON editor
 * does, so every guard and confirmation applies unchanged: the page only mirrors them (a
 * browser-forbidden row is always disabled here). In file mode every control is disabled.
 */

const GROUP_HEADS: [FlagGroup, string][] = [
  ['crew', 'Crew'],
  ['retries', 'Retries'],
  ['pace', 'Pace'],
  ['labels', 'Labels'],
  ['models', 'Models'],
  ['transcripts', 'Transcripts'],
  ['safety', 'Safety'],
  ['other', 'Other'],
];

/** Keys a zone needs: there is no default to reset them to. */
const NO_RESET = ['id', 'repo', 'gates'];

const GUARDED_NOTE = 'asks to confirm a change that loosens it';
const REFUSED_NOTE = 'fixed once the zone exists';

/** The zone page's section an `elsewhere` sentence names, else the JSON editor (Advanced). */
function elsewhereLink(base: string, sentence: string): string {
  const named = /(\w+) section/.exec(sentence)?.[1]?.toLowerCase() ?? 'advanced';
  const words = named === 'advanced' ? 'the JSON editor' : `the ${named} section`;
  return `<a href="${base}#${escapeHtml(named)}">${escapeHtml(words)}</a>`;
}

function row(r: FlagRow, o: { base: string; readOnly: boolean; forbiddenNote: string }): string {
  const { entry, key, guard } = r;
  const locked = o.readOnly || guard === 'browser-forbidden' || guard === 'refused';
  const control =
    entry.kind === 'elsewhere'
      ? `${escapeHtml(entry.elsewhere ?? '')} ${elsewhereLink(o.base, entry.elsewhere ?? '')}`
      : settingControl({
          path: key,
          kind: entry.kind,
          value: r.value,
          locked,
          ...(r.options ? { options: r.options } : {}),
          ...(entry.kind === 'select' && r.defaultValue === undefined
            ? { empty: '(not set)' }
            : {}),
          ...(entry.kind === 'number'
            ? {
                attrs: [
                  r.min === undefined ? '' : `min="${r.min}"`,
                  r.max === undefined ? '' : `max="${r.max}"`,
                  `step="${r.integer ? 1 : 'any'}"`,
                ]
                  .filter(Boolean)
                  .join(' '),
              }
            : {}),
        });
  const resettable =
    r.explicit &&
    !o.readOnly &&
    !NO_RESET.includes(key) &&
    guard !== 'browser-forbidden' &&
    guard !== 'refused';
  const def = r.defaultValue === undefined ? 'not set' : JSON.stringify(r.defaultValue);
  const marks = [
    r.explicit ? '<span class="set">set</span>' : '',
    resettable
      ? `<button type="button" class="reset" data-reset="${escapeHtml(key)}" title="Default: ${escapeHtml(def)}">Reset to default</button>`
      : '',
    guard === 'guarded' ? `<small>${GUARDED_NOTE}</small>` : '',
    guard === 'browser-forbidden' ? `<small>${o.forbiddenNote}</small>` : '',
    guard === 'refused' ? `<small>${REFUSED_NOTE}</small>` : '',
    `<span class="issue" data-flag-issue="${escapeHtml(key)}"></span>`,
  ]
    .filter(Boolean)
    .join(' ');
  const label =
    entry.kind === 'elsewhere'
      ? `<strong>${escapeHtml(entry.label)}</strong>`
      : `<label for="${settingId(key)}">${escapeHtml(entry.label)}</label>`;
  const search = `${entry.label} ${entry.help} ${key}`.toLowerCase();
  return `<tr data-flag="${escapeHtml(key)}" data-search="${escapeHtml(search)}" data-explicit="${r.explicit ? '1' : '0'}"><td>${label}<br><code>${escapeHtml(key)}</code><br><small>${escapeHtml(entry.help)}</small></td><td>${control}</td><td>${marks}</td></tr>`;
}

/**
 * The page's script. `jmFlagsPatch` turns the rows' fields (`{ key, kind, value, original,
 * explicit }`, or `{ key, reset: true }`) into one nested merge patch of what changed;
 * `jmSaveFlags` sends it for the zone, conditional on the revision drawn, and follows the answer
 * with the shared `jmConfigAnswer`, putting each issue beside its row.
 */
export const FLAGS_SCRIPT = `<script>
${CONFIG_ANSWER_FN}
function jmFlagsPatch(fields) {
  const patch = {};
  for (const f of fields) {
    let v;
    if (f.reset) v = null;
    else {
      if (f.kind === 'bool') v = !!f.value;
      else if (f.kind === 'list') v = String(f.value).split('\\n').map((l) => l.trim()).filter((l) => l !== '');
      else if (f.value === '') v = null;
      else if (f.kind === 'number') { const n = Number(f.value); v = Number.isFinite(n) ? n : f.value; }
      else v = f.value;
      const was = f.original === undefined ? null : f.original;
      if (JSON.stringify(v) === JSON.stringify(was)) continue;
      // Emptying what the zone doesn't set changes nothing.
      if (v === null && !f.explicit) continue;
    }
    const keys = f.key.split('.');
    let at = patch;
    for (const k of keys.slice(0, -1)) at = at[k] = at[k] && typeof at[k] === 'object' ? at[k] : {};
    at[keys[keys.length - 1]] = v;
  }
  return patch;
}
function jmFlagIssueAt(path, zoneIndex, zoneId) {
  const p = String(path || '');
  const pre = ['dropZones.' + zoneIndex + '.', 'dropZones[' + zoneId + '].'].find((x) => p.startsWith(x));
  if (!pre) return null;
  const parts = p.slice(pre.length).split('.');
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join('.');
    if (!/^[A-Za-z0-9_.]+$/.test(key)) continue;
    const at = document.querySelector('[data-flag-issue="' + key + '"]');
    if (at) return at;
  }
  return null;
}
function jmShowFlagIssues(issues, zoneIndex, zoneId, status) {
  const above = [];
  for (const i of issues) {
    const at = jmFlagIssueAt(i.path, zoneIndex, zoneId);
    if (at) at.textContent = (at.textContent ? at.textContent + ' ' : '') + i.message;
    else above.push((i.path ? i.path + ': ' : '') + i.message);
  }
  status.textContent = above.join('; ');
}
async function jmSaveFlags(zoneId, patch, revision, status, go, zoneIndex) {
  for (const s of document.querySelectorAll('[data-flag-issue]')) s.textContent = '';
  status.textContent = '';
  if (Object.keys(patch).length === 0) { status.textContent = 'Nothing changed.'; return 'unchanged'; }
  const base = '/zones/' + encodeURIComponent(zoneId) + '/flags';
  const r = await jmFetch('/api/control/config', { patch: { dropZones: [Object.assign({ id: zoneId }, patch)] }, expectRevision: revision, returnTo: base, cancelTo: base }, 'PATCH');
  return jmConfigAnswer(r, status, go, base, (issues) => jmShowFlagIssues(issues, zoneIndex, zoneId, status));
}
document.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('flag-search');
  if (search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const sec of document.querySelectorAll('section[data-group]')) {
      let any = false;
      for (const row of sec.querySelectorAll('tr[data-flag]')) {
        const hit = q === '' || row.dataset.search.includes(q);
        row.hidden = !hit;
        if (hit) any = true;
      }
      sec.hidden = !any;
    }
  });
  const form = document.getElementById('flags');
  if (!form || form.dataset.readonly === '1') return;
  for (const b of form.querySelectorAll('button.reset')) b.addEventListener('click', () => {
    const row = b.closest('tr');
    const on = row.dataset.reset !== '1';
    row.dataset.reset = on ? '1' : '';
    b.textContent = on ? 'Resets on save (undo)' : 'Reset to default';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = [];
    for (const row of form.querySelectorAll('tr[data-flag]')) {
      const key = row.dataset.flag;
      if (row.dataset.reset === '1') { fields.push({ key, reset: true }); continue; }
      const el = row.querySelector('[data-path]');
      if (!el || el.disabled) continue;
      fields.push({ key, kind: el.dataset.kind, value: el.dataset.kind === 'bool' ? el.checked : el.value, original: JSON.parse(el.dataset.original), explicit: row.dataset.explicit === '1' });
    }
    await jmSaveFlags(form.dataset.zone, jmFlagsPatch(fields), Number(form.dataset.revision), document.getElementById('flags-out'), (to) => { location.href = to; }, Number(form.dataset.index));
  });
});
</script>`;

/** The page, or undefined for an unknown zone. */
export function renderFlags(
  store: ConfigStore,
  id: string,
  o: { adoptBanner: string; forbiddenNote: string; saved?: number },
): string | undefined {
  const doc = store.document() as Record<string, unknown>;
  const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
  const index = zones.findIndex((z) => z.id === id);
  const raw = zones[index];
  const all = store.current().dropZones;
  const resolved = all.find((z) => z.id === id);
  if (!raw || !resolved) return undefined;
  const readOnly = store.mode() === 'file';
  const base = `/zones/${encodeURIComponent(id)}`;
  const rows = flagRows('zone', raw, doc);
  const sections = GROUP_HEADS.map(([group, head]) => {
    const mine = rows.filter((r) => r.entry.group === group);
    if (mine.length === 0) return '';
    return `<section data-group="${group}"><h3 data-group-head="${group}">${head}</h3><table><tr><th>Setting</th><th>Value</th><th></th></tr>${mine
      .map((r) => row(r, { base, readOnly, forbiddenNote: o.forbiddenNote }))
      .join('')}</table></section>`;
  }).join('\n');
  const saved =
    o.saved === undefined
      ? ''
      : `<p class="saved" role="status">Saved as revision ${o.saved}: it takes effect at the next pass.</p>`;
  return page(
    `<p><a href="/">Home</a> · <a href="/zones">Zones</a> · <a href="${base}">${zoneName(resolved, all)}</a> · <a href="${base}#advanced">Edit the zone as JSON</a></p>
<h2>Advanced settings · ${zoneName(resolved, all)}</h2>
<p>Every setting for this zone. Changes apply at the next pass; one that loosens a safeguard asks you to confirm first.</p>
${saved}${readOnly ? o.adoptBanner : ''}
<p><label>Search <input type="search" id="flag-search" placeholder="label, words or key" size="30"></label></p>
<form id="flags" data-zone="${escapeHtml(id)}" data-index="${index}" data-revision="${store.revision()}" data-readonly="${readOnly ? '1' : '0'}">
<p id="flags-out" role="status"></p>
${sections}
${readOnly ? '' : '<p><button id="flags-save">Save changes</button></p>'}
</form>
${FLAGS_SCRIPT}`,
    { title: `Advanced settings · ${zoneNameText(resolved, all)}` },
  );
}
