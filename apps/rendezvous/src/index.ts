import type { RendezvousStoredOffer } from '@cone/core';

export interface Env {
  ROOMS: DurableObjectNamespace;
}

interface ExchangeBody {
  code: string;
  participantId: string;
  encryptedOffer: RendezvousStoredOffer['encryptedOffer'];
  expiresAt: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/exchange') {
      return cors(json({ error: 'not found' }, 404));
    }

    let body: ExchangeBody;
    try {
      body = await request.json();
      validateExchangeBody(body);
    } catch (error) {
      return cors(json({ error: error instanceof Error ? error.message : 'invalid request' }, 400));
    }

    const id = env.ROOMS.idFromName(body.code);
    const response = await env.ROOMS.get(id).fetch('https://room.local/exchange', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    return cors(response);
  },
};

export class RendezvousRoom {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'not found' }, 404);
    }

    const body = await request.json() as ExchangeBody;
    const offers = await this.loadOffers();
    const now = Date.now();
    const activeOffers = offers.filter((offer) => Date.parse(offer.expiresAt) > now);
    const existingIndex = activeOffers.findIndex((offer) => offer.participantId === body.participantId);

    if (existingIndex === -1 && activeOffers.length >= 2) {
      return json({ error: 'pairing room is full' }, 409);
    }

    const nextOffer: RendezvousStoredOffer = {
      offerId: body.encryptedOffer.iv,
      participantId: body.participantId,
      encryptedOffer: body.encryptedOffer,
      expiresAt: body.expiresAt,
    };

    if (existingIndex >= 0) {
      activeOffers[existingIndex] = nextOffer;
    } else {
      activeOffers.push(nextOffer);
    }

    await this.state.storage.put('offers', activeOffers);
    await this.state.storage.setAlarm(Math.min(...activeOffers.map((offer) => Date.parse(offer.expiresAt))));
    return json({ offers: activeOffers });
  }

  async alarm(): Promise<void> {
    const activeOffers = (await this.loadOffers()).filter((offer) => Date.parse(offer.expiresAt) > Date.now());
    if (activeOffers.length === 0) {
      await this.state.storage.deleteAll();
      return;
    }

    await this.state.storage.put('offers', activeOffers);
    await this.state.storage.setAlarm(Math.min(...activeOffers.map((offer) => Date.parse(offer.expiresAt))));
  }

  private async loadOffers(): Promise<RendezvousStoredOffer[]> {
    return (await this.state.storage.get<RendezvousStoredOffer[]>('offers')) ?? [];
  }
}

function validateExchangeBody(body: ExchangeBody): void {
  if (!body || typeof body !== 'object') {
    throw new Error('body must be an object');
  }
  if (typeof body.code !== 'string' || body.code.length < 8) {
    throw new Error('code is required');
  }
  if (typeof body.participantId !== 'string' || body.participantId.length === 0) {
    throw new Error('participantId is required');
  }
  if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) {
    throw new Error('expiresAt is required');
  }
  if (!body.encryptedOffer || typeof body.encryptedOffer !== 'object') {
    throw new Error('encryptedOffer is required');
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'POST, OPTIONS');
  headers.set('access-control-allow-headers', 'content-type');
  headers.set('access-control-max-age', '86400');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
