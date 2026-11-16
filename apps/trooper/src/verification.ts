import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_PREFIX,
  type ItemDropPayload,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  MEDIA_EXTENSIONS,
  pathMatches,
  sniffMediaType,
} from '@jumpmaster/protocol';
import { scrubEnv } from './gates.js';
import type { TrooperDeps } from './main.js';
import { listAgentFiles, readAgentBytes } from './privilege.js';
import { gateExtraEnv, type RoleCtx } from './roles/shared.js';

export type ArtifactFile = {
  rule: string;
  name: string;
  mediaType: string;
  sha256: string;
  /** A root-owned copy the agent can read. */
  path: string;
};

const CHUNK_BYTES = 45 * 1024; // Base64 grows this to about 60 KiB, under the 64 KiB line limit.

/** One artifact as stdout lines, each small enough to cross the container's log stream. */
export function artifactLines(a: {
  rule: string;
  name: string;
  mediaType: string;
  sha256: string;
  bytes: Buffer;
}): string[] {
  const total = Math.max(1, Math.ceil(a.bytes.length / CHUNK_BYTES));
  return Array.from({ length: total }, (_, index) => {
    const data = a.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    const { rule, name, mediaType, sha256 } = a;
    return `${ARTIFACT_PREFIX}${JSON.stringify({
      rule,
      name,
      mediaType,
      sha256,
      index,
      total,
      data: data.toString('base64'),
    })}`;
  });
}

/**
 * Runs each verification rule the PR's diff matches, as the gate user with no credentials, and
 * collects what it produced. A rule that matches must leave at least one valid artifact.
 */
export async function runVerification(
  payload: ItemDropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  dir: string,
): Promise<{ ok: boolean; reason?: string; files: ArtifactFile[] }> {
  const rules = payload.verification ?? [];
  if (rules.length === 0) return { ok: true, files: [] };
  const as = ctx.ids?.gate ?? null;
  const gateDir = ctx.ids ? join(ctx.ids.gate.home, 'repo') : dir;
  const changed = await deps.git.changedPaths(
    dir,
    payload.repo.defaultBranch,
    ctx.ids?.agent ?? null,
  );
  const files: ArtifactFile[] = [];
  const outDir = join(ctx.workdir, 'artifacts');

  for (const rule of rules) {
    if (!changed.some((p) => rule.paths.some((g) => pathMatches(p, g)))) continue;
    const [result] = await deps.runGates(
      [{ name: `verify:${rule.name}`, run: rule.run, timeoutMinutes: rule.timeoutMinutes }],
      {
        cwd: gateDir,
        env: scrubEnv(process.env, ctx.secrets),
        extraEnv: gateExtraEnv(payload),
        secrets: ctx.secrets,
        ...(as ? { as } : {}),
      },
    );
    if (!result || result.timedOut || result.exitCode !== 0) {
      return { ok: false, reason: `verification ${rule.name} failed`, files };
    }
    const names = (await listAgentFiles(gateDir, as))
      .map((p) => p.slice(gateDir.length + 1))
      .filter((p) => pathMatches(p, rule.artifacts))
      .sort();
    let kept = 0;
    for (const name of names) {
      if (files.length >= MAX_ARTIFACTS) break;
      const bytes = await readAgentBytes(join(gateDir, name), as, MAX_ARTIFACT_BYTES).catch(
        () => null,
      );
      const mediaType = bytes && sniffMediaType(bytes);
      if (!bytes || !mediaType) continue;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      mkdirSync(outDir, { recursive: true, mode: 0o755 });
      const path = join(outDir, `${sha256}.${MEDIA_EXTENSIONS[mediaType]}`);
      writeFileSync(path, bytes, { mode: 0o644 });
      for (const line of artifactLines({ rule: rule.name, name, mediaType, sha256, bytes })) {
        deps.emit(line);
      }
      files.push({ rule: rule.name, name, mediaType, sha256, path });
      kept++;
    }
    if (kept === 0) {
      return { ok: false, reason: `verification ${rule.name} produced no artifacts`, files };
    }
  }
  return { ok: true, files };
}
