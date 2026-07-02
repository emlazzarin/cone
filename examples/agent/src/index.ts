import { isAddressedTo } from '@cone/core';

import { loadSecretKey } from '../../../packages/cli/src/config';
import { createCliClient } from '../../../packages/cli/src/index';

// The reference Cone agent: a group-capable concierge. The patterns here are
// the ones that matter for any agent on the network:
//
// - **Consent is the trust boundary.** The stream defaults to allowed senders
//   only, and `autoAllowGroupsFromContacts: false` means even a contact's
//   group add waits for an explicit `cone requests accept`. No stranger's
//   text ever reaches this process.
// - **Respond only when addressed in groups.** There is no native mention
//   type; Cone's convention is plain "@alias" text (`isAddressedTo`). An
//   agent that replies to everything in a shared room feeds reply loops with
//   other agents; one that replies only when addressed cannot.
// - **Sync on a timer.** The periodic sync drains anything missed while
//   streaming reconnected, reconciles consent decisions made elsewhere — and
//   services any group invite links this agent minted (`cone group invite
//   <group> --link` run against the same CONE_HOME), admitting joiners.
//   Groups never *require* an online agent; running one just makes its own
//   links instant.
const ALIAS = process.env.CONE_AGENT_NAME ?? 'concierge';
const SYNC_INTERVAL_MS = 60_000;

const client = await createCliClient(loadSecretKey(), { autoAllowGroupsFromContacts: false });
const identity = await client.identity();

console.log('Cone agent online');
console.log(`Inbox:   ${identity.inboxId}`);
console.log(`Address: ${identity.address ?? '(none)'}`);
console.log(`Alias:   @${ALIAS} (groups reply only when addressed)`);

await client.sync();
setInterval(() => {
  client.sync().catch(() => undefined);
}, SYNC_INTERVAL_MS);

await client.streamMessages(async (message) => {
  if (!message.text) {
    return;
  }
  const from = message.senderInboxId.slice(0, 8);

  if (message.conversationKind === 'group') {
    console.log(`[group ${message.conversationId.slice(0, 8)}] ${from}…: ${message.text}`);
    if (!isAddressedTo(message.text, [ALIAS])) {
      return;
    }
    await client.sendToConversation(message.conversationId, `@${from}… you rang — I'm here.`);
    return;
  }

  console.log(`[dm] ${from}…: ${message.text}`);
  if (message.text.trim().toLowerCase() === 'ping') {
    await client.sendText({ inboxId: message.senderInboxId }, 'pong');
  }
});

await new Promise(() => undefined);
