import type { ConeConversation, Contact } from '@cone/core';

import type { ContactEditForm } from './types';

export function createAddContactForm(): ContactEditForm {
  return {
    activeField: 0,
    fields: [
      { key: 'name', label: 'Local display name', value: '' },
      { key: 'identity', label: 'Inbox ID or EVM address', value: '' },
    ],
    kind: 'add',
    title: 'Add contact',
  };
}

export function createRenameContactForm(contact: Contact): ContactEditForm {
  return {
    activeField: 0,
    fields: [{ key: 'name', label: 'Local display name', value: contact.name }],
    kind: 'rename',
    targetContactId: contact.contactId,
    title: `Rename ${contact.name}`,
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
      `Expires ${expiresAt}`,
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
      { key: 'shareName', label: 'Share name (optional)', value: '' },
      { key: 'saveAs', label: 'Save peer as (optional)', value: '' },
    ],
    kind: 'pair-join',
    submitLabel: 'Join',
    title: 'Join pairing code',
  };
}

export function formValue(form: ContactEditForm, key: string): string {
  return form.fields.find((field) => field.key === key)?.value.trim() ?? '';
}
