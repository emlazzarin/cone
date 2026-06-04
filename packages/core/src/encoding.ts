const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function utf8ToBytes(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

export function bytesToUtf8(value: Uint8Array): string {
  return TEXT_DECODER.decode(value);
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error('invalid hex string');
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

export function base64UrlEncode(value: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('base64url');
  }

  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('invalid base64url string');
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64url'));
  }

  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }
  return output;
}
