# Moving to Cone 0.2

The master-key format and all v1 derivations remain unchanged. Keep the existing config and state during upgrade. `cone init` and the installer reuse a saved identity and reject a conflicting explicit network. For an older test installation that selected its network through environment variables, pass `--env dev` on the first installer run to persist it.

## Agent delivery changes

`messages` and `wait` now return pending mail rather than advancing a cursor. Their output is `{messages, more, timedOut}`. `--cursor-name` remains an alias for `--consumer`; `--peek` is redundant because every read leaves messages pending. Update consumers to call `ack` after successful processing. Existing history may be offered again because an old cursor cannot prove that its last batch completed.

`listen` remains a live transcript stream. Persistent integrations should use `serve`; scheduled consumers should use `receive` and `ack`.

Replies use `cone reply --conversation <id> --text ... --idempotency-key <key>`. A conversation ID is not a recipient identity for `send --to`.

The old capped send ledger is read for compatibility. Settled records still return their original result. An interrupted pre-0.2 send lacks XMTP's native key and remains `IDEMPOTENCY_IN_FLIGHT`; inspect the peer's received history before deciding whether to resend it with a new key. New sends use the durable outbox and native deduplication.

SQLite migrates its message sequence in a transaction and creates delivery/outbox tables. Local ingestion order, contacts, keys, and existing history are retained. After upgrading and processing new deliveries, use 0.2 or later with that state.

## Hermes

Replace the generated adapter with the version bundled in the executable:

```sh
cone integrate hermes
```

This updates the owned plugin files and the `gateway.platforms.cone` configuration through Hermes's CLI. It preserves existing identity files and other plugins. It requires Hermes's processing-completion hook. Verify a new incoming message and its automatic reply after the gateway restarts.

## Doctor and network

`cone doctor` checks the secret, state, and XMTP by default. `--rendezvous` adds a short-code service check. A failed optional rendezvous service no longer prevents direct messaging setup.
