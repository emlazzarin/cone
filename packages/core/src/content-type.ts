// The Cone envelope content type: every Cone-specific payload (read receipts,
// pair confirmations, app JSON) rides this custom XMTP content type, never the
// plain-text one. Text is text; envelopes are envelopes. This is what keeps
// Cone control traffic invisible-but-harmless in non-Cone XMTP clients (they
// render the fallback, or nothing when there is none) and what makes inbound
// text unspoofable (a typed message can never be mistaken for a control
// envelope, because envelopes are recognized by content type, not by parsing).
//
// The content type identity (authority `cone`, type `envelope`, major version
// 1) is a frozen protocol invariant. Minor version bumps must stay readable by
// every 1.x client; anything a 1.x client cannot read is a new major version,
// which old clients treat as a foreign content type and render via fallback.

import { utf8ToBytes, bytesToUtf8 } from './encoding';
import { APP_JSON_TYPE, envelopeType, isAppJsonEnvelope, type ConeEnvelope } from './envelope';

// Structural mirror of the XMTP ContentTypeId (identical in the node and wasm
// bindings), so core never imports an SDK.
export interface ConeContentTypeId {
  authorityId: string;
  typeId: string;
  versionMajor: number;
  versionMinor: number;
}

// Structural mirror of the XMTP EncodedContent both bindings accept on
// conversation.send().
export interface ConeEncodedContent {
  type?: ConeContentTypeId;
  parameters: Record<string, string>;
  fallback?: string;
  content: Uint8Array;
}

export const CONE_ENVELOPE_CONTENT_TYPE: ConeContentTypeId = {
  authorityId: 'cone',
  typeId: 'envelope',
  versionMajor: 1,
  versionMinor: 0,
};

// Accepts any minor version under major 1: minor bumps are compatible by
// contract. A future major version is deliberately NOT matched — old clients
// must treat it as a foreign content type and fall back to its fallback text.
export function isConeEnvelopeContentType(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const contentType = value as Partial<ConeContentTypeId>;
  return (
    contentType.authorityId === CONE_ENVELOPE_CONTENT_TYPE.authorityId &&
    contentType.typeId === CONE_ENVELOPE_CONTENT_TYPE.typeId &&
    contentType.versionMajor === CONE_ENVELOPE_CONTENT_TYPE.versionMajor
  );
}

// Control envelopes carry no fallback: to a client without the codec they are
// invisible, which is exactly what a read receipt should be. App JSON carries
// a human-readable fallback so a non-Cone client (or a future Cone this
// version cannot decode) still shows something meaningful.
export function coneEnvelopeFallback(envelope: ConeEnvelope): string | undefined {
  if (isAppJsonEnvelope(envelope)) {
    return humanizeAppJsonValue(envelope.value);
  }
  return undefined;
}

export function encodeConeEnvelope(envelope: ConeEnvelope): ConeEncodedContent {
  return {
    type: { ...CONE_ENVELOPE_CONTENT_TYPE },
    parameters: {},
    fallback: coneEnvelopeFallback(envelope),
    content: utf8ToBytes(JSON.stringify(envelope)),
  };
}

// Never throws: a payload that does not parse or is not envelope-shaped
// decodes to null, and the adapter treats it as unsupported. A codec decode
// that threw would poison whole message listings in the SDKs.
export function decodeConeEnvelope(encoded: { content: Uint8Array }): ConeEnvelope | null {
  try {
    const parsed = JSON.parse(bytesToUtf8(encoded.content)) as unknown;
    const type = envelopeType(parsed);
    if (type === undefined || !type.startsWith('cone.')) {
      return null;
    }
    return parsed as ConeEnvelope;
  } catch {
    return null;
  }
}

// The ContentCodec object registered with both XMTP SDKs (their ContentCodec
// interfaces are structurally identical). Registration is what makes inbound
// envelope content arrive decoded; sends go through encodeConeEnvelope
// directly.
export function createConeEnvelopeCodec(): {
  contentType: ConeContentTypeId;
  encode(content: ConeEnvelope): ConeEncodedContent;
  decode(content: ConeEncodedContent): ConeEnvelope | null;
  fallback(content: ConeEnvelope): string | undefined;
  shouldPush(content: ConeEnvelope): boolean;
} {
  return {
    contentType: { ...CONE_ENVELOPE_CONTENT_TYPE },
    encode: encodeConeEnvelope,
    decode: decodeConeEnvelope,
    fallback: coneEnvelopeFallback,
    // Control messages must never wake a device; app JSON is a real message.
    shouldPush: (content) => envelopeType(content) === APP_JSON_TYPE,
  };
}

// Best human rendering of an app-JSON value: a conventional text field if one
// exists, otherwise a shape summary. Shared by transcript display and the
// envelope fallback so both show the same thing.
export function humanizeAppJsonValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'message', 'content', 'body']) {
      if (typeof record[key] === 'string') {
        return record[key];
      }
    }
    const keys = Object.keys(record).slice(0, 4).join(', ');
    return keys ? `[structured message: ${keys}]` : '[structured message]';
  }
  return String(value);
}
