import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, openSync, closeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { ConeError, generateSecretKey, parseSecretKey, type SecretKey, type XmtpEnv } from '@cone/core';

import { defaultConfigPath } from './paths';

export interface CliConfig {
  secretKey?: string;
  env?: XmtpEnv;
  readReceipts?: boolean;
  // "Allow contacts to add you to groups" (default true): a group add from an
  // address-book contact lands directly in Chats; off routes every add to
  // Requests. Adds from blocked inboxes are always discarded silently.
  groupAutoAllow?: boolean;
}

export function initializeConfig(env?: XmtpEnv, path = defaultConfigPath()): { created: boolean; config: CliConfig } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = readConfig(path);
  const provided = process.env.CONE_SECRET_KEY ? parseSecretKey(process.env.CONE_SECRET_KEY) : undefined;
  if (existing.secretKey) {
    parseSecretKey(existing.secretKey);
    if (provided && provided !== existing.secretKey) throw new Error('CONE_SECRET_KEY differs from the saved identity; unset it or use a separate CONE_HOME');
    if (env && existing.env && env !== existing.env) throw new Error(`Cone is already initialized for ${existing.env}; use a separate CONE_HOME for ${env}`);
    if (!existing.env && env) writeConfig({ ...existing, env }, path);
    chmodSync(path, 0o600);
    return { created: false, config: readConfig(path) };
  }
  if (existsSync(path)) throw new Error(`Cone config exists without an identity: ${path}; restore its key before initializing`);
  const config: CliConfig = { secretKey: provided ?? generateSecretKey(), env: env ?? 'production', groupAutoAllow: false };
  try {
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    return initializeConfig(env, path);
  }
  return { created: true, config };
}

export function readConfig(path = defaultConfigPath()): CliConfig {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
}

export function writeConfig(config: CliConfig, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(config, null, 2));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function loadSecretKey(configPath = defaultConfigPath()): SecretKey {
  const envSecret = process.env.CONE_SECRET_KEY;
  if (envSecret) {
    return parseSecretKey(envSecret);
  }

  const config = readConfig(configPath);
  if (config.secretKey) {
    return parseSecretKey(config.secretKey);
  }

  throw new ConeError('NO_SECRET', [
    'missing secret key',
    'Run cone init to create and securely save an identity, or restore yours with cone login --secret-stdin --remember.',
    'The SECRET_KEY determines the XMTP account/inbox.',
  ].join('\n'));
}
