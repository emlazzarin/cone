import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseSecretKey, type SecretKey } from '@cone/core';

import { defaultConfigPath } from './paths';

export interface CliConfig {
  secretKey?: string;
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
  const envSecret = process.env.COS_SECRET_KEY;
  if (envSecret) {
    return parseSecretKey(envSecret);
  }

  const config = readConfig(configPath);
  if (config.secretKey) {
    return parseSecretKey(config.secretKey);
  }

  throw new Error([
    'missing secret key',
    'Provide one with COS_SECRET_KEY, pass --secret-stdin for this command, or save one locally with:',
    '  cos login --secret-stdin --remember',
    'The SECRET_KEY determines the XMTP account/inbox.',
  ].join('\n'));
}
