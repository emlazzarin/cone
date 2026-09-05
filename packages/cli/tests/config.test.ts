import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey } from '@cone/core';
import { initializeConfig, readConfig, writeConfig } from '../src/config';

const temporary: string[] = [];
const originalSecret = process.env.CONE_SECRET_KEY;
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalSecret === undefined) delete process.env.CONE_SECRET_KEY;
  else process.env.CONE_SECRET_KEY = originalSecret;
});
function path(): string {
  delete process.env.CONE_SECRET_KEY;
  const directory = mkdtempSync(join(tmpdir(), 'cone-config-test-'));
  temporary.push(directory);
  return join(directory, 'identity', 'config.json');
}

test('initialization persists the same identity and network across reinstalls and config changes', () => {
  const file = path();
  const initial = initializeConfig('dev', file);
  expect(initial.created).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  writeConfig({ ...initial.config, readReceipts: false }, file);
  expect(initializeConfig(undefined, file)).toEqual({ created: false, config: { ...initial.config, readReceipts: false } });
  expect(() => initializeConfig('production', file)).toThrow('already initialized for dev');
  expect(readConfig(file).secretKey).toBe(initial.config.secretKey);
});

test('an explicitly supplied key is persisted but cannot silently replace an existing identity', () => {
  const file = path();
  process.env.CONE_SECRET_KEY = generateSecretKey();
  const first = initializeConfig('dev', file);
  expect(first.config.secretKey).toBe(process.env.CONE_SECRET_KEY);
  process.env.CONE_SECRET_KEY = generateSecretKey();
  expect(() => initializeConfig('dev', file)).toThrow('differs from the saved identity');
  expect(readConfig(file).secretKey).toBe(first.config.secretKey);
});

test('a damaged config is reported without replacing the identity file', () => {
  const file = path();
  initializeConfig('dev', file);
  writeFileSync(file, '{"env":"dev"}');
  expect(() => initializeConfig('dev', file)).toThrow('restore its key');
  expect(readConfig(file)).toEqual({ env: 'dev' });
});
