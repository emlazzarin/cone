import {
  formatIncomingMessageLine,
  formatSyncStatus,
  formatTranscriptTime,
  incomingMessageBody,
  messageBody,
} from '@cone/core';

export const ESC = '\x1b[';

export { formatIncomingMessageLine, formatSyncStatus, incomingMessageBody, messageBody };

export function formatTime(value: string): string {
  return formatTranscriptTime(value);
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

export function pad(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length >= width) {
    return truncateAnsi(value, width);
  }
  return `${value}${' '.repeat(width - plain.length)}`;
}

export function inverse(value: string): string {
  return `${ESC}7m${value}${ESC}0m`;
}

export function dim(value: string): string {
  return `${ESC}2m${value}${ESC}0m`;
}

export function highlight(value: string): string {
  return `${ESC}36m${ESC}7m${value}${ESC}0m`;
}

export function accent(value: string): string {
  return `${ESC}33m${value}${ESC}0m`;
}

export function danger(value: string): string {
  return `${ESC}31m${value}${ESC}0m`;
}

export function success(value: string): string {
  return `${ESC}32m${value}${ESC}0m`;
}

export function inputField(value: string): string {
  return `${ESC}30;47m${value}${ESC}0m`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '');
}

export function ellipsize(value: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function tailLine(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  return value.slice(Math.max(0, value.length - width + 1));
}

export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const words = rawLine.split(/(\s+)/u).filter((word) => word.length > 0);
    let current = '';
    for (const word of words) {
      if (/^\s+$/u.test(word)) {
        if (current && !current.endsWith(' ')) {
          current += ' ';
        }
        continue;
      }
      const pieces = breakLongWord(word, safeWidth);
      for (const piece of pieces) {
        if (!current) {
          current = piece;
        } else if (`${current}${piece}`.length <= safeWidth) {
          current += piece;
        } else {
          lines.push(current.trimEnd());
          current = piece;
        }
      }
    }
    lines.push(current.trimEnd());
  }
  return lines.length > 0 ? lines : [''];
}

export function deleteLastWord(value: string): string {
  return value.replace(/\s*\S+\s*$/u, '');
}

export function isPrintableInput(value: string): boolean {
  return /^[^\x00-\x1f\x7f]+$/u.test(value);
}

export function isChatsShortcut(value: string, allowPlain = false): boolean {
  return (
    value === '\u001b[49;5u' ||
    value === '\u001b[27;5;49~' ||
    value === '\u001b[1;5P' ||
    value === '\u001b1' ||
    (allowPlain && value === '1')
  );
}

export function isContactsShortcut(value: string, allowPlain = false): boolean {
  return (
    value === '\u0000' ||
    value === '\u001b[50;5u' ||
    value === '\u001b[27;5;50~' ||
    value === '\u001b[1;5Q' ||
    value === '\u001b2' ||
    (allowPlain && value === '2')
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateAnsi(value: string, width: number): string {
  let output = '';
  let visible = 0;
  for (let index = 0; index < value.length && visible < width; index += 1) {
    if (value[index] === '\x1b') {
      const end = value.slice(index).search(/[A-Za-z]/u);
      if (end >= 0) {
        output += value.slice(index, index + end + 1);
        index += end;
      }
      continue;
    }
    output += value[index];
    visible += 1;
  }
  return `${output}${ESC}0m`;
}

function breakLongWord(word: string, width: number): string[] {
  if (word.length <= width) {
    return [word];
  }
  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }
  return chunks;
}
