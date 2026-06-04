import type { RendezvousClient, RendezvousStoredOffer } from './types';

export class HttpRendezvousClient implements RendezvousClient {
  constructor(private readonly baseUrl: string) {}

  async exchangeOffer(input: {
    code: string;
    participantId: string;
    encryptedOffer: RendezvousStoredOffer['encryptedOffer'];
    expiresAt: string;
  }): Promise<RendezvousStoredOffer[]> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/u, '')}/v1/exchange`, {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`rendezvous exchange failed: ${response.status}`);
    }

    const payload = await response.json() as { offers?: RendezvousStoredOffer[] };
    return payload.offers ?? [];
  }
}
