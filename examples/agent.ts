/**
 * cone-of-silence example agent
 *
 * This agent demonstrates the full pairing and messaging flow.
 * Run two instances (with different .env files) to connect them.
 *
 * Usage:
 *   bun run examples/agent.ts
 *
 * Commands (send as XMTP messages to this agent from xmtp.chat or another agent):
 *   "create invite"              — generate a single-use invite token
 *   "accept invite: <token>"     — complete the handshake with the inviter
 *   anything else                — echoed back if sent from a connected peer
 */

import { Agent } from '@xmtp/agent-sdk';

import { createCone, JsonFileStore } from '../src/index';

const agent = await Agent.createFromEnv();

const cone = await createCone({
  agent,
  store: new JsonFileStore(process.env.CONE_STATE_PATH ?? './.cone/state.json'),
});

console.log(`Agent inbox:   ${cone.self.inboxId}`);
console.log(`Agent address: ${cone.self.address ?? '(no address)'}`);
console.log('Waiting for messages...\n');

cone.on('connection:active', (connection) => {
  console.log(`[cone] ✓ New peer connected: ${connection.peerInboxId}`);
});

cone.on('message:text', (event) => {
  console.log(`[cone] ← text from ${event.connection.peerInboxId}: ${event.text}`);

  // Echo peer messages back so the example shows active post-handshake messaging.
  // Prefix the reply to avoid two identical agents endlessly bouncing the same text.
  if (!event.text.startsWith('echo: ')) {
    void cone.sendText({ peerInboxId: event.connection.peerInboxId }, `echo: ${event.text}`);
  }
});

cone.on('message:json', (event) => {
  console.log(`[cone] ← json from ${event.connection.peerInboxId}:`, event.value);
});

agent.on('message', async (ctx) => {
  const handled = await cone.handleMessage(ctx);
  if (handled) return;

  if (!ctx.isText()) return;

  const text = ctx.message.content.trim();
  const senderInboxId = ctx.message.senderInboxId;

  if (text.toLowerCase() === 'create invite') {
    const invite = await cone.createInvite();
    const instructions = cone.renderInviteInstructions(invite);
    await ctx.conversation.sendText(instructions);
    return;
  }

  const token = cone.extractInviteToken(text);
  if (token) {
    await ctx.conversation.sendText('Accepting invite, completing handshake...');
    try {
      const connection = await cone.acceptInvite(token);
      await ctx.conversation.sendText(
        `✓ Connected to peer ${connection.peerInboxId}. You can now send messages.`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.conversation.sendText(`✗ Failed to accept invite: ${message}`);
    }
    return;
  }

  console.log(`[xmtp] command from ${senderInboxId}: ${text}`);

  await ctx.conversation.sendText(
    `Unknown command. Try:\n  "create invite"\n  "accept invite: <token>"`
  );
});

await agent.start();
