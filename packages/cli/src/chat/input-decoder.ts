import { CHATS_PANE_SEQUENCES, CONTACTS_PANE_SEQUENCES, KEY } from './keys';

const ESC_FLUSH_MS = 25;

// Multi-byte sequences the decoder must hold together when they arrive split
// across reads. Longest first so a longer sequence wins over its prefix.
const KNOWN_SEQUENCES = [
  ...CHATS_PANE_SEQUENCES,
  ...CONTACTS_PANE_SEQUENCES,
  KEY.pageUp,
  KEY.pageDown,
  KEY.shiftTab,
  KEY.up,
  KEY.down,
]
  .filter((sequence) => sequence.length > 1)
  .sort((a, b) => b.length - a.length);

export { ESC_FLUSH_MS };

export class InputDecoder {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): string[] {
    return this.drain(true);
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  private drain(flush: boolean): string[] {
    const keys: string[] = [];

    while (this.pending.length > 0) {
      const sequence = KNOWN_SEQUENCES.find((candidate) => this.pending.startsWith(candidate));
      if (sequence) {
        keys.push(sequence);
        this.pending = this.pending.slice(sequence.length);
        continue;
      }

      if (this.pending.startsWith(KEY.esc)) {
        const isPartialKnownSequence = KNOWN_SEQUENCES.some((candidate) => candidate.startsWith(this.pending));
        if (!flush && isPartialKnownSequence) {
          break;
        }
        keys.push(KEY.esc);
        this.pending = this.pending.slice(KEY.esc.length);
        continue;
      }

      const [key = ''] = Array.from(this.pending);
      keys.push(key);
      this.pending = this.pending.slice(key.length);
    }

    return keys;
  }
}
