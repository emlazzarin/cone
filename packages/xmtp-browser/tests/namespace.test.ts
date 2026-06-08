import { describe, expect, test } from 'bun:test';

import { deriveAccount, generateSecretKey } from '@cone/core';
import { browserAccountNamespace } from '../src';

describe('browser account namespace', () => {
  test('is stable for the same account and distinct for different secrets', () => {
    const first = deriveAccount(generateSecretKey(), { env: 'dev' });
    const second = deriveAccount(generateSecretKey(), { env: 'dev' });

    expect(browserAccountNamespace(first)).toBe(browserAccountNamespace(first));
    expect(browserAccountNamespace(first)).not.toBe(browserAccountNamespace(second));
    expect(browserAccountNamespace(first)).toStartWith('cone-dev-main-0x');
  });
});
