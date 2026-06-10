// Raw terminal input handled by the chat TUI, named once so handlers never
// match on bare escape strings.

export const KEY = {
  ctrlB: '\u0002',
  ctrlC: '\u0003',
  ctrlF: '\u0006',
  ctrlU: '\u0015',
  ctrlW: '\u0017',
  ctrlX: '\u0018',
  tab: '\t',
  esc: '\u001b',
  backspace: '\u007f',
  up: '\u001b[A',
  down: '\u001b[B',
  shiftTab: '\u001b[Z',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
} as const;

export function isEnter(input: string): boolean {
  return input === '\r' || input === '\n';
}

// Ctrl+1 / Ctrl+2 arrive differently per terminal: kitty keyboard protocol,
// modifyOtherKeys, legacy F-key forms, ESC-prefixed digits, or (for Ctrl+2)
// a NUL byte.
export const CHATS_PANE_SEQUENCES: readonly string[] = [
  '\u001b[49;5u',
  '\u001b[27;5;49~',
  '\u001b[1;5P',
  '\u001b1',
];
export const CONTACTS_PANE_SEQUENCES: readonly string[] = [
  '\u0000',
  '\u001b[50;5u',
  '\u001b[27;5;50~',
  '\u001b[1;5Q',
  '\u001b2',
];

export function isChatsShortcut(value: string, allowPlain = false): boolean {
  return CHATS_PANE_SEQUENCES.includes(value) || (allowPlain && value === '1');
}

export function isContactsShortcut(value: string, allowPlain = false): boolean {
  return CONTACTS_PANE_SEQUENCES.includes(value) || (allowPlain && value === '2');
}
