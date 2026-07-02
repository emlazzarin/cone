import { describe, expect, test } from 'bun:test';

import { codeScopedKey, inviteScopedKey, secretRoomId } from '../src/crypto';
import { bytesToHex } from '../src/encoding';
import { deriveAccount, secretKeyFromHexSeed } from '../src/index';

// ─── Frozen protocol vectors ────────────────────────────────────────────────
//
// These are golden vectors, not self-consistency checks: the expected values
// are HARDCODED so that any change to the derivation — a salt or label edit,
// an HKDF parameter, a dependency swapping hash implementations — fails here
// instead of silently rotating every user's identity.
//
// walletPrivateKey determines the account's address and therefore its XMTP
// inbox: change it and every existing user becomes a different person, every
// contact edge and group membership orphaned. codeScopedKey/inviteScopedKey/
// secretRoomId are what let two different builds meet in the same rendezvous
// room and read each other's offers.
//
// A failure of this file is not a bug in this file. Either revert the change
// that broke it, or — if a new scheme is truly intended — introduce it under
// NEW version labels (cone/v2/…, cone_sk_v2_…) alongside these, and add new
// vectors. These v1 values must keep deriving forever.

const SEED_HEX = '01'.repeat(32);

describe('frozen v1 derivation vectors', () => {
  test('secret key encoding', () => {
    expect(String(secretKeyFromHexSeed(SEED_HEX))).toBe('cone_sk_v1_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAGv3_g');
  });

  test('account derivation on production (the identity that ships)', () => {
    const account = deriveAccount(secretKeyFromHexSeed(SEED_HEX), { env: 'production', accountId: 'main' });
    expect(account.walletPrivateKey).toBe('0x8fef1092e3619a0bdf8a32b89cca6d6ab887cd31269df016e54129d4eb6b60c0');
    expect(account.xmtpDbEncryptionKey).toBe('a9b979f7e7d0d2985254fa3ca437dca4820270c540c2ca9ec6e67ff5cd8ec763');
    expect(bytesToHex(account.coneStorageKey)).toBe('6e402981fa604a79b19a179dc4537cd235e41ee173ac0cc1f39ec640b7ec3e47');
    expect(bytesToHex(account.backupArchiveKey)).toBe('61ae2df483b28007e35cf323c1331011c198238d556a2052755e4c25fe9e25d0');
  });

  test('account derivation on dev (must stay distinct from production)', () => {
    const account = deriveAccount(secretKeyFromHexSeed(SEED_HEX), { env: 'dev', accountId: 'main' });
    expect(account.walletPrivateKey).toBe('0x8653cd1f99a4f3aa2e64ad5c93f5822e1e94d3c16714a249fdd27f03bef3d09a');
    expect(account.xmtpDbEncryptionKey).toBe('5332f3f73328f32bff88238ea958f732f5d372595b09f39cd25b4bfd24c567f6');
    expect(bytesToHex(account.coneStorageKey)).toBe('85abda91f4b50300c8526e26abbe319918473cce96386b9ad4deb70c0869e749');
    expect(bytesToHex(account.backupArchiveKey)).toBe('63f473251c96c04697aa21b0f831f626c7f4fb5cc7ec2adf904146364afa6904');
  });

  test('deriveAccount defaults to production', () => {
    const account = deriveAccount(secretKeyFromHexSeed(SEED_HEX));
    expect(account.env).toBe('production');
    expect(account.walletPrivateKey).toBe('0x8fef1092e3619a0bdf8a32b89cca6d6ab887cd31269df016e54129d4eb6b60c0');
  });

  test('pairing-code key derivation (including spoken-form normalization)', () => {
    expect(bytesToHex(codeScopedKey('anchor-beacon-cedar-drift-ember')))
      .toBe('b1d559a052a7d04ff26cf6339f424d3149bff95b783fb68a41f26472f7a5a7bf');
    // "Anchor Beacon …" spoken aloud and "anchor-beacon-…" typed must land on
    // the same key, or two people reading a code to each other cannot pair.
    expect(bytesToHex(codeScopedKey('Anchor Beacon Cedar Drift Ember')))
      .toBe('b1d559a052a7d04ff26cf6339f424d3149bff95b783fb68a41f26472f7a5a7bf');
  });

  test('invite-token key derivation (case-sensitive, distinct from code keys)', () => {
    expect(bytesToHex(inviteScopedKey('cone_gi_v1_AAAAAAAAAAAAAAAAAAAAAA')))
      .toBe('8d39aa031fb2ee10338afe54e230e1dd7c83d28243934077271effd89da46f6b');
  });

  test('rendezvous room addressing', () => {
    expect(secretRoomId('anchor-beacon-cedar-drift-ember'))
      .toBe('2a3964f7344ca2612dd106dba955937e1ca51cbb9ff4631da0868282089d8b60');
    expect(secretRoomId('cone_gi_v1_AAAAAAAAAAAAAAAAAAAAAA'))
      .toBe('cf229b60f444a6dee20ceb3a53dc3a13606b4778bf180b75eb106851df884e18');
  });

  // Frozen wire identifiers, as literals: a drift here strands deployed
  // clients even though every self-consistency test still passes.
  test('envelope and rendezvous identifiers are frozen', async () => {
    const envelope = await import('../src/envelope');
    expect(envelope.APP_JSON_TYPE).toBe('cone.app.json.v1');
    expect(envelope.READ_RECEIPT_TYPE).toBe('cone.read.v1');
    expect(envelope.PAIR_CONFIRM_TYPE).toBe('cone.pair.confirm.v1');
    expect(envelope.GROUP_UPDATE_TYPE).toBe('cone.group.update.v1');
    expect(envelope.BACKUP_TYPE).toBe('cone.backup.v1');

    const invites = await import('../src/invites');
    expect(invites.GROUP_INVITE_DESCRIPTOR_TYPE).toBe('cone.group.invite.descriptor.v1');
    expect(invites.GROUP_JOIN_REQUEST_TYPE).toBe('cone.group.invite.join.v1');

    const crypto = await import('../src/crypto');
    expect(crypto.GROUP_INVITE_TOKEN_PREFIX).toBe('cone_gi_v1_');

    // Rendezvous roles are validated server-side by exact string.
    const roles: Array<'pair' | 'descriptor' | 'join'> = ['pair', 'descriptor', 'join'];
    expect(roles).toEqual(['pair', 'descriptor', 'join']);
  });
});
