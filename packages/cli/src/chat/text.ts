// ANSI styling and plain-text layout helpers for the chat TUI.

// Control Sequence Introducer: the prefix of every ANSI escape we emit.
export const CSI = '\x1b[';

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
  return `${CSI}7m${value}${CSI}0m`;
}

export function dim(value: string): string {
  return `${CSI}2m${value}${CSI}0m`;
}

export function bold(value: string): string {
  return `${CSI}1m${value}${CSI}0m`;
}

// Selection bar: amber-inverse, matching the PWA's CRT accent.
export function highlight(value: string): string {
  return `${CSI}38;5;214m${CSI}7m${value}${CSI}0m`;
}

// The single accent color — 256-color amber, the PWA's `--amber` in terminal
// terms, so both surfaces read as one product.
export function accent(value: string): string {
  return `${CSI}38;5;214m${value}${CSI}0m`;
}

// State chips (active tab, current mode): bold amber-inverse so the current
// state is unmistakable at a glance.
export function chip(value: string): string {
  return `${CSI}1;38;5;214;7m${value}${CSI}0m`;
}

export function danger(value: string): string {
  return `${CSI}31m${value}${CSI}0m`;
}

export function success(value: string): string {
  return `${CSI}32m${value}${CSI}0m`;
}

export function inputField(value: string): string {
  return `${CSI}30;47m${value}${CSI}0m`;
}

// Emphasize the characters a live filter matched. Restores with non-reset
// codes (24 = underline off, 39 = default foreground) instead of `0m`, so the
// mark can sit inside a dim span or the amber-inverse selection bar without
// wiping those styles for the rest of the line. On the selection bar itself
// pass colored:false — its foreground is already amber, so only the underline
// distinguishes the match.
export function matchMark(value: string, options: { colored?: boolean } = {}): string {
  return options.colored ?? true
    ? `${CSI}4;38;5;214m${value}${CSI}24;39m`
    : `${CSI}4m${value}${CSI}24m`;
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
  return `${output}${CSI}0m`;
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
