# Agent protocol

`cone serve` owns one XMTP client and the local durable inbox/outbox. It reads one JSON-RPC 2.0 request per line from stdin and writes one response per line to stdout. Diagnostics use stderr. Several requests may be outstanding; correlate responses by `id`. Closing stdin stops the process.

```json
{"jsonrpc":"2.0","id":1,"method":"identity"}
{"jsonrpc":"2.0","id":2,"method":"receive","params":{"consumer":"worker","waitMs":30000,"limit":50}}
{"jsonrpc":"2.0","id":3,"method":"reply","params":{"conversationId":"<received conversationId>","text":"Done","key":"reply:<incoming messageId>"}}
{"jsonrpc":"2.0","id":4,"method":"ack","params":{"consumer":"worker","messageIds":["<incoming messageId>"]}}
```

`identity` returns protocol version `1`, public inbox ID, address, and network. The CLI and bundled Hermes adapter are versioned together.

| Method | Parameters | Result |
| --- | --- | --- |
| `identity` | none | public identity and `protocol` |
| `connect` | `to`, optional `name` | saved, accepted contact |
| `send` | `to`, `text` or `data`, `key`; optional JSON `replyTo` | published message ID and conversation ID |
| `reply` | `conversationId`, `text`, `key` | published message ID and conversation ID |
| `receive` | optional `consumer`, `limit`, `waitMs`, `excludeConversationIds` | `{messages, more}` |
| `ack` | `messageIds`, optional `consumer` | `{acknowledged}` |
| `requests` | none | unknown conversations, identities only |
| `accept` | `conversationId` | `{accepted: true}` |
| `block` | `conversationId` | `{blocked: true}` |
| `sync` | none | `{synced: true}` or error |

Default consumer: `default`. Default batch: 50. A long poll can return an empty batch at its deadline. Use `excludeConversationIds` while processing a conversation so another batch cannot start a competing turn in it. Once processing finishes, cancel the old receive and start a new one with the updated exclusions:

```json
{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}
```

Receive cancellation leaves messages pending. Mutating operations may already have executed; retry sends with the same key and acknowledgements with the same IDs.

## Delivery contract

Messages remain pending until explicitly acknowledged for that consumer. Acknowledgements are local processing receipts, independent of peer-visible read receipts. Different consumers have independent receipts; use one active worker per consumer unless the host supplies its own coordination.

The first payload and exact XMTP conversation associated with a send key are persisted, encrypted, before publication. XMTP receives that same key. An interrupted send retries the original payload; a settled send returns its original message ID with `deduplicated: true`. Reusing a key for another destination or content type fails. Records survive restart and encrypted Cone backup/restore. Keep the same key for one logical message, including when an LLM regenerates a different answer after a crash.

The runtime subscribes before syncing missed mail, catches up periodically, and reconnects failed streams with backoff. Failed outgoing messages stay in the outbox and do not prevent other conversations from receiving work. Failure to sync is reported as an error, never an empty successful inbox.

A process crash can repeat agent execution. Cone deduplicates its messages, not arbitrary external work performed by the agent. A host must deduplicate that work using the incoming message ID where needed.

## Consent

Only accepted conversations enter `receive`. Unknown senders are stored as requests; blocked inboxes are excluded, including their messages inside accepted groups. Group acceptance is explicit for agent runtimes. The maintained Hermes adapter additionally checks `@alias` before starting a group turn.

Cone controls which messages enter the host. The host controls tool access, scheduling, and authorization. An accepted peer does not become the operator.

## MCP

`cone mcp` exposes the same implementation using the official MCP SDK and stdio transport. Tools use the `cone_` prefix and validated schemas. Text sends and replies require a retry key; acknowledgement remains a separate tool. Tool errors set `isError`. Successful results include both JSON text and `structuredContent`.

MCP hosts decide when to execute an agent turn. Continuous automatic replies require a gateway integration such as Hermes or a scheduler owned by the host.
