import { PassThrough, Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { readGrant, readLine, StdinClosedError } from './stdin.js';

const grant = {
  token: 'tok-SECRET',
  owner: 'o',
  name: 'n',
  branch: 'jm/x',
  base: 'main',
  lease: '',
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

test('readLine returns two lines written in one chunk of a byte stream, leaving it open', async () => {
  const s = new PassThrough();
  s.write('one\ntwo\n');
  expect(await readLine(s, 100)).toBe('one');
  expect(await readLine(s, 100)).toBe('two');
  expect(s.destroyed).toBe(false);
});

test('an EOF or a stream error is a StdinClosedError; a bad grant is not', async () => {
  await expect(readGrant(Readable.from(['{"token":']))).rejects.toBeInstanceOf(StdinClosedError);
  const broken = new PassThrough();
  const p = readGrant(broken);
  broken.destroy(new Error('EPIPE'));
  await expect(p).rejects.toBeInstanceOf(StdinClosedError);
  const bad = readGrant(Readable.from(['not json\n']));
  await expect(bad).rejects.toThrow('grant is not valid JSON');
  await expect(readGrant(Readable.from(['not json\n']))).rejects.not.toBeInstanceOf(
    StdinClosedError,
  );
});

test('readGrant refuses a lease that is not a full SHA, and an option-shaped base or branch (issue #262)', async () => {
  const read = (over: Record<string, unknown>) =>
    readGrant(Readable.from([`${JSON.stringify({ ...grant, ...over })}\n`]));
  expect((await read({ lease: 'a'.repeat(40) })).lease).toBe('a'.repeat(40));
  for (const over of [
    { lease: 'main' },
    { lease: '-x' },
    { lease: 'refs/heads/main' },
    { base: '--upload-pack=x' },
    { branch: '-x' },
  ])
    await expect(read(over), JSON.stringify(over)).rejects.toThrow('grant rejected');
});

test('readGrant refuses a grant whose owner or name is not a GitHub one, without echoing it (issue #265)', async () => {
  const tokenOwner = ['ghp', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'].join('_');
  const read = (over: Record<string, unknown>) =>
    readGrant(Readable.from([`${JSON.stringify({ ...grant, ...over })}\n`]));
  expect((await read({ owner: 'acme', name: 'wid.gets-2' })).name).toBe('wid.gets-2');
  for (const over of [
    { name: 'widgets?x' },
    { name: 'wid%2Fgets' },
    { name: '"x"' },
    { owner: '-acme' },
    { name: '..' },
    { owner: tokenOwner },
  ]) {
    const err = await read(over).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message, JSON.stringify(over)).toBe(
      'grant rejected: does not match the grant schema',
    );
  }
});
