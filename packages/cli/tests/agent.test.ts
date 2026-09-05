import { expect, test } from 'bun:test';
import type { ConeClient, ConsentFilter, IncomingMessage, MessageHandler } from '@cone/core';
import { AgentSession } from '../src/agent';

function fixture() {
  let handler: MessageHandler = () => {};
  let filter: ConsentFilter | undefined;
  let pending = false;
  const client = {
    streamMessages: async (next: MessageHandler, options?: ConsentFilter) => { handler = next; filter = options; return () => {}; },
    sync: async () => ({ ok: true, errors: [] }),
    retryPendingSends: async () => [],
    receiveMessages: async () => ({ messages: pending ? [{ messageId: 'incoming' }] : [], more: false }),
    acknowledgeMessages: async () => { pending = false; },
  };
  const session = new AgentSession(client as unknown as ConeClient, () => {});
  return { client, session, arrived: async () => { pending = true; await handler({} as IncomingMessage); },
    fail: () => filter?.onError?.(new Error('stream broke')) };
}

test('a message arriving between reading and waiting wakes the pending receive', async () => {
  const f = fixture();
  await f.session.start();
  const read = f.client.receiveMessages;
  f.client.receiveMessages = async () => {
    const result = await read();
    if (!result.messages.length) await f.arrived();
    return result;
  };
  try {
    expect((await f.session.receive({ waitMs: 500 })).messages).toHaveLength(1);
  } finally { await f.session.close(); }
});

test('a stream failure during synchronization is not overwritten by successful sync', async () => {
  const f = fixture();
  f.client.sync = async () => { f.fail(); return { ok: true, errors: [] }; };
  try { await expect(f.session.start()).rejects.toThrow('stream broke'); }
  finally { await f.session.close(); }
});

test('a failed outbox item does not prevent receiving other work', async () => {
  const f = fixture();
  f.client.retryPendingSends = async () => { throw new Error('left the old group'); };
  try {
    await f.session.start();
    await f.arrived();
    expect((await f.session.receive()).messages).toHaveLength(1);
  } finally { await f.session.close(); }
});

test('cancelled long polls release their wait and leave the session usable', async () => {
  const f = fixture();
  await f.session.start();
  const controller = new AbortController();
  try {
    const receiving = f.session.receive({ waitMs: 30000, signal: controller.signal });
    controller.abort(new Error('conversation completed'));
    await expect(receiving).rejects.toThrow('conversation completed');
    await f.arrived();
    expect((await f.session.receive()).messages).toHaveLength(1);
  } finally { await f.session.close(); }
});
