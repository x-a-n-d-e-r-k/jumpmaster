/** One `.`-separated JWT segment, read in place. */
const JWT_SEGMENT = /[A-Za-z0-9_-]*/y;

/** The end of the segment run starting at `at`. */
function segmentEnd(text: string, at: number): number {
  JWT_SEGMENT.lastIndex = at;
  JWT_SEGMENT.exec(text);
  return JWT_SEGMENT.lastIndex;
}

/**
 * The first match of `<prefix>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` in `text` at or
 * after `from`, where `prefix` (a global regular expression made only of segment characters, which
 * cannot match starting inside one of its own matches, such as `eyJ` or `ghs_\d+_eyJ`) ends right
 * before the first segment's remaining characters. Same result as that regular expression, in time
 * linear in the text (#642): when a candidate fails at a segment, no start inside the run already
 * read can match, because `.` is not a segment character, so the search resumes after that run.
 */
export function findJwtShape(
  text: string,
  prefix: RegExp,
  from = 0,
): { start: number; end: number } | null {
  const head = new RegExp(prefix.source, 'g');
  let pos = from;
  while (pos <= text.length) {
    head.lastIndex = pos;
    const m = head.exec(text);
    if (m === null) return null;
    const after = m.index + m[0].length;
    const e1 = segmentEnd(text, after);
    pos = e1;
    if (e1 === after || text[e1] !== '.') continue;
    const e2 = segmentEnd(text, e1 + 1);
    pos = e2;
    if (e2 === e1 + 1 || text[e2] !== '.') continue;
    const e3 = segmentEnd(text, e2 + 1);
    pos = e3;
    if (e3 === e2 + 1) continue;
    return { start: m.index, end: e3 };
  }
  return null;
}

/** Replaces every match `findJwtShape` finds with `mark`. */
export function replaceJwtShapes(text: string, prefix: RegExp, mark: string): string {
  let out = '';
  let from = 0;
  for (let f = findJwtShape(text, prefix); f !== null; f = findJwtShape(text, prefix, f.end)) {
    out += text.slice(from, f.start) + mark;
    from = f.end;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** The stateless installation token's start; the JWT after it is read by `findJwtShape`. */
const STATELESS_PREFIX = /ghs_\d+_eyJ/g;

const TOKEN_SHAPES = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // A stateless installation token by its full shape (`ghs_<app id>_<JWT>`), with no lookbehind:
  // a token right after a letter, digit or `_` (the `n` of a JSON-escaped `\n`, an ANSI colour
  // code, `x-access-token%3A`) is still caught, and an identifier never has this shape.
  // Matched by `findJwtShape` with `STATELESS_PREFIX`, linear in the text (#642).
  STATELESS_PREFIX,
  // Installation tokens: stateless since 2026 (`ghs_<app id>_<JWT>`, ~520 characters with `.`, `-`
  // and `_`), the pattern GitHub suggests. Before the generic shape, which stops at the first `_`.
  // Not inside a longer identifier (`highs_and_lows_…`), which would refuse an ordinary push.
  /(?<![A-Za-z0-9_])ghs_[A-Za-z0-9._-]{36,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  // Git's basic-auth form of any GitHub token: base64 of `x-access-token:<token>`. The prefix is
  // fixed because `x-access-token:` is 15 bytes, a whole number of base64 groups.
  /eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/]{20,}={0,2}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // Jumpmaster MCP tokens (`jmm_` plus 32 random bytes in base64url).
  /jmm_[A-Za-z0-9_-]{20,}/g,
  // GitLab tokens: `glpat-` (personal, project, group) and the other `gl*-` prefixes. The legacy
  // body is 20 characters; the routable form adds `.`-separated segments, taken whole. A `.` with
  // no token character after it (a sentence's end) is left in place.
  /gl(?:pat|oas|dt|rt|cbt|ptt|ft|imt|agent|soat)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g,
];

/** A private key block's header; `<label>` is captured so the footer can be matched to it. */
const KEY_HEADER = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/g;
/** A newline as it appears raw (LF, CRLF) or JSON-escaped (the characters `\n`, `\r\n`). */
const KEY_NEWLINE = /\r?\n|(?:\\r)?\\n/;
/** A PEM header field (`Proc-Type: 4,ENCRYPTED`, `DEK-Info: …`), after any quotes or spaces. */
const KEY_FIELD = /^[\s'"`+,]*[A-Za-z][A-Za-z0-9-]*:/;
/** The body size from which a key block is taken as a real key; short dummy bodies are fakes. */
export const REAL_KEY_BODY_CHARS = 200;

export type PrivateKeyBlock = { start: number; end: number; real: boolean };

/**
 * Every private key block in `text`: from `-----BEGIN <label>PRIVATE KEY-----` to the matching
 * footer, or to the end of the text when there is none. Newlines may be LF, CRLF or JSON-escaped.
 * `real` when the body, header fields aside, has at least 200 base64 characters.
 */
export function findPrivateKeys(text: string): PrivateKeyBlock[] {
  const found: PrivateKeyBlock[] = [];
  const header = new RegExp(KEY_HEADER.source, 'g');
  for (let m = header.exec(text); m !== null; m = header.exec(text)) {
    const start = m.index;
    const bodyStart = start + m[0].length;
    const footer = `-----END ${m[1] ?? ''}PRIVATE KEY-----`;
    const at = text.indexOf(footer, bodyStart);
    const bodyEnd = at === -1 ? text.length : at;
    const end = at === -1 ? text.length : at + footer.length;
    let chars = 0;
    for (const line of text.slice(bodyStart, bodyEnd).split(KEY_NEWLINE)) {
      if (KEY_FIELD.test(line)) continue;
      chars += line.replace(/[^A-Za-z0-9+/=]/g, '').length;
    }
    found.push({ start, end, real: chars >= REAL_KEY_BODY_CHARS });
    header.lastIndex = end;
  }
  return found;
}

/** Replaces every private key block, real or fake, with `[REDACTED PRIVATE KEY]`. */
function redactPrivateKeys(text: string): string {
  const blocks = findPrivateKeys(text);
  if (blocks.length === 0) return text;
  let out = '';
  let from = 0;
  for (const b of blocks) {
    out += `${text.slice(from, b.start)}[REDACTED PRIVATE KEY]`;
    from = b.end;
  }
  return out + text.slice(from);
}

/** Replaces every private key block, then anything shaped like a known token with `mark`. */
export function redactTokenShapes(text: string, mark = '[REDACTED]'): string {
  let out = redactPrivateKeys(text);
  for (const re of TOKEN_SHAPES)
    out = re === STATELESS_PREFIX ? replaceJwtShapes(out, re, mark) : out.replace(re, mark);
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text: string, secrets: string[]): string {
  let out = text;
  // Longest first so a secret containing another secret is replaced whole.
  const known = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const s of known) out = out.replace(new RegExp(escapeRegExp(s), 'g'), '[REDACTED]');
  return redactTokenShapes(out);
}

/** True when `text` holds one of `secrets` verbatim or anything shaped like a known token. */
export function containsSecret(text: string, secrets: string[]): boolean {
  if (secrets.some((s) => s.length >= 8 && text.includes(s))) return true;
  return TOKEN_SHAPES.some((re) =>
    re === STATELESS_PREFIX ? findJwtShape(text, re) !== null : new RegExp(re.source).test(text),
  );
}

/** A GitHub token and its git basic-auth form (base64 of `x-access-token:<token>`); none when absent. */
export const withBasicAuth = (token: string | undefined): string[] =>
  token === undefined ? [] : [token, Buffer.from(`x-access-token:${token}`).toString('base64')];

/**
 * Every credential a drop payload carries, including the git basic-auth form of each GitHub token
 * (the forge token of item and crew roles, the read token of a doctor drop).
 */
export function payloadSecrets(p: {
  credentials: { claudeToken: string; forgeToken?: string; readToken?: string };
  gateSecrets?: Record<string, string>;
}): string[] {
  const { claudeToken, forgeToken, readToken } = p.credentials;
  return [
    ...Object.values(p.gateSecrets ?? {}),
    claudeToken,
    ...withBasicAuth(forgeToken),
    ...withBasicAuth(readToken),
  ];
}

/**
 * Every secret a push grant may redact with: the drop's own forge token and the author token, each
 * with its git basic-auth form, the Claude token, and the drop's gate secrets. Deliberately
 * narrower than the server's whole secret list: other zones' secrets never leave the server.
 */
export function dropSecrets(o: {
  forgeToken?: string;
  authorToken: string;
  claudeToken: string;
  gateSecrets?: Record<string, string>;
}): string[] {
  return [
    ...Object.values(o.gateSecrets ?? {}),
    o.claudeToken,
    ...withBasicAuth(o.forgeToken),
    ...withBasicAuth(o.authorToken),
  ];
}
