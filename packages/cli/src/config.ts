import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

import { ConeError, parseSecretKey, type SecretKey } from '@cone/core';

import { defaultConfigPath } from './paths';

export interface CliConfig {
  secretKey?: string;
  readReceipts?: boolean;
  // "Allow contacts to add you to groups" (default true): a group add from an
  // address-book contact lands directly in Chats; off routes every add to
  // Requests. Adds from blocked inboxes are always discarded silently.
  groupAutoAllow?: boolean;
}

export function readConfig(path = defaultConfigPath()): CliConfig {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
}

export function writeConfig(config: CliConfig, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
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
    'Provide one with CONE_SECRET_KEY, pass --secret-stdin for this command, or save one locally with:',
    '  cone login --secret-stdin --remember',
    'The SECRET_KEY determines the XMTP account/inbox.',
  ].join('\n'));
}
