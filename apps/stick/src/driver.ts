import type { Readable } from 'node:stream';
import type { ContainerLimits, ServiceSpec } from '@jumpmaster/protocol';

export type ContainerHandle = {
  logs(): AsyncIterable<string>;
  wait(): Promise<{ exitCode: number }>;
  /** The end of the container's stderr (unredacted), for a failure that left no result. */
  stderrTail(): string;
  stop(graceMs: number): Promise<void>;
  /** SIGKILL with no grace: the trooper gets no chance to checkpoint or push. */
  kill(): Promise<void>;
  /**
   * Writes one more line to stdin (a `holdStdin` container); rejects on an embedded newline and
   * once stdin has ended.
   */
  writeLine(line: string): Promise<void>;
  /** Closes stdin. Safe to call more than once. */
  endStdin(): void;
};

/** The per-drop repo volume, mounted at the one place the trooper uses it. */
export type RepoMount = { volume: string; target: '/home/agent/repo' };

/** A volume this engine holds: its name and labels. */
export type VolumeInfo = { name: string; labels: Record<string, string> };

/** A drop's internal /28 network under egress and its fixed addresses (see subnets.ts). */
export type DropNet = {
  name: string;
  subnet: string;
  gateway: string;
  proxy: string;
  trooper: string;
  /** The dead DNS upstream: in the subnet, never assigned. */
  dns: string;
  ipRange: string;
};

/** What the capability probe saw on a real drop network (see `probeIsolation`). */
export type IsolationFacts = {
  /** The host-side listener started (without it the other facts prove nothing). */
  listenerUp: boolean;
  /** The drop's gateway address is on one of the host's interfaces. */
  gatewayOnHost: boolean;
  /** A container with the drop's settings connected to the host listener at the gateway. */
  gatewayReachable: boolean;
  /** IPv6 was off in that container (the drop sysctls applied). */
  ipv6Disabled: boolean;
};

/** The running egress proxy: its stdout lines (ready, then one per tunnel) and a stop. */
export type ProxyHandle = {
  logs(): AsyncIterable<string>;
  /** Stops it gracefully, so its open tunnels are logged; the logs then end. */
  stop(): Promise<void>;
};

export interface ContainerDriver {
  start(o: {
    image: string;
    /** JSON payload, delivered on the container's stdin (never a file). */
    payload: string;
    name: string;
    labels: Record<string, string>;
    /**
     * Without egress: a private network for services, joined alongside the default one. With
     * egress (`egress` set): the only network, which has no route out.
     */
    network?: string;
    /** Egress on: the trooper joins only this drop network, at `.3`, with the dead DNS. */
    egress?: DropNet;
    limits?: ContainerLimits;
    /** The drop's repo volume: the container's only mount (no binds). */
    mount?: RepoMount;
    /**
     * Keep stdin open after the payload line, for `writeLine`/`endStdin`. Otherwise stdin ends
     * right after the payload.
     */
    holdStdin?: boolean;
  }): Promise<ContainerHandle>;
  /** Creates a local volume with these labels. */
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  /** The volume, or undefined when the engine has none by that name. */
  inspectVolume(name: string): Promise<VolumeInfo | undefined>;
  /** Volumes whose label `key` equals `value`. */
  listVolumesByLabel(key: string, value: string): Promise<VolumeInfo[]>;
  /** Removes one volume; gone already is fine, anything else (in use) throws. */
  removeVolume(name: string): Promise<void>;
  /**
   * Runs the locked-down init container on a fresh volume: from `image`, as root with only
   * CHOWN, no network, the volume its only mount. It gives the mount point to the agent (0700)
   * and is removed (confirmed) before this returns its exit code.
   */
  initVolume(o: {
    name: string;
    image: string;
    volume: string;
    labels: Record<string, string>;
  }): Promise<number>;
  /**
   * Force-removes the container, then resolves once the engine answers 404 for it; throws
   * `container not removed` when it still exists (or can't be checked) after `timeoutMs`.
   */
  removeAndWait(name: string, timeoutMs: number): Promise<void>;
  /**
   * The volume self-check's probe: a container from `image` with the init container's lockdown
   * (no network, no capability at all, read-only root, the volume its only mount), run as the
   * agent. It measures the free space of the volume's filesystem (where the engine keeps every
   * volume) and whether the agent can write there. Removed (confirmed) before this returns.
   * Throws when the free space can't be read.
   */
  probeVolume(o: {
    name: string;
    image: string;
    volume: string;
    labels: Record<string, string>;
  }): Promise<{ freeBytes: number; writable: boolean }>;
  /**
   * Starts sidecars and returns the network name. Without `net`, on a new internal network; with
   * `net` (egress), on that drop network with the dead DNS, like the trooper.
   */
  startServices(
    dropId: string,
    epoch: number,
    services: ServiceSpec[],
    labels: Record<string, string>,
    net?: DropNet,
  ): Promise<string>;
  /** Removes a drop's sidecars, its proxy and its network; anything already gone is fine. */
  removeServices(network: string, labels: Record<string, string>): Promise<void>;
  /** Removes networks left behind by a crashed run; returns how many. */
  removeNetworksByLabel(key: string, value: string): Promise<number>;
  /** Ids of every container (running or not) whose label `key` equals `value`. */
  listByLabel(key: string, value: string): Promise<string[]>;
  /** Force-removes (kills) one container. */
  remove(id: string): Promise<void>;
  /**
   * Creates the drop's internal network on a free /28 of `pool`, retrying with the next subnet
   * when the engine reports a conflict. No gateway address on the host side.
   */
  createDropNetwork(name: string, labels: Record<string, string>, pool: string): Promise<DropNet>;
  /** Starts the drop's proxy at `net.proxy`, also on the shared `jm-egress-out` network. */
  startEgressProxy(o: {
    name: string;
    image: string;
    net: DropNet;
    env: Record<string, string>;
    labels: Record<string, string>;
  }): Promise<ProxyHandle>;
  /** Networks whose label `key` equals `value`, with their labels. */
  listNetworksByLabel(
    key: string,
    value: string,
  ): Promise<{ name: string; labels: Record<string, string> }[]>;
  /** Removes one network; gone already is fine. */
  removeNetwork(name: string): Promise<void>;
  /** Whether the image is present on this engine. */
  imageExists(image: string): Promise<boolean>;
  /**
   * Pulls `ref` (a digest reference), reporting each progress event; rejects on any error the
   * engine reports and when `signal` aborts.
   */
  pullImage(
    ref: string,
    onProgress: (event: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** The image this stick's own container runs (an image id), or undefined outside a container. */
  selfImage(): Promise<string | undefined>;
  /** The image's config labels (empty when it has none); throws when it can't be inspected. */
  imageLabels(image: string): Promise<Record<string, string>>;
  /** The engine's version (`Server.Version`). */
  engineVersion(): Promise<string>;
  /**
   * Behavioural check of a drop network: a listener on the host network (run from `images.host`,
   * the stick's own image where it can find it, as an unprivileged user), and a container on
   * `net` with the trooper's settings (from `images.drop`) trying to reach it at the gateway. Both
   * images need node. Containers it starts are removed before it returns.
   */
  probeIsolation(net: DropNet, images: { host: string; drop: string }): Promise<IsolationFacts>;
}

/** Loading an image the stick fetched from its server (issue #141), as `docker load` does. */
export interface ImageLoader {
  /** Whether the image is present on this engine. */
  imageExists(image: string): Promise<boolean>;
  /**
   * Loads an image tar; resolves to the ids of the images it loaded (a name the engine reports is
   * resolved to its id). Rejects on any error the engine reports and when `signal` aborts.
   */
  loadImage(tar: Readable, signal: AbortSignal): Promise<string[]>;
  /** Removes an image by id; gone already is fine. */
  removeImage(id: string): Promise<void>;
  /**
   * Makes `ref` (a digest reference) name the image `id`, so `imageExists(ref)` finds it and
   * containers are created from it. Throws when the engine can't.
   */
  tagImage(id: string, ref: string): Promise<void>;
}
