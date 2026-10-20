import { Readable } from 'node:stream';
import Docker from 'dockerode';
import type { ContainerDriver, ContainerHandle } from './driver.js';

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
  constructor(private readonly docker = new Docker()) {}

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
        PidsLimit: 512,
        Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
      },
    });

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
    err.resume(); // stderr is not relayed
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
