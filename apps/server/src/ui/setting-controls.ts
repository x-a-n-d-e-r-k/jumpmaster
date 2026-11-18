import { escapeHtml } from './pages.js';

/**
 * The controls and the save-answer handling shared by the settings pages: the Install tab
 * (`settings.ts`) and a zone's advanced settings page (`flags.ts`). Each control carries its
 * path, its kind and the value it was drawn with (`data-original`), so a page's script sends only
 * what changed; every value is escaped.
 */

export type ControlKind = 'number' | 'bool' | 'text' | 'select' | 'list';

export interface Control {
  path: string;
  kind: ControlKind;
  value: unknown;
  /** `<input>` attributes for a number (min, max, step). */
  attrs?: string;
  options?: readonly string[];
  /** How a select's option reads (default: its value). */
  optionLabel?: (option: string) => string;
  /** A select's first option, with the empty value, for an unset optional setting. */
  empty?: string;
  /** Read-only: drawn disabled. */
  locked?: boolean;
}

/** Changes that take effect only when the server restarts. */
export const RESTART_NOTE = 'takes effect at the next restart';

/** The id that ties a setting's control to its `<label for>`. */
export const settingId = (path: string): string => `setting-${path.replaceAll('.', '-')}`;

export function settingControl(s: Control): string {
  const data = `id="${settingId(s.path)}" data-path="${escapeHtml(s.path)}" data-kind="${s.kind}" data-original="${escapeHtml(JSON.stringify(s.value ?? null))}"`;
  const lock = s.locked ? ' disabled' : '';
  if (s.kind === 'bool')
    return `<input type="checkbox" ${data}${s.value ? ' checked' : ''}${lock}>`;
  if (s.kind === 'select') {
    const empty =
      s.empty === undefined
        ? ''
        : `<option value=""${s.value === undefined || s.value === null ? ' selected' : ''}>${escapeHtml(s.empty)}</option>`;
    return `<select ${data}${lock}>${empty}${(s.options ?? [])
      .map(
        (o) =>
          `<option value="${escapeHtml(o)}"${o === s.value ? ' selected' : ''}>${escapeHtml(s.optionLabel?.(o) ?? o)}</option>`,
      )
      .join('')}</select>`;
  }
  if (s.kind === 'list') {
    const lines = Array.isArray(s.value) ? s.value.map(String).join('\n') : '';
    return `<textarea rows="${Math.min(8, Math.max(3, lines.split('\n').length + 1))}" cols="40" ${data}${lock}>${escapeHtml(lines)}</textarea>`;
  }
  const value = s.value === null || s.value === undefined ? '' : String(s.value);
  const type = s.kind === 'number' ? `type="number" ${s.attrs ?? ''}` : 'type="text"';
  return `<input ${type} ${data} value="${escapeHtml(value)}"${lock}>`;
}

/**
 * `jmConfigAnswer(r, status, go, savedTo, onIssues)` follows `PATCH /api/control/config`'s answer:
 * applied (to `savedTo?saved=<revision>`), the confirmation page (`go`), a conflict, the
 * ctl-or-file note, or the issues: to `onIssues` when given, else into `status`. It returns
 * which one it was. Each page's script embeds it.
 */
export const CONFIG_ANSWER_FN = `async function jmConfigAnswer(r, status, go, savedTo, onIssues) {
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (r.ok) {
    const restart = j.restartNeeded && j.restartNeeded.length ? ' ' + j.restartNeeded.join(', ') + ' ${RESTART_NOTE}.' : '';
    status.textContent = 'Applied as revision ' + j.revision + ': it takes effect at the next pass.' + restart;
    // Drawn again with the saved values, saying which revision it saved (and any restart badge).
    go(savedTo + '?saved=' + encodeURIComponent(j.revision));
    return 'saved';
  }
  if (r.status === 409 && j.needsConfirmation) { go(j.confirm); return 'confirm'; }
  if (r.status === 409 && j.conflict) { status.textContent = 'The config changed since this page was drawn: reload it and make the change again.'; return 'conflict'; }
  if (r.status === 403 && j.sessionForbidden) { status.textContent = 'Not from the browser: ' + j.sessionForbidden.join(', ') + ' is set with jumpmaster ctl or in the config file.'; return 'forbidden'; }
  if (j.issues) {
    if (onIssues) onIssues(j.issues);
    else status.textContent = j.issues.map((i) => (i.path ? i.path + ': ' : '') + i.message).join('; ');
    return 'refused';
  }
  status.textContent = j.error || ('Refused (' + r.status + ')');
  return 'refused';
}`;
