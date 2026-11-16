// The installer's routes (issue #138), reached at `server.publicUrl` from a machine that has
// nothing but the one-time code:
// - `GET /install/stick.sh`: the script, without auth (it holds no secret);
// - `GET /install/cosign?platform=`: the pinned cosign for that platform;
// - `GET /install/stick-image.tar?platform=`: the release's stick image as an OCI layout tar.
// Both downloads take the code as `Authorization: Bearer` and check it (unused, unexpired)
// without consuming it: only the stick's enrollment does that.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { configReader, type LiveConfig } from '../config/source.js';
import type { Db } from '../db/open.js';
import { pendingInviteByHash } from '../db/repo.js';
import type { ImageMirror } from '../images/mirror.js';
import { layoutFor } from '../images/serve.js';
import { PUBLIC_URL_NEEDED, publicOrigin } from '../reach.js';
import { codeHash, ENROLL_CODE } from './invite.js';
import {
  COSIGN_SHA256,
  repositoryOf,
  STICK_IMAGE_NAME,
  type StickScriptParams,
  stickScript,
} from './stick-sh.js';

/** Where the server image keeps cosign, as `<dir>/linux-<arch>/cosign`. */
export const COSIGN_DIR = '/app/install/cosign';

const PLATFORMS = new Set(['linux/amd64', 'linux/arm64']);

export interface InstallRouteDeps {
  db: Db;
  config: LiveConfig;
  now(): Date;
  images?: Pick<ImageMirror, 'lookup' | 'status'>;
  /** The release signer (`owner/name`); default from the environment. */
  signerRepository?: string | null;
  /** Where cosign is, per platform; default `JM_COSIGN_DIR` or `/app/install/cosign`. */
  cosignDir?: string;
  /** cosign's pinned SHA-256 per platform (tests serve a stand-in). */
  cosignSha256?: StickScriptParams['cosignSha256'];
}

/**
 * The repository whose release workflow signs the images: `JM_TRUSTED_SIGNER_REPOSITORY`, else
 * the server image's source (`JM_SOURCE_URL`, set from the release build's SOURCE_URL).
 */
export function signerFromEnv(env: NodeJS.ProcessEnv): string | null {
  return env.JM_TRUSTED_SIGNER_REPOSITORY || repositoryOf(env.JM_SOURCE_URL);
}

/** The current release's stick image the mirror holds, if any. */
function stickImage(
  images: InstallRouteDeps['images'],
): { name: string; ref: string; digest: string } | null {
  const i = images?.status().images.find((x) => x.name === STICK_IMAGE_NAME && x.current);
  return i ? { name: i.name, ref: i.ref, digest: i.digest } : null;
}

export function registerInstallRoutes(app: FastifyInstance, deps: InstallRouteDeps): void {
  const live = configReader(deps.config);
  const signer =
    deps.signerRepository === undefined ? signerFromEnv(process.env) : deps.signerRepository;
  const cosignDir = deps.cosignDir ?? (process.env.JM_COSIGN_DIR || COSIGN_DIR);
  const sums = deps.cosignSha256 ?? COSIGN_SHA256;

  /** The code is valid (pending), or the request is answered 401 as a wrong join token is. */
  const authorized = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const code = m?.[1];
    if (code && ENROLL_CODE.test(code) && pendingInviteByHash(deps.db, codeHash(code), deps.now()))
      return true;
    void reply.code(401).header('cache-control', 'no-store').send({ error: 'unauthorized' });
    return false;
  };

  const platformOf = (req: FastifyRequest<{ Querystring: { platform?: unknown } }>) => {
    const p = req.query.platform;
    return typeof p === 'string' && PLATFORMS.has(p) ? p : undefined;
  };

  app.get('/install/stick.sh', async (_req, reply) => {
    const serverUrl = publicOrigin(live());
    reply.header('cache-control', 'no-store').type('text/x-shellscript; charset=utf-8');
    if (!serverUrl)
      return reply
        .code(404)
        .send(`#!/bin/sh\necho 'jumpmaster: ${PUBLIC_URL_NEEDED} first (Settings)' >&2\nexit 1\n`);
    const image = stickImage(deps.images);
    return stickScript({
      serverUrl,
      image: image ? { ref: image.ref, digest: image.digest } : null,
      signerRepository: signer,
      cosignSha256: sums,
    });
  });

  app.get<{ Querystring: { platform?: unknown } }>('/install/cosign', async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const platform = platformOf(req);
    if (!platform)
      return reply.code(400).send({ error: 'platform must be linux/amd64 or linux/arm64' });
    const file = join(cosignDir, platform.replace('/', '-'), 'cosign');
    if (!existsSync(file))
      return reply.code(404).send({ error: 'this server has no cosign for that platform' });
    return reply
      .header('cache-control', 'no-store')
      .header('content-type', 'application/octet-stream')
      .header('content-length', statSync(file).size)
      .send(createReadStream(file));
  });

  app.get<{ Querystring: { platform?: unknown } }>(
    '/install/stick-image.tar',
    async (req, reply) => {
      if (!authorized(req, reply)) return reply;
      const platform = platformOf(req);
      if (!platform)
        return reply.code(400).send({ error: 'platform must be linux/amd64 or linux/arm64' });
      const image = stickImage(deps.images);
      if (!image || !deps.images)
        return reply.code(404).send({ error: 'this server mirrors no stick image' });
      const answer = layoutFor(deps.images.lookup(image.name, image.digest), platform);
      if (!answer.ok) return reply.code(answer.status).send(answer.body);
      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'application/x-tar')
        .header('content-length', answer.size)
        .send(answer.stream());
    },
  );
}
