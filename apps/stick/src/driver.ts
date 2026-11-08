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

export interface ContainerDriver {
  start(o: {
    image: string;
    /** JSON payload, delivered on the container's stdin (never a file). */
    payload: string;
    name: string;
    labels: Record<string, string>;
    /** A private network to join alongside the default one. */
    network?: string;
    limits?: ContainerLimits;
  }): Promise<ContainerHandle>;
  /** Starts sidecars on a new internal network and returns its name. */
  startServices(
    dropId: string,
    epoch: number,
    services: ServiceSpec[],
    labels: Record<string, string>,
  ): Promise<string>;
  /** Removes a drop's sidecars and network; anything already gone is fine. */
  removeServices(network: string, labels: Record<string, string>): Promise<void>;
  /** Removes networks left behind by a crashed run; returns how many. */
  removeNetworksByLabel(key: string, value: string): Promise<number>;
  /** Ids of every container (running or not) whose label `key` equals `value`. */
  listByLabel(key: string, value: string): Promise<string[]>;
  /** Force-removes (kills) one container. */
  remove(id: string): Promise<void>;
}
