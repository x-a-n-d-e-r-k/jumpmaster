import type { Config, DropZoneConfig } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import { insertStick, stampStick, upsertDropZone } from '../db/repo.js';
import { type DoctorCheck, type DoctorDeps, runChecks } from '../doctor/checks.js';
import { fakeForgePair } from './fakes.js';
import { makeZone, usageCfg } from './fixtures.js';
import { tmpDbFile } from './helpers.js';

export const NOW = new Date('2026-11-09T12:00:00.000Z');
export const ago = (ms: number) => new Date(NOW.getTime() - ms);
export const DIGEST = `sha256:${'a'.repeat(64)}`;
export const IMAGE = `ghcr.io/acme/jumpmaster-trooper@${DIGEST}`;
export const PG = `postgres@sha256:${'b'.repeat(64)}`;
export const AUTHOR_TOKEN = 'github_pat_AUTHORAUTHORAUTHORAUTHOR1234';
export const REVIEWER_TOKEN = 'github_pat_REVIEWERREVIEWERREVIEWER5678';
export const READ_TOKEN = 'github_pat_READREADREADREADREADREAD9012';
export const CLAUDE_TOKEN = 'sk-ant-oat01-CLAUDECLAUDECLAUDECLAUDE';

type Pair = ReturnType<typeof fakeForgePair>;

export interface DoctorWorld {
  db: Db;
  f: Pair;
  /** The forge on the read token (its author identity). */
  read: Pair;
  zone: DropZoneConfig;
  config: Config;
  deps: DoctorDeps;
  run(): Promise<DoctorCheck[]>;
}

/** A healthy one-zone install: every check passes but the ones that can't yet. */
export function world(
  o: { zone?: Partial<DropZoneConfig>; config?: Partial<Config>; readToken?: boolean } = {},
): DoctorWorld {
  const db: Db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  const zone = makeZone({
    image: IMAGE,
    preset: 'node',
    egress: { mode: 'enforce', allow: [] },
    ...o.zone,
  });
  const f = fakeForgePair({ issues: [], trusted: [] });
  for (const id of ['author', 'reviewer'] as const) {
    f.state.rules[id] = {
      kind: 'ok',
      rules: {
        requiredApprovals: 1,
        dismissStaleOnPush: true,
        requiredChecks: ['ci'],
        unpinnedChecks: [],
        viewerCanBypass: false,
        viewerIsAdmin: false,
        requiresPullRequest: true,
        requireCodeOwnerReview: false,
      },
    };
  }
  f.state.labels = ['agent-ready', 'agent-retry', 'bug'];
  f.state.dirs.set('main:.github/workflows', ['ci.yml']);
  f.state.dirs.set('main:', ['package.json', 'package-lock.json', 'src']);
  f.state.files.set('main:package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
  f.state.files.set('main:package-lock.json', '{}');
  insertStick(db, { id: 's1', name: 'stick-1', tokenHash: 'h1', slots: 2 });
  stampStick(
    db,
    's1',
    {
      capabilities: ['egress-v1', 'image-verify-v1'],
      imagePolicy: 'signed',
      version: '0.4.0',
      pinnedImages: [PG],
    },
    ago(20_000),
  );
  const config = {
    listen: { host: '127.0.0.1', port: 7420, allowedHosts: ['127.0.0.1:7420'] },
    dataDir: '/tmp/x',
    pollSeconds: 60,
    dropZones: [zone],
    usage: usageCfg,
    claude: { plan: 'max', fableWeeklyDropCap: 5 },
    secrets: {
      claudeToken: CLAUDE_TOKEN,
      githubAuthorToken: AUTHOR_TOKEN,
      githubReviewerToken: REVIEWER_TOKEN,
      joinToken: 'join-join-join-join',
      operatorToken: 'o'.repeat(32),
      ...(o.readToken ? { githubReadToken: READ_TOKEN } : {}),
    },
    ...o.config,
  } as Config;
  const read = fakeForgePair({ issues: [], trusted: [] });
  read.state.dirs.set('main:', ['package.json']);
  const deps: DoctorDeps = {
    db,
    config,
    now: () => NOW,
    env: { uid: 1000, inContainer: true, uidMap: '         0          0 4294967295\n' },
    forges: () => ({ author: f.author, reviewer: f.reviewer }),
    readForge: () => (o.readToken ? read.author : undefined),
  };
  const run = () => runChecks(deps);
  return { db, f, read, zone, config, deps, run };
}

export function one(checks: DoctorCheck[], id: string): DoctorCheck {
  const hit = checks.filter((c) => c.id === id);
  if (hit.length !== 1) throw new Error(`expected one ${id}, got ${hit.length}`);
  return hit[0] as DoctorCheck;
}
