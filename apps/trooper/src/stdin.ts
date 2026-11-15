import type { Readable } from 'node:stream';
import { type PushGrant, PushGrantSchema } from '@jumpmaster/protocol';

/** A grant is a small JSON object; a megabyte is far beyond any real one. */
export const GRANT_MAX_BYTES = 1024 * 1024;

const toBuffer = (c: string | Buffer): Buffer => (typeof c === 'string' ? Buffer.from(c) : c);

/**
 * Read one newline-terminated line from a stream. Bytes after the newline are pushed back, so a
 * later call on the same stream (the grant, after the payload) sees them. The stream is left open.
 * With `eofEnds`, a stream that closes mid-line yields what it had (if anything).
 * The errors never quote what was read: a line may carry a credential.
 */
export function readLine(stream: Readable, maxBytes: number, eofEnds = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let held = Buffer.alloc(0);
    const done = (fn: () => void) => {
      stream.off('readable', pump);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      fn();
    };
    const onEnd = () =>
      done(() =>
        eofEnds && held.length > 0
          ? resolve(held.toString('utf8'))
          : reject(new Error('stdin closed before a line')),
      );
    const onError = (err: Error) => done(() => reject(err));
    const pump = () => {
      for (;;) {
        const chunk = stream.read() as string | Buffer | null;
        if (chunk === null) return;
        const buf = toBuffer(chunk);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          held = Buffer.concat([held, buf]);
          if (held.length > maxBytes) return done(() => reject(new Error('stdin line too long')));
          continue;
        }
        const line = Buffer.concat([held, buf.subarray(0, nl)]);
        if (line.length > maxBytes) return done(() => reject(new Error('stdin line too long')));
        const rest = buf.subarray(nl + 1);
        done(() => {
          if (rest.length > 0) stream.unshift(rest);
          resolve(line.toString('utf8'));
        });
        return;
      }
    };
    stream.on('readable', pump);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
    pump();
  });
}

/** Read the grant line the stick sends once this container has printed its ready line. */
export async function readGrant(stdin: Readable): Promise<PushGrant> {
  const line = await readLine(stdin, GRANT_MAX_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error('grant is not valid JSON');
  }
  const parsed = PushGrantSchema.safeParse(raw);
  // Zod issues can name values; say only that the grant was refused.
  if (!parsed.success) throw new Error('grant rejected: does not match the grant schema');
  return parsed.data;
}
