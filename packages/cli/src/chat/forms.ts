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

export function createPairCreateResultForm(code: string, expiresAt: string): ContactEditForm {
  return {
    activeField: 0,
    fields: [],
    kind: 'pair-create',
    resultLines: [
      code,
      `Code expires at ${formatTranscriptTime(expiresAt)} — the pairing itself is permanent.`,
      'Give this code to the other person or agent.',
      `CLI: cos pair ${code}`,
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
      { key: 'shareName', label: 'Offer them a name for you (optional)', value: '' },
      { key: 'saveAs', label: 'Save their name as (optional)', value: '' },
    ],
    kind: 'pair-join',
    submitLabel: 'Join',
    title: 'Join pairing code',
  };
}

export function formValue(form: ContactEditForm, key: string): string {
  return form.fields.find((field) => field.key === key)?.value.trim() ?? '';
}
