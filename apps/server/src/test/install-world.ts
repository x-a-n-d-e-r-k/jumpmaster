// The whole app for the stick installer's routes (issues #138, #269): a mirror holding one stick
// image, cosign and a trusted root on disk, a public address, and an operator session.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { type Db, openDb } from '../db/open.js';
import { ScrubSet } from '../forge/scrub-set.js';
import type { ImageMirror } from '../images/mirror.js';
import type { ImageRecord, ImageStore } from '../images/store.js';
import { operatorSession, t0, tmpDbFile } from './helpers.js';

export const HOST = '127.0.0.1:7420';
export const JOIN = 'join-secret-value-4';
export const TOKEN = 'o'.repeat(32);
export const PUBLIC = 'https://jm.tail1234.ts.net';
export const CODE = /jm_enroll_[A-Za-z0-9_-]{43}/;
export const DAY = 24 * 60 * 60 * 1000;

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const TRUSTED_ROOT =
  '{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1"}';

/** A mirror holding one complete stick image for linux/amd64, its blobs in a temp directory. */
export function fakeImages(): Pick<ImageMirror, 'lookup' | 'status'> & { digest: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jm-blobs-'));
  const blob = (content: string, mediaType: string) => {
    const bytes = Buffer.from(content);
    const digest = `sha256:${sha(bytes)}`;
    writeFileSync(join(dir, digest.slice(7)), bytes);
    return { mediaType, digest, size: bytes.length };
  };
  const config = blob('{"config":1}', 'application/vnd.oci.image.config.v1+json');
  const layer = blob('layer-bytes', 'application/vnd.oci.image.layer.v1.tar+gzip');
  const manifest = blob(
    JSON.stringify({ config, layers: [layer] }),
    'application/vnd.oci.image.manifest.v1+json',
  );
  const index = blob(
    JSON.stringify({ manifests: [manifest] }),
    'application/vnd.oci.image.index.v1+json',
  );
  const store = {
    blobPath: (d: string) => join(dir, d.slice(7)),
    has: (d: string) => [config, layer, manifest, index].some((b) => b.digest === d),
    size: (d: string) => [config, layer, manifest, index].find((b) => b.digest === d)?.size ?? -1,
  } as unknown as ImageStore;
  const record: ImageRecord = {
    name: 'jumpmaster-stick',
    registry: 'ghcr.io/o',
    digest: index.digest,
    state: 'complete',
    attempts: 1,
    updatedAt: t0.toISOString(),
    index,
    platforms: { 'linux/amd64': { manifest, blobs: [config, layer] } },
    signatures: [],
    size: 1,
  };
  return {
    digest: index.digest,
    status: () => ({
      lock: true,
      images: [
        {
          name: record.name,
          digest: record.digest,
          ref: `ghcr.io/o/jumpmaster-stick@${record.digest}`,
          state: 'complete',
          platforms: ['linux/amd64'],
          size: 1,
          current: true,
        },
      ],
    }),
    lookup: (name, digest) =>
      name === record.name && digest === record.digest
        ? { listed: true, record, store, complete: true }
        : { listed: false },
  };
}

let app: FastifyInstance | undefined;
/** Closes the app the last `installWorld` made (an `afterEach`). */
export async function closeInstallWorld(): Promise<void> {
  await app?.close();
  app = undefined;
}

type Reply = Promise<LightMyRequestResponse>;

/** The app and its parts, with the requests the tests send. */
export interface InstallWorld {
  db: Db;
  store: ConfigStore;
  scrub: ScrubSet;
  images: ReturnType<typeof fakeImages>;
  session: Record<string, string>;
  /** The session has sudo for a minute from the clock's now. */
  sudo(): void;
  proto: Record<string, string>;
  trustedRootFile: string;
  setClock(d: Date): void;
  inject(opts: InjectOptions): Reply;
  add(payload: Record<string, unknown>): Reply;
  /** An invite made with sudo: its code, read off the result page. */
  invite(name: string, slots?: number | 'auto'): Promise<string>;
  enroll(cred: Record<string, string>): Reply;
  page(): Promise<string>;
  image(code?: string): Reply;
}

export async function installWorld(o: { publicUrl?: boolean } = {}): Promise<InstallWorld> {
  const db: Db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-invite-'));
  const env = { JM_JOIN_TOKEN: JOIN, JM_OPERATOR_TOKEN: TOKEN, JM_DEV_IMAGES: '1' };
  const filePath = join(dir, 'jumpmaster.config.json');
  const store = ConfigStore.open({
    db,
    boot: loadBoot({ ...env, JM_DATA_DIR: dir }, filePath),
    filePath,
    env,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const cosignDir = join(dir, 'cosign');
  mkdirSync(join(cosignDir, 'linux-amd64'), { recursive: true });
  writeFileSync(join(cosignDir, 'linux-amd64', 'cosign'), 'fake-cosign');
  const trustedRootFile = join(dir, 'trusted_root.json');
  writeFileSync(trustedRootFile, TRUSTED_ROOT);
  const scrub = new ScrubSet();
  const images = fakeImages();
  let clock = t0;
  const a = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no forge');
    },
    now: () => clock,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
    images,
    scrub,
    install: {
      signerRepository: 'o/jumpmaster',
      cosignDir,
      cosignSha256: { amd64: sha('fake-cosign'), arm64: 'f'.repeat(64) },
      trustedRootFile,
    },
  });
  app = a;
  if (o.publicUrl !== false) {
    const r = await a.inject({
      method: 'PUT',
      url: '/api/control/server/public-url',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
      payload: { publicUrl: PUBLIC },
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  const s = operatorSession(db, t0);
  const session = { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf };
  /** The session has sudo for a minute from the clock's now. */
  const sudo = (): void => {
    db.prepare('UPDATE sessions SET sudo_until = ?').run(
      new Date(clock.getTime() + 60_000).toISOString(),
    );
  };
  const proto = { host: HOST, 'x-jumpmaster-protocol': '1' };
  return {
    db,
    store,
    scrub,
    images,
    session,
    sudo,
    proto,
    trustedRootFile,
    setClock: (d: Date) => {
      clock = d;
    },
    inject: (opts) => a.inject(opts),
    add: (payload: Record<string, unknown>) =>
      a.inject({ method: 'POST', url: '/system/sticks/add', headers: session, payload }),
    /** An invite made with sudo: its code, read off the result page. */
    invite: async (name: string, slots: number | 'auto' = 'auto') => {
      sudo();
      const r = await a.inject({
        method: 'POST',
        url: '/system/sticks/add',
        headers: session,
        payload: { name, slots },
      });
      expect(r.statusCode, r.body).toBe(200);
      return CODE.exec(r.body)?.[0] as string;
    },
    enroll: (cred: Record<string, string>) =>
      a.inject({
        method: 'POST',
        url: '/api/sticks/enroll',
        headers: proto,
        payload: { ...cred, name: 'stick', slots: 1, capabilities: [] },
      }),
    page: async () =>
      (
        await a.inject({
          method: 'GET',
          url: '/system/sticks',
          headers: { host: HOST, cookie: s.cookie },
        })
      ).body,
    image: (code?: string) =>
      a.inject({
        method: 'GET',
        url: '/install/stick-image.tar?platform=linux/amd64',
        headers: { host: 'any.example', ...(code ? { authorization: `Bearer ${code}` } : {}) },
      }),
  };
}
