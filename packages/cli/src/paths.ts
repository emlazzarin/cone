import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_RENDEZVOUS_URL } from '@cone/core';

// CONE_HOME is the single path override: one directory holding config.json
// and state.sqlite. The exact-path CONE_STATE_PATH/CONE_CONFIG_PATH knobs
// were removed deliberately — two overrides for one decision, and their
// precedence over CONE_HOME meant a repo .env could silently make separate
// actors share one state database.
//
// 'environment' means a real env var *or* the repo .env Bun auto-loaded —
// the two are indistinguishable from inside the process. `cone config`
// surfaces these resolutions.

export type ConfigSource = 'default' | 'environment';

export interface ResolvedValue<T> {
  value: T;
  source: ConfigSource;
}

export function resolveStatePath(): ResolvedValue<string> {
  if (process.env.CONE_HOME) {
    return { value: join(process.env.CONE_HOME, 'state.sqlite'), source: 'environment' };
  }
  return { value: join(homedir(), '.local', 'share', 'cone', 'state.sqlite'), source: 'default' };
}

export function resolveConfigPath(): ResolvedValue<string> {
  if (process.env.CONE_HOME) {
    return { value: join(process.env.CONE_HOME, 'config.json'), source: 'environment' };
  }
  return { value: join(homedir(), '.config', 'cone', 'config.json'), source: 'default' };
}

export function resolveRendezvousUrl(): ResolvedValue<string> {
  if (process.env.CONE_RENDEZVOUS_URL) {
    return { value: process.env.CONE_RENDEZVOUS_URL, source: 'environment' };
  }
  return { value: DEFAULT_RENDEZVOUS_URL, source: 'default' };
}

export function defaultStatePath(): string {
  return resolveStatePath().value;
}

export function defaultConfigPath(): string {
  return resolveConfigPath().value;
}

export function defaultRendezvousUrl(): string {
  return resolveRendezvousUrl().value;
}
