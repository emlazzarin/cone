import { formatIncomingMessageLine } from '@cone/core';

import { loadSecretKey } from '../../../packages/cli/src/config';
import { createCliClient } from '../../../packages/cli/src/index';

const client = await createCliClient(loadSecretKey());
const identity = await client.identity();

console.log(`Cone agent online`);
console.log(`Inbox:   ${identity.inboxId}`);
console.log(`Address: ${identity.address ?? '(none)'}`);

await client.streamMessages(async (message) => {
  console.log(formatIncomingMessageLine(message, message.senderInboxId));
});

await new Promise(() => undefined);
