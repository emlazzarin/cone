import type { RendezvousClient, RendezvousRole, RendezvousStoredOffer } from './types';

// Rendezvous v2 transport. The room id is a hash of the shared secret — the
// service never receives a handshake code or invite token, only ciphertext.
export class HttpRendezvousClient implements RendezvousClient {
  constructor(private readonly baseUrl: string) {}

  async exchangeOffer(input: {
    roomId: string;
    participantId: string;
    role: RendezvousRole;
    encryptedOffer: RendezvousStoredOffer['encryptedOffer'];
    expiresAt: string;
  }): Promise<RendezvousStoredOffer[]> {
    const response = await this.request('POST', input);
    if (!response.ok) {
      throw new Error(`rendezvous exchange failed: ${response.status}`);
    }

    const payload = await response.json() as { offers?: RendezvousStoredOffer[] };
    return payload.offers ?? [];
  }

  async deleteRoom(roomId: string): Promise<void> {
    const response = await this.request('DELETE', { roomId });
    if (!response.ok) {
      throw new Error(`rendezvous delete failed: ${response.status}`);
    }
  }

  private async request(method: 'POST' | 'DELETE', body: unknown): Promise<Response> {
    try {
      return await fetch(this.endpoint(), {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method,
      });
    } catch {
      // fetch rejects on network-level failures (connection refused, DNS,
      // mixed content) with an unhelpful "failed to fetch" — say where we
      // tried to go and what usually fixes it.
      throw new Error(
        `rendezvous service unreachable at ${this.baseUrl} — pairing and group invites need it. ` +
        'Start it with `bun run dev:rendezvous`, or point CONE_RENDEZVOUS_URL at a deployed worker.',
      );
    }
  }

  private endpoint(): string {
    return `${this.baseUrl.replace(/\/$/u, '')}/v2/exchange`;
  }
}
