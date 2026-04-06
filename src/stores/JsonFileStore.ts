import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ConeStore, PeerSnapshot, StoredConnection, StoredInvite } from '../types';

declare const Bun: {
  write(path: string, data: string): Promise<number>;
};

interface JsonState {
  invites: Record<string, StoredInvite>;
  connections: Record<string, StoredConnection>;
  processedMessageIds: string[];
}

export class JsonFileStore implements ConeStore {
  private readonly filePath: string;
  private readonly state: JsonState;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = this.loadState(filePath);
  }

  async putInvite(invite: StoredInvite): Promise<void> {
    this.state.invites[invite.inviteId] = invite;
    await this._save();
  }

  getInvite(inviteId: string): Promise<StoredInvite | null> {
    return Promise.resolve(this.state.invites[inviteId] ?? null);
  }

  async consumeInvite(inviteId: string, peer: PeerSnapshot): Promise<void> {
    const invite = this.state.invites[inviteId];
    if (!invite) {
      return;
    }

    this.state.invites[inviteId] = {
      ...invite,
      status: 'consumed',
      consumedBy: peer,
    };

    await this._save();
  }

  async putConnection(connection: StoredConnection): Promise<void> {
    this.state.connections[connection.connectionId] = connection;
    await this._save();
  }

  getConnectionById(connectionId: string): Promise<StoredConnection | null> {
    return Promise.resolve(this.state.connections[connectionId] ?? null);
  }

  getConnectionByInboxId(peerInboxId: string): Promise<StoredConnection | null> {
    for (const connection of Object.values(this.state.connections)) {
      if (connection.peerInboxId === peerInboxId) {
        return Promise.resolve(connection);
      }
    }

    return Promise.resolve(null);
  }

  listConnections(): Promise<StoredConnection[]> {
    return Promise.resolve(Object.values(this.state.connections));
  }

  async markMessageProcessed(messageId: string): Promise<boolean> {
    if (this.state.processedMessageIds.includes(messageId)) {
      return false;
    }

    this.state.processedMessageIds.push(messageId);
    await this._save();
    return true;
  }

  private loadState(filePath: string): JsonState {
    if (!existsSync(filePath)) {
      return createEmptyState();
    }

    const content = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<JsonState>;

    return {
      invites: parsed.invites ?? {},
      connections: parsed.connections ?? {},
      processedMessageIds: parsed.processedMessageIds ?? [],
    };
  }

  private async _save(): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    await Bun.write(this.filePath, JSON.stringify(this.state, null, 2));
  }
}

function createEmptyState(): JsonState {
  return {
    invites: {},
    connections: {},
    processedMessageIds: [],
  };
}
