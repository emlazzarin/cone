import { isAddressedTo, type XmtpEnv } from '@cone/core';
import { AgentSession, createCliClient } from '@cone/cli';
import { initializeConfig, loadSecretKey } from '../../../packages/cli/src/config';

const alias = process.env.CONE_AGENT_NAME ?? 'concierge';
const env = process.env.XMTP_ENV;
if (env && !['production', 'dev', 'local'].includes(env)) throw new Error('Invalid XMTP_ENV');
initializeConfig(env as XmtpEnv | undefined);
const client = await createCliClient(loadSecretKey(), { autoAllowGroupsFromContacts: false });
const session = new AgentSession(client);
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await session.start();
  console.log(JSON.stringify({ ...await client.identity(), alias }));
  while (!shutdown.signal.aborted) {
    const batch = await session.receive({ consumer: 'concierge', waitMs: 30000, signal: shutdown.signal });
    for (const message of batch.messages) {
      if (message.text && (message.conversationKind === 'group'
        ? isAddressedTo(message.text, [alias]) : message.text.trim().toLowerCase() === 'ping')) {
        await client.sendToConversation(message.conversationId, 'pong', { idempotencyKey: `concierge:${message.messageId}` });
      }
      // This example intentionally ignores other content. Failed sends throw
      // before acknowledgement, leaving the request for the next run.
      await session.acknowledge([message.messageId], 'concierge');
    }
  }
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  await session.close();
  await client.close();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
