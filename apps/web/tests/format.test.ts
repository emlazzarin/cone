import { describe, expect, test } from 'bun:test';

import { clamp, countdown, hashHue, initials, relativeTime, shortId } from '../src/format';

const NOW = Date.parse('2026-06-09T12:00:00Z');

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('relativeTime', () => {
  test('returns empty for missing or invalid input', () => {
    expect(relativeTime(undefined, NOW)).toBe('');
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });

  test('buckets recent times', () => {
    expect(relativeTime(isoAgo(10_000), NOW)).toBe('now');
    expect(relativeTime(isoAgo(5 * 60_000), NOW)).toBe('5m');
    expect(relativeTime(isoAgo(3 * 3_600_000), NOW)).toBe('3h');
    expect(relativeTime(isoAgo(3 * 86_400_000), NOW)).toBe('3d');
  });

  test('falls back to a short date beyond a week', () => {
    const label = relativeTime(isoAgo(30 * 86_400_000), NOW);
    expect(label).not.toBe('');
    expect(label).toMatch(/\d/);
  });
});

describe('countdown', () => {
  test('formats minutes and seconds remaining', () => {
    expect(countdown(new Date(NOW + 90_000).toISOString(), NOW)).toBe('1:30');
    expect(countdown(new Date(NOW + 9 * 60_000 + 5_000).toISOString(), NOW)).toBe('9:05');
  });

  test('handles expiry and missing input', () => {
    expect(countdown(new Date(NOW - 1_000).toISOString(), NOW)).toBe('expired');
    expect(countdown(undefined, NOW)).toBe('');
  });
});

describe('initials', () => {
  test('uses first and last word', () => {
    expect(initials('Alice Smith')).toBe('AS');
    expect(initials('bob.eth')).toBe('BE');
  });

  test('uses leading characters for single words and hex ids', () => {
    expect(initials('Alice')).toBe('AL');
    expect(initials('0x3a9f1c')).toBe('3A');
  });

  test('handles empty input', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('hashHue', () => {
  test('is deterministic and within range', () => {
    expect(hashHue('alice')).toBe(hashHue('alice'));
    for (const seed of ['alice', 'bob', '0xdeadbeef', '']) {
      const hue = hashHue(seed);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  test('differs across typical inputs', () => {
    expect(hashHue('alice')).not.toBe(hashHue('bob'));
  });
});

describe('shortId', () => {
  test('truncates long ids with an ellipsis', () => {
    const id = '0x3a9f1c2d4e6b8a0c2d4f6b8a1c3e5d7f9b0a2c4e';
    const short = shortId(id);
    expect(short).toContain('…');
    expect(short.length).toBeLessThan(id.length);
    expect(short.startsWith('0x3a9f1c')).toBe(true);
    expect(short.endsWith(id.slice(-6))).toBe(true);
  });

  test('leaves short values alone', () => {
    expect(shortId('alice')).toBe('alice');
  });
});

describe('clamp', () => {
  test('bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
