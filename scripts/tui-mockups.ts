#!/usr/bin/env bun
// ConeTUI redesign exploration — three complete chat-screen mockups, rendered
// as real terminal output. Run in a terminal ≥100 cols:
//
//   bun run scripts/tui-mockups.ts            # full color
//   NO_COLOR=1 bun run scripts/tui-mockups.ts # plain box-drawing
//
// Direction A — "Panels": the current two-pane layout, refined (rounded
//   borders, padded gutters, identity header, composed input box).
// Direction B — "Focus": droid-style single column; the chat list becomes an
//   overlay (like the PWA's mobile mode), transcript gets full width.
// Direction C — "Rail": dense messenger — narrow avatar rail, list column,
//   transcript. Closest to the PWA desktop layout.
//
// All three keep the exact hotkey vocabulary and modes; only render.ts
// changes. See SCRATCHPAD-TUI.md for the tradeoffs.

const WIDTH = 100;
const color = !process.env.NO_COLOR;

// The PWA's CRT palette, for cross-surface identity.
const amber = (text: string) => (color ? `[38;2;240;190;66m${text}[0m` : text);
const green = (text: string) => (color ? `[38;2;125;207;121m${text}[0m` : text);
const dim = (text: string) => (color ? `[38;2;128;128;120m${text}[0m` : text);
const bold = (text: string) => (color ? `[1m${text}[0m` : text);
const inverse = (text: string) => (color ? `[7m${text}[0m` : text);

const ANSI_PATTERN = /\[[0-9;]*m/gu;
const visible = (text: string) => text.replace(ANSI_PATTERN, '').length;

function padTo(text: string, width: number): string {
  const gap = width - visible(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

// ── Box-drawing helpers ─────────────────────────────────────────────────
function top(width: number, title = '', right = ''): string {
  const label = title ? `─ ${title} ` : '';
  const tail = right ? ` ${right} ─` : '';
  const middle = width - 2 - visible(label) - visible(tail);
  return `╭${label}${'─'.repeat(Math.max(0, middle))}${tail}╮`;
}

function bottom(width: number): string {
  return `╰${'─'.repeat(width - 2)}╯`;
}

function row(content: string, width: number): string {
  return `│ ${padTo(content, width - 4)} │`;
}

function joinPanes(left: string[], right: string[], gap = ' '): string[] {
  const height = Math.max(left.length, right.length);
  const leftWidth = Math.max(...left.map(visible));
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    lines.push(`${padTo(left[index] ?? '', leftWidth)}${gap}${right[index] ?? ''}`);
  }
  return lines;
}

// Right-align a suffix (read marker, meta) inside a panel row.
function spread(left: string, right: string, width: number): string {
  return `${left}${' '.repeat(Math.max(1, width - visible(left) - visible(right)))}${right}`;
}

function print(title: string, note: string, lines: string[]): void {
  console.log('');
  console.log(bold(amber(`═══ ${title} `)) + dim(note));
  console.log('');
  for (const line of lines) {
    const padded = padTo(line, WIDTH);
    console.log(visible(padded) > WIDTH ? `${padded}  ${dim(`⚠ ${visible(padded)}`)}` : padded);
  }
  console.log('');
}

// Shared fixture (mirrors the preview harness data).
const CHATS = [
  { name: 'Alice', time: '2m', preview: 'no rush, just want it in before EOD', unread: 2, active: true },
  { name: 'crew', time: '15m', preview: 'me: ship it', unread: 0, group: true },
  { name: 'Codex', time: '1h', preview: 'sync complete: 3 conversations, 41…', unread: 0 },
  { name: 'Bob', time: '3d', preview: 'gm', unread: 0 },
];

// ── Direction A — "Panels" ──────────────────────────────────────────────
function directionA(): string[] {
  const lines: string[] = [];
  lines.push(top(WIDTH, amber('Cone') + dim(' ·dev'), `${green('live')} ${dim('·')} ${dim('you 0x81…9f2')}`));
  lines.push(row(`${bold('1')} Chats   ${dim('2 Contacts')}${' '.repeat(52)}${amber('1 request')} ${dim('·')} ${dim('receipts on')}`, WIDTH));
  lines.push(bottom(WIDTH));

  const listWidth = 34;
  const threadWidth = WIDTH - listWidth - 1;
  const list: string[] = [top(listWidth, dim('chats'))];
  for (const chat of CHATS) {
    const marker = chat.active ? amber('▸ ') : '  ';
    const name = `${chat.active ? bold(chat.name) : chat.name}${chat.group ? dim(' ⚇') : ''}`;
    const badge = chat.unread ? amber(`●${chat.unread} `) : '';
    list.push(row(spread(`${marker}${name}`, `${badge}${dim(chat.time.padStart(3))}`, listWidth - 4), listWidth));
    list.push(row(`  ${dim(chat.preview.slice(0, 28))}`, listWidth));
  }
  list.push(row('', listWidth));
  list.push(row(dim('t requests (1)'), listWidth));
  list.push(bottom(listWidth));

  const thread: string[] = [top(threadWidth, bold('Alice'), `${dim('⌛1h ·')} ${dim('inbox …6789')}`)];
  thread.push(row(dim('· disappearing messages: 1h — both sides see this'), threadWidth));
  thread.push(row('', threadWidth));
  thread.push(row(`${dim('16:02')} ${amber('Alice')}  can you review the pairing PR before the demo?`, threadWidth));
  thread.push(row(spread(`${dim('16:04')} ${dim('me')}     on it — give me 10`, green('✓✓'), threadWidth - 4), threadWidth));
  thread.push(row(`${dim('16:19')} ${amber('Alice')}  no rush, just want it in before EOD`, threadWidth));
  thread.push(row('', threadWidth));
  thread.push(row('', threadWidth));
  thread.push(row('', threadWidth));
  thread.push(row('', threadWidth));
  thread.push(bottom(threadWidth));
  thread.push(top(threadWidth));
  thread.push(row(`${amber('›')} write to Alice…`, threadWidth));
  thread.push(bottom(threadWidth));

  lines.push(...joinPanes(list, thread));
  lines.push(padTo(` ${dim('j/k')} move ${dim('·')} ${dim('Enter')} talk ${dim('·')} ${dim('n')} new ${dim('·')} ${dim('e')} timer ${dim('·')} ${dim('c/p')} pair ${dim('·')} ${dim('g')} join group ${dim('·')} ${dim('?')} help ${dim('·')} ${dim('q')} quit`, WIDTH));
  return lines;
}

// ── Direction B — "Focus" ───────────────────────────────────────────────
function directionB(): string[] {
  const lines: string[] = [];
  lines.push(padTo(`  ${bold(amber('◍ Cone'))} ${dim('·dev')}${' '.repeat(60)}${green('live')} ${dim('· you 0x81…9f2')}`, WIDTH));
  lines.push(padTo(`  ${dim('chat')} ${bold('Alice')} ${dim('· ⌛1h · inbox …6789 · 4 chats (Tab to switch) · 1 request')}`, WIDTH));
  lines.push(padTo(`  ${dim('─'.repeat(WIDTH - 4))}`, WIDTH));
  lines.push(padTo('', WIDTH));
  lines.push(padTo(`  ${dim('16:02')}  ${amber('Alice')}`, WIDTH));
  lines.push(padTo(`         can you review the pairing PR before the demo?`, WIDTH));
  lines.push(padTo('', WIDTH));
  lines.push(padTo(`  ${dim('16:04')}  ${dim('me')}${' '.repeat(WIDTH - 15 - 2)}${green('✓✓')}`, WIDTH));
  lines.push(padTo(`         on it — give me 10`, WIDTH));
  lines.push(padTo('', WIDTH));
  lines.push(padTo(`  ${dim('16:19')}  ${amber('Alice')}`, WIDTH));
  lines.push(padTo(`         no rush, just want it in before EOD`, WIDTH));
  lines.push(padTo('', WIDTH));
  lines.push(padTo('', WIDTH));
  lines.push(padTo(`  ${top(WIDTH - 4)}`, WIDTH));
  lines.push(padTo(`  ${row(`${amber('›')} write to Alice…`, WIDTH - 4)}`, WIDTH));
  lines.push(padTo(`  ${bottom(WIDTH - 4)}`, WIDTH));
  lines.push(padTo(`  ${dim('Tab')} chats ${dim('·')} ${dim('n')} new ${dim('·')} ${dim('e')} timer ${dim('·')} ${dim('t')} requests ${dim('·')} ${dim('?')} help`, WIDTH));
  lines.push(padTo('', WIDTH));
  lines.push(padTo(`  ${dim('── Tab opens the switcher as an overlay ──')}`, WIDTH));
  const overlayWidth = 56;
  const overlay: string[] = [top(overlayWidth, dim('switch to'))];
  for (const chat of CHATS) {
    const marker = chat.active ? amber('▸ ') : '  ';
    const name = `${chat.active ? bold(chat.name) : chat.name}${chat.group ? dim(' ⚇') : ''}`;
    const badge = padTo(chat.unread ? amber(`●${chat.unread}`) : '', 3);
    overlay.push(row(`${marker}${padTo(name, 12)}${badge}${dim(chat.time.padStart(3))}  ${dim(chat.preview.slice(0, 26))}`, overlayWidth));
  }
  overlay.push(row(dim('/ filter · Enter open · Esc close'), overlayWidth));
  overlay.push(bottom(overlayWidth));
  for (const line of overlay) {
    lines.push(padTo(`${' '.repeat(21)}${line}`, WIDTH));
  }
  return lines;
}

// ── Direction C — "Rail" ────────────────────────────────────────────────
function directionC(): string[] {
  const lines: string[] = [];
  lines.push(inverse(padTo(` ${bold('Cone')} ·dev   1 Chats  2 Contacts  3 Pair  4 Backup  5 Settings${' '.repeat(17)}live · you 0x81…9f2 `, WIDTH)));

  const railWidth = 9;
  const listWidth = 30;
  const threadWidth = WIDTH - railWidth - listWidth - 2;
  const rail: string[] = [top(railWidth)];
  const initials = [['AL', true, 2], ['CR', false, 0], ['CO', false, 0], ['BO', false, 0]] as const;
  for (const [label, active, unread] of initials) {
    rail.push(row(spread(active ? amber(bold(label)) : dim(label), unread ? amber(`•${unread}`) : '  ', railWidth - 4), railWidth));
    rail.push(row('', railWidth));
  }
  rail.push(row(dim('+'), railWidth));
  rail.push(bottom(railWidth));

  const list: string[] = [top(listWidth, dim('chats'), dim('1 req'))];
  for (const chat of CHATS) {
    const marker = chat.active ? amber('▸') : ' ';
    list.push(row(spread(`${marker} ${chat.active ? bold(chat.name) : chat.name}`, dim(chat.time.padStart(3)), listWidth - 4), listWidth));
    list.push(row(`  ${dim(chat.preview.slice(0, 24))}`, listWidth));
  }
  list.push(bottom(listWidth));

  const thread: string[] = [top(threadWidth, bold('Alice'), dim('⌛1h'))];
  thread.push(row(`${dim('16:02')} ${amber('Alice')}  can you review the pairing PR?`, threadWidth));
  thread.push(row(spread(`${dim('16:04')} ${dim('me')}     on it — give me 10`, green('✓✓'), threadWidth - 4), threadWidth));
  thread.push(row(`${dim('16:19')} ${amber('Alice')}  no rush, before EOD is fine`, threadWidth));
  thread.push(row('', threadWidth));
  thread.push(row('', threadWidth));
  thread.push(row('', threadWidth));
  thread.push(row(dim('┄'.repeat(threadWidth - 4)), threadWidth));
  thread.push(row(`${amber('›')} write to Alice…`, threadWidth));
  thread.push(bottom(threadWidth));

  lines.push(...joinPanes(rail, joinPanes(list, thread)));
  lines.push(inverse(padTo(' j/k move | Enter talk | n new | e timer | c/p pair | ? help | q quit ', WIDTH)));
  return lines;
}

print('Direction A — Panels', '(refined two-pane; the safe evolution)', directionA());
print('Direction B — Focus', '(droid-style single column; list as overlay)', directionB());
print('Direction C — Rail', '(dense messenger; closest to PWA desktop)', directionC());
console.log(dim('  All three keep the existing hotkeys, modes, and state machine — only render.ts changes.'));
console.log('');
