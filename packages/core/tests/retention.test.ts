import { describe, expect, test } from 'bun:test';

import {
  RETENTION_PRESETS_MS,
  formatRetention,
  isExpiredMessage,
  messageExpiresAt,
  parseRetention,
} from '../src/retention';

describe('retention', () => {
  test('presets render with the shared compact vocabulary', () => {
    expect(RETENTION_PRESETS_MS.map(formatRetention)).toEqual(['30s', '5m', '1h', '8h', '1d', '1w', '4w']);
  });

  test('formatRetention handles off, custom, and uneven durations', () => {
    expect(formatRetention(null)).toBe('off');
    expect(formatRetention(undefined)).toBe('off');
    expect(formatRetention(0)).toBe('off');
    expect(formatRetention(90 * 60_000)).toBe('1h30m');
    expect(formatRetention(36 * 60 * 60_000)).toBe('1d12h');
    // Custom values (e.g. typed in the TUI) keep their own label everywhere.
    expect(formatRetention(6 * 24 * 60 * 60_000)).toBe('6d');
    expect(formatRetention(30 * 24 * 60 * 60_000)).toBe('4w2d');
  });

  test('parseRetention round-trips formats and rejects junk', () => {
    expect(parseRetention('5m')).toBe(5 * 60_000);
    expect(parseRetention('1h30m')).toBe(90 * 60_000);
    expect(parseRetention('6d')).toBe(6 * 24 * 60 * 60_000);
    expect(parseRetention('4w')).toBe(28 * 24 * 60 * 60_000);
    expect(parseRetention('30s')).toBe(30_000);
    expect(parseRetention('off')).toBeNull();
    expect(parseRetention('none')).toBeNull();
    expect(parseRetention('0')).toBeNull();
    for (const preset of RETENTION_PRESETS_MS) {
      expect(parseRetention(formatRetention(preset))).toBe(preset);
    }
    expect(() => parseRetention('banana')).toThrow(/invalid duration/);
    expect(() => parseRetention('5x')).toThrow(/invalid duration/);
    expect(() => parseRetention('')).toThrow(/invalid duration/);
  });

  test('messages sent before the timer was set are exempt', () => {
    const retention = { durationMs: 60_000, fromAt: '2026-01-01T00:01:00.000Z' };
    expect(messageExpiresAt('2026-01-01T00:00:59.000Z', retention)).toBeUndefined();
    expect(messageExpiresAt('2026-01-01T00:01:00.000Z', retention)).toBe('2026-01-01T00:02:00.000Z');
    expect(messageExpiresAt('2026-01-01T00:05:00.000Z', retention)).toBe('2026-01-01T00:06:00.000Z');
    expect(messageExpiresAt('2026-01-01T00:05:00.000Z', undefined)).toBeUndefined();
    expect(messageExpiresAt('2026-01-01T00:05:00.000Z', null)).toBeUndefined();
  });

  test('isExpiredMessage treats the expiry instant as expired', () => {
    const retention = { durationMs: 60_000, fromAt: '2026-01-01T00:00:00.000Z' };
    const message = { sentAt: '2026-01-01T00:01:00.000Z' };
    const expiryMs = Date.parse('2026-01-01T00:02:00.000Z');
    expect(isExpiredMessage(message, retention, expiryMs - 1)).toBe(false);
    expect(isExpiredMessage(message, retention, expiryMs)).toBe(true);
    expect(isExpiredMessage(message, undefined, expiryMs)).toBe(false);
  });
});
