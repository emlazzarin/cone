import { Client, IdentifierKind, type ClientOptions, type Identifier, type XmtpEnv as SdkXmtpEnv } from '@xmtp/node-sdk';
import { hexToBytes, type DerivedAccount, type XmtpAdapter } from '@cone/core';
import { createSdkXmtpAdapter, type SdkClient, type SdkDm } from '@cone/core/xmtp';
import { privateKeyToAccount } from 'viem/accounts';

export interface NodeXmtpAdapterOptions {
  account: DerivedAccount;
  dbPath?: string;
}

export async function createNodeXmtpAdapter(options: NodeXmtpAdapterOptions): Promise<XmtpAdapter> {
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
  };
  const client = await Client.create(signer, clientOptions);

  return createSdkXmtpAdapter({
    client: client as unknown as SdkClient,
    env: options.account.env,
    address,
    ethereumIdentifierKind: IdentifierKind.Ethereum,
    // peerInboxId is a plain property on node-sdk DMs.
    peerInboxId: (dm: SdkDm) => (dm as unknown as { peerInboxId: string }).peerInboxId,
  });
}
