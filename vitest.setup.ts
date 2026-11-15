/**
 * Unit tests must not inherit the trooper container they may run in. The trooper image sets these
 * for a drop (its work root, the agent and gate users); a test that reads them would act as a live
 * drop, as when a Jumpmaster zone runs this repository's own gates inside a trooper image.
 */
export const CONTAINER_ENV = [
  'JM_CONTAINER',
  'JM_WORK_ROOT',
  'JM_AGENT_UID',
  'JM_AGENT_GID',
  'JM_AGENT_HOME',
  'JM_GATE_UID',
  'JM_GATE_GID',
  'JM_GATE_HOME',
] as const;

for (const name of CONTAINER_ENV) delete process.env[name];
