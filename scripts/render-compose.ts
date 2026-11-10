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
  let inPorts = false;
  for (const line of out.split('\n')) {
    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    const item = /^\s*-\s*(\S.*?)\s*$/.exec(line);
    if (inPorts && item) {
      const port = (item[1] as string).replace(/^(['"])(.*)\1$/, '$2');
      if (!port.startsWith('127.0.0.1:')) throw new Error(`port ${port} is not bound to 127.0.0.1`);
      continue;
    }
    inPorts = false;
  }
  for (const line of out.split('\n')) {
    const m = /^\s*(?:-\s*)?image:\s*(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = (m[1] as string).replace(/^(['"])(.*)\1$/, '$2');
    if (!DIGEST_REF.test(value) || value.includes('$'))
      throw new Error(`image ${value} is not pinned by digest`);
  }
  return out;
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
