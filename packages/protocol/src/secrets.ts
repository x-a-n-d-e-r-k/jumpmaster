import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

const errno = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;

/**
 * A secret from `NAME`, or from the file named by `NAME_FILE` (compose and Docker secrets). Setting
 * both is an error. A file must be a regular file, readable, not group- or world-writable (checked
 * with fstat on the opened descriptor), and non-empty; one trailing newline is trimmed and any other
 * whitespace is refused. Errors name the variable and the path, never the value. An environment
 * value is returned as it is, as before.
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const fileVar = `${name}_FILE`;
  const path = env[fileVar];
  if (path === undefined || path === '') return env[name];
  if (env[name] !== undefined && env[name] !== '')
    throw new Error(`${name} and ${fileVar} are both set; set only one`);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    const code = errno(e);
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error(`${fileVar}: ${path} is not readable by uid ${process.getuid?.() ?? '?'}`);
    if (code === 'ENOENT') throw new Error(`${fileVar}: ${path} does not exist`);
    throw new Error(`${fileVar}: ${path} cannot be opened (${code ?? 'error'})`);
  }
  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${fileVar}: ${path} is not a regular file`);
    if ((stat.mode & 0o022) !== 0)
      throw new Error(`${fileVar}: ${path} is group- or world-writable; chmod go-w it`);
    try {
      raw = readFileSync(fd, 'utf8');
    } catch (e) {
      throw new Error(`${fileVar}: ${path} cannot be read (${errno(e) ?? 'error'})`);
    }
  } finally {
    closeSync(fd);
  }
  const value = raw.replace(/\r?\n$/, '');
  if (value === '') throw new Error(`${fileVar}: ${path} is empty`);
  if (/\s/.test(value)) throw new Error(`${fileVar}: the secret contains whitespace`);
  return value;
}
