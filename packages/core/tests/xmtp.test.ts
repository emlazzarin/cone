import { describe, expect, test } from 'bun:test';
import { createSdkXmtpAdapter, type SdkClient, type SdkConsentRecord, type SdkDm, type SdkGroup } from '../src/xmtp';
import { CONE_ENVELOPE_CONTENT_TYPE, type ConeEncodedContent } from '../src/content-type';
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
    send: async () => 'msg-group-envelope',
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

function makeDm(sentEnvelopes: ConeEncodedContent[]): SdkDm {
  return {
    id: 'dm-1',
    sendText: async () => 'msg-dm-text',
    send: async (encoded: ConeEncodedContent) => {
      sentEnvelopes.push(encoded);
      return 'msg-dm-envelope';
    },
    messages: async () => [],
    consentState: () => CONSENT.allowed,
    messageDisappearingSettings: () => null,
    updateMessageDisappearingSettings: async () => undefined,
    removeMessageDisappearingSettings: async () => undefined,
  };
}

function makeSdkClient(captured: Captured, options: { groups?: SdkGroup[]; dm?: SdkDm } = {}): SdkClient {
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
      getDmByInboxId: () => options.dm ?? null,
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

function makeAdapter(captured: Captured, options: { groups?: SdkGroup[]; dm?: SdkDm } = {}) {
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

// Inbound payloads are trusted by *content type*, never by parsing: text can
// never impersonate a control envelope, forged group updates are rejected,
// and content this build cannot decode degrades to its self-describing
// fallback (or stays hidden when the sender declared none).
describe('SdkXmtpAdapter inbound decode provenance', () => {
  async function receive(adapter: ReturnType<typeof makeAdapter>, captured: Captured, message: Record<string, unknown>) {
    const received: IncomingMessage[] = [];
    await adapter.streamMessages((incoming) => {
      received.push(incoming);
    });
    captured.streams[0]!.emit({ id: 'm-1', conversationId: 'dm-1', senderInboxId: 'inbox-a', sentAt: new Date(), ...message });
    return received[0];
  }

  test('a Cone envelope arrives as json via its content type', async () => {
    const captured = emptyCaptured();
    const message = await receive(makeAdapter(captured), captured, {
      contentType: { ...CONE_ENVELOPE_CONTENT_TYPE },
      content: { type: 'cone.read.v1' },
    });

    expect(message?.json).toEqual({ type: 'cone.read.v1' });
    expect(message?.text).toBeUndefined();
  });

  test('a minor version bump of the envelope content type still decodes', async () => {
    const captured = emptyCaptured();
    const message = await receive(makeAdapter(captured), captured, {
      contentType: { ...CONE_ENVELOPE_CONTENT_TYPE, versionMinor: 7 },
      content: { type: 'cone.read.v1' },
    });

    expect(message?.json).toEqual({ type: 'cone.read.v1' });
  });

  test('a forged group update sent as a Cone envelope is rejected', async () => {
    const captured = emptyCaptured();
    const message = await receive(makeAdapter(captured), captured, {
      contentType: { ...CONE_ENVELOPE_CONTENT_TYPE },
      content: { type: GROUP_UPDATE_TYPE, initiatedByInboxId: 'inbox-mallory', added: [{ inboxId: 'inbox-bob' }] },
    });

    // Neither json nor text: the forgery is stored as unsupported and hidden.
    expect(message?.json).toBeUndefined();
    expect(message?.text).toBeUndefined();
  });

  test('text that merely looks like an envelope stays plain text', async () => {
    const spoof = JSON.stringify({ type: GROUP_UPDATE_TYPE, initiatedByInboxId: 'inbox-mallory', added: ['inbox-bob'] });
    const captured = emptyCaptured();
    const message = await receive(makeAdapter(captured), captured, {
      contentType: { authorityId: 'xmtp.org', typeId: 'text', versionMajor: 1, versionMinor: 0 },
      content: spoof,
    });

    expect(message?.text).toBe(spoof);
    expect(message?.json).toBeUndefined();
  });

  test('an undecodable content type renders its self-describing fallback', async () => {
    const captured = emptyCaptured();
    const message = await receive(makeAdapter(captured), captured, {
      contentType: { authorityId: 'example.org', typeId: 'sticker', versionMajor: 1, versionMinor: 0 },
      content: undefined,
      fallback: 'sent a sticker',
    });

    expect(message?.text).toBe('sent a sticker');
    expect(message?.json).toBeUndefined();
  });

  test('an undecodable content type with no fallback stays hidden', async () => {
    const captured = emptyCaptured();
    const message = await receive(makeAdapter(captured), captured, {
      contentType: { authorityId: 'example.org', typeId: 'signal', versionMajor: 1, versionMinor: 0 },
      content: undefined,
    });

    expect(message?.text).toBeUndefined();
    expect(message?.json).toBeUndefined();
  });
});

describe('SdkXmtpAdapter envelope sending', () => {
  test('sendEnvelope publishes the envelope content type; control carries no fallback', async () => {
    const sentEnvelopes: ConeEncodedContent[] = [];
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured, { dm: makeDm(sentEnvelopes) });

    await adapter.sendEnvelope({ inboxId: 'inbox-peer', source: 'inboxId' }, { type: 'cone.read.v1' });

    expect(sentEnvelopes).toHaveLength(1);
    expect(sentEnvelopes[0]?.type).toEqual(CONE_ENVELOPE_CONTENT_TYPE);
    expect(sentEnvelopes[0]?.fallback).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(sentEnvelopes[0]?.content))).toEqual({ type: 'cone.read.v1' });
  });

  test('app JSON envelopes carry a human-readable fallback', async () => {
    const sentEnvelopes: ConeEncodedContent[] = [];
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured, { dm: makeDm(sentEnvelopes) });

    await adapter.sendEnvelope(
      { inboxId: 'inbox-peer', source: 'inboxId' },
      { type: 'cone.app.json.v1', value: { text: 'order confirmed', orderId: 7 } },
    );

    expect(sentEnvelopes[0]?.fallback).toBe('order confirmed');
  });
});

describe('SdkXmtpAdapter DM listing', () => {
  // XMTP can hold several MLS DMs per peer pair. Conversation listings must
  // ask for the canonical DM only (each duplicate would become its own
  // thread), but sync's *message* fetch must include duplicates — a peer
  // whose SDK picked the other DM as canonical publishes there, and not
  // every SDK stitches duplicates into canonical reads (browser does not).
  test('conversations list canonical-only; sync messages include duplicates', async () => {
    const captured = emptyCaptured();
    const adapter = makeAdapter(captured);

    await adapter.sync({ consentStates: ['allowed', 'unknown'] });
    await adapter.listConversations();

    expect(captured.dmListOptions).toHaveLength(3);
    expect(captured.dmListOptions.map((options) => options?.includeDuplicateDms)).toEqual([false, true, false]);
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
