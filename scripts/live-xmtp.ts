#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { generateSecretKey } from '@cone/core';

const root = resolve(import.meta.dir, '..');
const runId = new Date().toISOString().replaceAll(/[:.]/gu, '-');
const runDir = join(root, '.cone', 'live-runs', runId);
const rendezvousUrl = process.env.COS_RENDEZVOUS_URL ?? 'http://localhost:8787';
const cli = ['bun', 'run', 'packages/cli/src/bin.ts'];

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

const baseEnv = {
  ...process.env,
  COS_OUTPUT: 'json',
  COS_RENDEZVOUS_URL: rendezvousUrl,
  XMTP_ENV: process.env.XMTP_ENV ?? 'dev',
};

mkdirSync(runDir, { recursive: true });

let rendezvous: Bun.Subprocess | null = null;

try {
  if (!(await isRendezvousReady())) {
    rendezvous = Bun.spawn(['bun', 'run', 'dev:rendezvous'], {
      cwd: root,
      env: baseEnv,
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    });
    rendezvous.stdin.write('n\n');
    await waitForRendezvous();
  }

  const aliceSecret = generateSecretKey();
  const bobSecret = generateSecretKey();

  await assertCommand(['login', '--secret-stdin', '--remember'], { actor: 'alice', stdin: aliceSecret });
  await assertCommand(['login', '--secret-stdin', '--remember'], { actor: 'bob', stdin: bobSecret });

  const aliceIdentity = JSON.parse((await assertCommand(['whoami'], { actor: 'alice' })).stdout) as { inboxId: string };
  const bobIdentity = JSON.parse((await assertCommand(['whoami'], { actor: 'bob' })).stdout) as { inboxId: string };

  const code = JSON.parse((await assertCommand(['pair'])).stdout) as { code: string };
  await Promise.all([
    assertCommand(['pair', code.code, '--share-name', 'alice', '--save-as', 'bob'], { actor: 'alice' }),
    assertCommand(['pair', code.code, '--share-name', 'bob', '--save-as', 'alice'], { actor: 'bob' }),
  ]);

  const bobListen = runCommand(['listen', '--once', '--timeout-ms', '120000'], { actor: 'bob' });
  await sleep(5_000);
  const sentToBob = JSON.parse((await assertCommand(['send', '--to', 'bob', '--text', 'live alice to bob'], { actor: 'alice' })).stdout) as {
    messageId: string;
  };
  const bobReceived = parseJsonLine((await assertResult(await bobListen)).stdout) as { conversationId: string; messageId: string; senderInboxId: string; text: string };
  assertEqual(bobReceived.messageId, sentToBob.messageId, 'Bob received a different message id');
  assertEqual(bobReceived.senderInboxId, aliceIdentity.inboxId, 'Bob saw the wrong sender inbox');
  assertEqual(bobReceived.text, 'live alice to bob', 'Bob received the wrong text');

  const aliceListen = runCommand(['listen', '--once', '--timeout-ms', '120000'], { actor: 'alice' });
  await sleep(5_000);
  const sentToAlice = JSON.parse((await assertCommand(['send', '--to', 'alice', '--text', 'live bob to alice'], { actor: 'bob' })).stdout) as {
    messageId: string;
  };
  const aliceReceived = parseJsonLine((await assertResult(await aliceListen)).stdout) as { conversationId: string; messageId: string; senderInboxId: string; text: string };
  assertEqual(aliceReceived.messageId, sentToAlice.messageId, 'Alice received a different message id');
  assertEqual(aliceReceived.senderInboxId, bobIdentity.inboxId, 'Alice saw the wrong sender inbox');
  assertEqual(aliceReceived.text, 'live bob to alice', 'Alice received the wrong text');

  await assertCommand(['inbox', 'sync'], { actor: 'alice' });
  await assertCommand(['inbox', 'sync'], { actor: 'bob' });
  assertIncludes((await assertCommand(['inbox'], { actor: 'alice' })).stdout, 'bob', 'Alice inbox did not include Bob contact');
  assertIncludes((await assertCommand(['inbox'], { actor: 'bob' })).stdout, 'alice', 'Bob inbox did not include Alice contact');
  assertIncludes(
    (await assertCommand(['inbox', 'read', bobReceived.conversationId], { actor: 'bob' })).stdout,
    'live alice to bob',
    'Bob local read model did not include Alice message',
  );
  assertIncludes(
    (await assertCommand(['inbox', 'read', aliceReceived.conversationId], { actor: 'alice' })).stdout,
    'live bob to alice',
    'Alice local read model did not include Bob message',
  );

  console.log(JSON.stringify({
    alice: aliceIdentity.inboxId,
    bob: bobIdentity.inboxId,
    messages: [sentToBob.messageId, sentToAlice.messageId],
    ok: true,
    runDir,
  }, null, 2));
} finally {
  rendezvous?.kill();
}

async function runCommand(args: string[], options: { actor?: string; stdin?: string } = {}): Promise<CommandResult> {
  const proc = Bun.spawn([...cli, ...args], {
    cwd: root,
    env: commandEnv(options.actor),
    stderr: 'pipe',
    stdin: options.stdin ? 'pipe' : 'ignore',
    stdout: 'pipe',
  });
  if (options.stdin && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, stdout };
}

async function assertCommand(args: string[], options: { actor?: string; stdin?: string } = {}): Promise<CommandResult> {
  return assertResult(await runCommand(args, options));
}

function commandEnv(actor?: string): Record<string, string | undefined> {
  if (!actor) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    COS_HOME: join(runDir, actor),
  };
}

async function assertResult(result: CommandResult): Promise<CommandResult> {
  if (result.code !== 0) {
    throw new Error(`command failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

async function isRendezvousReady(): Promise<boolean> {
  try {
    const response = await fetch(rendezvousUrl);
    return response.status === 404 || response.ok;
  } catch {
    return false;
  }
}

async function waitForRendezvous(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await isRendezvousReady()) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`rendezvous service did not become ready at ${rendezvousUrl}`);
}

function parseJsonLine(output: string): unknown {
  const line = output.split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (!line) {
    throw new Error(`no JSON line in output:\n${output}`);
  }
  return JSON.parse(line);
}

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(actual: string, expected: string, message: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`${message}: expected output to include ${expected}\n${actual}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
