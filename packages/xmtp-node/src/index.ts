import { Client, ConsentEntityType, ConsentState, ConversationType, GroupPermissionsOptions, IdentifierKind, LogLevel, PermissionLevel, type ClientOptions, type Identifier, type XmtpEnv as SdkXmtpEnv } from '@xmtp/node-sdk';
import type { ContentCodec } from '@xmtp/content-type-primitives';
import { createConeEnvelopeCodec, hexToBytes, type DerivedAccount, type XmtpAdapter } from '@cone/core';
import { createSdkXmtpAdapter, type SdkClient, type SdkDm, type SdkGroup } from '@cone/core/xmtp';
import { privateKeyToAccount } from 'viem/accounts';

export interface NodeXmtpAdapterOptions {
  account: DerivedAccount;
  dbPath?: string;
}

export async function createNodeXmtpAdapter(options: NodeXmtpAdapterOptions): Promise<XmtpAdapter> {
  process.env.XMTP_STREAM_WATCHDOG_ENABLED ??= 'true';
  const wallet = privateKeyToAccount(options.account.walletPrivateKey);
  const address = wallet.address.toLowerCase();
  const signer = {
    type: 'EOA' as const,
    getIdentifier: (): Identifier => ({ identifier: address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (message: string) => hexToBytes(await wallet.signMessage({ message })),
  };

  const clientOptions: ClientOptions = {
    dbEncryptionKey: hexToBytes(options.account.xmtpDbEncryptionKey),
    dbPath: options.dbPath,
    env: options.account.env as SdkXmtpEnv,
    waitForRegistrationVisible: { timeoutMs: 30000 },
    // stdout is the CLI / adapter protocol. Network errors are reported by
    // the adapter on stderr; native diagnostics must not corrupt JSON frames.
    stdoutLoggingLevel: LogLevel.Off,
    // Inbound Cone envelopes (read receipts, pair confirms, app JSON) decode
    // via this codec; without it their content would arrive undefined.
    codecs: [createConeEnvelopeCodec() as unknown as ContentCodec],
  };
  const client = await Client.create(signer, clientOptions);

  return createSdkXmtpAdapter({
    client: client as unknown as SdkClient,
    env: options.account.env,
    address,
    ethereumIdentifierKind: IdentifierKind.Ethereum,
    consent: {
      unknown: ConsentState.Unknown,
      allowed: ConsentState.Allowed,
      denied: ConsentState.Denied,
      inboxEntityType: ConsentEntityType.InboxId,
      groupEntityType: ConsentEntityType.GroupId,
    },
    permissionLevels: {
      member: PermissionLevel.Member,
      admin: PermissionLevel.Admin,
      superAdmin: PermissionLevel.SuperAdmin,
    },
    adminOnlyPermissions: GroupPermissionsOptions.AdminOnly,
    dmConversationType: ConversationType.Dm,
    groupConversationType: ConversationType.Group,
    // peerInboxId and isActive are plain properties on node-sdk conversations.
    peerInboxId: (dm: SdkDm) => (dm as unknown as { peerInboxId: string }).peerInboxId,
    groupIsActive: (group: SdkGroup) => (group as unknown as { isActive: boolean }).isActive,
  });
}
