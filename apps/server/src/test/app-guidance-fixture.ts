import type { GuidanceApps } from '../github/guidance.js';

/**
 * A two-app zone's app entries as an install holds them, with a private key, a client secret and
 * a token-like value: the guidance gets only each app's id and slug, so none of these may reach
 * its JSON, the page or ctl output.
 */
const BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const END = ['-----END', 'PRIVATE KEY-----'].join(' ');
export const APP_SECRETS = {
  pem: `${BEGIN}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCGUIDANCEFIXTURE0123456789\n${END}\n`,
  clientSecret: ['jm', 'clientsecret', 'GUIDANCEFIXTURE0123456789abcdef'].join('_'),
  token: ['ghs', 'GUIDANCEFIXTURETOKEN0123456789abcd'].join('_'),
};

export const APP_ENTRIES = {
  author: {
    appId: '4242',
    slug: 'acme-jm-author',
    clientId: 'Iv1.fixtureauthor',
    clientSecret: APP_SECRETS.clientSecret,
    pem: APP_SECRETS.pem,
    installationToken: APP_SECRETS.token,
    importedAt: '2026-11-01T00:00:00.000Z',
  },
  reviewer: {
    appId: '4343',
    slug: 'acme-jm-reviewer',
    clientId: 'Iv1.fixturereviewer',
    clientSecret: APP_SECRETS.clientSecret,
    pem: APP_SECRETS.pem,
    installationToken: APP_SECRETS.token,
    importedAt: '2026-11-01T00:00:00.000Z',
  },
};

/** The guidance input from the entries: only the app id and the slug. */
export function guidanceAppsOf(e: typeof APP_ENTRIES): GuidanceApps {
  return {
    author: { appId: Number(e.author.appId), slug: e.author.slug },
    reviewer: { slug: e.reviewer.slug },
  };
}
