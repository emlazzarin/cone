// Cone wire envelopes. Every Cone-specific payload is JSON with a `cos.*`
// type; everything except the app-JSON envelope is a control message and is
// hidden from transcripts.

export const APP_JSON_TYPE = 'cos.app.json.v1';
export const READ_RECEIPT_TYPE = 'cos.read.v1';
export const PAIR_CONFIRM_TYPE = 'cos.pair.confirm.v1';
export const UNSUPPORTED_MESSAGE_TYPE = 'cos.unsupported-message.v1';
export const BACKUP_TYPE = 'cos.backup.v1';
export const GROUP_UPDATE_TYPE = 'cos.group.update.v1';

// XMTP's GroupUpdated system message (membership/metadata changes), decoded by
// the adapter into Cone's envelope shape. Stored as a control message; surfaces
// render it as an attributed system line ("Alice added Bob").
export interface GroupUpdateEnvelope {
  type: typeof GROUP_UPDATE_TYPE;
  initiatedByInboxId: string;
  added: string[];
  removed: string[];
  left: string[];
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

export function isAppJsonEnvelope(value: unknown): value is { type: typeof APP_JSON_TYPE; value: unknown } {
  return (
    envelopeType(value) === APP_JSON_TYPE &&
    typeof value === 'object' &&
    value !== null &&
    'value' in value
  );
}

export function isControlEnvelope(value: unknown): boolean {
  const type = envelopeType(value);
  return type !== undefined && type.startsWith('cos.') && type !== APP_JSON_TYPE;
}
