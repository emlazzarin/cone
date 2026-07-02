import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Where did an environment variable's value actually come from? Bun merges
// .env files into process.env before any code runs, so from inside the
// process a `.env` line and a shell export are indistinguishable. The only
// way to answer honestly is to re-read the same files Bun loads and compare
// values — `git config --show-origin` for env vars.
//
// Best-effort by design: a shell export carrying the *same* value as a .env
// line is reported as the .env line (they are literally indistinguishable,
// and the .env line is the actionable answer); a shell export carrying a
// *different* value is reported as the shell overriding that line.

// The files Bun auto-loads from the working directory, in descending
// precedence.
function candidateEnvFiles(): string[] {
  return ['.env.local', `.env.${process.env.NODE_ENV ?? 'development'}`, '.env'];
}

export function envVarLocation(name: string, dir: string = process.cwd()): string {
  const actual = process.env[name];
  for (const file of candidateEnvFiles()) {
    let entries: Map<string, { value: string; line: number }>;
    try {
      entries = parseEnvFile(join(dir, file));
    } catch {
      continue;
    }
    const entry = entries.get(name);
    if (!entry) {
      continue;
    }
    return entry.value === actual ? `${file}:${entry.line}` : `shell (overrides ${file}:${entry.line})`;
  }
  return 'shell';
}

function parseEnvFile(path: string): Map<string, { value: string; line: number }> {
  const entries = new Map<string, { value: string; line: number }>();
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[index]!);
    if (!match) {
      continue;
    }
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) {
        value = value.slice(0, comment).trim();
      }
    }
    entries.set(match[1]!, { value, line: index + 1 });
  }
  return entries;
}
