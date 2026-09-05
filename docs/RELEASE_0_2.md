# Cone 0.2

Agent installation and message processing now have one maintained path: a standalone executable, a persistent local runtime, and a bundled Hermes platform adapter. The same runtime is available through MCP and JSON-RPC.

The incoming message stays pending until the host finishes its turn. Replies preserve their first payload and retry key across crashes, including a crash after publication. Unknown peers remain requests and agent groups require explicit acceptance.

## XMTP update

The previous Node SDK was a June 3 nightly build. Cone now pins Node SDK 6.1.0 and native bindings 1.11.0. The browser SDK moves from 7.0.0 to 7.1.0. The stable SDK releases are dated July 29, 2026.

The useful changes are native send idempotency keys, stream reliability fixes, an optional stream watchdog, and reduced native API connection overhead. Send helpers now take an options object. Cone enables the watchdog by default, waits for a new registration to become visible, and routes native diagnostics away from protocol stdout. The new outbox uses native idempotency rather than guessing whether an interrupted send published.

Upstream notes: [Node 6.1.0](https://github.com/xmtp/libxmtp/blob/node-sdk-6.1.0/docs/release-notes/node-sdk/6.1.0.md), [Browser 7.1.0](https://github.com/xmtp/libxmtp/blob/browser-sdk-7.1.0/docs/release-notes/browser-sdk/7.1.0.md).

The packaged targets are macOS ARM64 and Linux x86-64/ARM64. The native binding no longer supplies a macOS Intel binary.

## Compatibility

Identity derivation is unchanged. Pending-mail commands require explicit acknowledgement; see [migration notes](https://github.com/emlazzarin/cone/blob/master/docs/MIGRATION_0_2.md). Existing pairing and human chat features remain available. Direct messaging and the agent runtime need only XMTP.
