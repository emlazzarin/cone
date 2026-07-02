import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from './encoding';
import { ConeError } from './errors';
import type { DerivedAccount, SecretKey, XmtpEnv } from './types';

const SECRET_PREFIX = 'cone_sk_v1_';
// Version-agnostic family prefix: a cone_sk_* key this build cannot parse is
// from a newer Cone, which deserves a better error than "invalid prefix".
const SECRET_FAMILY_PREFIX = 'cone_sk_';
const SECRET_VERSION = 1;
const SEED_LENGTH = 32;
const CHECKSUM_LENGTH = 4;
const PAYLOAD_LENGTH = 1 + SEED_LENGTH + CHECKSUM_LENGTH;

export function generateSecretKey(): SecretKey {
  const seed = crypto.getRandomValues(new Uint8Array(SEED_LENGTH));
  return encodeSecretSeed(seed);
}

export function parseSecretKey(input: string): SecretKey {
  const trimmed = input.trim();
  decodeSecretSeed(trimmed);
  return trimmed as SecretKey;
}

export function deriveAccount(
  secret: SecretKey,
  options: { env?: XmtpEnv; accountId?: string } = {},
): DerivedAccount {
  // The default is the durable network. The env is part of the derivation
  // salt, so the same SECRET KEY is a *different identity* per network —
  // a social graph formed on one env can never move to another.
  const env = options.env ?? 'production';
  const accountId = options.accountId ?? 'main';
  const seed = decodeSecretSeed(secret);
  const salt = utf8ToBytes(`cone/v1/${env}/${accountId}`);

  return {
    accountId,
    env,
    walletPrivateKey: `0x${bytesToHex(deriveBytes(seed, salt, 'xmtp-wallet', 32))}`,
    xmtpDbEncryptionKey: bytesToHex(deriveBytes(seed, salt, 'xmtp-db', 32)),
    coneStorageKey: deriveBytes(seed, salt, 'cone-storage', 32),
    backupArchiveKey: deriveBytes(seed, salt, 'backup-archive', 32),
  };
}

export function encodeSecretSeed(seed: Uint8Array): SecretKey {
  if (seed.length !== SEED_LENGTH) {
    throw new Error('secret seed must be 32 bytes');
  }

  const body = concatBytes(new Uint8Array([SECRET_VERSION]), seed);
  const checksum = checksumBytes(body);
  return `${SECRET_PREFIX}${base64UrlEncode(concatBytes(body, checksum))}` as SecretKey;
}

export function decodeSecretSeed(secret: SecretKey | string): Uint8Array {
  if (!secret.startsWith(SECRET_PREFIX)) {
    if (secret.startsWith(SECRET_FAMILY_PREFIX)) {
      throw new Error('this SECRET KEY was created by a newer version of Cone — update Cone to use it');
    }
    throw new ConeError('BAD_SECRET', 'invalid secret key prefix');
  }

  const payload = base64UrlDecode(secret.slice(SECRET_PREFIX.length));
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new ConeError('BAD_SECRET', 'invalid secret key length');
  }

  const version = payload[0];
  if (version !== SECRET_VERSION) {
    throw new Error('unsupported secret key version — this key is from a newer version of Cone');
  }

  const body = payload.slice(0, 1 + SEED_LENGTH);
  const checksum = payload.slice(1 + SEED_LENGTH);
  if (!constantTimeEqual(checksum, checksumBytes(body))) {
    throw new ConeError('BAD_SECRET', 'invalid secret key checksum');
  }

  return payload.slice(1, 1 + SEED_LENGTH);
}

export function secretKeyFromHexSeed(hexSeed: string): SecretKey {
  return encodeSecretSeed(hexToBytes(hexSeed));
}

function deriveBytes(seed: Uint8Array, salt: Uint8Array, label: string, length: number): Uint8Array {
  return hkdf(sha256, seed, salt, utf8ToBytes(label), length);
}

function checksumBytes(body: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(SECRET_PREFIX), body)).slice(0, CHECKSUM_LENGTH);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left[i]! ^ right[i]!;
  }
  return result === 0;
}
