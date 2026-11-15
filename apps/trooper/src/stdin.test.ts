import { PassThrough, Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { readGrant, readLine } from './stdin.js';

const grant = {
  token: 'tok-SECRET',
  owner: 'o',
  name: 'n',
  branch: 'jm/x',
  base: 'main',
  lease: 'l',
  protectedPaths: [],
  secrets: [],
};

test('readLine returns two sequential lines from one stream', async () => {
  const s = Readable.from(['one\ntw', 'o\nrest']);
  expect(await readLine(s, 100)).toBe('one');
  expect(await readLine(s, 100)).toBe('two');
});

test('readLine leaves the stream open and waits for a later line', async () => {
  const s = new PassThrough();
  s.write('first\n');
  expect(await readLine(s, 100)).toBe('first');
  const second = readLine(s, 100);
  setTimeout(() => s.write('second\n'), 10);
  expect(await second).toBe('second');
  expect(s.destroyed).toBe(false);
});

test('readLine rejects past maxBytes', async () => {
  await expect(readLine(Readable.from(['x'.repeat(50)]), 10)).rejects.toThrow(
    'stdin line too long',
  );
  await expect(readLine(Readable.from(['x'.repeat(50), '\n']), 10)).rejects.toThrow(
    'stdin line too long',
  );
});

test('readLine rejects on EOF with no newline', async () => {
  await expect(readLine(Readable.from(['abc']), 100)).rejects.toThrow('stdin closed before a line');
});

test('readGrant reads the second line and validates it', async () => {
  const s = Readable.from([`{"junk":1}\n${JSON.stringify(grant)}\n`]);
  await readLine(s, 100);
  expect((await readGrant(s)).branch).toBe('jm/x');
});

test('readGrant never echoes the line on a bad grant', async () => {
  const bad = Readable.from(['{"token":"tok-SECRET","extra":1}\n']);
  const err = await readGrant(bad).catch((e) => e);
  expect(String(err.message)).not.toContain('tok-SECRET');
  const notJson = Readable.from(['tok-SECRET@\n']);
  const err2 = await readGrant(notJson).catch((e) => e);
  expect(String(err2.message)).not.toContain('tok-SECRET');
});
