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
