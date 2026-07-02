import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envVarLocation } from '../src/env-origin';

// Unique names so the repo's real .env (loaded into this test process by Bun)
// can never collide with the fixtures.
const VAR = 'CONE_TEST_ORIGIN_VAR';
const OTHER = 'CONE_TEST_ORIGIN_OTHER';

describe('envVarLocation', () => {
  afterEach(() => {
    delete process.env[VAR];
    delete process.env[OTHER];
  });

  function fixtureDir(envContent: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cone-env-origin-'));
    writeFileSync(join(dir, '.env'), envContent);
    return dir;
  }

  test('a value matching the .env line is attributed to its file and line', () => {
    const dir = fixtureDir(`# comment\n${VAR}=hello\n`);
    process.env[VAR] = 'hello';

    expect(envVarLocation(VAR, dir)).toBe('.env:2');
  });

  test('a differing value is the shell overriding the .env line', () => {
    const dir = fixtureDir(`${VAR}=from-file\n`);
    process.env[VAR] = 'from-shell';

    expect(envVarLocation(VAR, dir)).toBe('shell (overrides .env:1)');
  });

  test('a variable absent from every env file is the shell', () => {
    const dir = fixtureDir(`${OTHER}=unrelated\n`);
    process.env[VAR] = 'set-somewhere';

    expect(envVarLocation(VAR, dir)).toBe('shell');
  });

  test('quoted values and export prefixes are understood', () => {
    const dir = fixtureDir(`export ${VAR}="hello world" # trailing comment ignored by quotes\n`);
    process.env[VAR] = 'hello world';

    expect(envVarLocation(VAR, dir)).toBe('.env:1');
  });

  test('unquoted trailing comments are stripped before comparing', () => {
    const dir = fixtureDir(`${VAR}=dev # the ephemeral network\n`);
    process.env[VAR] = 'dev';

    expect(envVarLocation(VAR, dir)).toBe('.env:1');
  });
});
