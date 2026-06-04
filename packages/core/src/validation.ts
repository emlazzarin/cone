import type { Contact, IdentityRef, SaveContactInput } from './types';

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/u.test(value);
}

export function isLikelyInboxId(value: string): boolean {
  return value.length >= 12 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

export function normalizeContactName(name: string): string {
  const normalized = name.trim().replaceAll(/\s+/gu, ' ');
  if (normalized.length === 0) {
    throw new Error('contact name is required');
  }
  if (normalized.length > 80) {
    throw new Error('contact name must be 80 characters or fewer');
  }
  return normalized;
}

export function normalizeIdentityRef(ref: IdentityRef): IdentityRef {
  if (typeof ref !== 'string') {
    return ref;
  }

  const value = ref.trim();
  if (value.length === 0) {
    throw new Error('identity reference is required');
  }
  if (isEvmAddress(value)) {
    return { address: value };
  }
  return { contactName: value };
}

export function assertValidContactInput(input: SaveContactInput): void {
  normalizeContactName(input.name);
  if (!input.inboxId && !input.address) {
    throw new Error('contact requires an inbox ID or address');
  }
  if (input.address && !isEvmAddress(input.address)) {
    throw new Error('contact address must be an EVM address');
  }
}

export function contactMatchesName(contact: Contact, name: string): boolean {
  return contact.name.toLocaleLowerCase() === normalizeContactName(name).toLocaleLowerCase();
}
