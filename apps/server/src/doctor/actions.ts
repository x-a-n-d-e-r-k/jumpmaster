import type { FastifyInstance } from 'fastify';
import type { DropZoneConfig } from '../config.js';
import {
  PAT_EXPIRATION_DAYS,
  patTemplateUrl,
  repoOf,
  type ZoneGuidance,
} from '../github/guidance.js';
import { DOC, type DoctorAction, type DoctorCheck } from './checks.js';

/**
 * The control that fixes each doctor fail (§10.3): a page in this UI, a page on the repository
 * (with the generated file to bring there), or the install runbook. Every href is a GET to a page;
 * the two writes (create the labels, run a doctor drop) are POST actions the page renders as
 * buttons behind the session's CSRF header, never as links.
 */

export type Action = DoctorAction;

/** Which pages exist in this build: the doctor links to them once they do. */
export type Pages = {
  /** `/zones` and `/zones/:id` (Task 11). */
  zones: boolean;
  /** `/settings/install` and `/settings/history` (Task 13, with `/settings/mcp-tokens`). */
  settings: boolean;
  /** `/settings/credentials` (Task 9). */
  credentials: boolean;
};

/** The pages this build registers (M4.5a, before Tasks 9, 11 and 13); `pagesOf` derives them. */
export const PAGES_M45A: Pages = { zones: false, settings: false, credentials: false };

/**
 * Which pages the running app registers, read from its routes after registration: Tasks 9, 11
 * and 13 bring a page and its links together, with no flag to flip early or forget.
 */
export function pagesOf(app: Pick<FastifyInstance, 'hasRoute'>): Pages {
  const has = (url: string) => app.hasRoute({ method: 'GET', url });
  return {
    zones: has('/zones'),
    settings: has('/settings/install') && has('/settings/history'),
    credentials: has('/settings/credentials'),
  };
}

export type ActionCtx = { zone?: DropZoneConfig; guidance?: ZoneGuidance; pages: Pages };

const GITHUB = 'https://github.com';
const zonePath = (zone: DropZoneConfig) => `/zones/${encodeURIComponent(zone.id)}`;

/** The check's own troubleshooting entry (a heading per id), or the topic the check names. */
const docs = (check: DoctorCheck): Action => ({
  kind: 'docs',
  label: `Read the runbook: ${check.id}`,
  href: check.doc ?? `${DOC}#${check.id.replace(/\./g, '')}`,
});
const app = (label: string, href: string): Action => ({ kind: 'app', label, href });

/** Before the Credentials tab, the wizard step that sets the credential. */
function credentials(check: DoctorCheck, ctx: ActionCtx): Action {
  if (ctx.pages.credentials) return app('Open Settings, Credentials', '/settings/credentials');
  // The check names its credentials (the first is the one the wizard reaches first).
  const claude = check.id === 'claude.token-age' || check.credentials?.[0] === 'claudeToken';
  if (check.id === 'vault.key' || check.id === 'credential.shadowed') return docs(check);
  return claude
    ? app('Set the Claude token (setup step)', '/setup/claude')
    : app('Set the GitHub tokens (setup step)', '/setup/forge');
}

function zoneSection(section: string, words: string) {
  return (check: DoctorCheck, ctx: ActionCtx): Action | undefined =>
    ctx.pages.zones && ctx.zone
      ? app(`Edit the ${words} of ${ctx.zone.id}`, `${zonePath(ctx.zone)}#${section}`)
      : docs(check);
}

function settings(path: string, label: string) {
  return (check: DoctorCheck, ctx: ActionCtx): Action =>
    ctx.pages.settings ? app(label, path) : docs(check);
}

/** The indefinite article for a word: "an" before a vowel sound's letter, else "a". */
const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

function reads(role: 'author' | 'reviewer') {
  return (check: DoctorCheck, ctx: ActionCtx): Action =>
    ctx.zone
      ? {
          kind: 'forge',
          label: `Make ${article(role)} ${role} token with the right permissions`,
          href:
            ctx.guidance?.pat[role] ??
            patTemplateUrl(role, repoOf(ctx.zone), { expirationDays: PAT_EXPIRATION_DAYS }),
        }
      : docs(check);
}

/** Without the guidance (GitHub unreadable just now), the zone's GitHub page has every file. */
const githubPage = (ctx: ActionCtx, what: string): Action | undefined =>
  ctx.zone ? app(`Get the ${what} for ${ctx.zone.id}`, `${zonePath(ctx.zone)}/github`) : undefined;

type Rule = (check: DoctorCheck, ctx: ActionCtx) => Action | undefined;

const TABLE: Record<string, Rule> = {
  'config.listen': settings('/settings/install', 'Open Settings, Install'),
  'claude.plan': settings('/settings/install', 'Open Settings, Install'),
  'usage.gate': settings('/settings/install', 'Open Settings, Install'),
  'config.file': settings('/settings/history', 'Open Settings, History'),
  'config.uid': docs,
  'config.secret-files': docs,
  // The Install tab carries the restart-pending badge and the restart command.
  'config.restart': settings('/settings/install', 'Open Settings, Install'),
  'claude.token-age': credentials,
  'forge.author': credentials,
  'forge.reviewer': credentials,
  'forge.admin': credentials,
  'forge.private-clone': credentials,
  'credential.install': credentials,
  'credential.missing': credentials,
  'credential.kind': credentials,
  'credential.same': credentials,
  'credential.shadowed': credentials,
  'vault.key': credentials,
  'forge.author-reads': reads('author'),
  'forge.reviewer-reads': reads('reviewer'),
  'control.kill': () => app('Open the kill switch on home', '/'),
  'stick.seen': () => app('See the sticks on home', '/'),
  'stick.image-policy': () => app('See the sticks on home', '/'),
  'stick.capabilities': () => app('See the sticks on home', '/'),
  'forge.branch-rules': (check, ctx) =>
    ctx.guidance
      ? {
          kind: 'forge',
          label: 'Import the ruleset file on GitHub',
          href: ctx.guidance.rulesUrl,
          artifact: { filename: ctx.guidance.ruleset.filename, text: ctx.guidance.ruleset.text },
        }
      : (githubPage(ctx, 'ruleset file') ?? docs(check)),
  'forge.codeowners': (check, ctx) =>
    ctx.guidance
      ? {
          kind: 'forge',
          label: 'Create .github/CODEOWNERS on GitHub',
          href: ctx.guidance.codeowners.newFileUrl,
          artifact: { filename: 'CODEOWNERS', text: ctx.guidance.codeowners.text },
        }
      : (githubPage(ctx, 'CODEOWNERS text') ?? docs(check)),
  'forge.ci': (check, ctx) => {
    if (!ctx.zone) return docs(check);
    const jobs = ctx.guidance?.ciJobs ?? [];
    return {
      kind: 'forge',
      label: `Open GitHub Actions${jobs.length > 0 ? ` (detected jobs: ${jobs.join(', ')})` : ''}`,
      href: `${GITHUB}/${ctx.zone.repo}/actions`,
    };
  },
  'forge.labels': (check, ctx) =>
    ctx.zone
      ? {
          kind: 'app',
          label: 'Create the missing labels',
          href: `/api/control/zones/${encodeURIComponent(ctx.zone.id)}/labels`,
          method: 'POST',
        }
      : docs(check),
  'zone.mode': (_c, ctx) =>
    ctx.pages.zones ? app('Open the zones', '/zones') : app('Open home (zone modes)', '/'),
  // The zone page's sections (Task 11): Stack, Egress, Merging, and Advanced for the rest.
  'zone.preset': zoneSection('stack', 'preset'),
  'zone.services': zoneSection('stack', 'services'),
  'zone.egress': zoneSection('egress', 'egress'),
  'zone.identity': zoneSection('merging', 'identity'),
  'zone.goals': zoneSection('advanced', 'goals'),
  'zone.crew-cap': zoneSection('advanced', 'crew'),
  'zone.doctor-drop': (check, ctx) =>
    ctx.zone
      ? {
          kind: 'app',
          label: `Run a doctor drop for ${ctx.zone.id}`,
          href: '/api/control/doctor/drop',
          method: 'POST',
          body: { zone: ctx.zone.id },
        }
      : docs(check),
};

/** Check ids with no action, and why (none today: every check has at least its runbook entry). */
export const NO_ACTION: Record<string, string> = {};

export const ACTION_IDS = Object.keys(TABLE);

/** The action for a fail or a warn; a pass or a skip has none. */
export function actionFor(check: DoctorCheck, ctx: ActionCtx): Action | undefined {
  if (check.status === 'pass' || check.status === 'skip') return undefined;
  const rule = TABLE[check.id];
  return rule ? rule(check, ctx) : docs(check);
}
