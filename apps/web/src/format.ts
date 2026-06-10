// Pure display helpers specific to the PWA. Kept framework-free so they can
// be unit tested without pulling in Preact. Anything shared with the TUI
// (relative time, message bodies, optimistic-send matching) lives in
// @cone/core; relativeTime is re-exported because PWA views treat it as part
// of this module's formatting vocabulary.

export { relativeTime } from '@cone/core';

export function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '?';
  }
  if (/^0x[0-9a-f]/i.test(trimmed)) {
    return trimmed.slice(2, 4).toUpperCase();
  }
  const parts = trimmed.split(/[\s_./-]+/u).filter(Boolean);
  const first = parts[0] ?? trimmed;
  if (parts.length < 2) {
    return first.slice(0, 2).toUpperCase();
  }
  const last = parts[parts.length - 1] ?? '';
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

// Deterministic hue (0-359) from a string, so each peer gets a stable,
// recognizable avatar tint without storing anything.
export function hashHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

export function countdown(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) {
    return '';
  }
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) {
    return 'expired';
  }
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
