export type ContainerHandle = {
  logs(): AsyncIterable<string>;
  wait(): Promise<{ exitCode: number }>;
  stop(graceMs: number): Promise<void>;
};

export interface ContainerDriver {
  start(o: {
    image: string;
    /** JSON payload, delivered on the container's stdin (never a file). */
    payload: string;
    name: string;
    labels: Record<string, string>;
  }): Promise<ContainerHandle>;
  /** Ids of every container (running or not) whose label `key` equals `value`. */
  listByLabel(key: string, value: string): Promise<string[]>;
  /** Force-removes (kills) one container. */
  remove(id: string): Promise<void>;
}
