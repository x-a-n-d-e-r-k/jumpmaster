import type { Config, ConfigIssue } from '../config.js';

export type ConfigMode = 'file' | 'db';

export type ConfigStatus = {
  mode: ConfigMode;
  revision: number;
  filePath?: string;
  /** The issues of the file's last reload, while it stays invalid (doctor `config.file`). */
  fileProblem?: ConfigIssue[];
  /** In db mode with a config file present: the line the startup log and the doctor say. */
  fileIgnored?: string;
  /** With `fileIgnored`: whether the file's bytes equal `ctl config export` (a current mirror). */
  fileMatchesExport?: boolean;
  /** Settings changed since this process started that only a restart applies. */
  restartPending: string[];
};

/** What a consumer needs: the config as it is now (the store, in the server). */
export type ConfigSource = { current(): Config; status?(): ConfigStatus };

/** A fixed config (tests, tools) or a live source. Consumers read it once per pass or request. */
export type LiveConfig = Config | ConfigSource;

export function configReader(c: LiveConfig): () => Config {
  if ('current' in c && typeof c.current === 'function') {
    const source = c as ConfigSource;
    return () => source.current();
  }
  return () => c as Config;
}

/** The store's status, when the source has one. */
export function statusOf(c: LiveConfig): ConfigStatus | undefined {
  return 'status' in c && typeof c.status === 'function' ? c.status() : undefined;
}
