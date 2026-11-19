// The fake container driver the runner tests use (and the image sweep's tests, with its image
// list/remove and container list): it records what the stick asked of the engine.
import type { ContainerDriver, DropNet } from '../driver.js';
import type { ContainerInfo, ImageGcDriver } from '../image-gc.js';

export const NET: DropNet = {
  name: 'jm-drop-d1-3',
  subnet: '172.30.0.16/28',
  gateway: '172.30.0.17',
  proxy: '172.30.0.18',
  trooper: '172.30.0.19',
  dns: '172.30.0.20',
  ipRange: '172.30.0.24/29',
};

export function fakeDriver(
  lines: string[],
  opts: {
    hang?: boolean;
    exitCode?: number;
    serviceError?: string;
    stderr?: string;
    /** The proxy's stdout; `hang` keeps it open with no ready line. */
    proxyLines?: string[];
    proxyHang?: boolean;
    netError?: string;
    proxyError?: string;
    networks?: { name: string; labels: Record<string, string> }[];
    /** The trooper image's labels (default: a current trooper's); an Error is thrown instead. */
    imageLabels?: Record<string, string> | Error;
    /** Which images are on the engine already (default: all of them). */
    present?: (ref: string) => boolean;
    pullError?: string;
    /** `removeAndWait` throws `container not removed`. */
    removeError?: boolean;
    /** How long a stopped container takes to exit (its grace in use). */
    stopDelayMs?: number;
    /** The engine's images for the sweep: reference to image id (absent: no such image). */
    imageIds?: Record<string, string>;
    /** Every container, running or stopped, for the sweep. */
    containers?: ContainerInfo[];
    /** The container list throws this. */
    listContainersError?: Error;
    /** A remove of this reference throws the error given. */
    removeImageError?: (ref: string) => Error | undefined;
  } = {},
) {
  const order: string[] = [];
  const gc: string[] = [];
  const d = {
    order,
    started: undefined as Parameters<ContainerDriver['start']>[0] | undefined,
    stopped: false,
    killed: false,
    services: undefined as unknown,
    servicesNet: undefined as DropNet | undefined,
    removedNetworks: [] as string[],
    removedLabels: [] as Record<string, string>[],
    stopGrace: 0,
    net: undefined as { name: string; labels: Record<string, string>; pool: string } | undefined,
    proxy: undefined as Parameters<ContainerDriver['startEgressProxy']>[0] | undefined,
    proxyStopped: false,
    inspected: [] as string[],
    /** Pulls and verification steps, in order, with the container steps in `order` too. */
    images: [] as string[],
    /** The sweep's engine calls, in order. */
    gc,
  };
  const driver = {
    async imageId(ref: string): Promise<string | undefined> {
      gc.push(`inspect ${ref}`);
      return opts.imageIds?.[ref];
    },
    async removeImageRef(ref: string): Promise<void> {
      gc.push(`remove ${ref}`);
      const e = opts.removeImageError?.(ref);
      if (e) throw e;
      if (opts.imageIds) delete opts.imageIds[ref];
    },
    async listContainers(): Promise<ContainerInfo[]> {
      gc.push('containers');
      if (opts.listContainersError) throw opts.listContainersError;
      return opts.containers ?? [];
    },
    async imageLabels(image) {
      d.inspected.push(image);
      const l = opts.imageLabels ?? {
        'org.jumpmaster.trooper.egress': '1',
        'org.jumpmaster.trooper.push': '1',
      };
      if (l instanceof Error) throw l;
      return l;
    },
    async createDropNetwork(name, labels, pool) {
      order.push('network');
      d.net = { name, labels, pool };
      if (opts.netError) throw new Error(opts.netError);
      return { ...NET, name };
    },
    async startEgressProxy(o) {
      order.push('proxy');
      d.proxy = o;
      if (opts.proxyError) throw new Error(opts.proxyError);
      let release: () => void = () => {};
      const stopped = new Promise<void>((r) => {
        release = r;
      });
      return {
        async *logs() {
          if (opts.proxyHang) {
            await stopped;
            return;
          }
          yield '{"ready":true}';
          await stopped;
          for (const l of opts.proxyLines ?? []) yield l;
        },
        async stop() {
          order.push('proxy-stop');
          d.proxyStopped = true;
          release();
        },
      };
    },
    async listNetworksByLabel() {
      return opts.networks ?? [];
    },
    async removeNetwork() {},
    async imageExists(ref) {
      return opts.present ? opts.present(ref) : true;
    },
    async pullImage(ref) {
      order.push(`pull ${ref}`);
      d.images.push(`pull ${ref}`);
      if (opts.pullError) throw new Error(opts.pullError);
    },
    async engineVersion() {
      return '29.9.2';
    },
    async selfImage() {
      return undefined;
    },
    async probeIsolation() {
      return {
        listenerUp: true,
        gatewayOnHost: false,
        gatewayReachable: false,
        ipv6Disabled: true,
      };
    },
    async start(o) {
      order.push('trooper');
      d.started = o;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      return {
        async *logs() {
          for (const l of lines) yield l;
          if (opts.hang) await gate;
        },
        async wait() {
          if (opts.hang) await gate;
          return { exitCode: d.stopped ? 137 : (opts.exitCode ?? 0) };
        },
        stderrTail: () => opts.stderr ?? '',
        async stop(grace: number) {
          d.stopped = true;
          d.stopGrace = grace;
          if (opts.stopDelayMs) setTimeout(release, opts.stopDelayMs);
          else release();
        },
        async kill() {
          d.killed = true;
          release();
        },
        async writeLine() {},
        endStdin() {},
      };
    },
    async listByLabel() {
      return [];
    },
    async remove() {},
    async startServices(dropId, epoch, services, labels, net) {
      order.push('services');
      d.services = { dropId, epoch, names: services.map((s) => s.name), labels };
      d.servicesNet = net;
      if (opts.serviceError) throw new Error(opts.serviceError);
      return `jm-drop-${dropId}-${epoch}`;
    },
    async removeServices(network, labels) {
      order.push('teardown');
      d.removedNetworks.push(network);
      d.removedLabels.push(labels);
    },
    async removeNetworksByLabel() {
      return 0;
    },
    async createVolume(name) {
      order.push(`volume ${name.replace(/-[0-9a-f]{8}$/, '')}`);
    },
    async inspectVolume() {
      return undefined;
    },
    async listVolumesByLabel() {
      return [];
    },
    async removeVolume(name) {
      order.push(`removeVolume ${name.replace(/-[0-9a-f]{8}$/, '')}`);
    },
    async initVolume(o) {
      order.push(`init ${o.image}`);
      return 0;
    },
    async removeAndWait(name) {
      order.push(`removeAndWait ${name}`);
      if (opts.removeError) throw new Error('container not removed');
    },
    async probeVolume() {
      return { freeBytes: 100 * 2 ** 30, writable: true };
    },
  } satisfies ContainerDriver & ImageGcDriver;
  return Object.assign(d, { driver });
}
