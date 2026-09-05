// Explicit network check for each native release artifact; excluded from bun test.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const binary = resolve(process.argv[2]!);
const directory = mkdtempSync(join(tmpdir(), 'cone-native-smoke-'));
const env = { ...process.env, PATH: '/usr/bin:/bin', CONE_HOME: directory, CONE_SECRET_KEY: '', XMTP_ENV: 'dev' };
const run = async (...args: string[]) => {
  const child = Bun.spawn([binary, ...args], { env, cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`Cone ${args[0]} exited ${exit}: ${stderr}`);
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); }
};
try {
  const initial = await run('init', '--env', 'dev');
  if ((await run('init', '--env', 'dev')).inboxId !== initial.inboxId) throw new Error('Reinitialization changed the identity');

  // Send request #1 immediately. It must survive XMTP startup.
  const child = Bun.spawn([binary, 'serve'], { env, cwd: directory, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"identity"}\n');
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`serve failed: ${stderr}`);
    const response = JSON.parse(stdout);
    if (response.id !== 1 || response.result.inboxId !== initial.inboxId) throw new Error('Immediate startup request was lost');
  } finally { clearTimeout(timer); child.kill(); }

  const mcp = new Client({ name: 'cone-release-test', version: '1' });
  const transport = new StdioClientTransport({ command: binary, args: ['mcp'], env, cwd: directory, stderr: 'pipe' });
  try {
    await mcp.connect(transport, { timeout: 60000 });
    const identity = await mcp.callTool({ name: 'cone_identity', arguments: {} });
    if ((identity.structuredContent as { inboxId?: string })?.inboxId !== initial.inboxId) throw new Error('MCP identity did not match the saved key');
    if ((await mcp.listTools()).tools.length !== 9) throw new Error('MCP tools missing');
  } finally { await mcp.close(); }
  console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch,
    identityPreserved: true, immediateStdioRequest: true, mcp: true, runtimeOnPath: false }));
} finally { rmSync(directory, { recursive: true, force: true }); }
