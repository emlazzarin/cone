import { Client, IdentifierKind, type ClientOptions, type Identifier, type XmtpEnv as SdkXmtpEnv } from '@xmtp/browser-sdk';
import { hexToBytes, type DerivedAccount, type XmtpAdapter } from '@cone/core';
import { createSdkXmtpAdapter, type SdkClient, type SdkDm } from '@cone/core/xmtp';
import { privateKeyToAccount } from 'viem/accounts';

export { IndexedDbStore } from './store';

export interface BrowserXmtpAdapterOptions {
  account: DerivedAccount;
  dbPath?: string;
}

export function browserAccountNamespace(account: DerivedAccount): string {
  const address = privateKeyToAccount(account.walletPrivateKey).address.toLowerCase();
  return `cone-${account.env}-${account.accountId}-${address}`;
}

export async function createBrowserXmtpAdapter(options: BrowserXmtpAdapterOptions): Promise<XmtpAdapter> {
  const wallet = privateKeyToAccount(options.account.walletPrivateKey);
  const address = wallet.address.toLowerCase();
  const signer = {
    type: 'EOA' as const,
    getIdentifier: (): Identifier => ({ identifier: address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (message: string) => hexToBytes(await wallet.signMessage({ message })),
  };

  const clientOptions: ClientOptions = {
    dbEncryptionKey: hexToBytes(options.account.xmtpDbEncryptionKey),
    dbPath: options.dbPath ?? `${browserAccountNamespace(options.account)}.db3`,
    env: options.account.env as SdkXmtpEnv,
  };
  const client = await Client.create(signer, clientOptions);

  return createSdkXmtpAdapter({
    client: client as unknown as SdkClient,
    env: options.account.env,
    address,
    ethereumIdentifierKind: IdentifierKind.Ethereum,
    // peerInboxId is an async method on browser-sdk DMs.
    peerInboxId: (dm: SdkDm) => (dm as unknown as { peerInboxId(): Promise<string> }).peerInboxId(),
  });
}
