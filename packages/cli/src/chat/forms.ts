import { RETENTION_PRESETS_MS, formatRetention, formatTranscriptTime, type ConeConversation, type Contact } from '@cone/core';

import type { ContactEditForm } from './types';

export function createAddContactForm(): ContactEditForm {
  return {
    activeField: 0,
    fields: [
      { key: 'name', label: 'Name', value: '' },
      { key: 'identity', label: 'XMTP inbox ID or EVM address', value: '' },
    ],
    kind: 'add',
    title: 'Add contact',
  };
}

export function createRenameContactForm(contact: Contact): ContactEditForm {
  return {
    activeField: 0,
    fields: [{ key: 'name', label: 'New name', value: contact.name }],
    kind: 'rename',
    targetContactId: contact.contactId,
    title: `Rename ${contact.name}`,
  };
}

// Name (or re-name) the peer of a conversation you're already in — saves a
// local contact for that inbox so the chat shows a name instead of a raw ID.
export function createNamePeerForm(conversation: ConeConversation, prefillName: string): ContactEditForm {
  return {
    activeField: 0,
    fields: [{ key: 'name', label: 'Name', value: prefillName }],
    kind: 'name-peer',
    targetConversationId: conversation.conversationId,
    submitLabel: 'Save',
    title: `Name this chat`,
  };
}

export function createDeleteContactForm(contact: Contact): ContactEditForm {
  return {
    activeField: 0,
    fields: [{ key: 'confirm', label: 'Type DELETE to confirm', value: '' }],
    kind: 'delete',
    targetContactId: contact.contactId,
    title: `Delete ${contact.name}`,
  };
}

export function createDeleteConversationForm(conversation: ConeConversation): ContactEditForm {
  return {
    activeField: 0,
    fields: [{ key: 'confirm', label: `Type DELETE to remove ${conversation.title}`, value: '' }],
    kind: 'conversation-delete',
    submitLabel: 'Delete',
    targetConversationId: conversation.conversationId,
    title: `Delete chat ${conversation.title}`,
  };
}

// Disappearing-messages timer for the selected chat. The single field is
// prefilled with the current setting; Up/Down cycle the presets and free text
// ('45m', '6d') is accepted as a custom value. Applies to both sides via XMTP
// settings, and other surfaces display custom values as-is.
export function createTimerForm(conversation: ConeConversation): ContactEditForm {
  return {
    activeField: 0,
    fields: [{
      key: 'duration',
      label: `Disappear after (off, ${RETENTION_PRESETS_MS.map((durationMs) => formatRetention(durationMs)).join(', ')})`,
      value: formatRetention(conversation.retention?.durationMs ?? null),
    }],
    kind: 'timer',
    submitLabel: 'Set',
    targetConversationId: conversation.conversationId,
    title: `Disappearing messages — ${conversation.title}`,
  };
}

export function createNewMessageForm(): ContactEditForm {
  return {
    activeField: 0,
    fields: [
      { key: 'to', label: 'To', value: '' },
      { key: 'message', label: 'Message', value: '' },
    ],
    kind: 'message',
    submitLabel: 'Send',
    title: 'New message',
  };
}

// Minting a code immediately joins its room: pairing needs both sides
// waiting, so the code stays on screen while this side polls in the
// background (the same non-blocking pattern as group invites).
export function createPairCreateResultForm(code: string, expiresAt: string): ContactEditForm {
  return {
    activeField: 0,
    fields: [],
    kind: 'pair-create',
    pending: true,
    resultLines: [
      code,
      `Code expires at ${formatTranscriptTime(expiresAt)} — the pairing itself is permanent.`,
      'Give this code to the other person or agent.',
      `CLI: cone pair ${code}`,
    ],
    submitLabel: 'Done',
    title: 'Pairing code created',
  };
}

export function createPairJoinForm(): ContactEditForm {
  return {
    activeField: 0,
    fields: [
      { key: 'code', label: 'Handshake code', value: '' },
      { key: 'shareName', label: 'My display name (offered to them, optional)', value: '' },
      { key: 'saveAs', label: 'Save peer as (optional)', value: '' },
    ],
    kind: 'pair-join',
    submitLabel: 'Join',
    title: 'Join pairing code',
  };
}

// Synchronous group invite: the code stays on screen while the background
// invite waits for a join request. Single use, expires with the code.
export function createGroupInviteForm(conversation: ConeConversation, code: string, expiresAt: string): ContactEditForm {
  return {
    activeField: 0,
    fields: [],
    kind: 'group-invite',
    pending: true,
    resultLines: [
      code,
      `Code expires at ${formatTranscriptTime(expiresAt)} — single use.`,
      'Give this code to the person joining.',
      `CLI: cone group join ${code}`,
    ],
    returnTo: 'group-info',
    submitLabel: 'Done',
    targetConversationId: conversation.conversationId,
    title: `Invite to ${conversation.title}`,
  };
}

// Async invite link: no waiting — the token is a capability, and joiners are
// admitted by this account's next sync (the TUI's auto-sync covers it).
export function createGroupLinkResultForm(
  conversation: ConeConversation,
  link: { token: string; expiresAt: string; maxUses: number },
): ContactEditForm {
  return {
    activeField: 0,
    fields: [],
    kind: 'group-link',
    resultLines: [
      link.token,
      `Expires ${formatTranscriptTime(link.expiresAt)} — ${link.maxUses} use${link.maxUses === 1 ? '' : 's'}.`,
      'Anyone with the token can join; they are added when this account syncs.',
      `CLI: cone group join ${link.token}`,
    ],
    returnTo: 'group-info',
    submitLabel: 'Done',
    targetConversationId: conversation.conversationId,
    title: `Invite link — ${conversation.title}`,
  };
}

export function createGroupJoinForm(): ContactEditForm {
  return {
    activeField: 0,
    fields: [
      { key: 'code', label: 'Invite code', value: '' },
      { key: 'shareName', label: 'My display name (offered to them, optional)', value: '' },
    ],
    kind: 'group-join',
    submitLabel: 'Join',
    title: 'Join group by code',
  };
}

export function createGroupRenameForm(conversation: ConeConversation): ContactEditForm {
  return {
    activeField: 0,
    fields: [{ key: 'name', label: 'Group name (shared — every member sees it)', value: conversation.groupName ?? '' }],
    kind: 'group-rename',
    returnTo: 'group-info',
    submitLabel: 'Rename',
    targetConversationId: conversation.conversationId,
    title: `Rename group ${conversation.title}`,
  };
}

export function createGroupAddMemberForm(conversation: ConeConversation): ContactEditForm {
  return {
    activeField: 0,
    fields: [{ key: 'identity', label: 'Contact name, XMTP inbox ID, or EVM address', value: '' }],
    kind: 'group-add-member',
    returnTo: 'group-info',
    submitLabel: 'Add',
    targetConversationId: conversation.conversationId,
    title: `Add member to ${conversation.title}`,
  };
}

export function formValue(form: ContactEditForm, key: string): string {
  return form.fields.find((field) => field.key === key)?.value.trim() ?? '';
}
