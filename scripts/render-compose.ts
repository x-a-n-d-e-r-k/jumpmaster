// Renders the release's compose.yaml from deploy/compose.yaml.tmpl and the release's image lock.
// Every `{{image NAME}}` becomes `<registry>/NAME@<digest>`; anything left unpinned is an error,
// so a published compose file never runs a tag; so is a port published beyond 127.0.0.1. The release workflow runs it with plain Node
// (type stripping), so it imports only Node's own modules:
//   node scripts/render-compose.ts deploy/compose.yaml.tmpl images.lock.json > compose.yaml
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Every image a release publishes, in the order the workflow builds them. */
export const RELEASE_IMAGES = [
  'jumpmaster-trooper',
  'jumpmaster-trooper-python',
  'jumpmaster-trooper-go',
  'jumpmaster-trooper-jvm',
  'jumpmaster-egress',
  'jumpmaster-server',
  'jumpmaster-stick',
] as const;

export type Lock = { registry: string; images: Record<string, string> };

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REGISTRY = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/;
const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DIGEST_REF = /@sha256:[0-9a-f]{64}$/;

export function renderCompose(template: string, lock: Lock): string {
  if (typeof lock.registry !== 'string' || !REGISTRY.test(lock.registry))
    throw new Error(`the lock's registry ${String(lock.registry)} is not a registry path`);
  for (const [name, digest] of Object.entries(lock.images ?? {}))
    if (typeof digest !== 'string' || !DIGEST.test(digest))
      throw new Error(`the lock's ${name} is not a sha256 digest`);
  const out = template.replace(/\{\{image ([^{}\s]+)\}\}/g, (_m, name: string) => {
    if (!NAME.test(name)) throw new Error(`{{image ${name}}} is not an image name`);
    const digest = lock.images[name];
    if (!digest) throw new Error(`the lock has no ${name}`);
    return `${lock.registry}/${name}@${digest}`;
  });
  const left = /\{\{[^\n]*?\}\}/.exec(out);
  if (left) throw new Error(`leftover placeholder ${left[0]}`);
  // Every published port is on loopback: the UI and its setup page are for this host only.
  checkPorts(out);
  for (const line of out.split('\n')) {
    const m = /^\s*(?:-\s*)?image:\s*(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = (m[1] as string).replace(/^(['"])(.*)\1$/, '$2');
    if (!DIGEST_REF.test(value) || value.includes('$'))
      throw new Error(`image ${value} is not pinned by digest`);
  }
  return out;
}

/** The line without a trailing `# comment` (a `#` outside quotes, at the start or after a space). */
function uncomment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1] as string)))
      return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2');

function checkPort(entry: string): void {
  const v = unquote(entry);
  if (v.startsWith('{')) {
    if (!/(^|[{,\s])host_ip:\s*['"]?127\.0\.0\.1['"]?\s*(,|\})/.test(v))
      throw new Error(`port ${v} is not bound to 127.0.0.1`);
    return;
  }
  if (!v.startsWith('127.0.0.1:')) throw new Error(`port ${v} is not bound to 127.0.0.1`);
}

/**
 * Every published port is on 127.0.0.1 and no service uses the host network, in whatever YAML
 * form the template takes: a block list with comments or blank lines in it, a flow list, or
 * long-form entries (which must say `host_ip: 127.0.0.1`). Node's own modules only (see the top).
 */
export function checkPorts(text: string): void {
  const lines = text.split('\n').map(uncomment);
  let service = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const svc = /^ {2}([A-Za-z0-9_.-]+):$/.exec(line);
    if (svc) service = svc[1] as string;
    if (/^\s*network_mode:\s*['"]?host['"]?$/.test(line))
      throw new Error(`service ${service || '?'} uses the host network`);
    const key = /^(\s*)ports:\s*(.*)$/.exec(line);
    if (!key) continue;
    const base = (key[1] as string).length;
    const rest = (key[2] as string).trim();
    if (rest) {
      const flow = /^\[(.*)\]$/.exec(rest);
      if (!flow) throw new Error(`ports: ${rest} is not a list this check reads`);
      for (const e of (flow[1] as string).match(/\{[^}]*\}|[^,]+/g) ?? [])
        if (e.trim()) checkPort(e);
      continue;
    }
    // The block: every following line indented deeper than `ports:`; blank lines don't end it.
    let item: string[] | null = null;
    let itemIndent = -1;
    const finish = () => {
      if (!item) return;
      const [first, ...more] = item;
      if (more.length === 0 && !/^[\w-]+:\s/.test(first as string)) checkPort(first as string);
      else {
        const map = [first, ...more].join(', ');
        if (!/(^|,\s*)host_ip:\s*['"]?127\.0\.0\.1['"]?(\s*,|$)/.test(map))
          throw new Error(`port {${map}} is not bound to 127.0.0.1`);
      }
      item = null;
    };
    for (i = i + 1; i < lines.length; i++) {
      const l = lines[i] as string;
      if (l.trim() === '') continue;
      const ind = indentOf(l);
      if (ind <= base) break;
      const dash = /^(\s*)-\s*(.*)$/.exec(l);
      if (dash && (itemIndent < 0 || (dash[1] as string).length === itemIndent)) {
        finish();
        itemIndent = (dash[1] as string).length;
        item = [(dash[2] as string).trim()];
      } else if (item && ind > itemIndent) item.push(l.trim());
      else throw new Error(`ports entry ${l.trim()} is not one this check reads`);
    }
    finish();
    i--;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [templatePath, lockPath] = process.argv.slice(2);
  try {
    if (!templatePath || !lockPath)
      throw new Error('usage: render-compose.ts <compose.yaml.tmpl> <images.lock.json>');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lock;
    process.stdout.write(renderCompose(readFileSync(templatePath, 'utf8'), lock));
  } catch (e) {
    process.stderr.write(`render-compose: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
