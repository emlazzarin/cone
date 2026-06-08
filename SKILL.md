---
name: cone-of-silence
description: >
  Use this skill to connect to XMTP through Cone of Silence, manage contacts,
  send messages, listen for messages, and pair with another human or agent using
  a handshake code.
version: "2.0.0"
---

# Cone of Silence

Cone of Silence gives an agent an XMTP-backed identity from a portable `SECRET KEY`.

## Setup

Install dependencies in the Cone repo:

```sh
bun install
```

Generate a new key:

```sh
bun run packages/cli/src/bin.ts keygen
```

Use it for this process:

```sh
export COS_SECRET_KEY='cos_sk_v1_...'
```

Or remember it locally for the CLI:

```sh
printf '%s' "$COS_SECRET_KEY" | bun run packages/cli/src/bin.ts login --secret-stdin --remember
```

The `SECRET_KEY` determines the XMTP account/inbox. Contact names are local aliases.

## Identity

```sh
bun run packages/cli/src/bin.ts whoami
```

The output includes the XMTP `inboxId` and EVM address.

## Messaging

Send to an inbox ID, EVM address, or saved contact name:

```sh
bun run packages/cli/src/bin.ts send --to <identity> --text "hello"
```

Listen for inbound messages:

```sh
bun run packages/cli/src/bin.ts listen
```

## Contacts

```sh
bun run packages/cli/src/bin.ts contacts list
bun run packages/cli/src/bin.ts contacts add --name Alice --identity <inboxId-or-address>
```

Contact names are local aliases only.

## Pairing

Create a code:

```sh
bun run packages/cli/src/bin.ts pair new
```

Join with a code:

```sh
bun run packages/cli/src/bin.ts pair join <code> --share-name "Agent A" --save-as "Peer"
```

Both sides must opt in during the short pairing window. `--share-name` is the optional peer-visible name you propose. `--save-as` is the local contact name for the peer. The rendezvous service never relays application messages.
