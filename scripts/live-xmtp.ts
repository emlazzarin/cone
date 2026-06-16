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

  // --- Groups: create, welcome consent policy, fan-out, request flow ---
  const carolSecret = generateSecretKey();
  await assertCommand(['login', '--secret-stdin', '--remember'], { actor: 'carol', stdin: carolSecret });
  const carolIdentity = JSON.parse((await assertCommand(['whoami'], { actor: 'carol' })).stdout) as { inboxId: string };

  // Alice creates a group with Bob (her contact) and Carol (a stranger to both).
  const group = JSON.parse((await assertCommand(
    ['group', 'create', '--name', 'Live Crew', '--member', 'bob', '--member', carolIdentity.inboxId],
    { actor: 'alice' },
  )).stdout) as { conversationId: string; kind: string };
  assertEqual(group.kind, 'group', 'created conversation is not a group');

  await sleep(5_000); // welcome propagation

  // Bob knows Alice (address-book contact) -> the toggle (default on) auto-allows on sync.
  await assertCommand(['inbox', 'sync'], { actor: 'bob' });
  const bobInbox = JSON.parse((await assertCommand(['inbox'], { actor: 'bob' })).stdout) as {
    conversations: Array<{ conversationId: string; kind?: string; consentState: string }>;
  };
  const bobGroup = bobInbox.conversations.find((conversation) => conversation.conversationId === group.conversationId);
  if (!bobGroup) {
    throw new Error('Bob did not auto-allow the group added by his contact Alice');
  }
  assertEqual(bobGroup.kind ?? 'missing', 'group', 'Bob stored the group as a non-group conversation');

  // Carol does not know Alice -> the group lands in Requests until accepted.
  await assertCommand(['inbox', 'sync'], { actor: 'carol' });
  const carolRequests = JSON.parse((await assertCommand(['requests'], { actor: 'carol' })).stdout) as Array<{ conversationId: string }>;
  if (!carolRequests.some((conversation) => conversation.conversationId === group.conversationId)) {
    throw new Error('Carol did not see the unknown-adder group as a Request');
  }
  await assertCommand(['requests', 'accept', group.conversationId], { actor: 'carol' });

  // Fan-out: Alice sends once; Bob and Carol both receive it on live streams.
  const bobGroupListen = runCommand(['listen', '--once', '--timeout-ms', '120000'], { actor: 'bob' });
  const carolGroupListen = runCommand(['listen', '--once', '--timeout-ms', '120000'], { actor: 'carol' });
  await sleep(5_000);
  const groupSent = JSON.parse((await assertCommand(
    ['group', 'send', group.conversationId, '--text', 'live group hello'],
    { actor: 'alice' },
  )).stdout) as { messageId: string };
  const bobGroupMessage = parseJsonLine((await assertResult(await bobGroupListen)).stdout) as {
    messageId: string;
    conversationKind?: string;
    senderInboxId: string;
  };
  const carolGroupMessage = parseJsonLine((await assertResult(await carolGroupListen)).stdout) as { messageId: string };
  assertEqual(bobGroupMessage.messageId, groupSent.messageId, 'Bob received a different group message id');
  assertEqual(carolGroupMessage.messageId, groupSent.messageId, 'Carol received a different group message id');
  assertEqual(bobGroupMessage.senderInboxId, aliceIdentity.inboxId, 'Bob saw the wrong group sender');
  assertEqual(bobGroupMessage.conversationKind ?? 'missing', 'group', 'group message was not tagged with its kind');

  // Membership and roles: three members, creator is super admin.
  const groupInfo = JSON.parse((await assertCommand(['group', 'info', group.conversationId], { actor: 'alice' })).stdout) as {
    members: Array<{ inboxId: string; level: string }>;
  };
  if (groupInfo.members.length !== 3) {
    throw new Error(`expected 3 group members, got ${groupInfo.members.length}`);
  }
  assertEqual(
    groupInfo.members.find((member) => member.inboxId === aliceIdentity.inboxId)?.level ?? 'missing',
    'superAdmin',
    'group creator is not super admin',
  );

  console.log(JSON.stringify({
    alice: aliceIdentity.inboxId,
    bob: bobIdentity.inboxId,
    carol: carolIdentity.inboxId,
    group: group.conversationId,
    messages: [sentToBob.messageId, sentToAlice.messageId, groupSent.messageId],
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
