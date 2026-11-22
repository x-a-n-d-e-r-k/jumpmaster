import { describe, expect, test } from 'vitest';
import { renderChatMarkdown } from './markdown.js';

const md = (text: string) => renderChatMarkdown(text, {});

/** The only hrefs allowed: absolute http(s) URLs and same-origin paths. */
const ALLOWED_HREF = /^(?:https?:\/\/|\/(?!\/))/;

/** Asserts `html` holds no script element, no event attribute in a tag, no disallowed href. */
function assertInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<(?:iframe|img|svg)/i);
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    expect(tag).not.toMatch(/\son\w*\s*=/i);
    expect(tag).toMatch(
      /^<\/?(?:p|br|h[345]|ul|ol|li|pre|code|strong|em|a|table|thead|tbody|tr|th|td)\b/,
    );
  }
  for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(ALLOWED_HREF);
}

describe('renderChatMarkdown', () => {
  test('ATX headings: # and ## are h3, ### is h4, deeper is h5', () => {
    expect(md('# One')).toBe('<h3>One</h3>');
    expect(md('## Merlin')).toBe('<h3>Merlin</h3>');
    expect(md('### Three')).toBe('<h4>Three</h4>');
    expect(md('#### Four')).toBe('<h5>Four</h5>');
    expect(md('###### Six')).toBe('<h5>Six</h5>');
    expect(md('#12 is not a heading')).toBe('<p>#12 is not a heading</p>');
  });

  test('paragraphs split on blank lines; a single newline is <br>', () => {
    expect(md('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
  });

  test('unordered lists with - or *, ordered lists with 1.', () => {
    expect(md('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(md('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(md('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(md('Intro\n- a\n\nAfter')).toBe('<p>Intro</p><ul><li>a</li></ul><p>After</p>');
  });

  test('fenced code: the language word is ignored and the body escaped', () => {
    expect(md('```ts\nconst a = 1 < 2;\n  x\n```')).toBe(
      '<pre><code>const a = 1 &lt; 2;\n  x</code></pre>',
    );
  });

  test('a fenced block renders **x**, <b> and [a](https://x) literally, escaped', () => {
    expect(md('```\n**x** <b> [a](https://x) #12\n```')).toBe(
      '<pre><code>**x** &lt;b&gt; [a](https://x) #12</code></pre>',
    );
    expect(renderChatMarkdown('```\n#12\n```', { repo: 'o/r' })).not.toContain('<a');
  });

  test('inline code, bold and italic', () => {
    expect(md('a `x <y>` b')).toBe('<p>a <code>x &lt;y&gt;</code> b</p>');
    expect(md('**monitor** it')).toBe('<p><strong>monitor</strong> it</p>');
    expect(md('*one* and _two_')).toBe('<p><em>one</em> and <em>two</em></p>');
    expect(md('snake_case_name stays')).toBe('<p>snake_case_name stays</p>');
    expect(md('**bold `code`**')).toBe('<p><strong>bold <code>code</code></strong></p>');
  });

  test('a GFM pipe table: header, delimiter, body rows', () => {
    const html = md('| A | B | C |\n|---|---|---|\n| 1 | **2** | 3 |\n| 4 | 5 | 6 |');
    expect(html).toBe(
      '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>' +
        '<tbody><tr><td>1</td><td><strong>2</strong></td><td>3</td></tr>' +
        '<tr><td>4</td><td>5</td><td>6</td></tr></tbody></table>',
    );
    expect(html.match(/<th>/g)).toHaveLength(3);
    expect(/<tbody>(.*)<\/tbody>/.exec(html)?.[1]?.match(/<tr>/g)).toHaveLength(2);
  });

  test('lines of pipes with no delimiter row stay a paragraph', () => {
    expect(md('| a | b |\n| c | d |')).toBe('<p>| a | b |<br>| c | d |</p>');
    expect(md('a | b')).toBe('<p>a | b</p>');
  });

  test('links: https, http and same-origin paths; external ones open in a new tab', () => {
    expect(md('[docs](https://ok.example/a?b=1&c=2)')).toBe(
      '<p><a href="https://ok.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>',
    );
    expect(md('[old](http://ok.example)')).toBe(
      '<p><a href="http://ok.example" target="_blank" rel="noopener noreferrer">old</a></p>',
    );
    expect(md('[drop](/drops/abc)')).toBe('<p><a href="/drops/abc">drop</a></p>');
    expect(md('[**b**](/x)')).toBe('<p><a href="/x"><strong>b</strong></a></p>');
  });

  test('a disallowed link url renders as escaped plain text', () => {
    expect(md('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
    expect(md('[x](//evil.example)')).toBe('<p>[x](//evil.example)</p>');
    expect(md('[x](/\\evil.example)')).toBe('<p>[x](/\\evil.example)</p>');
  });

  test('#12 links through linkify in text, not inside a code span or a link', () => {
    const refs = { repo: 'o/r' };
    expect(renderChatMarkdown('see #12', refs)).toBe(
      '<p>see <a href="https://github.com/o/r/issues/12" target="_blank" rel="noopener noreferrer">#12</a></p>',
    );
    expect(renderChatMarkdown('see `#12`', refs)).toBe('<p>see <code>#12</code></p>');
    expect(renderChatMarkdown('[about #12](/x)', refs)).toBe('<p><a href="/x">about #12</a></p>');
    expect(md('Ruling 3 and Briefing 4')).toBe(
      '<p><a href="/briefings#ruling-3">Ruling 3</a> and <a href="/briefings/4">Briefing 4</a></p>',
    );
  });

  test('raw HTML stays visible, escaped text', () => {
    expect(md('<a href="https://x">hi</a>')).toBe(
      '<p>&lt;a href=&quot;https://x&quot;&gt;hi&lt;/a&gt;</p>',
    );
  });

  test('long adversarial lines render in linear time, still inert', () => {
    const n = 200_000;
    for (const text of [
      `a | b\n|-${' '.repeat(n)}x`,
      `a | b\nc${' '.repeat(n)}|x`,
      '[a '.repeat(n / 3),
      '[a](b '.repeat(n / 6),
      '**a '.repeat(n / 4),
      'a**b '.repeat(n / 5),
      '/**'.repeat(n / 3),
      '**a** **/'.repeat(n / 9),
      '**/a b/** '.repeat(n / 10),
      '*.a b/** '.repeat(n / 9),
      '*a '.repeat(n / 3),
      ' _a'.repeat(n / 3),
      '`a '.repeat(n / 3),
      `# a${' '.repeat(n)}x`,
      `\`\`\`${' '.repeat(n)}!`,
      `- a${' '.repeat(n)}x`,
      `<script>${'*a '.repeat(n / 3)}`,
    ]) {
      const t = performance.now();
      const html = md(text);
      expect(performance.now() - t).toBeLessThan(500);
      assertInert(html);
      expect(html).not.toMatch(/<script/i);
    }
  });

  test('double asterisks in globs, arithmetic and bare URLs stay text', () => {
    expect(md('globs apps/**/src and packages/**/test here')).toBe(
      '<p>globs apps/**/src and packages/**/test here</p>',
    );
    expect(md('matches **/*.test.ts and **/*.spec.ts')).toBe(
      '<p>matches **/*.test.ts and **/*.spec.ts</p>',
    );
    expect(md('2**3**4')).toBe('<p>2**3**4</p>');
    expect(md('see https://example.com/a**b**c')).toBe('<p>see https://example.com/a**b**c</p>');
  });

  test('a glob ending in ** does not close bold or italic', () => {
    expect(md('matches **/*.test.ts and apps/**')).toBe('<p>matches **/*.test.ts and apps/**</p>');
    expect(md('**/*.md and docs/**')).toBe('<p>**/*.md and docs/**</p>');
    expect(md('**/dist is ignored, like build/**.')).toBe(
      '<p>**/dist is ignored, like build/**.</p>',
    );
    expect(md('*.ts or src/**')).toBe('<p>*.ts or src/**</p>');
    expect(md('*a b** c')).toBe('<p>*a b** c</p>');
  });

  test('bold still renders in ordinary positions', () => {
    expect(md('**bold** and (**bold**), **bold**.')).toBe(
      '<p><strong>bold</strong> and (<strong>bold</strong>), <strong>bold</strong>.</p>',
    );
    expect(md('**Note:** see `x`')).toBe('<p><strong>Note:</strong> see <code>x</code></p>');
    expect(md('- **item** here')).toBe('<ul><li><strong>item</strong> here</li></ul>');
    expect(md('a | b\n-|-\n**c** | d')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
        '<tbody><tr><td><strong>c</strong></td><td>d</td></tr></tbody></table>',
    );
    expect(md('[**b** c](/x)')).toBe('<p><a href="/x"><strong>b</strong> c</a></p>');
    expect(md('**a *b* _c_**')).toBe('<p><strong>a <em>b</em> <em>c</em></strong></p>');
  });

  test('asterisks and underscores in globs, arithmetic and bare URLs stay text', () => {
    expect(md('globs apps/*/src/*.ts here')).toBe('<p>globs apps/*/src/*.ts here</p>');
    expect(md('2*3*4')).toBe('<p>2*3*4</p>');
    expect(md('see https://example.com/_next_/x')).toBe('<p>see https://example.com/_next_/x</p>');
    expect(md('a/_b_ c')).toBe('<p>a/_b_ c</p>');
    expect(md('*one* and _two_')).toBe('<p><em>one</em> and <em>two</em></p>');
    expect(md('(*one*), _two_.')).toBe('<p>(<em>one</em>), <em>two</em>.</p>');
  });

  describe('XSS inputs render inert', () => {
    const cases: [string, string][] = [
      ['<script>alert(1)</script>', '&lt;script&gt;'],
      ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
      ['[x](javascript:alert(1))', 'javascript:'],
      ['[x](JaVaScRiPt:alert(1))', 'JaVaScRiPt:'],
      ['[x](java&#115;cript:alert(1))', 'java&amp;#115;cript:'],
      ['[x]( javascript:alert(1))', '( javascript:'],
      ['[x](//evil.example)', '(//evil.example)'],
      ['[x](data:text/html,<script>)', 'data:text/html,&lt;script&gt;'],
      ['[x](https://ok.example" onmouseover="x)', '&quot; onmouseover=&quot;x)'],
      ['**<svg onload=x>**', '<strong>&lt;svg onload=x&gt;</strong>'],
      ['[x](https://a', '[x](https://a'],
      ['## Title <iframe src=x>', '<h3>Title &lt;iframe src=x&gt;</h3>'],
    ];
    for (const [input, shown] of cases) {
      test(input, () => {
        const html = md(input);
        assertInert(html);
        expect(html).not.toContain('<a ');
        expect(html).toContain(shown);
      });
    }
  });
});
