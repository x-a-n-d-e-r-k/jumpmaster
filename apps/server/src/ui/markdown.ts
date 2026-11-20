import { linkTarget } from './links.js';
import { escapeHtml, type LinkRefs, linkify } from './pages.js';

/**
 * Chat replies as HTML (#490): a small, fixed Markdown subset, and nothing else. Assistant text is
 * untrusted (it quotes issue bodies, PR text and tool output), so this is a trust boundary (D4):
 * every character of the input is escaped, and the only elements are the ones built here, from
 * the constructs below. Raw HTML in the input stays visible text.
 *
 * Blocks: ATX headings, paragraphs, one-level `-`/`*`/`1.` lists, fenced code, GFM pipe tables.
 * Inline: code spans, `**bold**`, `*italic*`/`_italic_`, and `[text](url)` links whose url is
 * `https://`, `http://` or a same-origin `/path`. Plain text runs go through `linkify`.
 */

// Every pattern here is linear on one line: no two quantifiers can split the same run of text.
// The inline constructs and the table delimiter are scanned by hand (#561).
const FENCE_OPEN = /^\s{0,3}```\s*[\w+#.-]*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;
const HEADING_OPEN = /^\s{0,3}(#{1,6})[ \t]/;
const BULLET = /^\s{0,3}[-*][ \t]+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)][ \t]+(.*)$/;
const DELIMITER_CELL = /^:?-+:?$/;

/** A link's url, allowed only as an absolute http(s) URL or a same-origin path (not `//`, `/\`). */
const SAFE_URL = /^(?:https?:\/\/|\/(?![/\\]))[^\s\x00-\x1f\x7f"'<>\\`]*$/i;

const isSpaceOrTab = (c: string | undefined) => c === ' ' || c === '\t';

/** `s` without the spaces and tabs at its end, scanned by hand (a `[ \t]+$` regex is quadratic). */
function trimTabsEnd(s: string): string {
  let end = s.length;
  while (end > 0 && isSpaceOrTab(s[end - 1])) end--;
  return s.slice(0, end);
}

const isFenceOpen = (line: string) => FENCE_OPEN.test(line.trimEnd());

/** An ATX heading's level and text, without the optional closing `#` run; undefined otherwise. */
function heading(line: string): { level: number; text: string } | undefined {
  const m = HEADING_OPEN.exec(line);
  if (!m) return undefined;
  const level = (m[1] as string).length;
  // `rest` keeps the one required separator at index 0, so a closing run needs its own.
  let rest = trimTabsEnd(line.slice(m[0].length - 1));
  let k = rest.length;
  while (k > 0 && rest[k - 1] === '#') k--;
  if (k < rest.length && k > 1 && isSpaceOrTab(rest[k - 1])) rest = trimTabsEnd(rest.slice(0, k));
  let start = 0;
  while (isSpaceOrTab(rest[start])) start++;
  return { level, text: rest.slice(start) };
}

/** A GFM delimiter row: optional outer pipes around one or more `:?-+:?` cells. */
function isDelimiterRow(line: string): boolean {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').every((c) => DELIMITER_CELL.test(c.trim()));
}

/** A letter, digit, `_` or `/`: `*` and `_` emphasis does not open after or close before one. */
const WORD_BEFORE = /[\p{L}\p{N}_/]$/u;
const WORD_AFTER = /^[\p{L}\p{N}_/]/u;

/**
 * `indexOf` for scans whose start never moves back: each needle remembers its last answer, so
 * repeated searches past an unclosed delimiter cost one pass over the line, not one per opener.
 */
function forwardFinder(text: string): (needle: string, from: number) => number {
  const memo = new Map<string, { from: number; at: number }>();
  return (needle, from) => {
    const m = memo.get(needle);
    if (m && from >= m.from && (m.at === -1 || m.at >= from)) return m.at;
    const at = text.indexOf(needle, from);
    memo.set(needle, { from, at });
    return at;
  };
}

/** For each index, whether it sits in a whitespace-free run holding `://` (a bare URL). */
function bareUrlMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const m of text.matchAll(/\S+/g)) {
    if (m[0].includes('://')) mask.fill(1, m.index, m.index + m[0].length);
  }
  return mask;
}

/**
 * One line's inline Markdown as HTML; inside a link's text, plain runs are only escaped.
 *
 * Scanned left to right; at each position the first construct that closes wins: a code span,
 * a link `[text](url)`, `**bold**`, `*italic*`, `_italic_`. Every closing delimiter is the
 * first one after the opener, found through `forwardFinder`, so the scan is linear.
 * `*` and `_` emphasis opens only after a non-word character other than `/`, closes only before
 * one, and never inside a bare URL, so globs, `2*3*4`, snake_case and URLs stay text.
 */
function inline(text: string, refs: LinkRefs, inLink = false): string {
  const plain = (s: string) => (inLink ? escapeHtml(s) : linkify(s, refs));
  const next = forwardFinder(text);
  const url = bareUrlMask(text);
  const opensAt = (i: number) =>
    url[i] !== 1 && !WORD_BEFORE.test(text.slice(Math.max(0, i - 2), i));
  const closesAt = (j: number) => !WORD_AFTER.test(text.slice(j + 1, j + 3));
  const nonSpace = (c: string | undefined) => c !== undefined && !/\s/.test(c);

  let out = '';
  let last = 0;
  const emit = (i: number, end: number, html: string) => {
    out += plain(text.slice(last, i)) + html;
    last = end;
    return end;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      const j = next('`', i + 1);
      if (j > i + 1) {
        i = emit(i, j + 1, `<code>${escapeHtml(text.slice(i + 1, j))}</code>`);
        continue;
      }
    } else if (c === '[') {
      const j = next(']', i + 1);
      const k = j !== -1 && text[j + 1] === '(' ? next(')', j + 2) : -1;
      if (k !== -1) {
        const href = text.slice(j + 2, k);
        i = emit(
          i,
          k + 1,
          !inLink && SAFE_URL.test(href)
            ? `<a href="${escapeHtml(href)}"${linkTarget(href)}>${inline(text.slice(i + 1, j), refs, true)}</a>`
            : plain(text.slice(i, k + 1)),
        );
        continue;
      }
    } else if (c === '*') {
      if (text[i + 1] === '*' && nonSpace(text[i + 2])) {
        const j = next('**', i + 3);
        if (j !== -1) {
          i = emit(i, j + 2, `<strong>${inline(text.slice(i + 2, j), refs, inLink)}</strong>`);
          continue;
        }
      }
      const em = emphasis(i, '*');
      if (em !== undefined) {
        i = em;
        continue;
      }
    } else if (c === '_') {
      const em = emphasis(i, '_');
      if (em !== undefined) {
        i = em;
        continue;
      }
    }
    i++;
  }
  return out + plain(text.slice(last));

  /** `*italic*` or `_italic_` opening at `i`: the index past it, or undefined. */
  function emphasis(i: number, mark: '*' | '_'): number | undefined {
    if (!nonSpace(text[i + 1]) || text[i + 1] === mark || !opensAt(i)) return undefined;
    const j = next(mark, i + 1);
    if (j === -1 || !nonSpace(text[j - 1]) || !closesAt(j)) return undefined;
    return emit(i, j + 1, `<em>${inline(text.slice(i + 1, j), refs, inLink)}</em>`);
  }
}

/** A table row's cells: the outer pipes dropped, split on the rest. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Whether lines `i` and `i + 1` open a pipe table: a row with a pipe, then a delimiter row. */
function tableAt(lines: string[], i: number): boolean {
  const head = lines[i] ?? '';
  const delim = lines[i + 1] ?? '';
  return head.includes('|') && delim.includes('|') && isDelimiterRow(delim);
}

const blank = (line: string) => line.trim() === '';

/** Whether a line starts a block other than a paragraph (so it ends the paragraph before it). */
const opensBlock = (lines: string[], i: number): boolean => {
  const line = lines[i] ?? '';
  return (
    isFenceOpen(line) ||
    heading(line) !== undefined ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    tableAt(lines, i)
  );
};

/** Chat Markdown as HTML: the subset above, every other character escaped. */
export function renderChatMarkdown(text: string, refs: LinkRefs): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      i++;
      continue;
    }
    if (isFenceOpen(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i] as string))
        body.push(lines[i++] as string);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const head = heading(line);
    if (head) {
      const tag = head.level <= 2 ? 'h3' : head.level === 3 ? 'h4' : 'h5';
      out.push(`<${tag}>${inline(head.text, refs)}</${tag}>`);
      i++;
      continue;
    }
    if (tableAt(lines, i)) {
      const head = cells(line);
      const row = (c: string[], tag: 'th' | 'td') =>
        `<tr>${head.map((_, k) => `<${tag}>${inline(c[k] ?? '', refs)}</${tag}>`).join('')}</tr>`;
      const body: string[] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i] as string) && (lines[i] as string).includes('|')) {
        body.push(row(cells(lines[i++] as string), 'td'));
      }
      out.push(
        `<table><thead>${row(head, 'th')}</thead>${body.length ? `<tbody>${body.join('')}</tbody>` : ''}</table>`,
      );
      continue;
    }
    const list = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : undefined;
    if (list) {
      const items: string[] = [];
      let item: RegExpExecArray | null;
      while (i < lines.length && (item = list.exec(lines[i] as string))) {
        items.push(`<li>${inline(item[1] as string, refs)}</li>`);
        i++;
      }
      const tag = list === BULLET ? 'ul' : 'ol';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    do para.push(inline((lines[i++] as string).trim(), refs));
    while (i < lines.length && !blank(lines[i] as string) && !opensBlock(lines, i));
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('');
}
