import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultStatePath(): string {
  if (process.env.CONE_STATE_PATH) {
    return process.env.CONE_STATE_PATH;
  }
  if (process.env.CONE_HOME) {
    return join(process.env.CONE_HOME, 'state.sqlite');
  }
  return join(homedir(), '.local', 'share', 'cone', 'state.sqlite');
}

export function defaultConfigPath(): string {
  if (process.env.CONE_CONFIG_PATH) {
    return process.env.CONE_CONFIG_PATH;
  }
  if (process.env.CONE_HOME) {
    return join(process.env.CONE_HOME, 'config.json');
  }
  return join(homedir(), '.config', 'cone', 'config.json');
}

export function defaultRendezvousUrl(): string {
  return process.env.CONE_RENDEZVOUS_URL ?? 'http://localhost:8787';
}
