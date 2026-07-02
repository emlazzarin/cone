import { formatMessageLine } from '@cone/core';

import { loadSecretKey } from '../../../packages/cli/src/config';
import { createCliClient } from '../../../packages/cli/src/index';

// Agent boundary: explicit accept only. Never auto-allow groups, even when a
// contact adds this agent — group consent is granted via `cone requests accept`.
const client = await createCliClient(loadSecretKey(), { autoAllowGroupsFromContacts: false });
const identity = await client.identity();

console.log(`Cone agent online`);
console.log(`Inbox:   ${identity.inboxId}`);
console.log(`Address: ${identity.address ?? '(none)'}`);

await client.streamMessages(async (message) => {
  console.log(formatMessageLine(message, message.senderInboxId));
});

await new Promise(() => undefined);
