import type { RendezvousClient, RendezvousRole, RendezvousStoredOffer } from './types';

// The one fallback rendezvous URL, shared by every surface (CLI paths, PWA
// bootstrap) so the default cannot drift between them. Local dev serves it
// via `bun run dev:rendezvous`; deployments override with CONE_RENDEZVOUS_URL
// (CLI) or VITE_CONE_RENDEZVOUS_URL (web, baked at build time).
export const DEFAULT_RENDEZVOUS_URL = 'http://localhost:8787';

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
      throw new Error(`rendezvous exchange failed: ${response.status}${await errorDetail(response)}`);
    }

    const payload = await response.json() as { offers?: RendezvousStoredOffer[] };
    return payload.offers ?? [];
  }

  async deleteRoom(roomId: string): Promise<void> {
    const response = await this.request('DELETE', { roomId });
    if (!response.ok) {
      throw new Error(`rendezvous delete failed: ${response.status}${await errorDetail(response)}`);
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

// The worker explains its rejections ("room role mismatch", "pairing room is
// full") — relay that instead of a bare status code, since it usually names
// the user's actual mistake (e.g. pairing with a group-invite code).
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' && body.error.length > 0 ? ` (${body.error})` : '';
  } catch {
    return '';
  }
}
