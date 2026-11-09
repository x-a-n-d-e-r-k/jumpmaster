import { Readable } from 'node:stream';
import { EGRESS_PROXY_ALIAS, type ServiceSpec } from '@jumpmaster/protocol';
import Docker from 'dockerode';
import type { ContainerDriver, ContainerHandle, DropNet, ProxyHandle } from './driver.js';
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

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
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
