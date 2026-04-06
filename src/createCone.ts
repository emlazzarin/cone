import { ConeImpl } from './cone';
import type { Cone, ConeOptions } from './types';

const DEFAULT_INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60 * 1000;

export async function createCone(options: ConeOptions): Promise<Cone> {
  const {
    agent,
    store,
    inviteExpiryMs = DEFAULT_INVITE_EXPIRY_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  } = options;

  return new ConeImpl(agent, store, inviteExpiryMs, handshakeTimeoutMs);
}
