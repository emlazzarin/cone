import { describe, expect, test } from 'bun:test';
import { createSdkXmtpAdapter, type SdkClient, type SdkConsentRecord, type SdkGroup } from '../src/xmtp';
import { GROUP_UPDATE_TYPE } from '../src/envelope';
import type { IncomingMessage } from '../src/types';

// Sentinel enum values stand in for the SDK's injected const-enum members so
// the tests prove pass-through, not specific protocol integers.
const CONSENT = { unknown: 'C-UNKNOWN', allowed: 'C-ALLOWED', denied: 'C-DENIED', inboxEntityType: 'E-INBOX', groupEntityType: 'E-GROUP' };
const LEVELS = { member: 'L-MEMBER', admin: 'L-ADMIN', superAdmin: 'L-SUPER' };
const DM_TYPE = 'T-DM';
const GROUP_TYPE = 'T-GROUP';
const ADMIN_ONLY = 'P-ADMIN-ONLY';

interface CapturedStream {
  options: Record<string, unknown>;
  emit: (message: unknown) => void;
}

interface Captured {
  streams: CapturedStream[];
  consentWrites: SdkConsentRecord[];
  groupCreates: Array<{ inboxIds: string[]; options?: Record<string, unknown> }>;
  dmListOptions: Array<Record<string, unknown> | undefined>;
}

function makeGroup(overrides: Partial<SdkGroup> & { id: string }): SdkGroup {
  return {
    name: 'Crew',
    description: 'a test group',
    addedByInboxId: 'inbox-adder',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    sendText: async () => 'msg-group',
    messages: async () => [],
    consentState: () => CONSENT.unknown,
    messageDisappearingSettings: () => null,
    updateMessageDisappearingSettings: async () => undefined,
    removeMessageDisappearingSettings: async () => undefined,
    members: async () => [
      { inboxId: 'inbox-adder', permissionLevel: LEVELS.superAdmin, consentState: CONSENT.allowed },
      { inboxId: 'inbox-self', permissionLevel: LEVELS.member, consentState: CONSENT.unknown },
    ],
    addMembers: async () => undefined,
    removeMembers: async () => undefined,
    requestRemoval: async () => undefined,
    updateName: async () => undefined,
    updateDescription: async () => undefined,
    addAdmin: async () => undefined,
    removeAdmin: async () => undefined,
    addSuperAdmin: async () => undefined,
    removeSuperAdmin: async () => undefined,
    ...overrides,
  };
}

function makeSdkClient(captured: Captured, options: { groups?: SdkGroup[] } = {}): SdkClient {
  return {
    inboxId: 'inbox-self',
    conversations: {
      async streamAllMessages(handlers) {
        const stream: CapturedStream = { options: { ...handlers }, emit: (message) => handlers.onValue(message) };
        captured.streams.push(stream);
        return { return: () => undefined };
      },
      async syncAll() {},
      listDms: (listOptions?: Record<string, unknown>) => {
        captured.dmListOptions.push(listOptions);
        return [];
      },
      listGroups: () => options.groups ?? [],
      async createGroup(inboxIds, createOptions) {
        captured.groupCreates.push({ inboxIds, options: createOptions });
        return makeGroup({ id: 'group-created', name: (createOptions?.groupName as string) ?? undefined, consentState: () => CONSENT.allowed });
      },
      getConversationById: () => null,
      fetchDmByIdentifier: () => null,
      createDmWithIdentifier: () => Promise.reject(new Error('unused')),
      getDmByInboxId: () => null,
      createDm: () => Promise.reject(new Error('unused')),
    },
    preferences: {
      async setConsentStates(records) {
        captured.consentWrites.push(...records);
      },
      async getConsentState() {
        return CONSENT.unknown;
      },
    },
    fetchInboxIdByIdentifier: () => null,
    canMessage: async () => new Map(),
    close: () => undefined,
  };
}

function makeAdapter(captured: Captured, options: { groups?: SdkGroup[] } = {}) {
  return createSdkXmtpAdapter({
    client: makeSdkClient(captured, options),
    env: 'dev',
    address: '0xabc',
    ethereumIdentifierKind: 'K-ETH',
    consent: CONSENT,
    permissionLevels: LEVELS,
    adminOnlyPermissions: ADMIN_ONLY,
    dmConversationType: DM_TYPE,
    groupConversationType: GROUP_TYPE,
    peerInboxId: () => 'inbox-peer',
    groupIsActive: () => true,
  });
}

function emptyCaptured(): Captured {
  return { streams: [], consentWrites: [], groupCreates: [], dmListOptions: [] };
}

describe('SdkXmtpAdapter streaming', () => {
  // One SDK stream per conversation type, so a message's kind is always known
  // — a group message must never be persisted as a DM-shaped conversation.
  test('streamMessages opens one stream per conversation type', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);

    await adapter.streamMessages(() => {});

    expect(captured.streams.map((stream) => stream.options.conversationType)).toEqual([DM_TYPE, GROUP_TYPE]);
  });

  test('streamMessages maps consent filters onto both streams', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);

    await adapter.streamMessages(() => {}, { consentStates: ['allowed', 'unknown'] });

    for (const stream of captured.streams) {
      expect(stream.options.consentStates).toEqual([CONSENT.allowed, CONSENT.unknown]);
    }
  });

  test('streamMessages omits consentStates when no filter is given', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);

    await adapter.streamMessages(() => {});

    for (const stream of captured.streams) {
      expect('consentStates' in stream.options).toBe(false);
    }
  });

  test('messages are tagged with the conversation kind of their stream', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);
    const received: IncomingMessage[] = [];
    await adapter.streamMessages((message) => {
      received.push(message);
    });

    captured.streams[0]!.emit({ id: 'm-dm', conversationId: 'dm-1', senderInboxId: 'inbox-a', sentAt: new Date(), content: 'hi' });
    captured.streams[1]!.emit({ id: 'm-group', conversationId: 'group-1', senderInboxId: 'inbox-b', sentAt: new Date(), content: 'yo' });

    expect(received.map((message) => message.conversationKind)).toEqual(['dm', 'group']);
  });

  // XMTP delivers membership/metadata changes as GroupUpdated system messages;
  // the adapter normalizes them into Cone's cone.group.update.v1 control shape.
  test('decodes GroupUpdated messages into the group-update control envelope', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);
    const received: IncomingMessage[] = [];
    await adapter.streamMessages((message) => {
      received.push(message);
    });

    captured.streams[1]!.emit({
      id: 'm-update',
      conversationId: 'group-1',
      senderInboxId: 'inbox-alice',
      sentAt: new Date(),
      contentType: { authorityId: 'xmtp.org', typeId: 'group_updated' },
      content: {
        initiatedByInboxId: 'inbox-alice',
        addedInboxes: [{ inboxId: 'inbox-bob' }],
        removedInboxes: [],
        leftInboxes: [{ inboxId: 'inbox-carol' }],
        metadataFieldChanges: [{ fieldName: 'group_name', oldValue: 'Old', newValue: 'New' }],
      },
    });

    expect(received[0]?.json).toEqual({
      type: GROUP_UPDATE_TYPE,
      initiatedByInboxId: 'inbox-alice',
      added: ['inbox-bob'],
      removed: [],
      left: ['inbox-carol'],
      adminsAdded: [],
      adminsRemoved: [],
      superAdminsAdded: [],
      superAdminsRemoved: [],
      metadataChanges: [{ field: 'group_name', oldValue: 'Old', newValue: 'New' }],
    });
  });
});

describe('SdkXmtpAdapter DM listing', () => {
  // XMTP can hold several MLS DMs per peer pair; the SDK stitches them, and
  // every DM listing must ask for the canonical one only — otherwise each
  // duplicate becomes its own thread in the read model.
  test('sync and list exclude duplicate DMs explicitly', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);

    await adapter.sync({ consentStates: ['allowed', 'unknown'] });
    await adapter.listConversations();

    expect(captured.dmListOptions).toHaveLength(2);
    for (const options of captured.dmListOptions) {
      expect(options?.includeDuplicateDms).toBe(false);
    }
  });
});

describe('SdkXmtpAdapter groups', () => {
  test('sync lists groups with members, roles, and the adder', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured, { groups: [makeGroup({ id: 'group-1' })] });

    const result = await adapter.sync({ consentStates: ['allowed', 'unknown'] });
    const group = result.conversations.find((conversation) => conversation.conversationId === 'group-1');

    expect(group).toMatchObject({
      kind: 'group',
      title: 'Crew',
      groupName: 'Crew',
      memberCount: 2,
      addedByInboxId: 'inbox-adder',
      consentState: 'unknown',
    });
    expect(group?.members).toEqual([
      { inboxId: 'inbox-adder', level: 'superAdmin', consentState: 'allowed' },
      { inboxId: 'inbox-self', level: 'member', consentState: 'unknown' },
    ]);
    expect(group?.peerInboxId).toBeUndefined();
  });

  test('createGroup maps name, description, and the locked preset', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);

    const created = await adapter.createGroup(['inbox-a', 'inbox-b'], { name: 'Ops', description: 'on-call', locked: true });

    expect(captured.groupCreates[0]).toEqual({
      inboxIds: ['inbox-a', 'inbox-b'],
      options: { groupName: 'Ops', groupDescription: 'on-call', permissions: ADMIN_ONLY },
    });
    expect(created.kind).toBe('group');
    expect(created.consentState).toBe('allowed');
  });

  test('setGroupConsent writes a GroupId-entity consent record', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);

    await adapter.setGroupConsent('group-1', 'denied');

    expect(captured.consentWrites).toEqual([
      { entityType: CONSENT.groupEntityType, state: CONSENT.denied, entity: 'group-1' },
    ]);
  });
});
