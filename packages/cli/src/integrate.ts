import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import adapter from '../../../integrations/hermes/adapter.py' with { type: 'text' };
import entrypoint from '../../../integrations/hermes/__init__.py' with { type: 'text' };
import manifest from '../../../integrations/hermes/plugin.yaml' with { type: 'text' };

export async function integrateHermes(options: { binary?: string; hermes?: string; home?: string; name?: string; restart?: boolean } = {}): Promise<unknown> {
  const hermesHome = options.home ?? process.env.HERMES_HOME ?? join(homedir(), '.hermes');
  const hermes = options.hermes ?? Bun.which('hermes') ?? join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes');
  const binary = resolve(options.binary ?? (process.execPath.endsWith('/bun') ? join(homedir(), '.local', 'bin', 'cone') : process.execPath));
  if (!await Bun.file(binary).exists()) throw new Error(`Cone executable not found: ${binary}; build it or pass --binary`);
  if (!await Bun.file(hermes).exists()) throw new Error('Hermes CLI not found; pass --hermes with its executable path');
  const env = { ...process.env, HERMES_HOME: hermesHome };
  const run = async (args: string[]) => {
    const child = Bun.spawn([hermes, ...args], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`hermes ${args.slice(0, 2).join(' ')} failed: ${(stderr || stdout).trim()}`);
  };
  await run(['--version']);
  const pluginDir = join(hermesHome, 'plugins', 'cone-platform');
  mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries({ 'adapter.py': adapter, '__init__.py': entrypoint, 'plugin.yaml': manifest })) {
    const path = join(pluginDir, name);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  }
  // Use Hermes's supported configuration commands, including its own policy
  // checks. The installing agent never needs to edit protected config files.
  const extra = { binary, name: options.name ?? 'hermes',
    home: process.env.CONE_HOME ? resolve(process.env.CONE_HOME) : '',
    dm_policy: 'allowlist', group_policy: 'allowlist' };
  // Hermes config set accepts scalar values, not JSON objects. Top-level
  // platforms take precedence over legacy gateway.platforms settings.
  for (const [key, value] of Object.entries(extra)) {
    await run(['config', 'set', `platforms.cone.extra.${key}`, value]);
  }
  await run(['config', 'set', 'platforms.cone.enabled', 'true']);
  // Progress previews and partial token streams are local host activity, not
  // completed messages for a peer agent. Scope these defaults to Cone alone.
  for (const key of ['tool_progress', 'thinking_progress', 'interim_assistant_messages', 'streaming', 'long_running_notifications']) {
    await run(['config', 'set', `display.platforms.cone.${key}`, 'false']);
  }
  await run(['plugins', 'enable', 'cone-platform']);
  if (options.restart !== false) await run(['gateway', 'restart']);
  return { installed: true, pluginDir, binary, restarted: options.restart !== false,
    next: 'Verify an incoming message and automatic reply over XMTP.' };
}
