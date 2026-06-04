import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultStatePath(id?: string): string {
  if (process.env.COS_STATE_PATH) {
    return process.env.COS_STATE_PATH;
  }
  const resolvedId = normalizeCliId(id ?? process.env.COS_ID);
  if (process.env.COS_HOME) {
    return join(process.env.COS_HOME, 'state', resolvedId ?? 'default', 'state.sqlite');
  }
  if (resolvedId) {
    return join(homedir(), '.local', 'share', 'cone-of-silence', 'ids', resolvedId, 'state.sqlite');
  }
  return join(homedir(), '.local', 'share', 'cone-of-silence', 'state.sqlite');
}

export function defaultConfigPath(id?: string): string {
  if (process.env.COS_CONFIG_PATH) {
    return process.env.COS_CONFIG_PATH;
  }
  const resolvedId = normalizeCliId(id ?? process.env.COS_ID);
  if (process.env.COS_HOME) {
    return join(process.env.COS_HOME, 'config', resolvedId ?? 'default', 'config.json');
  }
  if (resolvedId) {
    return join(homedir(), '.config', 'cone-of-silence', 'ids', resolvedId, 'config.json');
  }
  return join(homedir(), '.config', 'cone-of-silence', 'config.json');
}

export function defaultRendezvousUrl(): string {
  return process.env.COS_RENDEZVOUS_URL ?? 'http://localhost:8787';
}

export function normalizeCliId(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error('id must be 1-64 characters and contain only letters, numbers, dots, underscores, or dashes');
  }
  return normalized;
}
