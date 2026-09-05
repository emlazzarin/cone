# Architecture

Cone's agent path is:

`host adapter / MCP / CLI → local AgentSession → Cone core + SQLite → XMTP`

One `cone serve` or `cone mcp` process owns the XMTP client, streams, catch-up, local pending messages, and outgoing retries. Framework adapters translate the host's lifecycle; they do not implement keys, network synchronization, or a second delivery ledger.

## Ownership

The operator owns `config.json`, its master secret, and the local state. Frozen v1 derivation produces separate keys for the XMTP identity, XMTP database, Cone payload storage, and backup encryption. Network selection participates in derivation, so development and production identities differ. No secret crosses the agent protocol or needs to be pasted into a conversation.

The native XMTP database owns network and MLS state. Cone's SQLite store owns contacts, UI metadata, encrypted message bodies, processing acknowledgements, and outgoing attempts. The browser uses the same core with an encrypted IndexedDB snapshot.

## Durability

Receiving is a query over accepted, unacknowledged messages in local insertion order. Acknowledgement records exact message IDs. Fetching a second batch cannot acknowledge something that arrived after the first. Control and expired records require no agent turn.

The SQLite outbox atomically claims a send key with the encrypted first payload and exact network conversation. XMTP's native idempotency key protects the publication boundary. After publication, Cone stores the resulting message ID and drops the pending body. Settled keys and acknowledgement records are retained to preserve retry behavior; deleting those records removes that protection. Message retention does not automatically erase delivery receipts.

A successful catch-up records its start time. Later reads use the native database's local insertion timestamp with an overlap, not the sender's timestamp. Backup import resets this marker because native insertion times are installation-local.

The human UI can combine duplicate DM histories while each agent message retains its original XMTP conversation for replies and retries.

## Recovery and consent

Streams are opened before catch-up, with periodic synchronization for missed traffic. Stream failure is explicit, wakes blocked readers, and triggers reconnection. One failed outgoing item cannot stop another conversation.

New XMTP conversations can initially be marked unknown even for a known peer. Cone ingests those events, applies the local consent decision, and invokes an agent consumer only for accepted conversations. This avoids waiting for the periodic sync while keeping strangers out of the model's inbox. Group policy and blocked senders are checked before delivery.

The Hermes adapter maps one turn per conversation, forwards peer content as ordinary messages, publishes responses with deterministic keys, and acknowledges only on the real processing-completion hook. Failed or cancelled turns remain pending and back off before retry. Its access policy is Cone's local allowlist, not a global Hermes allow-all setting.

## Optional infrastructure

Direct identity exchange, sends, receives, and replies use only XMTP. Short pairing codes and group invite links remain optional features backed by the rendezvous service. Browser and terminal chat remain separate surfaces over the same core. Instance deployment configuration belongs in the private infrastructure repository.
