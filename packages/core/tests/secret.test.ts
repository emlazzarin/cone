import { describe, expect, test } from 'bun:test';

import { deriveAccount, generateSecretKey, parseSecretKey, secretKeyFromHexSeed } from '../src/index';

describe('secret keys', () => {
  test('generates parseable Cone secret keys', () => {
    const secret = generateSecretKey();

    expect(secret.startsWith('cos_sk_v1_')).toBe(true);
    expect(parseSecretKey(secret)).toBe(secret);
  });

  test('derives deterministic account material by environment and account id', () => {
    const secret = secretKeyFromHexSeed('00'.repeat(32));

    const first = deriveAccount(secret, { env: 'dev', accountId: 'main' });
    const second = deriveAccount(secret, { env: 'dev', accountId: 'main' });
    const production = deriveAccount(secret, { env: 'production', accountId: 'main' });

    expect(first.walletPrivateKey).toBe(second.walletPrivateKey);
    expect(first.xmtpDbEncryptionKey).toBe(second.xmtpDbEncryptionKey);
    expect(first.walletPrivateKey).not.toBe(production.walletPrivateKey);
    expect(first.coneStorageKey).toEqual(second.coneStorageKey);
  });

  test('rejects corrupted checksums', () => {
    const secret = generateSecretKey();
    const index = 'cos_sk_v1_'.length + 8;
    const replacement = secret[index] === 'A' ? 'B' : 'A';
    const corrupted = `${secret.slice(0, index)}${replacement}${secret.slice(index + 1)}`;

    expect(() => parseSecretKey(corrupted)).toThrow(/checksum|length|base64url/i);
  });
});
