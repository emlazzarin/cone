import { describe, expect, test } from 'bun:test';

import { decodeToken, encodeToken } from '../src/token';

const validPayload = {
  inviteId: 'test-invite-id',
  pairId: 'test-pair-id',
  inviterInboxId: 'test-inbox-id',
  env: 'dev',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  secret: 'a'.repeat(64),
};

describe('token', () => {
  test('round-trips a valid payload', () => {
    const token = encodeToken(validPayload);

    expect(decodeToken(token)).toEqual(validPayload);
  });

  test('throws for wrong prefix', () => {
    expect(() => decodeToken('bad:prefix:abc')).toThrow(/prefix/i);
  });

  test('throws for expired token', () => {
    const token = encodeToken({
      ...validPayload,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(() => decodeToken(token)).toThrow(/expired/i);
  });

  test('throws for missing required field after payload corruption', () => {
    const encoded = encodeToken(validPayload).slice('cos:invite:v1:'.length);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const corrupted = JSON.stringify({
      ...JSON.parse(decoded),
      secret: undefined,
    });
    const token = `cos:invite:v1:${Buffer.from(corrupted, 'utf8').toString('base64url')}`;

    expect(() => decodeToken(token)).toThrow(/missing required field/i);
  });

  test('throws for malformed base64', () => {
    expect(() => decodeToken('cos:invite:v1:!!!notbase64!!!')).toThrow();
  });

  test('throws for malformed json', () => {
    const token = `cos:invite:v1:${Buffer.from('not json').toString('base64url')}`;

    expect(() => decodeToken(token)).toThrow(/json/i);
  });
});
