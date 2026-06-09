const ESC = '\u001b';
const ESC_FLUSH_MS = 25;

const KNOWN_SEQUENCES = [
  '\u001b[49;5u',
  '\u001b[50;5u',
  '\u001b[27;5;49~',
  '\u001b[27;5;50~',
  '\u001b[1;5P',
  '\u001b[1;5Q',
  '\u001b[5~',
  '\u001b[6~',
  '\u001b[Z',
  '\u001b[A',
  '\u001b[B',
  '\u001b1',
  '\u001b2',
].sort((a, b) => b.length - a.length);

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

      if (this.pending.startsWith(ESC)) {
        const isPartialKnownSequence = KNOWN_SEQUENCES.some((candidate) => candidate.startsWith(this.pending));
        if (!flush && isPartialKnownSequence) {
          break;
        }
        keys.push(ESC);
        this.pending = this.pending.slice(ESC.length);
        continue;
      }

      const [key = ''] = Array.from(this.pending);
      keys.push(key);
      this.pending = this.pending.slice(key.length);
    }

    return keys;
  }
}
