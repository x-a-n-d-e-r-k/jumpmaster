import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const errno = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;

/** The largest secret file read; tokens are well under 1 KiB. */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * A secret from `NAME`, or from the file named by `NAME_FILE` (compose and Docker secrets). Setting
 * both is an error. Errors name the variable and the path, never the value.
 *
 * The file is opened non-blocking, so a FIFO or device can't stall startup, and `fstat` on that
 * descriptor must show a regular file that is not group- or world-writable and at most 64 KiB
 * before anything is read.
 *
 * Whitespace differs by source, on purpose:
 * - A file value has exactly one trailing `\n` (or `\r\n`) trimmed, since `echo` and editors add
 *   one. Any other whitespace is refused, including a second newline, leading or trailing spaces,
 *   and a UTF-8 byte-order mark (U+FEFF counts as whitespace, so a BOM is reported as "contains
 *   whitespace"; save the file without one).
 * - An environment value is returned exactly as set, as before M4, so existing deployments read the
 *   same bytes. A token set in the environment with a trailing newline therefore differs from the
 *   same token read from a file; a server and stick sharing the join token should use the same
 *   source, or a value with no trailing newline.
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const fileVar = `${name}_FILE`;
  const path = env[fileVar];
  if (path === undefined || path === '') return env[name];
  if (env[name] !== undefined && env[name] !== '')
    throw new Error(`${name} and ${fileVar} are both set; set only one`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
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
    if (stat.size > MAX_SECRET_FILE_BYTES)
      throw new Error(`${fileVar}: ${path} is larger than 64 KiB`);
    // Read at most one byte past the cap, in case the file grew after fstat.
    const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let length = 0;
    try {
      for (;;) {
        const n = readSync(fd, buffer, length, buffer.length - length, null);
        if (n === 0) break;
        length += n;
        if (length > MAX_SECRET_FILE_BYTES)
          throw new Error(`${fileVar}: ${path} is larger than 64 KiB`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(fileVar)) throw e;
      throw new Error(`${fileVar}: ${path} cannot be read (${errno(e) ?? 'error'})`);
    }
    raw = buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const value = raw.replace(/\r?\n$/, '');
  if (value === '') throw new Error(`${fileVar}: ${path} is empty`);
  if (/\s/.test(value)) throw new Error(`${fileVar}: the secret contains whitespace`);
  return value;
}
