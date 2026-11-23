import { RESTART_PATHS } from '../config/boot.js';
import { type FlagGroup, type FlagRow, type FlagScope, flagRows } from '../config/catalog.js';
import type { ConfigStore } from '../config/store.js';
import type { DropZoneConfig } from '../config.js';
import { SYSTEM_OTHER_MACHINES_HREF } from './links.js';
import { breadcrumb, escapeHtml, PROJECTS_HREF, page, projectHref } from './pages.js';
import { CONFIG_ANSWER_FN, RESTART_NOTE, settingControl, settingId } from './setting-controls.js';
import { type ZoneRef, zoneName, zoneNameText } from './zone-name.js';

/**
 * The advanced settings pages: a zone's (`/projects/:id/flags`, issue #322) and the install's
 * (`/system/advanced`, issue #323; #623 moved it from `/settings/flags`). Each lists every setting of its scope in the catalog, one per
 * row, grouped, with its plain words, a control, whether the document sets it and a Reset. One
 * Save sends one merge patch of what changed through `PATCH /api/control/config`, as the Setup
 * form and the Install tab do, so every guard and confirmation applies unchanged: the page only
 * mirrors them. In file mode every control is disabled. Both pages draw their rows with
 * `renderFlagsForm` and run `FLAGS_SCRIPT`.
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

/** Where Save sends a page's patch, and where the answer returns to. */
export interface FlagsTarget {
  /** This page: the answer returns here, and a confirmation's Cancel too. */
  savedTo: string;
  /** A zone page: the patch is the zone's, inside `dropZones`, at this index of the document. */
  zone?: { id: string; index: number };
}

export interface FlagsForm {
  scope: FlagScope;
  rows: readonly FlagRow[];
  target: FlagsTarget;
  /** The revision drawn: the save is conditional on it. */
  revision: number;
  readOnly: boolean;
  /** Where a browser-forbidden change is made instead (HTML). */
  forbiddenNote: string;
}

/**
 * The link beside an `elsewhere` sentence. A zone's: the Setup section it names, else none (the
 * Advanced JSON is read-only, #617). The install's: the Other machines tab for the address; none
 * for a setting changed only with ctl or in the file.
 */
function elsewhereLink(f: FlagsForm, r: FlagRow): string {
  const sentence = r.entry.elsewhere ?? '';
  if (f.scope === 'install') {
    return r.key === 'server.publicUrl'
      ? ` <a href="${SYSTEM_OTHER_MACHINES_HREF}">Other machines</a>`
      : '';
  }
  const base = projectHref(f.target.zone?.id ?? '');
  const named = /(\w+) section/.exec(sentence)?.[1]?.toLowerCase();
  if (!named) return '';
  return ` <a href="${base}/setup#${escapeHtml(named)}">${escapeHtml(`the ${named} section`)}</a>`;
}

/**
 * A browser-forbidden row is disabled: a session can't make that change. On the install, the
 * signed image policy is forbidden only to turn off, so it is disabled only while it's on (as on
 * the Install tab); a zone's is always disabled.
 */
function forbiddenLocked(f: FlagsForm, r: FlagRow): boolean {
  if (r.guard !== 'browser-forbidden') return false;
  return f.scope === 'zone' || r.entry.kind !== 'bool' || r.value === true;
}

/**
 * A record's control: one text input per key, each at its own path (`models.implement`), drawn
 * with the key's stored value and whether the document sets it. An empty input the document sets
 * sends null, which removes the key; one it doesn't set sends nothing.
 */
function recordControl(r: FlagRow, locked: boolean): string {
  const value = (r.value && typeof r.value === 'object' ? r.value : {}) as Record<string, unknown>;
  return (r.keys ?? [])
    .map((k) => {
      const path = `${r.key}.${k}`;
      const set = Object.hasOwn(value, k);
      return `<label for="${settingId(path)}">${escapeHtml(k)}</label> ${settingControl({
        path,
        kind: 'text',
        value: value[k],
        locked,
        attrs: `data-explicit="${set ? '1' : '0'}"`,
      })}`;
    })
    .join('<br>');
}

function row(f: FlagsForm, r: FlagRow): string {
  const { entry, key, guard } = r;
  const forbidden = forbiddenLocked(f, r);
  const locked = f.readOnly || forbidden || guard === 'refused';
  const control =
    entry.kind === 'elsewhere'
      ? `${escapeHtml(entry.elsewhere ?? '')}${elsewhereLink(f, r)}`
      : entry.kind === 'record'
        ? recordControl(r, locked)
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
    !f.readOnly &&
    !(f.scope === 'zone' && NO_RESET.includes(key)) &&
    guard !== 'browser-forbidden' &&
    guard !== 'refused';
  const def = r.defaultValue === undefined ? 'not set' : JSON.stringify(r.defaultValue);
  const marks = [
    r.explicit ? '<span class="set">set</span>' : '',
    resettable
      ? `<button type="button" class="reset" data-reset="${escapeHtml(key)}" title="Default: ${escapeHtml(def)}">Reset to default</button>`
      : '',
    guard === 'guarded' ? `<small>${GUARDED_NOTE}</small>` : '',
    forbidden ? `<small>${f.forbiddenNote}</small>` : '',
    guard === 'refused' ? `<small>${REFUSED_NOTE}</small>` : '',
    f.scope === 'install' && (RESTART_PATHS as readonly string[]).includes(key)
      ? `<small>${RESTART_NOTE}</small>`
      : '',
    `<span class="issue" data-flag-issue="${escapeHtml(key)}"></span>`,
  ]
    .filter(Boolean)
    .join(' ');
  const label =
    entry.kind === 'elsewhere' || entry.kind === 'record'
      ? `<strong>${escapeHtml(entry.label)}</strong>`
      : `<label for="${settingId(key)}">${escapeHtml(entry.label)}</label>`;
  const search = `${entry.label} ${entry.help} ${key}`.toLowerCase();
  return `<tr data-flag="${escapeHtml(key)}" data-search="${escapeHtml(search)}" data-explicit="${r.explicit ? '1' : '0'}"><td>${label}<br><code>${escapeHtml(key)}</code><br><small>${escapeHtml(entry.help)}</small></td><td>${control}</td><td>${marks}</td></tr>`;
}

/**
 * The page's script. `jmFlagsPatch` turns the rows' fields (`{ key, kind, value, original,
 * explicit }`, or `{ key, reset: true }`) into one nested merge patch of what changed;
 * `jmSaveFlags(target, …)` sends it (inside `dropZones` for a zone's target, as it is for the
 * install's), conditional on the revision drawn, and follows the answer with the shared
 * `jmConfigAnswer` back to `target.savedTo`, putting each issue beside its row.
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
function jmRowFields(row) {
  const key = row.dataset.flag;
  if (row.dataset.reset === '1') return [{ key, reset: true }];
  const fields = [];
  // One control per row, or one per key of a record, each at its own data-path.
  for (const el of row.querySelectorAll('[data-path]')) {
    if (el.disabled) continue;
    const own = el.dataset.explicit;
    fields.push({ key: el.dataset.path, kind: el.dataset.kind, value: el.dataset.kind === 'bool' ? el.checked : el.value, original: JSON.parse(el.dataset.original), explicit: (own === undefined ? row.dataset.explicit : own) === '1' });
  }
  return fields;
}
function jmFlagIssueAt(path, target) {
  const p = String(path || '');
  const z = target.zone;
  const pre = z ? ['dropZones.' + z.index + '.', 'dropZones[' + z.id + '].'].find((x) => p.startsWith(x)) : '';
  if (pre === undefined) return null;
  const parts = p.slice(pre.length).split('.');
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join('.');
    if (!/^[A-Za-z0-9_.]+$/.test(key)) continue;
    const at = document.querySelector('[data-flag-issue="' + key + '"]');
    if (at) return at;
  }
  return null;
}
function jmShowFlagIssues(issues, target, status) {
  const above = [];
  for (const i of issues) {
    const at = jmFlagIssueAt(i.path, target);
    if (at) at.textContent = (at.textContent ? at.textContent + ' ' : '') + i.message;
    else above.push((i.path ? i.path + ': ' : '') + i.message);
  }
  status.textContent = above.join('; ');
}
async function jmSaveFlags(target, patch, revision, status, go) {
  for (const s of document.querySelectorAll('[data-flag-issue]')) s.textContent = '';
  status.textContent = '';
  if (Object.keys(patch).length === 0) { status.textContent = 'Nothing changed.'; return 'unchanged'; }
  const body = target.zone ? { dropZones: [Object.assign({ id: target.zone.id }, patch)] } : patch;
  const r = await jmFetch('/api/control/config', { patch: body, expectRevision: revision, returnTo: target.savedTo, cancelTo: target.savedTo }, 'PATCH');
  return jmConfigAnswer(r, status, go, target.savedTo, (issues) => jmShowFlagIssues(issues, target, status));
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
    for (const row of form.querySelectorAll('tr[data-flag]')) fields.push(...jmRowFields(row));
    await jmSaveFlags(JSON.parse(form.dataset.target), jmFlagsPatch(fields), Number(form.dataset.revision), document.getElementById('flags-out'), (to) => { location.href = to; });
  });
});
</script>`;

/** The search box, the rows by group and the Save: the part both pages share. */
export function renderFlagsForm(f: FlagsForm): string {
  const sections = GROUP_HEADS.map(([group, head]) => {
    const mine = f.rows.filter((r) => r.entry.group === group);
    if (mine.length === 0) return '';
    return `<section data-group="${group}"><h3 data-group-head="${group}">${head}</h3><table><tr><th>Setting</th><th>Value</th><th></th></tr>${mine
      .map((r) => row(f, r))
      .join('')}</table></section>`;
  }).join('\n');
  return `<p><label>Search <input type="search" id="flag-search" placeholder="label, words or key" size="30"></label></p>
<form id="flags" data-scope="${f.scope}" data-target="${escapeHtml(JSON.stringify(f.target))}" data-revision="${f.revision}" data-readonly="${f.readOnly ? '1' : '0'}">
<p id="flags-out" role="status"></p>
${sections}
${f.readOnly ? '' : '<p><button id="flags-save">Save changes</button></p>'}
</form>`;
}

/** Said at the top after a save: only a revision number is ever echoed. */
export const savedNote = (saved: number | undefined): string =>
  saved === undefined
    ? ''
    : `<p class="saved" role="status">Saved as revision ${saved}: it takes effect at the next pass.</p>`;

/** A zone's page, or undefined for an unknown zone. */
export function renderFlags(
  store: ConfigStore,
  id: string,
  o: {
    adoptBanner: string;
    forbiddenNote: string;
    saved?: number;
    /** The project header and tab bar, in place of the breadcrumb (#616). */
    header?: (zone: DropZoneConfig, zones: readonly ZoneRef[]) => string;
  },
): string | undefined {
  const doc = store.document() as Record<string, unknown>;
  const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
  const index = zones.findIndex((z) => z.id === id);
  const raw = zones[index];
  const all = store.current().dropZones;
  const resolved = all.find((z) => z.id === id);
  if (!raw || !resolved) return undefined;
  const readOnly = store.mode() === 'file';
  const base = projectHref(id);
  const form = renderFlagsForm({
    scope: 'zone',
    rows: flagRows('zone', raw, doc),
    target: { savedTo: `${base}/flags`, zone: { id, index } },
    revision: store.revision(),
    readOnly,
    forbiddenNote: o.forbiddenNote,
  });
  return page(
    `${
      o.header
        ? `${o.header(resolved, all)}<p><a href="${base}/setup#advanced">View the zone as JSON</a></p>`
        : `${breadcrumb([
            { label: 'Projects', href: PROJECTS_HREF },
            { label: zoneName(resolved, all), href: base },
            { label: 'Advanced settings' },
          ])}<p><a href="${base}/setup#advanced">View the zone as JSON</a></p>`
    }
<h2>Advanced settings · ${zoneName(resolved, all)}</h2>
<p>Every setting for this zone. Changes apply at the next pass; one that loosens a safeguard asks you to confirm first.</p>
${savedNote(o.saved)}${readOnly ? o.adoptBanner : ''}
${form}
${FLAGS_SCRIPT}`,
    { title: `Advanced settings · ${zoneNameText(resolved, all)}` },
  );
}
