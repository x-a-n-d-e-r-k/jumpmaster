// Clone e2e (clone.sh): a stand-in GitLab host, a git smart-HTTPS remote. Runs as root in a
// container on the default bridge, from the trooper image (node and git are there), with a
// certificate from the e2e's own test CA for its bridge address. Two roles:
//   - E2E_ROLE=remote: serves /srv/git through `git http-backend`, and only to a request that
//     carries `Authorization: Basic base64(<E2E_USERNAME>:<E2E_TOKEN>)` (a GitLab read deploy
//     token's form); any other gets 401. While /srv/redirect holds an origin, every request is
//     answered with a redirect there instead (the hostile remote).
//   - E2E_ROLE=other: the host a hostile remote redirects to. It serves nothing (404) and logs
//     every request with all its headers verbatim, so the driver can search them for the token.
// Each request is one JSON line in /srv/access.log. The remote's lines never hold a credential:
// only whether one came and whether it was right.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';

const ROLE = process.env.E2E_ROLE;
const PORT = 8443;
const LOG = '/srv/access.log';
const REDIRECT = '/srv/redirect';
const expected =
  ROLE === 'remote'
    ? Buffer.from(`${process.env.E2E_USERNAME}:${process.env.E2E_TOKEN}`).toString('base64')
    : '';
if (ROLE !== 'remote' && ROLE !== 'other')
  throw new Error(`E2E_ROLE ${ROLE} is not remote or other`);
if (ROLE === 'remote' && (!process.env.E2E_USERNAME || !process.env.E2E_TOKEN))
  throw new Error('the remote needs E2E_USERNAME and E2E_TOKEN');

const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
const ipOf = (req) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

/** `none`, `ok` or `bad`: the request's basic credential against the planted one. */
function authOf(req) {
  const h = req.headers.authorization;
  if (h === undefined) return 'none';
  const m = /^basic\s+(\S+)\s*$/i.exec(h);
  return m && m[1] === expected ? 'ok' : 'bad';
}

/** Runs `git http-backend` as a CGI for one request, relaying its headers and body. */
function backend(req, res, entry) {
  const url = new URL(req.url, 'https://remote.invalid');
  const h = req.headers;
  const env = {
    PATH: process.env.PATH,
    GIT_PROJECT_ROOT: '/srv/git',
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: req.method,
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: h['content-type'] ?? '',
    REMOTE_ADDR: entry.ip,
    REMOTE_USER: process.env.E2E_USERNAME,
    ...(h['content-length'] !== undefined ? { CONTENT_LENGTH: h['content-length'] } : {}),
    ...(h['content-encoding'] !== undefined
      ? { HTTP_CONTENT_ENCODING: h['content-encoding'] }
      : {}),
    ...(h['git-protocol'] !== undefined ? { GIT_PROTOCOL: h['git-protocol'] } : {}),
  };
  const cgi = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  req.pipe(cgi.stdin);
  cgi.stdin.on('error', () => {});
  let head = Buffer.alloc(0);
  let started = false;
  cgi.stdout.on('data', (chunk) => {
    if (started) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const ends = [
      [head.indexOf('\r\n\r\n'), 4],
      [head.indexOf('\n\n'), 2],
    ].filter(([i]) => i >= 0);
    if (ends.length === 0) return;
    const [at, skip] = ends.sort((a, b) => a[0] - b[0])[0];
    started = true;
    let status = 200;
    for (const line of head.subarray(0, at).toString('utf8').split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else res.setHeader(name, value);
    }
    res.writeHead(status);
    res.write(head.subarray(at + skip));
    log({ ...entry, status });
  });
  cgi.stdout.on('end', () => {
    if (!started) {
      res.writeHead(500);
      log({ ...entry, status: 500 });
    }
    res.end();
  });
}

const key = readFileSync('/srv/tls/key.pem');
const cert = readFileSync('/srv/tls/cert.pem');
createServer({ key, cert }, (req, res) => {
  const ip = ipOf(req);
  if (ROLE === 'other') {
    log({ ip, method: req.method, path: req.url, headers: req.headers, status: 404 });
    req.resume();
    res.writeHead(404).end('not here\n');
    return;
  }
  const entry = { ip, method: req.method, path: req.url, auth: authOf(req) };
  if (existsSync(REDIRECT)) {
    const to = `${readFileSync(REDIRECT, 'utf8').trim()}${req.url}`;
    log({ ...entry, status: 302, location: to });
    req.resume();
    res.writeHead(302, { Location: to }).end();
    return;
  }
  if (entry.auth !== 'ok') {
    log({ ...entry, status: 401 });
    req.resume();
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="jm-e2e"' }).end('auth required\n');
    return;
  }
  backend(req, res, entry);
}).listen(PORT, '0.0.0.0', () => writeFileSync('/srv/listening', `${PORT}\n`));
