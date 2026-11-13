// Spike helper for the GitHub App design (docs/superpowers/specs/2026-11-13-github-app-auth.md, §13
// Task 1). Not part of the product. It signs an app JWT from an app id and the app's downloaded key,
// mints an installation token narrowed to one repository, runs one named step and prints only that
// step's outcome as JSON. It never prints a token or the key. Run with plain Node (type stripping):
//   node scripts/spike/github-app.ts open-pr --app 123 --key ~/Downloads/author.pem --repo me/jm-spike
//   node scripts/spike/github-app.ts approve --app 456 --key ~/Downloads/reviewer.pem --repo me/jm-spike --pr 1
//   node scripts/spike/github-app.ts status  --app 123 --key ... --repo ... --pr 1
//   node scripts/spike/github-app.ts merge   --app 123 --key ... --repo ... --pr 1
//   node scripts/spike/github-app.ts bypass  --app 123 --key ... --repo ...
import { createSign } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const STEPS = ['open-pr', 'approve', 'status', 'merge', 'bypass'] as const;
export type Step = (typeof STEPS)[number];
export type Args = {
  step: Step;
  app: string;
  key: string;
  repo: { owner: string; name: string };
  pr?: number;
  /** Test seams: the clock for branch names and the file open-pr commits. */
  now?: () => number;
  file?: string;
};
export type Call = (
  method: string,
  path: string,
  auth: string,
  body?: unknown,
) => Promise<{ status: number; json: any }>;
type Outcome = Record<string, unknown>;

const NEEDS_PR: readonly Step[] = ['approve', 'status', 'merge'];

export function parseArgs(argv: string[]): Args {
  const [step, ...rest] = argv;
  if (!STEPS.includes(step as Step)) throw new Error(`the step must be one of ${STEPS.join(', ')}`);
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!flag.startsWith('--') || rest[i + 1] === undefined)
      throw new Error(`unexpected argument ${flag}`);
    flags[flag.slice(2)] = rest[i + 1]!;
  }
  for (const f of ['app', 'key', 'repo']) if (!flags[f]) throw new Error(`--${f} is required`);
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(flags.repo!);
  if (!m) throw new Error('--repo must be owner/name');
  const out: Args = {
    step: step as Step,
    app: flags.app!,
    key: flags.key!,
    repo: { owner: m[1]!, name: m[2]! },
  };
  if (flags.pr !== undefined) {
    const pr = Number(flags.pr);
    if (!Number.isInteger(pr) || pr < 1) throw new Error('--pr must be a pull request number');
    out.pr = pr;
  }
  if (NEEDS_PR.includes(out.step) && out.pr === undefined)
    throw new Error(`${out.step} needs --pr`);
  return out;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** The app's JWT: RS256, issued 60s in the past for clock skew, expiring under GitHub's ten-minute cap. */
export function appJwt(appId: string, pem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: appId, iat: nowSec - 60, exp: nowSec + 540 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Removes every secret this run holds from an outcome, wherever GitHub might have echoed it. */
function scrub(out: Outcome, secrets: string[]): Outcome {
  let text = JSON.stringify(out);
  for (const s of secrets) if (s) text = text.split(s).join('[redacted]');
  text = text.replace(/gh[opsu]_[A-Za-z0-9_]{20,}/g, '[redacted]');
  return JSON.parse(text);
}

export async function runStep(a: Args, jwt: string, call: Call): Promise<Outcome> {
  const { owner, name } = a.repo;
  const repo = `/repos/${owner}/${name}`;
  const inst = await call('GET', `${repo}/installation`, `Bearer ${jwt}`);
  if (inst.status !== 200)
    return {
      step: 'mint',
      http: inst.status,
      message: `${inst.json?.message ?? 'failed'} — is the app installed on ${owner}/${name}?`,
    };
  const mint = await call(
    'POST',
    `/app/installations/${inst.json.id}/access_tokens`,
    `Bearer ${jwt}`,
    {
      repositories: [name],
    },
  );
  if (mint.status !== 201)
    return { step: 'mint', http: mint.status, message: mint.json?.message ?? 'failed' };
  const token: string = mint.json.token;
  const auth = `token ${token}`;
  return scrub(await act(a, repo, auth, call), [token, jwt]);
}

async function act(a: Args, repo: string, auth: string, call: Call): Promise<Outcome> {
  const fail = (step: string, r: { status: number; json: any }, extra: Outcome = {}) => ({
    step,
    ...extra,
    http: r.status,
    message: r.json?.message ?? 'failed',
  });
  switch (a.step) {
    case 'open-pr': {
      const meta = await call('GET', repo, auth);
      if (meta.status !== 200) return fail('open-pr', meta);
      const base = meta.json.default_branch as string;
      const ref = await call('GET', `${repo}/git/ref/heads/${base}`, auth);
      if (ref.status !== 200) return fail('open-pr', ref);
      const branch = `spike-${(a.now ?? Date.now)()}`;
      const made = await call('POST', `${repo}/git/refs`, auth, {
        ref: `refs/heads/${branch}`,
        sha: ref.json.object.sha,
      });
      if (made.status !== 201) return fail('open-pr', made);
      const file = a.file ?? `spike/${branch}.txt`;
      const put = await call('PUT', `${repo}/contents/${file}`, auth, {
        message: `spike: ${branch}`,
        content: Buffer.from(`${branch}\n`).toString('base64'),
        branch,
      });
      if (put.status !== 201) return fail('open-pr', put);
      const pr = await call('POST', `${repo}/pulls`, auth, {
        title: `spike: ${branch}`,
        head: branch,
        base,
      });
      if (pr.status !== 201) return fail('open-pr', pr);
      return { step: 'open-pr', http: pr.status, pr: pr.json.number, login: pr.json.user?.login };
    }
    case 'approve': {
      const r = await call('POST', `${repo}/pulls/${a.pr}/reviews`, auth, {
        event: 'APPROVE',
        body: 'spike approval',
      });
      if (r.status !== 200) return fail('approve', r, { pr: a.pr });
      return {
        step: 'approve',
        pr: a.pr,
        http: r.status,
        state: r.json.state,
        login: r.json.user?.login,
      };
    }
    case 'status': {
      const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewDecision mergeStateStatus mergeable}}}`;
      const r = await call('POST', '/graphql', auth, {
        query: q,
        variables: { o: a.repo.owner, n: a.repo.name, p: a.pr },
      });
      const pr = r.json?.data?.repository?.pullRequest;
      if (r.status !== 200 || !pr)
        return {
          step: 'status',
          pr: a.pr,
          http: r.status,
          message: r.json?.errors?.[0]?.message ?? r.json?.message ?? 'failed',
        };
      return {
        step: 'status',
        pr: a.pr,
        http: r.status,
        reviewDecision: pr.reviewDecision,
        mergeStateStatus: pr.mergeStateStatus,
        mergeable: pr.mergeable,
      };
    }
    case 'merge': {
      const r = await call('PUT', `${repo}/pulls/${a.pr}/merge`, auth, { merge_method: 'squash' });
      if (r.status === 200)
        return { step: 'merge', pr: a.pr, http: r.status, merged: r.json.merged === true };
      return {
        step: 'merge',
        pr: a.pr,
        http: r.status,
        merged: false,
        message: r.json?.message ?? 'failed',
      };
    }
    case 'bypass': {
      const list = await call('GET', `${repo}/rulesets`, auth);
      if (list.status !== 200) return fail('bypass', list);
      const rulesets = [];
      for (const rs of list.json as { id: number; name: string }[]) {
        const one = await call('GET', `${repo}/rulesets/${rs.id}`, auth);
        rulesets.push({
          name: rs.name,
          current_user_can_bypass:
            one.status === 200 ? (one.json.current_user_can_bypass ?? null) : `http ${one.status}`,
        });
      }
      return { step: 'bypass', http: list.status, rulesets };
    }
  }
}

const github: Call = async (method, path, auth, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: auth,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'jumpmaster-spike',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: `non-JSON response (${text.length} bytes)` };
  }
  return { status: res.status, json };
};

async function main(): Promise<void> {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(
      `${(e as Error).message}\nusage: node scripts/spike/github-app.ts <${STEPS.join('|')}> --app ID --key PATH.pem --repo owner/name [--pr N]`,
    );
    process.exit(2);
  }
  const pem = readFileSync(a.key.replace(/^~(?=\/)/, homedir()), 'utf8');
  const out = await runStep(a, appJwt(a.app, pem), github);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.http === 200 || out.http === 201 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  await main();
