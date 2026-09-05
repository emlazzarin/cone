// Public surface of @cone/core: what the CLI, PWA, adapters, and tests
// actually consume. Internal helpers (encoding, validation, envelope plumbing)
// stay module-private — import them directly within core, not from here.
export { hexToBytes } from './encoding';
export {
  codeScopedKey,
  decryptJson,
  encryptJson,
  isGroupInviteToken,
  secretRoomId,
} from './crypto';
export {
  deriveAccount,
  generateSecretKey,
  parseSecretKey,
  secretKeyFromHexSeed,
} from './secret';
export { createConeClient } from './client';
export { ConeError } from './errors';
export {
  errorMessage,
  filterMatchSnippet,
  formatConnectionStatus,
  formatConversationPreview,
  formatMessageLine,
  formatSyncStatus,
  formatTranscriptTime,
  formatGroupUpdate,
  groupHistoryNotice,
  isAddressedTo,
  isAllowedConversation,
  isDeniedConversation,
  isGroupUpdateMessage,
  isReadReceipt,
  isRequestConversation,
  isVisibleChatMessage,
  laterIso,
  latestInboundAt,
  latestReadOutboundId,
  matchConversationFilter,
  matchesPendingSend,
  messageBody,
  normalizeDeliveryStatus,
  relativeTime,
} from './display';
export type { ConeConnectionStatus, ConversationFilterMatch, FilterMatchSnippet } from './display';
export {
  GROUP_UPDATE_TYPE,
  READ_RECEIPT_TYPE,
  isAppJsonEnvelope,
  isControlEnvelope,
  isGroupUpdateEnvelope,
} from './envelope';
export type { ConeEnvelope } from './envelope';
export {
  CONE_ENVELOPE_CONTENT_TYPE,
  createConeEnvelopeCodec,
  encodeConeEnvelope,
  isConeEnvelopeContentType,
} from './content-type';
export type { ConeContentTypeId, ConeEncodedContent } from './content-type';
export {
  createEncryptedPairingOffer,
  createHandshakeCode,
  decryptPeerOffer,
} from './pairing';
export {
  GROUP_INVITE_LINK_TTL_MS,
  GROUP_INVITE_TTL_MS,
  createEncryptedGroupDescriptor,
  createEncryptedJoinRequest,
  decryptGroupDescriptor,
  decryptJoinRequest,
  decryptJoinRequests,
} from './invites';
export type { GroupInviteDescriptor } from './invites';
export {
  RETENTION_PRESETS_MS,
  formatRetention,
  isExpiredMessage,
  messageExpiresAt,
  parseRetention,
} from './retention';
export { MemoryStore } from './store';
export { DEFAULT_RENDEZVOUS_URL, HttpRendezvousClient } from './rendezvous';
export type {
  ConeClient,
  ConeConsentState,
  ConeConversation,
  ConeGroupMember,
  ConeIdentity,
  ConsentFilter,
  ConeMessage,
  ConeStore,
  ConeStoreMetadata,
  ConeStoreSnapshot,
  Contact,
  ContactSource,
  ConversationKind,
  CreateConeClientOptions,
  CreateGroupInput,
  CreateGroupOptions,
  DerivedAccount,
  GroupInviteLink,
  GroupInviteResult,
  GroupJoinResult,
  GroupMemberLevel,
  HandshakeCode,
  IdentityRef,
  IdentityRefObject,
  IncomingMessage,
  MessageDeliveryStatus,
  MessageListOptions,
  MessageHandler,
  MessageRetention,
  PairingOffer,
  PairingResult,
  PendingGroupJoin,
  RendezvousClient,
  RendezvousRole,
  RendezvousStoredOffer,
  ResolvedIdentity,
  SaveContactInput,
  SecretKey,
  SendOptions,
  SentMessage,
  StoredMessage,
  OutboxEntry,
  MessageAcknowledgement,
  PendingMessageOptions,
  SyncResult,
  Unsubscribe,
  XmtpAdapter,
  XmtpEnv,
  XmtpSyncResult,
} from './types';
