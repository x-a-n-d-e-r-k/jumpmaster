import { Readable } from 'node:stream';
import type { ServiceSpec } from '@jumpmaster/protocol';
import Docker from 'dockerode';
import type { ContainerDriver, ContainerHandle } from './driver.js';

const SERVICE_LABEL = 'jumpmaster.service';
const DEFAULT_PIDS = 512;
const NETWORK_REMOVE_ATTEMPTS = 5;
const MB = 1024 * 1024;
const STDERR_TAIL_BYTES = 4000;

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
  ): Promise<string> {
    const name = `jm-drop-${dropId}-${epoch}`;
    await this.docker.createNetwork({ Name: name, Internal: true, Labels: labels });
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
      },
    });

    if (o.network) await this.docker.getNetwork(o.network).connect({ Container: container.id });

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
      errTail = (errTail + c.toString('utf8')).slice(-STDERR_TAIL_BYTES);
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
