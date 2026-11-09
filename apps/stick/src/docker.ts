import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { EGRESS_PROXY_ALIAS, type ServiceSpec } from '@jumpmaster/protocol';
import Docker from 'dockerode';
import type {
  ContainerDriver,
  ContainerHandle,
  DropNet,
  IsolationFacts,
  ProxyHandle,
} from './driver.js';
import { allocateSubnet, dropLayout } from './subnets.js';

const SERVICE_LABEL = 'jumpmaster.service';
/** `drop` on a drop network, `proxy` on a proxy container, `out` on the shared exit network. */
export const EGRESS_LABEL = 'jumpmaster.egress';
/** The one network with a route out, shared by every drop's proxy (and nothing else). */
export const EGRESS_OUT = 'jm-egress-out';
const SUBNET_ATTEMPTS = 8;
const PROXY_PIDS = 64;
const PROXY_MEMORY_MB = 256;
/**
 * The resolver's upstream is the dead in-subnet address, tried once for a second: the engine's
 * embedded DNS answers container names and aliases, and every external name fails.
 */
const DEAD_DNS_OPTIONS = ['timeout:1', 'attempts:1'];
/** No IPv6 inside a drop under egress, whatever the engine does with link-local addresses. */
const NO_IPV6 = {
  'net.ipv6.conf.all.disable_ipv6': '1',
  'net.ipv6.conf.default.disable_ipv6': '1',
};

const PROBE_MS = 20_000;
/** The host-network probe containers run as nobody. */
const PROBE_USER = '65534:65534';

/**
 * `name@sha256:…` for a pull: a `name:tag@sha256:…` reference loses its tag, which the digest
 * overrides anyway (the API would otherwise take the tag as part of the repository name).
 */
export function pullRef(ref: string): string {
  const at = ref.lastIndexOf('@');
  if (at < 0) return ref;
  const name = ref.slice(0, at);
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return `${colon > slash ? name.slice(0, colon) : name}${ref.slice(at)}`;
}

/**
 * This process's container id, from the bind mounts Docker gives every container (its
 * hostname, hosts and resolv.conf live under /var/lib/docker/containers/<id>/). Undefined
 * outside a container.
 */
export function ownContainerId(mountinfo?: string): string | undefined {
  let text = mountinfo;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/self/mountinfo', 'utf8');
    } catch {
      return undefined;
    }
  }
  return /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)\b/.exec(text)?.[1];
}
/** On the host network: listens on every address and reports the host's addresses. */
const HOST_ADDRESSES = `const os=require('os');console.log(JSON.stringify({addrs:Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a)=>a.address)}));`;
const HOST_LISTENER = `const net=require('net'),os=require('os');const s=net.createServer((c)=>c.end('hi'));s.on('error',()=>{console.log(JSON.stringify({listening:false}));process.exit(0)});s.listen(Number(process.env.PORT),'0.0.0.0',()=>{const addrs=Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a)=>a.address);console.log(JSON.stringify({listening:true,addrs}))});setTimeout(()=>process.exit(0),60000);`;
/**
 * On the drop network, with the trooper's settings: tries the host listener at the gateway, then
 * stays attached so the host's addresses are read while the network is in use.
 */
const DROP_PROBE = `const net=require('net'),fs=require('fs');let v6;try{v6=fs.readFileSync('/proc/sys/net/ipv6/conf/all/disable_ipv6','utf8').trim()}catch(e){v6=String(e.code)}const s=net.connect({host:process.env.GW,port:Number(process.env.PORT)});const done=(r)=>{s.destroy();console.log(JSON.stringify({connect:r,v6}));setTimeout(()=>process.exit(0),30000)};s.setTimeout(3000,()=>done('timeout'));s.on('connect',()=>done('connected'));s.on('error',(e)=>done(e.code||'error'));`;

/** The first JSON line of a stream, or null when it ends or the time runs out first. */
async function firstJsonLine(
  stream: AsyncIterable<string>,
  ms: number,
): Promise<Record<string, unknown> | null> {
  const it = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timer);
    if (next === 'timeout' || next.done) return null;
    try {
      return JSON.parse(next.value) as Record<string, unknown>;
    } catch {
      // keep reading
    }
  }
}

/** Whether a network create failed because the subnet is taken (another drop raced us to it). */
const isSubnetConflict = (e: unknown): boolean =>
  /overlap|in use|conflict/i.test(e instanceof Error ? e.message : String(e));

const egressHostConfig = (net: DropNet) => ({
  NetworkMode: net.name,
  Dns: [net.dns],
  DnsOptions: DEAD_DNS_OPTIONS,
  Sysctls: NO_IPV6,
});
const DEFAULT_PIDS = 512;
const NETWORK_REMOVE_ATTEMPTS = 5;
const MB = 1024 * 1024;
const STDERR_TAIL_CHARS = 4000;

/** Splits a byte stream into lines. */
async function* lines(stream: Readable): AsyncIterable<string> {
  let buf = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
  }
  if (buf) yield buf;
}

export class DockerDriver implements ContainerDriver {
  constructor(
    private readonly docker = new Docker(),
    private readonly opts: { networkRetryMs?: number } = {},
  ) {}

  async listByLabel(key: string, value: string): Promise<string[]> {
    const found = await this.docker.listContainers({
      all: true,
      filters: { label: [`${key}=${value}`] },
    });
    return found.map((c) => c.Id);
  }

  async remove(id: string): Promise<void> {
    await this.docker.getContainer(id).remove({ force: true });
  }

  async startServices(
    dropId: string,
    epoch: number,
    services: ServiceSpec[],
    labels: Record<string, string>,
    net?: DropNet,
  ): Promise<string> {
    const name = net?.name ?? `jm-drop-${dropId}-${epoch}`;
    if (!net) await this.docker.createNetwork({ Name: name, Internal: true, Labels: labels });
    for (const s of services) {
      let container: Docker.Container;
      try {
        container = await this.docker.createContainer({
          Image: s.image,
          Env: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`),
          Labels: { ...labels, [SERVICE_LABEL]: s.name },
          // No published ports or mounts. Default capabilities: database images need them.
          HostConfig: {
            NetworkMode: name,
            ...(net ? egressHostConfig(net) : {}),
            Privileged: false,
            SecurityOpt: ['no-new-privileges'],
            PidsLimit: DEFAULT_PIDS,
            Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
          },
          NetworkingConfig: { EndpointsConfig: { [name]: { Aliases: [s.name] } } },
        });
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404) {
          throw new Error(`image ${s.image} is missing: docker pull ${s.image} on this host`);
        }
        throw e;
      }
      await container.start();
    }
    return name;
  }

  async removeServices(network: string, labels: Record<string, string>): Promise<void> {
    const filter = [...Object.entries(labels).map(([k, v]) => `${k}=${v}`), SERVICE_LABEL];
    const found = await this.docker
      .listContainers({ all: true, filters: { label: filter } })
      .catch(() => []);
    for (const c of found) {
      await this.docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {});
    }
    // The trooper can still be detaching just after it exits, and Docker then refuses. A leaked
    // network holds a subnet from a small pool, so this is worth waiting a few seconds for.
    const baseMs = this.opts.networkRetryMs ?? 1000;
    for (let attempt = 0; attempt < NETWORK_REMOVE_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, baseMs * 2 ** (attempt - 1)));
      try {
        await this.docker.getNetwork(network).remove();
        return;
      } catch {
        // Gone already, or still in use. The stick's startup sweep is the backstop.
      }
    }
  }

  async removeNetworksByLabel(key: string, value: string): Promise<number> {
    const found = await this.docker.listNetworks({ filters: { label: [`${key}=${value}`] } });
    for (const n of found) {
      await this.docker
        .getNetwork(n.Id)
        .remove()
        .catch(() => {});
    }
    return found.length;
  }

  async createDropNetwork(
    name: string,
    labels: Record<string, string>,
    pool: string,
  ): Promise<DropNet> {
    const refused: string[] = [];
    for (let attempt = 0; attempt < SUBNET_ATTEMPTS; attempt++) {
      const held = await this.networkSubnets();
      const net = dropLayout(name, allocateSubnet([...held, ...refused], pool));
      try {
        await this.docker.createNetwork({
          Name: name,
          Internal: true,
          CheckDuplicate: true,
          EnableIPv6: false,
          Labels: { ...labels, [EGRESS_LABEL]: 'drop' },
          // No address on the host's side of the bridge: the drop can't reach the host through
          // its gateway, whatever the host listens on.
          Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
          IPAM: {
            Driver: 'default',
            Config: [{ Subnet: net.subnet, IPRange: net.ipRange, Gateway: net.gateway }],
          },
        });
        return net;
      } catch (e) {
        if (!isSubnetConflict(e)) throw e;
        refused.push(net.subnet);
      }
    }
    throw new Error(`no drop subnet after ${SUBNET_ATTEMPTS} conflicts`);
  }

  /** Every IPv4 and IPv6 subnet any network on this engine holds. */
  private async networkSubnets(): Promise<string[]> {
    const all = (await this.docker.listNetworks()) as {
      IPAM?: { Config?: { Subnet?: string }[] | null };
    }[];
    return all.flatMap((n) => (n.IPAM?.Config ?? []).flatMap((c) => (c.Subnet ? [c.Subnet] : [])));
  }

  /** The shared exit network: created once, labelled; one that isn't ours is never used. */
  private async ensureEgressOut(): Promise<void> {
    const find = async () =>
      (
        (await this.docker.listNetworks({ filters: { name: [EGRESS_OUT] } })) as {
          Name: string;
          Labels?: Record<string, string> | null;
        }[]
      ).find((n) => n.Name === EGRESS_OUT);
    const check = (n: { Labels?: Record<string, string> | null }) => {
      if (n.Labels?.[EGRESS_LABEL] !== 'out')
        throw new Error(
          `a network named ${EGRESS_OUT} exists without the ${EGRESS_LABEL}=out label`,
        );
    };
    const existing = await find();
    if (existing) return check(existing);
    try {
      await this.docker.createNetwork({
        Name: EGRESS_OUT,
        CheckDuplicate: true,
        Labels: { [EGRESS_LABEL]: 'out' },
        // Proxies of different drops can't talk to each other here.
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      });
    } catch (e) {
      // Another drop created it first.
      const raced = await find();
      if (!raced) throw e;
      check(raced);
    }
  }

  async startEgressProxy(
    o: Parameters<ContainerDriver['startEgressProxy']>[0],
  ): Promise<ProxyHandle> {
    await this.ensureEgressOut();
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        Image: o.image,
        name: o.name,
        Env: Object.entries(o.env).map(([k, v]) => `${k}=${v}`),
        Labels: { ...o.labels, [SERVICE_LABEL]: EGRESS_PROXY_ALIAS, [EGRESS_LABEL]: 'proxy' },
        HostConfig: {
          NetworkMode: o.net.name,
          ReadonlyRootfs: true,
          Privileged: false,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: PROXY_PIDS,
          Memory: PROXY_MEMORY_MB * MB,
          MemorySwap: PROXY_MEMORY_MB * MB,
          Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [o.net.name]: {
              IPAMConfig: { IPv4Address: o.net.proxy },
              Aliases: [EGRESS_PROXY_ALIAS],
            },
          },
        },
      });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404)
        throw new Error(`image ${o.image} is missing: build or pull it on this host`);
      throw e;
    }
    await this.docker.getNetwork(EGRESS_OUT).connect({ Container: container.id });
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    (stream as unknown as Readable).on('error', () => {});
    const out = new Readable({ read() {} });
    const err = new Readable({ read() {} });
    err.resume();
    container.modem.demuxStream(stream, wrap(out), wrap(err));
    stream.on('end', () => {
      out.push(null);
      err.push(null);
    });
    await container.start();
    return {
      logs: () => lines(out),
      async stop() {
        await container.stop({ t: 5 }).catch(() => {});
      },
    };
  }

  async listNetworksByLabel(
    key: string,
    value: string,
  ): Promise<{ name: string; labels: Record<string, string> }[]> {
    const found = (await this.docker.listNetworks({
      filters: { label: [`${key}=${value}`] },
    })) as { Name: string; Labels?: Record<string, string> | null }[];
    return found.map((n) => ({ name: n.Name, labels: n.Labels ?? {} }));
  }

  async removeNetwork(name: string): Promise<void> {
    await this.docker
      .getNetwork(name)
      .remove()
      .catch(() => {});
  }

  async engineVersion(): Promise<string> {
    const v = (await this.docker.version()) as { Version?: string };
    return v.Version ?? '';
  }

  async probeIsolation(
    net: DropNet,
    images: { host: string; drop: string },
  ): Promise<IsolationFacts> {
    const hardening = {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: PROXY_PIDS,
    };
    const labels = { [EGRESS_LABEL]: 'probe' };
    const created: Docker.Container[] = [];
    const run = async (image: string, o: Docker.ContainerCreateOptions) => {
      const c = await this.docker.createContainer({ Image: image, Labels: labels, ...o });
      created.push(c);
      const stream = (await c.attach({
        stream: true,
        stdout: true,
        stderr: false,
      })) as unknown as Readable;
      stream.on('error', () => {});
      const out = new Readable({ read() {} });
      c.modem.demuxStream(stream, wrap(out), wrap(new Readable({ read() {} })));
      stream.on('end', () => out.push(null));
      await c.start();
      return firstJsonLine(lines(out), PROBE_MS);
    };
    try {
      let listener: { listening?: boolean; addrs?: string[] } | null = null;
      let port = 0;
      for (let attempt = 0; attempt < 3 && !listener?.listening; attempt++) {
        port = 40_000 + Math.floor(Math.random() * 10_000);
        // On the host's network: from the stick's own image, as nobody.
        listener = await run(images.host, {
          Entrypoint: ['node', '-e', HOST_LISTENER],
          Env: [`PORT=${port}`],
          User: PROBE_USER,
          HostConfig: { NetworkMode: 'host', ...hardening },
        });
      }
      if (!listener?.listening)
        return {
          listenerUp: false,
          gatewayOnHost: false,
          gatewayReachable: false,
          ipv6Disabled: false,
        };
      const inside = (await run(images.drop, {
        Entrypoint: ['node', '-e', DROP_PROBE],
        Env: [`GW=${net.gateway}`, `PORT=${port}`],
        HostConfig: { ...egressHostConfig(net), ...hardening },
        NetworkingConfig: {
          EndpointsConfig: { [net.name]: { IPAMConfig: { IPv4Address: net.trooper } } },
        },
      })) as { connect?: string; v6?: string } | null;
      // Read while the drop container is attached: an engine may bring the bridge up lazily.
      const host = (await run(images.host, {
        Entrypoint: ['node', '-e', HOST_ADDRESSES],
        User: PROBE_USER,
        HostConfig: { NetworkMode: 'host', ...hardening },
      })) as { addrs?: string[] } | null;
      return {
        listenerUp: true,
        gatewayOnHost: [...(listener.addrs ?? []), ...(host?.addrs ?? [])].includes(net.gateway),
        // No answer at all from inside is not proof of isolation: treat it as reachable.
        gatewayReachable: inside === null || inside.connect === 'connected',
        ipv6Disabled: inside?.v6 === '1',
      };
    } finally {
      for (const c of created) await c.remove({ force: true }).catch(() => {});
    }
  }

  async pullImage(
    ref: string,
    onProgress: (event: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('aborted');
    const stream = (await this.docker.pull(pullRef(ref), { abortSignal: signal })) as Readable;
    const abort = () => stream.destroy(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      // One JSON object per line; an `error` in any of them is the pull failing.
      for await (const line of lines(stream)) {
        if (line.trim() === '') continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.error !== undefined || event.errorDetail !== undefined)
          throw new Error(
            String(event.error ?? (event.errorDetail as { message?: unknown })?.message ?? 'error'),
          );
        onProgress(event);
      }
    } finally {
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) throw new Error('aborted');
  }

  async selfImage(): Promise<string | undefined> {
    const id = ownContainerId();
    if (!id) return undefined;
    try {
      const info = (await this.docker.getContainer(id).inspect()) as { Image?: string };
      return typeof info.Image === 'string' && info.Image !== '' ? info.Image : undefined;
    } catch {
      return undefined;
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async imageLabels(image: string): Promise<Record<string, string>> {
    const info = (await this.docker.getImage(image).inspect()) as {
      Config?: { Labels?: Record<string, string> | null };
    };
    return { ...(info.Config?.Labels ?? {}) };
  }

  async start(o: Parameters<ContainerDriver['start']>[0]): Promise<ContainerHandle> {
    const container = await this.docker.createContainer({
      Image: o.image,
      name: o.name,
      Labels: o.labels,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        // An init as PID 1 forwards the stop signal to the trooper, which checkpoints on it.
        Init: true,
        Privileged: false,
        // The trooper (root, PID 1) only needs to drop to the agent/gate uids and kill their
        // processes. No CHOWN or DAC_OVERRIDE: root cannot read the agent's private files.
        CapDrop: ['ALL'],
        CapAdd: ['SETUID', 'SETGID', 'KILL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: o.limits?.pids ?? DEFAULT_PIDS,
        // MemorySwap equal to Memory: no swap, so a heavy drop can't thrash a shared host.
        ...(o.limits?.memoryMb
          ? { Memory: o.limits.memoryMb * MB, MemorySwap: o.limits.memoryMb * MB }
          : {}),
        ...(o.limits?.shmMb ? { ShmSize: o.limits.shmMb * MB } : {}),
        Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
        // Egress: created on the drop network only, so it never touches a network with a route.
        ...(o.egress ? egressHostConfig(o.egress) : {}),
      },
      ...(o.egress
        ? {
            NetworkingConfig: {
              EndpointsConfig: {
                [o.egress.name]: { IPAMConfig: { IPv4Address: o.egress.trooper } },
              },
            },
          }
        : {}),
    });

    if (o.network && !o.egress)
      await this.docker.getNetwork(o.network).connect({ Container: container.id });

    // Attach before start so no output is missed; the payload (with tokens)
    // goes over stdin, never onto disk or into a mount.
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });
    stream.on('error', () => {}); // EPIPE/ECONNRESET when the container dies instantly
    const out = new Readable({ read() {} });
    const err = new Readable({ read() {} });
    container.modem.demuxStream(stream, wrap(out), wrap(err));
    stream.on('end', () => {
      out.push(null);
      err.push(null);
    });
    // stderr is not relayed; its tail explains a trooper that died before posting a result.
    let errTail = '';
    err.on('data', (c: Buffer) => {
      const all = errTail + c.toString('utf8');
      if (all.length <= STDERR_TAIL_CHARS) errTail = all;
      else {
        // A cut line may start mid-credential, past what redaction can recognise: drop it.
        const cut = all.slice(-STDERR_TAIL_CHARS);
        const nl = cut.indexOf('\n');
        errTail = nl < 0 ? '' : cut.slice(nl + 1);
      }
    });
    // AutoRemove means the container may be gone by the time we ask; subscribe first.
    const waited = container.wait({ condition: 'next-exit' }).then(
      (r: { StatusCode: number }) => ({ exitCode: r.StatusCode }),
      () => ({ exitCode: -1 }),
    );
    try {
      await container.start();
    } catch (e) {
      (stream as unknown as Readable).destroy();
      await container.remove({ force: true }).catch(() => {});
      throw e;
    }
    try {
      stream.end(o.payload);
    } catch {
      // container already gone; exit code surfaces via wait()
    }

    return {
      logs: () => lines(out),
      wait: () => waited,
      stderrTail: () => errTail,
      async kill() {
        await container.kill({ signal: 'SIGKILL' }).catch(() => {});
      },
      async stop(graceMs: number) {
        try {
          await container.kill({ signal: 'SIGINT' });
        } catch {
          return; // already gone
        }
        const done = await Promise.race([
          waited.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
        ]);
        if (!done) await container.kill({ signal: 'SIGKILL' }).catch(() => {});
      },
    };
  }
}

function wrap(r: Readable) {
  return {
    write: (c: Buffer) => r.push(c),
    end: () => {},
    on: () => {},
    once: () => {},
    emit: () => {},
  } as unknown as NodeJS.WritableStream;
}
