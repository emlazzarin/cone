// The TUI layout kit: rounded-corner panels, column composition, and
// right-aligned metadata. render.ts builds every screen out of these; the
// droid-inspired look is layout discipline (borders, padding, one accent),
// not a framework. All helpers are ANSI-aware via stripAnsi.
import { accent, dim, pad, stripAnsi } from './text';

export interface BoxOptions {
  width: number;
  // Total height including the two border rows; rows are padded/truncated.
  height: number;
  title?: string;
  right?: string;
  // The focused pane gets an amber border; everything else recedes to dim.
  active?: boolean;
}

export function box(rows: string[], options: BoxOptions): string[] {
  const { width, height } = options;
  const paint = options.active ? accent : dim;
  const innerWidth = Math.max(0, width - 4);
  const innerHeight = Math.max(0, height - 2);

  const titleLabel = options.title ? `─ ${options.title} ` : '';
  const rightLabel = options.right ? ` ${options.right} ─` : '';
  const middle = Math.max(0, width - 2 - visibleWidth(titleLabel) - visibleWidth(rightLabel));
  const top = `${paint('╭')}${options.title ? `${paint('─ ')}${options.title}${paint(' ')}` : ''}${paint('─'.repeat(middle))}${options.right ? `${paint(' ')}${options.right}${paint(' ─')}` : ''}${paint('╮')}`;

  const lines: string[] = [top];
  for (let index = 0; index < innerHeight; index += 1) {
    lines.push(`${paint('│')} ${pad(rows[index] ?? '', innerWidth)} ${paint('│')}`);
  }
  lines.push(`${paint('╰')}${paint('─'.repeat(Math.max(0, width - 2)))}${paint('╯')}`);
  return lines;
}

// Right-align a suffix against a left segment within a width.
export function spread(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) {
    return pad(`${left} ${right}`, width);
  }
  return `${left}${' '.repeat(gap)}${right}`;
}

// Compose pre-sized panes side by side; shorter panes pad with emptiness.
export function columns(panes: string[][], widths: number[], gap = ' '): string[] {
  const height = Math.max(0, ...panes.map((pane) => pane.length));
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    lines.push(panes.map((pane, paneIndex) => pad(pane[index] ?? '', widths[paneIndex] ?? 0)).join(gap));
  }
  return lines;
}

// Pad or truncate a pane to an exact height.
export function fitRows(lines: string[], height: number): string[] {
  if (lines.length >= height) {
    return lines.slice(0, height);
  }
  return [...lines, ...Array.from({ length: height - lines.length }, () => '')];
}

export function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}
