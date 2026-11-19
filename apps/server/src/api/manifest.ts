/**
 * The control manifest (§10.3, ctl parity): every route under `/api/control/`, with the `ctl`
 * invocation that reaches it, so everything a page can do a script can do too. Tests keep it
 * equal to the routes the app registers and check that each example parses to its route; the
 * `ctl` usage line and `ctl help` are generated from `CTL_VERBS`.
 *
 * This module is plain data: `ctl` imports it inside the container, beside nothing else.
 */

export type ControlMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A setting a route depends on: off, the route is not registered (the router answers 404). */
export type Switch = 'mcp.enabled';

export type ControlRoute = {
  method: ControlMethod;
  /** The route as registered (`:id`, `:name` for a segment). */
  path: string;
  /** An example invocation that `ctlRequest` maps to this method and path; null with a reason. */
  ctl: string | null;
  /** Other invocations reaching the same route (`unkill`, `resume`, …). */
  also?: string[];
  /** Why no `ctl` verb reaches it; only with `ctl: null`. */
  reason?: string;
  requires?: Switch;
};

/** What `ctl` says when a route is missing because its switch is off. */
export const SWITCHES: Record<Switch, string> = {
  'mcp.enabled':
    "Command's MCP server is off: turn on mcp.enabled under Settings, Install (it takes effect at the next restart)",
};

export const CONTROL_ROUTES: ControlRoute[] = [
  // Status
  { method: 'GET', path: '/api/control/status', ctl: 'ctl status' },
  // Setup
  {
    method: 'POST',
    path: '/api/control/sudo',
    ctl: null,
    reason: 'browser re-auth; the token is always sudo',
  },
  { method: 'POST', path: '/api/control/setup/reopen', ctl: 'ctl setup reopen' },
  { method: 'POST', path: '/api/control/setup/code', ctl: 'ctl setup-code' },
  { method: 'PUT', path: '/api/control/passphrase', ctl: 'ctl passphrase set' },
  { method: 'POST', path: '/api/control/detect', ctl: 'ctl detect octo/demo' },
  // Zones
  { method: 'GET', path: '/api/control/zones', ctl: 'ctl zones list' },
  { method: 'POST', path: '/api/control/zones', ctl: 'ctl zones add octo/demo' },
  { method: 'GET', path: '/api/control/zones/:id', ctl: 'ctl zones show web' },
  {
    method: 'POST',
    path: '/api/control/zones/:id',
    ctl: 'ctl pause web',
    also: ['ctl resume web', 'ctl observe web'],
  },
  { method: 'DELETE', path: '/api/control/zones/:id', ctl: 'ctl zones remove web' },
  {
    method: 'GET',
    path: '/api/control/zones/:id/egress/observed',
    ctl: 'ctl zones egress observed web',
  },
  {
    method: 'POST',
    path: '/api/control/zones/:id/egress/adopt',
    ctl: 'ctl zones egress adopt web registry.npmjs.org',
  },
  { method: 'POST', path: '/api/control/zones/:id/crew-cycle', ctl: 'ctl crew-cycle web' },
  { method: 'GET', path: '/api/control/zones/:id/backlog', ctl: 'ctl backlog web' },
  { method: 'POST', path: '/api/control/zones/:id/queue', ctl: 'ctl queue web 178' },
  {
    method: 'POST',
    path: '/api/control/zones/:id/intake/goal-stub',
    ctl: 'ctl intake web stub goal.json',
  },
  {
    method: 'POST',
    path: '/api/control/zones/:id/intake/issue',
    ctl: 'ctl intake web issue issue.json',
  },
  // GitHub
  {
    method: 'GET',
    path: '/api/control/zones/:id/github',
    ctl: 'ctl github web ruleset',
    also: ['ctl github web codeowners --reviewer alice'],
  },
  { method: 'POST', path: '/api/control/github/recommend', ctl: 'ctl github recommend octo/demo' },
  // Settings
  {
    method: 'PUT',
    path: '/api/control/server/public-url',
    ctl: 'ctl public-url set https://jumpmaster.example.ts.net',
    also: ['ctl public-url clear'],
  },
  {
    method: 'POST',
    path: '/api/control/server/public-url/check',
    ctl: 'ctl public-url check',
  },
  {
    method: 'PATCH',
    path: '/api/control/config',
    ctl: 'ctl config set pollSeconds=30',
    also: ['ctl settings set pollSeconds=30', 'ctl zones set web readyLabel=go'],
  },
  {
    method: 'POST',
    path: '/api/control/mcp-tokens',
    ctl: 'ctl mcp-tokens mint web read --days 30',
    requires: 'mcp.enabled',
  },
  {
    method: 'GET',
    path: '/api/control/mcp-tokens',
    ctl: 'ctl mcp-tokens list',
    requires: 'mcp.enabled',
  },
  {
    method: 'DELETE',
    path: '/api/control/mcp-tokens/:id',
    ctl: 'ctl mcp-tokens revoke 3',
    requires: 'mcp.enabled',
  },
  // Credentials
  { method: 'GET', path: '/api/control/secrets', ctl: 'ctl secrets list' },
  { method: 'PUT', path: '/api/control/secrets/:name', ctl: 'ctl secrets set claudeToken' },
  {
    method: 'POST',
    path: '/api/control/secrets/:name/test',
    ctl: 'ctl secrets test claudeToken',
  },
  {
    method: 'POST',
    path: '/api/control/secrets/github-app/:owner/:role/test',
    ctl: 'ctl secrets test github-app/acme/author',
  },
  { method: 'DELETE', path: '/api/control/secrets/:name', ctl: 'ctl secrets remove claudeToken' },
  { method: 'POST', path: '/api/control/secrets/reload', ctl: 'ctl secrets reload' },
  { method: 'POST', path: '/api/control/secrets/vault/on', ctl: 'ctl secrets vault on' },
  { method: 'POST', path: '/api/control/secrets/vault/off', ctl: 'ctl secrets vault off' },
  {
    method: 'POST',
    path: '/api/control/secrets/vault/prefer',
    ctl: 'ctl secrets vault prefer on',
    also: ['ctl secrets vault prefer off'],
  },
  {
    method: 'POST',
    path: '/api/control/secrets/:name/copy-to-vault',
    ctl: 'ctl secrets copy-to-vault githubReadToken',
  },
  // Config
  { method: 'GET', path: '/api/control/config', ctl: 'ctl config show' },
  { method: 'GET', path: '/api/control/config/revisions', ctl: 'ctl config revisions' },
  { method: 'POST', path: '/api/control/config/rollback', ctl: 'ctl config rollback 3' },
  { method: 'POST', path: '/api/control/config/reload', ctl: 'ctl config reload' },
  { method: 'POST', path: '/api/control/config/adopt', ctl: 'ctl config adopt' },
  { method: 'POST', path: '/api/control/config/mode', ctl: 'ctl config mode file' },
  { method: 'GET', path: '/api/control/config/export', ctl: 'ctl config export' },
  { method: 'POST', path: '/api/control/config/import', ctl: 'ctl config import next.json' },
  // Doctor
  { method: 'POST', path: '/api/control/doctor', ctl: 'ctl doctor', also: ['ctl doctor web'] },
  { method: 'GET', path: '/api/control/doctor', ctl: 'ctl doctor --last' },
  {
    method: 'POST',
    path: '/api/control/doctor/drop',
    ctl: 'ctl doctor web --drop',
    also: ['ctl doctor web --cancel'],
  },
  { method: 'POST', path: '/api/control/zones/:id/labels', ctl: 'ctl labels web' },
  // Briefings
  { method: 'GET', path: '/api/control/briefings', ctl: 'ctl briefings' },
  { method: 'POST', path: '/api/control/briefings/:id/rule', ctl: 'ctl rule 3 yes' },
  {
    method: 'POST',
    path: '/api/control/zones/:id/briefings/dismiss',
    ctl: 'ctl dismiss web 3 4',
  },
  // Drops
  {
    method: 'POST',
    path: '/api/control/drops/:id/extend-retention',
    ctl: 'ctl drops extend-retention d1 6',
  },
  { method: 'POST', path: '/api/control/drops/:id/cancel', ctl: 'ctl drops cancel d1' },
  { method: 'GET', path: '/api/control/drops/:id/transcript', ctl: 'ctl drops transcript d1' },
  {
    method: 'GET',
    path: '/api/control/zones/:id/transcripts',
    ctl: 'ctl zones transcripts web --since 2026-11-16',
  },
  // Sticks
  { method: 'GET', path: '/api/control/sticks', ctl: 'ctl sticks' },
  {
    method: 'POST',
    path: '/api/control/sticks/:id/slots',
    ctl: 'ctl sticks slots kidney-shadow 2',
  },
  {
    method: 'POST',
    path: '/api/control/sticks/:id/remove',
    ctl: 'ctl sticks remove kidney-shadow',
  },
  {
    method: 'POST',
    path: '/api/control/sticks/:id/upgrade',
    ctl: 'ctl sticks upgrade kidney-shadow',
  },
  {
    method: 'POST',
    path: '/api/control/sticks/upgrade-all',
    ctl: 'ctl sticks upgrade --all',
  },
  {
    method: 'POST',
    path: '/api/control/sticks/invites/:id/cancel',
    ctl: 'ctl sticks cancel vps-1',
  },
  // Kill
  { method: 'POST', path: '/api/control/kill', ctl: 'ctl kill', also: ['ctl unkill'] },
];

export type Page =
  | 'Status'
  | 'Setup'
  | 'Zones'
  | 'GitHub'
  | 'Settings'
  | 'Credentials'
  | 'Config'
  | 'Doctor'
  | 'Briefings'
  | 'Drops'
  | 'Sticks'
  | 'Kill';

export const PAGES: Page[] = [
  'Status',
  'Setup',
  'Zones',
  'GitHub',
  'Settings',
  'Credentials',
  'Config',
  'Doctor',
  'Briefings',
  'Drops',
  'Sticks',
  'Kill',
];

/** Each verb, the page it belongs to and its forms, as `ctl help` and the usage line print them. */
export const CTL_VERBS: { verb: string; page: Page; forms: string[] }[] = [
  { verb: 'status', page: 'Status', forms: ['ctl status [--json]'] },
  { verb: 'setup-code', page: 'Setup', forms: ['ctl setup-code'] },
  { verb: 'setup', page: 'Setup', forms: ['ctl setup reopen'] },
  { verb: 'passphrase', page: 'Setup', forms: ['ctl passphrase set (the passphrase on stdin)'] },
  { verb: 'detect', page: 'Setup', forms: ['ctl detect <owner/name>'] },
  {
    verb: 'zones',
    page: 'Zones',
    forms: [
      'ctl zones add <owner/name> [--id <id>] [--preset <p>] [--identity starter] [--egress off|monitor|enforce] [--resume]',
      'ctl zones list [--json]',
      'ctl zones show <zone> [--json]',
      'ctl zones set <zone> <path>=<json>… [--note <text>]',
      'ctl zones remove <zone>',
      'ctl zones egress observed <zone> [--json]',
      'ctl zones egress adopt <zone> <host>…',
      'ctl zones transcripts <zone> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <file>]',
    ],
  },
  { verb: 'pause', page: 'Zones', forms: ['ctl pause <zone>'] },
  { verb: 'resume', page: 'Zones', forms: ['ctl resume <zone>'] },
  { verb: 'observe', page: 'Zones', forms: ['ctl observe <zone>'] },
  { verb: 'crew-cycle', page: 'Zones', forms: ['ctl crew-cycle <zone>'] },
  {
    verb: 'backlog',
    page: 'Zones',
    forms: ['ctl backlog <zone> (open issues with no Jumpmaster label)'],
  },
  { verb: 'queue', page: 'Zones', forms: ['ctl queue <zone> <issue> (puts the ready label on)'] },
  {
    verb: 'intake',
    page: 'Zones',
    forms: [
      'ctl intake <zone> stub <file.json> (prints the GOAL.md stub)',
      'ctl intake <zone> issue <file.json> (files the issue ready)',
    ],
  },
  {
    verb: 'github',
    page: 'GitHub',
    forms: [
      'ctl github <zone> recommend | pat <author|reviewer|read> | ruleset | codeowners [--reviewer <login>]… | checklist',
      'ctl github recommend <owner/name> [--paid-plan] [--identity starter|two-bot]',
    ],
  },
  {
    verb: 'settings',
    page: 'Settings',
    forms: ['ctl settings set <path>=<json>… [--note <text>]'],
  },
  {
    verb: 'public-url',
    page: 'Settings',
    forms: ['ctl public-url set <https://address>', 'ctl public-url clear', 'ctl public-url check'],
  },
  {
    verb: 'mcp-tokens',
    page: 'Settings',
    forms: [
      'ctl mcp-tokens mint <zone> <read|write> --days N [--label <text>]',
      'ctl mcp-tokens list',
      'ctl mcp-tokens revoke <id>',
    ],
  },
  {
    verb: 'secrets',
    page: 'Credentials',
    forms: [
      'ctl secrets list',
      'ctl secrets set <name> [--from-file <path>] [--created YYYY-MM-DD] (the value on stdin or in the file, never in argv)',
      'ctl secrets test <name>',
      'ctl secrets test github-app/<owner>/<role>',
      'ctl secrets remove <name>',
      'ctl secrets reload',
      'ctl secrets vault on|off',
      'ctl secrets vault prefer on|off',
      'ctl secrets copy-to-vault <name>',
    ],
  },
  {
    verb: 'config',
    page: 'Config',
    forms: [
      'ctl config show [--json]',
      'ctl config revisions',
      'ctl config set <path>=<json>… [--note <text>]',
      'ctl config rollback <id> [note]',
      'ctl config import <file> [--dry-run] [--note <text>]',
      'ctl config export',
      'ctl config reload',
      'ctl config adopt',
      'ctl config mode file',
    ],
  },
  {
    verb: 'doctor',
    page: 'Doctor',
    forms: [
      'ctl doctor [zone] [--json] [--artifacts <dir>]',
      'ctl doctor --last [--json]',
      'ctl doctor <zone> --drop',
      'ctl doctor <zone> --cancel',
    ],
  },
  { verb: 'labels', page: 'Doctor', forms: ['ctl labels <zone>'] },
  { verb: 'briefings', page: 'Briefings', forms: ['ctl briefings [--json]'] },
  {
    verb: 'rule',
    page: 'Briefings',
    forms: ['ctl rule <briefing> <option> [--options <digest>] [note]'],
  },
  { verb: 'dismiss', page: 'Briefings', forms: ['ctl dismiss <zone> <briefing>…'] },
  {
    verb: 'drops',
    page: 'Drops',
    forms: [
      'ctl drops extend-retention <dropId> <hours>',
      'ctl drops cancel <dropId>',
      'ctl drops transcript <dropId> [--out <file>]',
    ],
  },
  {
    verb: 'sticks',
    page: 'Sticks',
    forms: [
      'ctl sticks [--json]',
      'ctl sticks slots <name-or-id> <n>',
      'ctl sticks remove <name-or-id>',
      'ctl sticks upgrade <name-or-id>',
      'ctl sticks upgrade --all',
      'ctl sticks cancel <invite-name-or-id>',
    ],
  },
  { verb: 'kill', page: 'Kill', forms: ['ctl kill'] },
  { verb: 'unkill', page: 'Kill', forms: ['ctl unkill'] },
];

/** The manifest route a request reaches, if any (`:id` and `:name` match one segment). */
export function routeFor(method: string, path: string): ControlRoute | undefined {
  const bare = path.split('?')[0] ?? '';
  return CONTROL_ROUTES.find(
    (r) =>
      r.method === method && new RegExp(`^${r.path.replace(/:[a-z]+/gi, '[^/]+')}$`).test(bare),
  );
}
