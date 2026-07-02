import { sha256 } from '@noble/hashes/sha256';

import { base64UrlDecode, base64UrlEncode, bytesToHex, bytesToUtf8, utf8ToBytes } from './encoding';

const AES_KEY_LENGTH = 32;
const AES_IV_LENGTH = 12;

export interface EncryptedBytes {
  alg: 'AES-256-GCM';
  iv: string;
  data: string;
}

export interface EncryptedJson<T = unknown> extends EncryptedBytes {
  contentType: 'application/json';
  schema: string;
  _type?: T;
}

export async function encryptBytes(keyMaterial: Uint8Array, plaintext: Uint8Array): Promise<EncryptedBytes> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  const key = await importAesKey(keyMaterial);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toCryptoBytes(iv) }, key, toArrayBuffer(plaintext));

  return {
    alg: 'AES-256-GCM',
    iv: base64UrlEncode(iv),
    data: base64UrlEncode(new Uint8Array(encrypted)),
  };
}

export async function decryptBytes(keyMaterial: Uint8Array, encrypted: EncryptedBytes): Promise<Uint8Array> {
  if (encrypted.alg !== 'AES-256-GCM') {
    throw new Error(`unsupported encryption algorithm: ${encrypted.alg}`);
  }

  const key = await importAesKey(keyMaterial);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toCryptoBytes(base64UrlDecode(encrypted.iv)) },
    key,
    toArrayBuffer(base64UrlDecode(encrypted.data)),
  );
  return new Uint8Array(decrypted);
}

export async function encryptJson<T>(keyMaterial: Uint8Array, schema: string, value: T): Promise<EncryptedJson<T>> {
  const encrypted = await encryptBytes(keyMaterial, utf8ToBytes(JSON.stringify(value)));
  return { ...encrypted, contentType: 'application/json', schema };
}

export async function decryptJson<T>(keyMaterial: Uint8Array, encrypted: EncryptedJson): Promise<T> {
  if (encrypted.contentType !== 'application/json') {
    throw new Error(`unsupported encrypted content type: ${encrypted.contentType}`);
  }

  return JSON.parse(bytesToUtf8(await decryptBytes(keyMaterial, encrypted))) as T;
}

// Pairing encryption is keyed by the shared handshake code alone: the peer
// knows nothing about us yet, so no account-derived secret can participate.
export function codeScopedKey(code: string): Uint8Array {
  return sha256(utf8ToBytes(`cone-pairing-code:v1:${normalizeHandshakeCode(code)}`)).slice(0, AES_KEY_LENGTH);
}

// Rendezvous v2: the room is addressed by a hash of the shared secret, so the
// worker relays ciphertext it can never decrypt (v1 sent the raw code, which
// is also the encryption key's input). Domain-separated from the encryption
// keys so a room id can never double as key material.
export function secretRoomId(secret: string): string {
  return sha256Hex(`cone-rendezvous-room:v1:${normalizeRendezvousSecret(secret)}`);
}

// Async group invite tokens are base64url and therefore case-sensitive —
// unlike spoken handshake codes they must NOT be lowercased.
export const GROUP_INVITE_TOKEN_PREFIX = 'cone_gi_v1_';
// The version-agnostic family prefix. Anything cone_gi_* that is not a valid
// v1 token gets a clear "update Cone" error instead of being lowercased into
// a handshake code that hashes to an empty room and times out silently.
const GROUP_INVITE_TOKEN_FAMILY_PREFIX = 'cone_gi_';

export function isGroupInviteToken(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(GROUP_INVITE_TOKEN_PREFIX) && trimmed.length > GROUP_INVITE_TOKEN_PREFIX.length;
}

export function assertSupportedRendezvousSecret(secret: string): void {
  const trimmed = secret.trim();
  if (trimmed.startsWith(GROUP_INVITE_TOKEN_FAMILY_PREFIX) && !isGroupInviteToken(trimmed)) {
    throw new Error(
      'unrecognized invite token — it may be truncated, or created by a newer version of Cone. ' +
      'Check the token was pasted whole; if it was, update Cone to join.',
    );
  }
}

export function generateGroupInviteToken(): string {
  const secret = crypto.getRandomValues(new Uint8Array(16));
  return `${GROUP_INVITE_TOKEN_PREFIX}${base64UrlEncode(secret)}`;
}

// The shared secret behind a rendezvous exchange: a handshake code (spoken,
// case-insensitive) or an invite token (pasted, case-sensitive).
export function normalizeRendezvousSecret(secret: string): string {
  const trimmed = secret.trim();
  assertSupportedRendezvousSecret(trimmed);
  return isGroupInviteToken(trimmed) ? trimmed : normalizeHandshakeCode(trimmed);
}

// Encryption key for group-invite payloads under a code or token.
export function inviteScopedKey(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (isGroupInviteToken(trimmed)) {
    return sha256(utf8ToBytes(`cone-invite-token:v1:${trimmed}`)).slice(0, AES_KEY_LENGTH);
  }
  return codeScopedKey(trimmed);
}

export function normalizeHandshakeCode(code: string): string {
  return code.trim().toLowerCase().replaceAll(/\s+/gu, '-');
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function randomHandshakeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const words = Array.from(bytes)
    .map((byte) => WORDS[byte % WORDS.length])
    .slice(0, 5);
  return words.join('-');
}

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

async function importAesKey(keyMaterial: Uint8Array): Promise<CryptoKey> {
  const keyBytes = keyMaterial.length === AES_KEY_LENGTH ? keyMaterial : sha256(keyMaterial);
  return crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(toArrayBuffer(bytes));
}

const WORDS = [
  'anchor',
  'beacon',
  'cedar',
  'drift',
  'ember',
  'field',
  'glade',
  'harbor',
  'iron',
  'juniper',
  'keystone',
  'lantern',
  'meadow',
  'north',
  'orbit',
  'prairie',
  'quartz',
  'ridge',
  'signal',
  'timber',
  'uplink',
  'valley',
  'willow',
  'xenon',
  'yonder',
  'zenith',
] as const;
