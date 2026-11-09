import type { ContainerLimits, ServiceSpec } from '@jumpmaster/protocol';

export type ContainerHandle = {
  logs(): AsyncIterable<string>;
  wait(): Promise<{ exitCode: number }>;
  /** The end of the container's stderr (unredacted), for a failure that left no result. */
  stderrTail(): string;
  stop(graceMs: number): Promise<void>;
  /** SIGKILL with no grace: the trooper gets no chance to checkpoint or push. */
  kill(): Promise<void>;
};

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
  }): Promise<ContainerHandle>;
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
  /** The image's config labels (empty when it has none); throws when it can't be inspected. */
  imageLabels(image: string): Promise<Record<string, string>>;
  /** The engine's version (`Server.Version`). */
  engineVersion(): Promise<string>;
  /**
   * Behavioural check of a drop network with `image` (any image with node): a listener on the
   * host network, and a container on `net` with the trooper's settings trying to reach it at the
   * gateway. Containers it starts are removed before it returns.
   */
  probeIsolation(net: DropNet, image: string): Promise<IsolationFacts>;
}
