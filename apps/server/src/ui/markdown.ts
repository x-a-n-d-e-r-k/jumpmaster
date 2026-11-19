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

const FENCE_OPEN = /^\s{0,3}```\s*[\w+#.-]*\s*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;
const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^\s{0,3}[-*][ \t]+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)][ \t]+(.*)$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** A link's url, allowed only as an absolute http(s) URL or a same-origin path (not `//`, `/\`). */
const SAFE_URL = /^(?:https?:\/\/|\/(?![/\\]))[^\s\x00-\x1f\x7f"'<>\\`]*$/i;

/**
 * The inline constructs, leftmost first, earlier alternatives first at one position: a code span,
 * a link, bold, `*italic*`, `_italic_` (not inside a word, so snake_case stays text).
 */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]*)\]\(([^)\n]*)\)|\*\*(?=\S)(.+?)\*\*|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu;

/** One line's inline Markdown as HTML; inside a link's text, plain runs are only escaped. */
function inline(text: string, refs: LinkRefs, inLink = false): string {
  const plain = (s: string) => (inLink ? escapeHtml(s) : linkify(s, refs));
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const [all, code, linkText, url, bold, star, under] = m;
    out += plain(text.slice(last, m.index));
    last = m.index + all.length;
    if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else if (linkText !== undefined && url !== undefined) {
      out +=
        !inLink && SAFE_URL.test(url)
          ? `<a href="${escapeHtml(url)}"${linkTarget(url)}>${inline(linkText, refs, true)}</a>`
          : plain(all);
    } else if (bold !== undefined) out += `<strong>${inline(bold, refs, inLink)}</strong>`;
    else out += `<em>${inline(star ?? under ?? '', refs, inLink)}</em>`;
  }
  return out + plain(text.slice(last));
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
  return head.includes('|') && delim.includes('|') && DELIMITER.test(delim);
}

const blank = (line: string) => line.trim() === '';

/** Whether a line starts a block other than a paragraph (so it ends the paragraph before it). */
const opensBlock = (lines: string[], i: number): boolean => {
  const line = lines[i] ?? '';
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
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
    if (FENCE_OPEN.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i] as string))
        body.push(lines[i++] as string);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
      out.push(`<${tag}>${inline(heading[2] as string, refs)}</${tag}>`);
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
