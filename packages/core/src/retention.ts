// Disappearing-messages (retention) helpers shared by the TUI and PWA.
// Expiry is always derived from a message's sentAt and the conversation's
// *current* retention — never stored — so changing or removing the timer
// immediately applies to the whole conversation, matching XMTP semantics.

import type { MessageRetention } from './types';

// Timer presets offered by both surfaces: 30s, 5m, 1h, 8h, 1d, 1w, 4w.
// XMTP takes an arbitrary duration, so these buckets are Cone convention;
// custom values (typed in the TUI or set by another client) stay legal and
// every surface must display them.
export const RETENTION_PRESETS_MS: readonly number[] = [
  30_000,
  5 * 60_000,
  60 * 60_000,
  8 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  28 * 24 * 60 * 60_000,
];

// When a message disappears under the given retention, or undefined if it
// never does. Messages sent before the timer was set (sentAt < fromAt) are
// exempt — enabling a timer is forward-looking and never deletes history.
export function messageExpiresAt(sentAt: string, retention: MessageRetention | undefined | null): string | undefined {
  if (!retention || retention.durationMs <= 0) {
    return undefined;
  }
  const sentMs = Date.parse(sentAt);
  if (Number.isNaN(sentMs) || sentAt < retention.fromAt) {
    return undefined;
  }
  return new Date(sentMs + retention.durationMs).toISOString();
}

export function isExpiredMessage(
  message: { sentAt: string },
  retention: MessageRetention | undefined | null,
  now: number,
): boolean {
  const expiresAt = messageExpiresAt(message.sentAt, retention);
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}

const UNITS_MS: ReadonlyArray<[suffix: string, ms: number]> = [
  ['w', 7 * 24 * 60 * 60_000],
  ['d', 24 * 60 * 60_000],
  ['h', 60 * 60_000],
  ['m', 60_000],
  ['s', 1_000],
];

// Compact duration label shared by both surfaces: presets render as '30s',
// '5m', '1h', '8h', '1d', '1w', '4w'; uneven values decompose ('1h30m');
// null/undefined (timer off) renders as 'off'.
export function formatRetention(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || durationMs <= 0) {
    return 'off';
  }
  const parts: string[] = [];
  let remaining = Math.round(durationMs / 1_000) * 1_000;
  for (const [suffix, unitMs] of UNITS_MS) {
    const count = Math.floor(remaining / unitMs);
    if (count > 0) {
      parts.push(`${count}${suffix}`);
      remaining -= count * unitMs;
    }
  }
  return parts.length > 0 ? parts.join('') : 'off';
}

// Parse a user-entered timer: 'off' (or 'none'/'0') disables, otherwise one or
// more <number><unit> terms with s/m/h/d/w units ('5m', '1h30m', '6d', '4w').
// Returns durationMs, or null for off. Throws on anything else.
export function parseRetention(input: string): number | null {
  const value = input.trim().toLowerCase();
  if (value === 'off' || value === 'none' || value === '0') {
    return null;
  }
  if (!/^(\d+[smhdw])+$/.test(value)) {
    throw new Error(`invalid duration: ${input} (expected e.g. 30s, 1h, 6d, 4w, or off)`);
  }
  let durationMs = 0;
  for (const [, count, suffix] of value.matchAll(/(\d+)([smhdw])/g)) {
    durationMs += Number(count) * UNITS_MS.find(([unit]) => unit === suffix)![1];
  }
  if (durationMs <= 0) {
    throw new Error(`invalid duration: ${input} (expected e.g. 30s, 1h, 6d, 4w, or off)`);
  }
  return durationMs;
}
