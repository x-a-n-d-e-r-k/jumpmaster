import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { REDIRECTS } from './ui/redirects.js';

/**
 * The operator docs name pages by their current paths (issue #630): no page path in README.md,
 * SECURITY.md or docs/runbooks/*.md matches an old path in the redirect table. Plans and specs
 * under docs/superpowers/ are historical records and are not checked.
 */

const ROOT = new URL('../../../', import.meta.url);

const DOCS = [
  'README.md',
  'SECURITY.md',
  ...readdirSync(new URL('docs/runbooks/', ROOT))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/runbooks/${f}`),
];

/** A fastify `from` pattern as a regex over a whole path: `:param` is one segment. */
const patternOf = (from: string): RegExp =>
  new RegExp(
    `^${from
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}/?$`,
  );

const OLD = REDIRECTS.map((r) => ({ from: r.from, re: patternOf(r.from) }));

/**
 * The page paths in `text`: a `/` that starts a path (not inside a word, a file path or an
 * external URL's path), or the path of a URL on the local server, cut at `?` or `#`.
 */
function pagePaths(text: string): string[] {
  const paths: string[] = [];
  const local = /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|<[^>\s]+>)(?::\d+)?(\/[^\s`'")\]?#]*)/g;
  for (const m of text.matchAll(local)) paths.push(m[1] ?? '');
  const bare = /(?<![\w/.:~<>@$-])(\/[A-Za-z0-9_<>{}:.%-]+(?:\/[A-Za-z0-9_<>{}:.%-]+)*)/g;
  for (const m of text.matchAll(bare)) paths.push(m[1] ?? '');
  return paths;
}

/** The old page paths `text` names, each with the `from` pattern it matches. */
function oldPaths(text: string): string[] {
  const found: string[] = [];
  for (const path of pagePaths(text)) {
    const hit = OLD.find((o) => o.re.test(path));
    if (hit) found.push(`${path} (old ${hit.from})`);
  }
  return found;
}

describe('page paths in the operator docs', () => {
  test.each(DOCS)('%s names no moved page by its old path', (file) => {
    const text = readFileSync(new URL(file, ROOT), 'utf8');
    expect(oldPaths(text)).toEqual([]);
  });

  test('an old page path fails the check', () => {
    expect(oldPaths('Open `/zones/jm/goals` to see the objectives.')).toEqual([
      '/zones/jm/goals (old /zones/:id/goals)',
    ]);
    expect(oldPaths('see http://127.0.0.1:7420/settings/credentials')).toHaveLength(1);
    expect(oldPaths('the [Log](/observations?zone=jm)')).toHaveLength(1);
  });

  test('API paths, current pages and pages that did not move pass', () => {
    expect(oldPaths('curl /api/control/zones')).toEqual([]);
    expect(oldPaths('`/projects/jm/goals`, `/drops/<id>`, `/briefings/<n>`')).toEqual([]);
    expect(oldPaths('edit docs/runbooks/install.md or https://github.com/o/r/settings')).toEqual(
      [],
    );
  });
});
