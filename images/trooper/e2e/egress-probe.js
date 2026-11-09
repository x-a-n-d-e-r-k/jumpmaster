#!/usr/bin/env node
// Egress e2e probe, run as the gate user inside a drop under egress (test layer only). Tries every
// way out the plan names and prints one JSON line: each check, what it saw, and whether that is
// what the mode expects. Exits non-zero when any check is wrong. E2E_MODE (a gate secret) is
// `enforce` or `monitor`.
const { spawnSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');

const MODE = process.env.E2E_MODE || 'enforce';
const HOST_PORT = Number(process.env.E2E_HOST_PORT || 39999);
const proxy = new URL(process.env.HTTPS_PROXY || 'http://none:1');
const checks = [];
const check = (name, ok, saw) => checks.push({ name, ok: Boolean(ok), saw });

const getent = (name) => {
  const r = spawnSync('getent', ['hosts', name], { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, out: (r.stdout || '').trim().split('\n')[0] };
};

const tcp = (host, port, ms = 3000) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done('timeout'));
    s.on('connect', () => done('connected'));
    s.on('error', (e) => done(e.code || 'error'));
  });

/** Sends raw bytes to the proxy and returns the status code of its answer. */
const viaProxy = (raw) =>
  new Promise((resolve) => {
    const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let buf = '';
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(15_000, () => done('timeout'));
    s.on('data', (c) => {
      buf += c.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) done(Number(m[1]));
    });
    s.on('error', (e) => done(e.code || 'error'));
    s.on('connect', () => s.write(raw));
  });
const connectVia = (target) => viaProxy(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

/** A raw DNS query (TXT) over UDP; resolves with the answer count, or the failure. */
const dnsQuery = (server, name, ms = 3000) =>
  new Promise((resolve) => {
    const sock = dgram.createSocket(server.includes(':') ? 'udp6' : 'udp4');
    const labels = name
      .split('.')
      .map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
    const q = Buffer.concat([
      Buffer.from([0x13, 0x37, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ...labels,
      Buffer.from([0x00, 0x00, 0x10, 0x00, 0x01]),
    ]);
    const done = (v) => {
      clearTimeout(timer);
      sock.close();
      resolve(v);
    };
    const timer = setTimeout(() => done('timeout'), ms);
    sock.on('error', (e) => done(e.code || 'error'));
    sock.on('message', (m) => done({ rcode: m[3] & 0x0f, answers: m.readUInt16BE(6) }));
    sock.send(q, 53, server, (e) => e && done(e.code || 'error'));
  });

(async () => {
  const enforce = MODE === 'enforce';
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // DNS: the embedded resolver answers names on the drop network and nothing else.
  const ext = getent('example.com');
  check('dns: an external name does not resolve', ext.status !== 0, ext);
  const exfil = getent(`${nonce}.exfil-probe.example.com`);
  check('dns: an exfil-shaped name does not resolve', exfil.status !== 0, exfil);
  const alias = getent('jm-egress');
  check('dns: jm-egress resolves', alias.status === 0, alias);
  const svc = getent('db');
  check('dns: the service resolves', svc.status === 0, svc);
  const txt = await dnsQuery('127.0.0.11', `${nonce}.txt-probe.example.com`);
  check(
    'dns: a TXT query to the embedded resolver gets no answer',
    txt === 'timeout' || txt.answers === 0,
    txt,
  );
  const pub = await dnsQuery('8.8.8.8', `${nonce}.udp-probe.example.com`);
  check(
    'dns: a public resolver is unreachable over UDP',
    pub === 'timeout' || typeof pub === 'string',
    pub,
  );

  // Direct connections: no route out, to the host, the metadata address or over IPv6.
  const raw = await tcp('1.1.1.1', 443);
  check('direct: a raw public IP fails', raw !== 'connected', raw);
  const meta = await tcp('169.254.169.254', 80);
  check('direct: the metadata address fails', meta !== 'connected', meta);
  const v6 = await tcp('2606:4700:4700::1111', 443);
  check('direct: IPv6 fails', v6 !== 'connected', v6);
  const mine = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal);
  const v4 = mine.find((a) => a.family === 'IPv4');
  const last = v4 ? Number(v4.address.split('.')[3]) : -1;
  const gateway = v4 ? v4.address.replace(/\.\d+$/, `.${last - (last % 16) + 1}`) : '';
  check('direct: the trooper sits at .3 of its /28', last % 16 === 3, v4?.address);
  const gw = await tcp(gateway, HOST_PORT);
  check(
    `direct: the gateway ${gateway}:${HOST_PORT} (a host listener) fails`,
    gw !== 'connected',
    gw,
  );
  const v6addrs = mine.filter((a) => a.family === 'IPv6').map((a) => a.address);
  let disabled = '';
  try {
    disabled = fs.readFileSync('/proc/sys/net/ipv6/conf/all/disable_ipv6', 'utf8').trim();
  } catch (e) {
    disabled = String(e.code);
  }
  check('direct: no IPv6 address, IPv6 disabled', v6addrs.length === 0 && disabled === '1', {
    v6addrs,
    disabled,
  });

  // The proxy: only CONNECT to listed public hosts on 443 (monitor: any public host).
  let fetched;
  try {
    fetched = (await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(20_000) }))
      .status;
  } catch (e) {
    fetched = String(e.cause?.code || e.message);
  }
  check('proxy: an allowed host works (fetch through the env proxy)', fetched === 200, fetched);
  const denied = await connectVia('example.com:443');
  check(
    `proxy: an unlisted host is ${enforce ? 'refused' : 'let through (monitor)'}`,
    enforce ? denied === 403 : denied === 200,
    denied,
  );
  for (const target of [
    '169.254.169.254:443',
    '169.254.169.254:80',
    '1.1.1.1:443',
    '[::1]:443',
    'localhost:443',
    'github.com:22',
    'registry.npmjs.org:443@example.com',
  ]) {
    const got = await connectVia(target);
    check(`proxy: CONNECT ${target} is refused`, got === 403 || got === 400, got);
  }
  const plain = await viaProxy(
    'GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n',
  );
  check('proxy: plain HTTP is refused', plain === 405, plain);
  const rebind = await connectVia('localtest.me:443');
  check('proxy: a public name resolving to loopback is refused', rebind === 403, rebind);

  // The environment the trooper built, and the tool files it wrote as this user.
  check(
    'env: HTTPS_PROXY is the drop proxy',
    process.env.HTTPS_PROXY === 'http://jm-egress:3128',
    process.env.HTTPS_PROXY,
  );
  check(
    'env: NO_PROXY names the service',
    /(^|,)db(,|$)/.test(process.env.NO_PROXY || ''),
    process.env.NO_PROXY,
  );
  check(
    'env: no JM_ variable but the gate secrets',
    Object.keys(process.env).filter((k) => k.startsWith('JM_') && !k.startsWith('JM_SERVICE_'))
      .length === 0,
    Object.keys(process.env).filter((k) => k.startsWith('JM_')),
  );
  for (const f of ['.m2/settings.xml', '.gradle/gradle.properties']) {
    let st;
    try {
      const s = fs.statSync(`${os.homedir()}/${f}`);
      st = {
        uid: s.uid,
        mode: (s.mode & 0o777).toString(8),
        proxy: /jm-egress/.test(fs.readFileSync(`${os.homedir()}/${f}`, 'utf8')),
      };
    } catch (e) {
      st = String(e.code);
    }
    check(
      `files: ~/${f} is the gate user's, 0600, names the proxy`,
      st.uid === process.getuid() && st.mode === '600' && st.proxy,
      st,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`${JSON.stringify({ mode: MODE, checks: checks.length, failed })}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
