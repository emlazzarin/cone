import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultStatePath(): string {
  if (process.env.COS_STATE_PATH) {
    return process.env.COS_STATE_PATH;
  }
  if (process.env.COS_HOME) {
    return join(process.env.COS_HOME, 'state.sqlite');
  }
  return join(homedir(), '.local', 'share', 'cone-of-silence', 'state.sqlite');
}

export function defaultConfigPath(): string {
  if (process.env.COS_CONFIG_PATH) {
    return process.env.COS_CONFIG_PATH;
  }
  if (process.env.COS_HOME) {
    return join(process.env.COS_HOME, 'config.json');
  }
  return join(homedir(), '.config', 'cone-of-silence', 'config.json');
}

export function defaultRendezvousUrl(): string {
  return process.env.COS_RENDEZVOUS_URL ?? 'http://localhost:8787';
}
