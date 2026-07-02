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
export {
  errorMessage,
  formatConnectionStatus,
  formatConversationPreview,
  formatMessageLine,
  formatSyncStatus,
  formatTranscriptTime,
  formatGroupUpdate,
  groupHistoryNotice,
  isAllowedConversation,
  isDeniedConversation,
  isGroupUpdateMessage,
  isReadReceipt,
  isRequestConversation,
  isVisibleChatMessage,
  laterIso,
  latestInboundAt,
  latestReadOutboundId,
  matchesPendingSend,
  messageBody,
  normalizeDeliveryStatus,
  relativeTime,
} from './display';
export type { ConeConnectionStatus } from './display';
export {
  GROUP_UPDATE_TYPE,
  READ_RECEIPT_TYPE,
  isGroupUpdateEnvelope,
} from './envelope';
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
export { HttpRendezvousClient } from './rendezvous';
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
  SentMessage,
  StoredMessage,
  SyncResult,
  Unsubscribe,
  XmtpAdapter,
  XmtpEnv,
  XmtpSyncResult,
} from './types';
