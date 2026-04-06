const TOKEN_PREFIX = 'cos:invite:v1:';

interface TokenPayload {
  inviteId: string;
  pairId: string;
  inviterInboxId: string;
  inviterAddress?: string;
  env: string;
  expiresAt: string;
  secret: string;
}

export function encodeToken(payload: TokenPayload): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, 'utf8').toString('base64url');

  return `${TOKEN_PREFIX}${encoded}`;
}

export function decodeToken(token: string): TokenPayload {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error('invalid invite token prefix');
  }

  const encoded = token.slice(TOKEN_PREFIX.length);
  let decoded: string;

  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new Error('invalid invite token encoding');
  }

  let value: unknown;

  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('invalid invite token json');
  }

  const payload = validateTokenPayload(value);
  if (Date.parse(payload.expiresAt) < Date.now()) {
    throw new Error('invite expired');
  }

  return payload;
}

function validateTokenPayload(value: unknown): TokenPayload {
  if (!isRecord(value)) {
    throw new Error('invalid invite token payload');
  }

  const inviteId = getRequiredString(value, 'inviteId');
  const pairId = getRequiredString(value, 'pairId');
  const inviterInboxId = getRequiredString(value, 'inviterInboxId');
  const env = getRequiredString(value, 'env');
  const expiresAt = getRequiredString(value, 'expiresAt');
  const secret = getRequiredString(value, 'secret');
  const inviterAddress = getOptionalString(value, 'inviterAddress');

  if (Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('missing required field: expiresAt');
  }

  return {
    inviteId,
    pairId,
    inviterInboxId,
    inviterAddress,
    env,
    expiresAt,
    secret,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required field: ${key}`);
  }

  return value;
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required field: ${key}`);
  }

  return value;
}
