#!/usr/bin/env bun
/**
 * Generates fresh XMTP credentials and prints them ready to paste into .env
 *
 * Usage: bun run gen:keys
 *
 * XMTP_WALLET_KEY   — secp256k1 private key (0x + 64 hex chars)
 *                     Same format as viem generatePrivateKey()
 *                     Used by @xmtp/agent-sdk to create the agent's XMTP identity
 *
 * XMTP_DB_ENCRYPTION_KEY — 32 random bytes as hex (64 chars, no 0x prefix)
 *                          Used to encrypt the local XMTP message database
 */

import { randomBytes } from 'node:crypto';
import { generatePrivateKey } from 'viem/accounts';

const walletKey = generatePrivateKey();
const dbEncryptionKey = randomBytes(32).toString('hex');

console.log('# Paste these into your .env file (keep them secret, never commit)\n');
console.log(`XMTP_WALLET_KEY=${walletKey}`);
console.log(`XMTP_DB_ENCRYPTION_KEY=${dbEncryptionKey}`);
console.log(`XMTP_ENV=dev`);
