import type { ConeStore, PeerSnapshot, StoredConnection, StoredInvite } from '../types';

export class MemoryStore implements ConeStore {
  private readonly invites = new Map<string, StoredInvite>();
  private readonly connections = new Map<string, StoredConnection>();
  private readonly processedMessageIds = new Set<string>();

  putInvite(invite: StoredInvite): Promise<void> {
    this.invites.set(invite.inviteId, invite);
    return Promise.resolve();
  }

  getInvite(inviteId: string): Promise<StoredInvite | null> {
    return Promise.resolve(this.invites.get(inviteId) ?? null);
  }

  consumeInvite(inviteId: string, peer: PeerSnapshot): Promise<void> {
    const invite = this.invites.get(inviteId);
    if (!invite) {
      return Promise.resolve();
    }

    this.invites.set(inviteId, {
      ...invite,
      status: 'consumed',
      consumedBy: peer,
    });

    return Promise.resolve();
  }

  putConnection(connection: StoredConnection): Promise<void> {
    this.connections.set(connection.connectionId, connection);
    return Promise.resolve();
  }

  getConnectionById(connectionId: string): Promise<StoredConnection | null> {
    return Promise.resolve(this.connections.get(connectionId) ?? null);
  }

  getConnectionByInboxId(peerInboxId: string): Promise<StoredConnection | null> {
    for (const connection of this.connections.values()) {
      if (connection.peerInboxId === peerInboxId) {
        return Promise.resolve(connection);
      }
    }

    return Promise.resolve(null);
  }

  listConnections(): Promise<StoredConnection[]> {
    return Promise.resolve([...this.connections.values()]);
  }

  markMessageProcessed(messageId: string): Promise<boolean> {
    if (this.processedMessageIds.has(messageId)) {
      return Promise.resolve(false);
    }

    this.processedMessageIds.add(messageId);
    return Promise.resolve(true);
  }
}
