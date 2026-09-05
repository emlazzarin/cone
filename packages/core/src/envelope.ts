// Cone wire envelopes. Every Cone-specific payload is JSON with a `cone.*`
// type; everything except the app-JSON envelope is a control message and is
// hidden from transcripts. On the network, envelopes ride the Cone envelope
// content type (see content-type.ts) — never plain text, so a typed message
// can never impersonate one.

// The shape of every Cone wire payload: a self-describing `type` plus
// type-specific fields. New fields on an existing type must be optional
// (tolerant-reader), and a field's meaning is never repurposed.
export type ConeEnvelope = { type: string } & Record<string, unknown>;

export const APP_JSON_TYPE = 'cone.app.json.v1';
export const READ_RECEIPT_TYPE = 'cone.read.v1';
export const PAIR_CONFIRM_TYPE = 'cone.pair.confirm.v1';
export const UNSUPPORTED_MESSAGE_TYPE = 'cone.unsupported-message.v1';
export const BACKUP_TYPE = 'cone.backup.v1';
export const GROUP_UPDATE_TYPE = 'cone.group.update.v1';

// XMTP's GroupUpdated system message (membership/metadata/admin changes),
// decoded by the adapter into Cone's envelope shape. Stored as a control
// message; surfaces render it as an attributed system line ("Alice added Bob").
// The admin arrays are optional: envelopes stored before Phase 2 lack them.
export interface GroupUpdateEnvelope {
  type: typeof GROUP_UPDATE_TYPE;
  initiatedByInboxId: string;
  added: string[];
  removed: string[];
  left: string[];
  adminsAdded?: string[];
  adminsRemoved?: string[];
  superAdminsAdded?: string[];
  superAdminsRemoved?: string[];
  metadataChanges: Array<{ field: string; oldValue?: string; newValue?: string }>;
}

export function isGroupUpdateEnvelope(value: unknown): value is GroupUpdateEnvelope {
  return envelopeType(value) === GROUP_UPDATE_TYPE;
}

export function envelopeType(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string') {
      return type;
    }
  }
  return undefined;
}

export function isAppJsonEnvelope(value: unknown): value is { type: typeof APP_JSON_TYPE; value: unknown; replyTo?: string } {
  return (
    envelopeType(value) === APP_JSON_TYPE &&
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    (!('replyTo' in value) || value.replyTo === undefined || typeof value.replyTo === 'string')
  );
}

export function isControlEnvelope(value: unknown): boolean {
  const type = envelopeType(value);
  return type !== undefined && type.startsWith('cone.') && type !== APP_JSON_TYPE;
}

// Validates an envelope received over the network. Group updates are minted
// exclusively by decoding XMTP's own GroupUpdated system messages — one
// arriving *as a sent envelope* is a forgery attempt ("Alice added Bob"
// authored by Mallory) and is rejected here, at the trust boundary.
export function isAcceptableInboundEnvelope(value: unknown): value is ConeEnvelope {
  const type = envelopeType(value);
  return type !== undefined && type.startsWith('cone.') && type !== GROUP_UPDATE_TYPE;
}
