#!/usr/bin/env bun
// One-command local install: workspace deps plus a global `cone` binary.
// `bun link` symlinks packages/cli's bin into ~/.bun/bin, which Bun's own
// installer puts on PATH — no build step, Bun runs the TypeScript directly.
import { $ } from 'bun';

await $`bun install`;
await $`bun link`.cwd(new URL('../packages/cli', import.meta.url).pathname);

console.log(`
cone is installed (bun link → ~/.bun/bin/cone).

Get started:
  cone keygen              generate a SECRET KEY — save it, it IS your account
  cone login --remember    paste the key once; config lands in ~/.config/cone
  cone chat                open the TUI

Pairing and group invites need the rendezvous service. For local dev, run
  bun run dev:rendezvous
in another terminal (or point CONE_RENDEZVOUS_URL at a deployed worker).

Uninstall the binary with: cd packages/cli && bun unlink
`);
