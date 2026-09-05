import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ConeClient } from '@cone/core';
import { AgentSession } from '../src/agent';
import { createMcpServer } from '../src/mcp';

test('a standard MCP client sees pending mail until explicit acknowledgement and validates send keys', async () => {
  let acknowledged = false;
  let sends = 0;
  const session = new AgentSession({
    receiveMessages: async () => ({ messages: acknowledged ? [] : [{ messageId: 'incoming' }], more: false }),
    acknowledgeMessages: async (ids: string[]) => { acknowledged = ids.includes('incoming'); },
    sendText: async () => { sends++; return { messageId: 'outgoing' }; },
  } as unknown as ConeClient);
  const server = createMcpServer(session);
  const client = new Client({ name: 'integration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('cone_reply');
    const first = await client.callTool({ name: 'cone_receive', arguments: {} });
    expect(first.structuredContent).toEqual({ messages: [{ messageId: 'incoming' }], more: false });
    expect((await client.callTool({ name: 'cone_receive', arguments: {} })).structuredContent).toEqual(first.structuredContent);
    const invalid = await client.callTool({ name: 'cone_send', arguments: { to: 'Peer', text: 'hello' } });
    expect(invalid.isError).toBe(true);
    expect(sends).toBe(0);
    await client.callTool({ name: 'cone_ack', arguments: { messageIds: ['incoming'] } });
    expect((await client.callTool({ name: 'cone_receive', arguments: {} })).structuredContent).toEqual({ messages: [], more: false });
  } finally { await client.close(); await server.close(); await session.close(); }
});
