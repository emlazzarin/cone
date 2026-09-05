import { createInterface } from 'node:readline';
import { ConeError } from '@cone/core';
import { AgentSession } from './agent';

export async function serveAgent(session: AgentSession): Promise<void> {
  // Keep stdin buffered until the transport is ready. readline starts consuming
  // immediately, so constructing it before this await can discard request #1.
  await session.start();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const active = new Set<Promise<void>>();
  const controllers = new Map<unknown, AbortController>();
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const stop = () => { input.close(); void session.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const task = (async () => {
        let id: unknown = null;
        let owned: AbortController | undefined;
        try {
          const request = JSON.parse(line);
          if (request?.jsonrpc === '2.0' && request.method === 'notifications/cancelled') {
            controllers.get(request.params?.requestId)?.abort();
            return;
          }
          if (!request || request.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof request.id)) {
            throw new Error('expected a JSON-RPC 2.0 request with an id');
          }
          id = request.id;
          if (controllers.has(id)) throw new Error('request id is already active');
          owned = new AbortController();
          controllers.set(id, owned);
          const result = await dispatch(session, request.method, request.params ?? {}, owned.signal);
          write({ jsonrpc: '2.0', id, result });
        } catch (error) {
          write({ jsonrpc: '2.0', id, error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
            data: { code: error instanceof ConeError ? error.code : 'REQUEST_FAILED' },
          } });
        } finally { if (owned && controllers.get(id) === owned) controllers.delete(id); }
      })();
      active.add(task);
      void task.finally(() => active.delete(task));
    }
  } finally {
    await session.close();
    await Promise.allSettled(active);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

export async function dispatch(session: AgentSession, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const client = session.client;
  switch (method) {
    case 'identity': return { protocol: 1, ...await client.identity() };
    case 'receive': return session.receive({
      signal,
      consumer: optionalString(params, 'consumer'),
      limit: optionalNumber(params, 'limit'),
      waitMs: optionalNumber(params, 'waitMs'),
      excludeConversationIds: stringArray(params, 'excludeConversationIds', []),
    });
    case 'ack': return session.acknowledge(stringArray(params, 'messageIds'), optionalString(params, 'consumer'));
    case 'send': {
      const options = { idempotencyKey: string(params, 'key'), replyTo: optionalString(params, 'replyTo') };
      const to = string(params, 'to');
      if ('data' in params && !('text' in params)) return client.sendJson(to, params.data, options);
      if ('data' in params) throw new Error('provide text or data, not both');
      return client.sendText(to, string(params, 'text'), options);
    }
    case 'reply': return client.sendToConversation(string(params, 'conversationId'), string(params, 'text'), {
      idempotencyKey: string(params, 'key'),
    });
    case 'connect': {
      const peer = await client.resolveIdentity(string(params, 'to'));
      if (!await client.canMessage({ inboxId: peer.inboxId })) throw new Error('peer is not reachable on XMTP');
      return client.saveContact({ name: optionalString(params, 'name') ?? peer.inboxId, inboxId: peer.inboxId, address: peer.address });
    }
    case 'requests': return (await client.listConversations()).filter(c => c.consentState === 'unknown').map(c => ({
      conversationId: c.conversationId, kind: c.kind, peerInboxId: c.peerInboxId,
    }));
    case 'accept': await client.setConversationConsent(string(params, 'conversationId'), 'allowed'); return { accepted: true };
    case 'block': await client.setConversationConsent(string(params, 'conversationId'), 'denied'); return { blocked: true };
    case 'sync': await session.start(); return { synced: true };
    default: throw new Error(`unknown method: ${method}`);
  }
}

function string(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}
function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error(`${key} must be a number`);
  return value;
}
function stringArray(params: Record<string, unknown>, key: string, fallback?: string[]): string[] {
  const value = params[key] ?? fallback;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) throw new Error(`${key} must be an array of message or conversation IDs`);
  return value;
}
