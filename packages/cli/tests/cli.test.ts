import { describe, expect, test } from 'bun:test';

import { generateSecretKey, type ConeClient, type ConeConsentState, type ConeConversation, type ConeGroupMember, type ConeIdentity, type ConeMessage, type Contact, type IncomingMessage, type MessageHandler, type SecretKey, type SentMessage, type SyncResult, type Unsubscribe, type XmtpEnv } from '@cone/core';

import { runCli, type CliIo } from '../src/index';

describe('CLI', () => {
  test('keygen prints a parseable secret', async () => {
    const io = makeIo();

    expect(await runCli(['keygen'], io)).toBe(0);
    expect(io.out[0]?.startsWith('cone_sk_v1_')).toBe(true);
  });

  test('login reads a single prompted secret without requiring stdin EOF', async () => {
    const secret = generateSecretKey();
    const io = makeIo('', { secretLine: secret });

    expect(await runCli(['login'], io)).toBe(0);

    expect(io.prompts).toEqual(['Paste SECRET_KEY: ']);
    expect(JSON.parse(io.out.join(''))).toEqual({ ok: true, remembered: false });
  });

  test('login --secret-stdin warns when used from an interactive terminal', async () => {
    const secret = generateSecretKey();
    const io = makeIo(secret, { isStdinTty: true });

    expect(await runCli(['login', '--secret-stdin'], io)).toBe(0);

    expect(io.err.join('')).toContain('press Ctrl-D');
    expect(io.err.join('')).toContain('cone login --remember');
  });

  test('send command resolves client from stdin secret and sends text', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    let receivedOptions: { env?: XmtpEnv } | undefined;

    const exitCode = await runCli(
      ['send', '--secret-stdin', '--to', 'Alice', '--text', 'hello'],
      io,
      {
        createClient: async (_secret: SecretKey, options?: { env?: XmtpEnv }) => {
          receivedOptions = options;
          return client;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(client.sent).toEqual([{ to: 'Alice', text: 'hello' }]);
    expect(receivedOptions).toEqual({ env: undefined });
  });

  test('contacts commands list and add contacts through the client', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(
      await runCli(
        ['contacts', 'add', '--secret-stdin', '--name', 'Alice', '--identity', '0x1111111111111111111111111111111111111111'],
        io,
        { createClient: async () => client },
      ),
    ).toBe(0);

    expect(client.contacts[0]?.name).toBe('Alice');
  });

  test('config prints resolved values with provenance, without unlocking an account', async () => {
    const KEYS = ['CONE_HOME', 'XMTP_ENV', 'CONE_RENDEZVOUS_URL', 'CONE_SECRET_KEY', 'CONE_OUTPUT'] as const;
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    const noClient = { createClient: async (): Promise<ConeClient> => {
      throw new Error('config must not unlock an account');
    } };
    try {
      for (const key of KEYS) {
        delete process.env[key];
      }

      // Bare environment: every value is the compiled default.
      const io = makeIo();
      expect(await runCli(['config'], io, noClient)).toBe(0);
      const bare = JSON.parse(io.out.join('')) as Record<string, { value?: unknown; source: string; via?: string }>;
      expect(bare.xmtpEnv).toEqual({ value: 'production', source: 'default' });
      expect(bare.rendezvousUrl).toEqual({ value: 'http://localhost:8787', source: 'default' });
      expect(bare.statePath?.source).toBe('default');
      expect(bare.configPath?.source).toBe('default');
      // The secret itself is never printed, only where one would come from.
      expect(io.out.join('')).not.toContain('cone_sk_v1_');

      // Overridden environment: values and sources both reflect it.
      const home = `/tmp/cone-config-test-${crypto.randomUUID()}`;
      process.env.CONE_HOME = home;
      process.env.XMTP_ENV = 'dev';
      process.env.CONE_RENDEZVOUS_URL = 'https://rendezvous.example';
      const overriddenIo = makeIo();
      expect(await runCli(['config'], overriddenIo, noClient)).toBe(0);
      const overridden = JSON.parse(overriddenIo.out.join('')) as Record<string, { value?: unknown; source: string; via?: string; location?: string }>;
      // Environment-sourced entries name the variable that supplied them and
      // pinpoint where it was set (.env line or shell — the exact string
      // depends on this machine's .env, so only its presence is asserted).
      expect(overridden.xmtpEnv).toMatchObject({ value: 'dev', source: 'environment', via: 'XMTP_ENV' });
      expect(overridden.statePath).toMatchObject({ value: `${home}/state.sqlite`, source: 'environment', via: 'CONE_HOME' });
      expect(overridden.configPath).toMatchObject({ value: `${home}/config.json`, source: 'environment', via: 'CONE_HOME' });
      expect(overridden.rendezvousUrl).toMatchObject({ value: 'https://rendezvous.example', source: 'environment', via: 'CONE_RENDEZVOUS_URL' });
      for (const entry of [overridden.xmtpEnv, overridden.statePath, overridden.configPath, overridden.rendezvousUrl]) {
        expect(typeof entry?.location).toBe('string');
      }
      expect(overridden.secretKey).toEqual({ source: 'none' });
      expect(overridden.readReceipts).toEqual({ value: true, source: 'default' });
      expect(overridden.groupAutoAllow).toEqual({ value: true, source: 'default' });
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  test('pair --print mints a code without unlocking an account', async () => {
    const io = makeIo(generateSecretKey());

    expect(await runCli(['pair', '--print'], io, { createClient: async () => {
      throw new Error('client should not be created');
    } })).toBe(0);

    const output = JSON.parse(io.out.join('')) as { code?: string };
    expect(output.code).toContain('-');
  });

  test('bare pair mints a code and immediately waits on it', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['pair', '--secret-stdin', '--plain'], io, { createClient: async () => client })).toBe(0);

    // Both the printed code and the join used the same fresh code.
    const output = io.out.join('');
    const minted = output.match(/Handshake code: (\S+)/)?.[1] ?? '';
    expect(minted).toBeTruthy();
    expect(output).toContain('waiting for them');
    expect(client.pairRequests).toEqual([{ code: minted, proposedName: undefined }]);
    expect(output).toContain('Paired with Dana');
  });

  test('pair with a code does not send a peer-visible name implicitly', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(
      await runCli(
        ['pair', 'shared-code', '--secret-stdin'],
        io,
        { createClient: async () => client },
      ),
    ).toBe(0);

    expect(client.pairRequests[0]).toEqual({ code: 'shared-code', proposedName: undefined });
    const output = JSON.parse(io.out.join('')) as { next?: { send?: string }; contact?: { name?: string } };
    expect(output.contact?.name).toBe('Dana');
    expect(output.next?.send).toBe('cone send --to "Dana" --text "hello"');
  });

  test('pair with a code supports explicit share and local contact names', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(
      await runCli(
        ['pair', 'shared-code', '--secret-stdin', '--share-name', 'Charlie CLI', '--save-as', 'Dana Laptop'],
        io,
        { createClient: async () => client },
      ),
    ).toBe(0);

    expect(client.pairRequests[0]).toEqual({ code: 'shared-code', proposedName: 'Charlie CLI' });
    const output = JSON.parse(io.out.join('')) as { next?: { send?: string }; contact?: { name?: string } };
    expect(output.contact?.name).toBe('Dana Laptop');
    expect(output.next?.send).toBe('cone send --to "Dana Laptop" --text "hello"');
  });

  test('old pair subcommands point to the simplified syntax', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['pair', 'join', 'shared-code', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('usage: cone pair [code]');
  });

  test('listen --once waits for one message before exiting', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    const exitPromise = runCli(
      ['listen', '--secret-stdin', '--once', '--timeout-ms', '1000'],
      io,
      { createClient: async () => client },
    );

    await client.waitForHandler();
    await client.emit({
      conversationId: 'dm-cli',
      conversationKind: 'dm',
      messageId: 'msg-cli-inbound',
      raw: {},
      senderInboxId: 'inbox-alice',
      sentAt: new Date().toISOString(),
      text: 'hello from alice',
    });

    expect(await exitPromise).toBe(0);
    expect(io.out.join('')).toContain('hello from alice');
    expect(client.unsubscribed).toBe(true);
  });

  test('send --json rides sendJson with replyTo and idempotency options', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(
      ['send', '--secret-stdin', '--to', 'Alice', '--data', '{"kind":"quote","amount":5}', '--reply-to', 'msg-1', '--idempotency-key', 'tx-9'],
      io,
      { createClient: async () => client },
    )).toBe(0);

    expect(client.jsonSends).toEqual([{ to: 'Alice', value: { kind: 'quote', amount: 5 }, replyTo: 'msg-1', idempotencyKey: 'tx-9' }]);
    expect(client.sent).toEqual([]);
  });

  test('send rejects text+json together, bad JSON, and reply-to without json', async () => {
    const client = new MockClient();

    const both = makeIo(generateSecretKey());
    expect(await runCli(['send', '--secret-stdin', '--to', 'Alice', '--text', 'hi', '--data', '{}'], both, { createClient: async () => client })).toBe(1);
    expect(JSON.parse(both.err.join('')).error.code).toBe('USAGE');

    const badJson = makeIo(generateSecretKey());
    expect(await runCli(['send', '--secret-stdin', '--to', 'Alice', '--data', '{nope'], badJson, { createClient: async () => client })).toBe(1);
    expect(JSON.parse(badJson.err.join('')).error.code).toBe('USAGE');

    const replyText = makeIo(generateSecretKey());
    expect(await runCli(['send', '--secret-stdin', '--to', 'Alice', '--text', 'hi', '--reply-to', 'msg-1'], replyText, { createClient: async () => client })).toBe(1);
    expect(JSON.parse(replyText.err.join('')).error.code).toBe('USAGE');
  });

  test('messages reads pending mail without acknowledgement and exit-codes nothing-new', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.pollResult = {
      messages: [{
        conversationId: 'dm-cli', direction: 'inbound', kind: 'text', messageId: 'poll-1',
        senderInboxId: 'inbox-alice', sentAt: '2026-01-01T10:00:00.000Z', text: 'while you slept',
      }],
      cursor: 'cursor-2',
    };

    expect(await runCli(['messages', '--secret-stdin', '--cursor-name', 'agent-main'], io, { createClient: async () => client })).toBe(0);
    expect(client.synced).toBe(true);
    expect(client.receiveRequests).toEqual([{ consumer: 'agent-main', limit: 50, waitMs: 0 }]);
    expect(client.acknowledged).toEqual([]);
    const output = JSON.parse(io.out.join('')) as { cursor: string; messages: Array<{ messageId: string }> };
    expect(output.cursor).toBeUndefined();
    expect(output.messages[0]?.messageId).toBe('poll-1');

    const empty = makeIo(generateSecretKey());
    const quietClient = new MockClient();
    expect(await runCli(['messages', '--secret-stdin', '--peek'], empty, { createClient: async () => quietClient })).toBe(3);
    expect(quietClient.acknowledged).toEqual([]);
  });

  test('a failed sync is an error, never \'nothing new\'', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.failSync = true;

    expect(await runCli(['messages', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(JSON.parse(io.err.join('')).error.code).toBe('SYNC_FAILED');
  });

  test('a garbage --timeout-ms fails fast as USAGE instead of hanging', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['wait', '--secret-stdin', '--timeout-ms', 'nope'], io, { createClient: async () => client })).toBe(1);
    expect(JSON.parse(io.err.join('')).error.code).toBe('USAGE');
  });

  test('listen --once timeout is nothing-new (exit 3), matching messages/wait', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['listen', '--secret-stdin', '--once', '--timeout-ms', '60'], io, { createClient: async () => client })).toBe(3);
    expect(JSON.parse(io.out.join('')).timedOut).toBe(true);
  });

  test('wait drains missed messages without blocking when the poll has mail', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.pollResult = {
      messages: [{
        conversationId: 'dm-cli', direction: 'inbound', kind: 'text', messageId: 'missed-1',
        senderInboxId: 'inbox-alice', sentAt: '2026-01-01T10:00:00.000Z', text: 'missed while asleep',
      }],
      cursor: 'cursor-3',
    };

    expect(await runCli(['wait', '--secret-stdin', '--timeout-ms', '5000'], io, { createClient: async () => client })).toBe(0);
    expect(client.synced).toBe(true);
    expect(io.out.join('')).toContain('missed-1');
  });

  test('wait times out with the nothing-new exit code', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['wait', '--secret-stdin', '--timeout-ms', '60'], io, { createClient: async () => client })).toBe(3);
    expect(client.unsubscribed).toBe(true);
    expect(JSON.parse(io.out.join('')).timedOut).toBe(true);
  });

  test('doctor reports structured checks and fails without a secret', async () => {
    const previous = {
      home: process.env.CONE_HOME,
      secret: process.env.CONE_SECRET_KEY,
      rendezvous: process.env.CONE_RENDEZVOUS_URL,
    };
    process.env.CONE_HOME = `/tmp/cone-doctor-${Date.now()}`;
    process.env.CONE_RENDEZVOUS_URL = 'http://127.0.0.1:1'; // nothing listens here
    delete process.env.CONE_SECRET_KEY;
    try {
      const io = makeIo();
      expect(await runCli(['doctor'], io)).toBe(1);
      const report = JSON.parse(io.out.join('')) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
      expect(report.ok).toBe(false);
      const byName = Object.fromEntries(report.checks.map((check) => [check.name, check.ok]));
      expect(byName.secret).toBe(false);
      expect(byName['state-db']).toBe(true);
      expect(byName.rendezvous).toBeUndefined();
      expect(byName.xmtp).toBe(false);
    } finally {
      for (const [key, value] of [
        ['CONE_HOME', previous.home],
        ['CONE_SECRET_KEY', previous.secret],
        ['CONE_RENDEZVOUS_URL', previous.rendezvous],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test.each(['listen', 'messages', 'wait'])('%s defaults to explicit-accept for group adds; the flag opts in', async (command) => {
    const strictIo = makeIo(generateSecretKey());
    const strictClient = new MockClient();
    let strictOptions: { autoAllowGroupsFromContacts?: boolean } | undefined;
    const strictExit = runCli([command, '--secret-stdin', '--once', '--timeout-ms', '50'], strictIo, {
      createClient: async (_secret, options) => {
        strictOptions = options;
        return strictClient;
      },
    });
    await strictExit;
    expect(strictOptions?.autoAllowGroupsFromContacts).toBe(false);

    const optInIo = makeIo(generateSecretKey());
    const optInClient = new MockClient();
    let optInOptions: { autoAllowGroupsFromContacts?: boolean } | undefined;
    await runCli([command, '--secret-stdin', '--once', '--timeout-ms', '50', '--auto-accept-groups-from-contacts'], optInIo, {
      createClient: async (_secret, options) => {
        optInOptions = options;
        return optInClient;
      },
    });
    expect(optInOptions?.autoAllowGroupsFromContacts).toBe(true);
  });

  test('listen enriches group messages with the sender contact and group name', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.contacts = [{
      contactId: 'contact-alice',
      name: 'Alice',
      inboxId: 'inbox-alice',
      source: 'paired',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    client.conversations = [
      { conversationId: 'group-crew', kind: 'group', title: 'Crew', groupName: 'Crew', consentState: 'allowed' },
    ];

    const exitPromise = runCli(
      ['listen', '--secret-stdin', '--once', '--timeout-ms', '1000'],
      io,
      { createClient: async () => client },
    );
    await client.waitForHandler();
    await client.emit({
      conversationId: 'group-crew',
      conversationKind: 'group',
      messageId: 'msg-group',
      raw: {},
      senderInboxId: 'inbox-alice',
      sentAt: new Date().toISOString(),
      text: 'hello crew',
    });

    expect(await exitPromise).toBe(0);
    const line = JSON.parse(io.out.find((entry) => entry.includes('msg-group')) ?? '{}') as Record<string, unknown>;
    expect(line.senderName).toBe('Alice');
    expect(line.groupName).toBe('Crew');
    expect(line.conversationKind).toBe('group');
  });

  test('inbox commands sync and read through the local read model', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [{
      conversationId: 'dm-cli',
      contactId: 'contact-alice',
      kind: 'dm' as const, peerInboxId: 'inbox-alice', consentState: 'allowed',
      title: 'Alice',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    client.messages = [{
      conversationId: 'dm-cli',
      direction: 'inbound',
      kind: 'text',
      messageId: 'msg-cli',
      senderInboxId: 'inbox-alice',
      sentAt: '2026-01-01T00:00:00.000Z',
      text: 'hello',
    }];

    expect(await runCli(['inbox', 'sync', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.synced).toBe(true);
    expect(await runCli(['inbox', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(await runCli(['inbox', 'read', '--secret-stdin', 'Alice'], io, { createClient: async () => client })).toBe(0);

    const output = io.out.join('\n');
    expect(output).toContain('Alice');
    expect(output).toContain('hello');
  });

  test('chat requires an interactive terminal unless plain log is requested', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['chat', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('requires an interactive TTY');
  });

  test('inbox list hides requests and points to cone requests', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-allowed', kind: 'dm' as const, peerInboxId: 'inbox-allowed', title: 'Allowed', consentState: 'allowed' },
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['inbox', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('Allowed');
    expect(output).not.toContain('inbox-stranger');
    expect(output).toContain('1 request');
  });

  test('requests list shows only unknown senders', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-allowed', kind: 'dm' as const, peerInboxId: 'inbox-allowed', title: 'Allowed', consentState: 'allowed' },
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('inbox-stranger');
    expect(output).not.toContain('Allowed');
  });

  test('requests accept marks the peer allowed and can save a contact', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', 'accept', 'dm-req', '--save-as', 'Stranger', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls).toContainEqual({ to: 'inbox-stranger', state: 'allowed' });
    expect(client.conversations.find((c) => c.conversationId === 'dm-req')?.consentState).toBe('allowed');
    expect(client.contacts.some((contact) => contact.name === 'Stranger' && contact.inboxId === 'inbox-stranger')).toBe(true);
  });

  test('requests block denies the peer inbox', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-req', kind: 'dm' as const, peerInboxId: 'inbox-stranger', title: 'inbox-stranger', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', 'block', 'inbox-stranger', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls.at(-1)).toEqual({ to: 'inbox-stranger', state: 'denied' });
    expect(client.conversations.find((c) => c.conversationId === 'dm-req')?.consentState).toBe('denied');
  });

  test('group create resolves members and reports the new group', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(
      ['group', 'create', '--secret-stdin', '--member', 'Alice', '--member', 'inbox-bob', '--name', 'Crew', '--locked'],
      io,
      { createClient: async () => client },
    )).toBe(0);

    expect(client.groupCreates[0]).toEqual({ name: 'Crew', members: ['Alice', 'inbox-bob'], locked: true });
    const output = JSON.parse(io.out.join('')) as { kind?: string; title?: string };
    expect(output.kind).toBe('group');
    expect(output.title).toBe('Crew');
  });

  test('group create requires at least one member', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['group', 'create', '--secret-stdin', '--name', 'Crew'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('usage: cone group create');
  });

  test('group info, add, send, and leave resolve a group by name', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'group-crew', kind: 'group', title: 'Crew', groupName: 'Crew', consentState: 'allowed' },
      { conversationId: 'dm-alice', kind: 'dm', peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];
    client.groupMembers = [
      { inboxId: 'inbox-cli', level: 'superAdmin', consentState: 'allowed' },
      { inboxId: 'inbox-bob', level: 'member', consentState: 'allowed' },
    ];

    expect(await runCli(['group', 'info', 'Crew', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(io.out.join('')).toContain('inbox-cli [superAdmin]');

    expect(await runCli(['group', 'add', 'Crew', '--member', 'inbox-dana', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupMemberAdds).toEqual([{ conversationId: 'group-crew', members: ['inbox-dana'] }]);

    expect(await runCli(['group', 'send', 'Crew', '--text', 'hello crew', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.sentToConversation).toEqual([{ conversationId: 'group-crew', text: 'hello crew' }]);

    expect(await runCli(['group', 'leave', 'Crew', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.leftGroups).toEqual(['group-crew']);
  });

  test('group rename, describe, remove, promote, and demote route through the client', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'group-crew', kind: 'group', title: 'Crew', groupName: 'Crew', consentState: 'allowed' },
    ];

    expect(await runCli(['group', 'rename', 'Crew', '--name', 'New Crew', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupRenames).toEqual([{ conversationId: 'group-crew', name: 'New Crew' }]);

    // The rename took effect locally — the new name resolves the group now.
    expect(await runCli(['group', 'describe', 'New Crew', '--text', 'the crew', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupDescriptions).toEqual([{ conversationId: 'group-crew', description: 'the crew' }]);

    expect(await runCli(['group', 'remove', 'group-crew', '--member', 'inbox-troll', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupMemberRemovals).toEqual([{ conversationId: 'group-crew', members: ['inbox-troll'] }]);

    expect(await runCli(['group', 'promote', 'group-crew', '--member', 'inbox-bob', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupLevelChanges.at(-1)).toEqual({ conversationId: 'group-crew', member: 'inbox-bob', level: 'admin' });

    expect(await runCli(['group', 'promote', 'group-crew', '--member', 'inbox-bob', '--super', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupLevelChanges.at(-1)).toEqual({ conversationId: 'group-crew', member: 'inbox-bob', level: 'superAdmin' });

    expect(await runCli(['group', 'demote', 'group-crew', '--member', 'inbox-bob', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupLevelChanges.at(-1)).toEqual({ conversationId: 'group-crew', member: 'inbox-bob', level: 'member' });
  });

  test('group invite mints a code, waits, and reports the joiner', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'group-crew', kind: 'group', title: 'Crew', groupName: 'Crew', consentState: 'allowed' },
    ];

    expect(await runCli(['group', 'invite', 'Crew', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('Invite code for Crew: anchor-beacon-cedar-drift-ember');
    expect(output).toContain('Added Joiner (inbox-joiner) to Crew.');
    expect(output).toContain('cone contacts add --name "Joiner" --identity inbox-joiner');
    expect(client.groupInvites).toEqual([{ code: 'anchor-beacon-cedar-drift-ember', conversationId: 'group-crew' }]);
  });

  test('group invite --link mints an async token and group links manages it', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'group-crew', kind: 'group', title: 'Crew', groupName: 'Crew', consentState: 'allowed' },
    ];

    expect(await runCli(['group', 'invite', 'Crew', '--link', '--max-uses', '3', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.inviteLinks).toEqual([{ conversationId: 'group-crew', maxUses: 3, ttlMs: undefined }]);
    const output = io.out.join('');
    expect(output).toContain('cone_gi_v1_test-token');
    expect(output).toContain('cone group join cone_gi_v1_test-token');
    expect(output).toContain('cone group links revoke link-1');

    const listIo = makeIo(generateSecretKey());
    expect(await runCli(['group', 'links', '--plain', '--secret-stdin'], listIo, { createClient: async () => client })).toBe(0);
    expect(listIo.out.join('')).toContain('link-1 — group-crew, 0/1 uses');

    const revokeIo = makeIo(generateSecretKey());
    expect(await runCli(['group', 'links', 'revoke', 'link-1', '--secret-stdin'], revokeIo, { createClient: async () => client })).toBe(0);
    expect(client.revokedLinks).toEqual(['link-1']);
  });

  test('group join posts a join request and points at sync', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();

    expect(await runCli(['group', 'join', 'anchor-beacon-cedar-drift-ember', '--share-name', 'Sam', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.groupJoins).toEqual([{ code: 'anchor-beacon-cedar-drift-ember', proposedName: 'Sam' }]);
    expect(io.out.join('')).toContain('cone inbox sync');

    const usage = makeIo(generateSecretKey());
    expect(await runCli(['group', 'join', '--secret-stdin'], usage, { createClient: async () => client })).toBe(1);
    expect(usage.err.join('')).toContain('usage: cone group join <code>');
  });

  test('group info reports a left group from the cached mirror', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      {
        conversationId: 'group-old',
        kind: 'group',
        title: 'Old Crew',
        consentState: 'allowed',
        active: false,
        members: [{ inboxId: 'inbox-a', level: 'superAdmin', consentState: 'allowed' }],
      },
    ];

    expect(await runCli(['group', 'info', 'Old Crew', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('no longer a member');
    expect(output).toContain('inbox-a [superAdmin]');
  });

  test('group commands reject DM targets and unknown groups', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-alice', kind: 'dm', peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];

    expect(await runCli(['group', 'info', 'Alice', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('group not found');
  });

  test('requests accept and block on a group target the group conversation', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'group-req', kind: 'group', title: 'Mystery Crew', consentState: 'unknown' },
    ];

    expect(await runCli(['requests', 'accept', 'group-req', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls).toContainEqual({ to: 'group-req', state: 'allowed' });
    expect(client.conversations[0]?.consentState).toBe('allowed');

    expect(await runCli(['requests', 'block', 'group-req', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.consentCalls.at(-1)).toEqual({ to: 'group-req', state: 'denied' });
    // Accept's --save-as is DM-only; a group accept never creates a contact.
    expect(client.contacts).toHaveLength(0);
  });

  test('timer sets, shows, and clears the disappearing-messages duration', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-alice', kind: 'dm' as const, peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];

    expect(await runCli(['timer', 'Alice', '1h', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.retentionCalls.at(-1)).toEqual({ conversationId: 'dm-alice', durationMs: 3_600_000 });
    expect(io.out.join('')).toContain('Disappearing messages in Alice: 1h.');

    expect(await runCli(['timer', 'dm-alice', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(io.out.at(-1)).toContain('Disappearing messages in Alice: 1h.');

    expect(await runCli(['timer', 'inbox-alice', 'off', '--plain', '--secret-stdin'], io, { createClient: async () => client })).toBe(0);
    expect(client.retentionCalls.at(-1)).toEqual({ conversationId: 'dm-alice', durationMs: null });
    expect(io.out.at(-1)).toContain('Disappearing messages off in Alice.');
  });

  test('timer rejects unknown targets and junk durations', async () => {
    const io = makeIo(generateSecretKey());
    const client = new MockClient();
    client.conversations = [
      { conversationId: 'dm-alice', kind: 'dm' as const, peerInboxId: 'inbox-alice', title: 'Alice', consentState: 'allowed' },
    ];

    expect(await runCli(['timer', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('usage: cone timer');

    expect(await runCli(['timer', 'Nobody', '1h', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('not found');

    expect(await runCli(['timer', 'Alice', 'banana', '--secret-stdin'], io, { createClient: async () => client })).toBe(1);
    expect(io.err.join('')).toContain('invalid duration');
    expect(client.retentionCalls).toHaveLength(0);
  });
});

function makeIo(
  stdin = '',
  options: { isStdinTty?: boolean; secretLine?: string } = {},
): CliIo & { err: string[]; out: string[]; prompts: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  return {
    err,
    out,
    prompts,
    isStdinTty: () => options.isStdinTty ?? false,
    secretLine: async (prompt) => {
      prompts.push(prompt);
      return options.secretLine ?? stdin;
    },
    stderr: (text) => err.push(text),
    stdinText: async () => stdin,
    stdout: (text) => out.push(text),
  };
}

class MockClient implements ConeClient {
  receiveRequests: unknown[] = [];
  acknowledged: string[] = [];
  async receiveMessages(options?: unknown) { this.receiveRequests.push(options); return { messages: this.pollResult.messages, more: false }; }
  async acknowledgeMessages(ids: string[]) { this.acknowledged.push(...ids); }
  async retryPendingSends() { return []; }

  conversations: ConeConversation[] = [];
  contacts: Contact[] = [];
  messages: ConeMessage[] = [];
  pairRequests: Array<{ code: string; proposedName?: string }> = [];
  sent: Array<{ to: string; text: string }> = [];
  sentToConversation: Array<{ conversationId: string; text: string }> = [];
  consentCalls: Array<{ to: string; state: ConeConsentState }> = [];
  groupCreates: Array<{ name?: string; members: unknown[]; locked?: boolean }> = [];
  groupMemberAdds: Array<{ conversationId: string; members: unknown[] }> = [];
  groupMemberRemovals: Array<{ conversationId: string; members: unknown[] }> = [];
  groupRenames: Array<{ conversationId: string; name: string }> = [];
  groupDescriptions: Array<{ conversationId: string; description: string }> = [];
  groupLevelChanges: Array<{ conversationId: string; member: unknown; level: string }> = [];
  groupInvites: Array<{ code: string; conversationId: string }> = [];
  groupJoins: Array<{ code: string; proposedName?: string }> = [];
  inviteLinks: Array<{ conversationId: string; maxUses?: number; ttlMs?: number }> = [];
  revokedLinks: string[] = [];
  leftGroups: string[] = [];
  groupMembers: ConeGroupMember[] = [];
  retentionCalls: Array<{ conversationId: string; durationMs: number | null }> = [];
  synced = false;
  closed = false;
  unsubscribed = false;
  private handler: MessageHandler | null = null;
  private resolveHandler?: () => void;
  private readonly handlerReady = new Promise<void>((resolve) => {
    this.resolveHandler = resolve;
  });

  identity(): Promise<ConeIdentity> {
    return Promise.resolve({ env: 'dev', inboxId: 'inbox-cli' });
  }

  resolveIdentity(ref: unknown) {
    if (typeof ref === 'string' && ref.startsWith('0x')) {
      return Promise.resolve({ address: ref, inboxId: 'inbox-address', source: 'address' as const });
    }
    return Promise.resolve({ inboxId: String(ref), source: 'contact' as const });
  }

  canMessage(): Promise<boolean> {
    return Promise.resolve(true);
  }

  sendText(to: unknown, text: string): Promise<SentMessage> {
    this.sent.push({ text, to: String(to) });
    return Promise.resolve({ messageId: 'msg-cli', sentAt: new Date().toISOString() });
  }

  jsonSends: Array<{ to: string; value: unknown; replyTo?: string; idempotencyKey?: string }> = [];

  sendJson(to: unknown, value: unknown, options?: { replyTo?: string; idempotencyKey?: string }): Promise<SentMessage> {
    this.jsonSends.push({ to: String(to), value, replyTo: options?.replyTo, idempotencyKey: options?.idempotencyKey });
    return Promise.resolve({ messageId: 'msg-json', sentAt: new Date().toISOString() });
  }

  sendReadReceipt(): Promise<void> {
    return Promise.resolve();
  }

  setConsent(to: unknown, state: ConeConsentState): Promise<void> {
    const inboxId = typeof to === 'object' && to !== null && 'inboxId' in to ? String((to as { inboxId: string }).inboxId) : String(to);
    this.consentCalls.push({ to: inboxId, state });
    this.conversations = this.conversations.map((conversation) =>
      conversation.peerInboxId === inboxId ? { ...conversation, consentState: state } : conversation,
    );
    return Promise.resolve();
  }

  // Mirrors the real client: DM rows record peer-inbox consent, groups record
  // the conversation id.
  setConversationConsent(conversationId: string, state: ConeConsentState): Promise<void> {
    const conversation = this.conversations.find((entry) => entry.conversationId === conversationId);
    if (conversation?.kind !== 'group' && conversation?.peerInboxId) {
      return this.setConsent({ inboxId: conversation.peerInboxId }, state);
    }
    this.consentCalls.push({ to: conversationId, state });
    this.conversations = this.conversations.map((entry) =>
      entry.conversationId === conversationId ? { ...entry, consentState: state } : entry,
    );
    return Promise.resolve();
  }

  sendToConversation(conversationId: string, text: string): Promise<SentMessage> {
    this.sentToConversation.push({ conversationId, text });
    return Promise.resolve({ conversationId, messageId: 'msg-conv', sentAt: new Date().toISOString() });
  }

  createGroup(input: { name?: string; members: unknown[]; locked?: boolean }): Promise<ConeConversation> {
    this.groupCreates.push({ name: input.name, members: input.members, locked: input.locked });
    const conversation: ConeConversation = {
      conversationId: `group-${this.groupCreates.length}`,
      kind: 'group',
      title: input.name ?? 'Group',
      groupName: input.name,
      memberCount: input.members.length + 1,
      consentState: 'allowed',
    };
    this.conversations.push(conversation);
    return Promise.resolve(conversation);
  }

  listGroupMembers(): Promise<ConeGroupMember[]> {
    return Promise.resolve(this.groupMembers);
  }

  addGroupMembers(conversationId: string, members: unknown[]): Promise<void> {
    this.groupMemberAdds.push({ conversationId, members });
    return Promise.resolve();
  }

  removeGroupMembers(conversationId: string, members: unknown[]): Promise<void> {
    this.groupMemberRemovals.push({ conversationId, members });
    return Promise.resolve();
  }

  leaveGroup(conversationId: string): Promise<void> {
    this.leftGroups.push(conversationId);
    return Promise.resolve();
  }

  renameGroup(conversationId: string, name: string): Promise<void> {
    this.groupRenames.push({ conversationId, name });
    this.conversations = this.conversations.map((conversation) =>
      conversation.conversationId === conversationId ? { ...conversation, groupName: name, title: name } : conversation,
    );
    return Promise.resolve();
  }

  setGroupDescription(conversationId: string, description: string): Promise<void> {
    this.groupDescriptions.push({ conversationId, description });
    return Promise.resolve();
  }

  setGroupMemberLevel(conversationId: string, member: unknown, level: string): Promise<void> {
    this.groupLevelChanges.push({ conversationId, member, level });
    return Promise.resolve();
  }

  setRetention(conversationId: string, durationMs: number | null): Promise<void> {
    this.retentionCalls.push({ conversationId, durationMs });
    this.conversations = this.conversations.map((conversation) =>
      conversation.conversationId === conversationId
        ? {
            ...conversation,
            retention: durationMs !== null && durationMs > 0
              ? { durationMs, fromAt: new Date().toISOString() }
              : undefined,
          }
        : conversation,
    );
    return Promise.resolve();
  }

  purgeExpiredMessages(): Promise<number> {
    return Promise.resolve(0);
  }

  failSync = false;

  sync(): Promise<SyncResult> {
    this.synced = true;
    if (this.failSync) {
      return Promise.resolve({
        completedAt: new Date().toISOString(),
        conversationsSynced: 0,
        errors: ['xmtp unreachable'],
        messagesSynced: 0,
        ok: false,
        startedAt: new Date().toISOString(),
      });
    }
    return Promise.resolve({
      completedAt: new Date().toISOString(),
      conversationsSynced: this.conversations.length,
      errors: [],
      messagesSynced: this.messages.length,
      ok: true,
      startedAt: new Date().toISOString(),
    });
  }

  streamMessages(handler: MessageHandler): Promise<Unsubscribe> {
    this.handler = handler;
    this.resolveHandler?.();
    return Promise.resolve(() => {
      this.unsubscribed = true;
      this.handler = null;
    });
  }

  waitForHandler(): Promise<void> {
    return this.handlerReady;
  }

  async emit(message: IncomingMessage): Promise<void> {
    await this.handler?.(message);
  }

  listConversations() {
    return Promise.resolve(this.conversations);
  }

  listMessages(conversationId?: string) {
    return Promise.resolve(this.messages.filter((message) => !conversationId || message.conversationId === conversationId));
  }

  deleteConversation(conversationId: string): Promise<void> {
    this.conversations = this.conversations.filter((conversation) => conversation.conversationId !== conversationId);
    this.messages = this.messages.filter((message) => message.conversationId !== conversationId);
    return Promise.resolve();
  }

  listContacts(): Promise<Contact[]> {
    return Promise.resolve(this.contacts);
  }

  async saveContact(input: { name: string; inboxId?: string; address?: string }): Promise<Contact> {
    await Promise.resolve();
    if (this.closed) {
      throw new Error('client was closed before saveContact completed');
    }
    const contact: Contact = {
      contactId: `contact-${this.contacts.length + 1}`,
      createdAt: new Date().toISOString(),
      inboxId: input.inboxId ?? 'inbox-address',
      name: input.name,
      source: 'manual',
      updatedAt: new Date().toISOString(),
      address: input.address,
    };
    this.contacts.push(contact);
    return contact;
  }

  deleteContact(contactId: string): Promise<void> {
    this.contacts = this.contacts.filter((contact) => contact.contactId !== contactId);
    return Promise.resolve();
  }

  createHandshakeCode() {
    return Promise.resolve({ code: 'anchor-beacon-cedar-drift-ember', expiresAt: new Date().toISOString() });
  }

  inviteToGroupWithCode(code: string, conversationId: string) {
    this.groupInvites.push({ code, conversationId });
    return Promise.resolve({ conversationId, joiner: { inboxId: 'inbox-joiner', proposedName: 'Joiner' } });
  }

  joinGroupWithCode(code: string, options?: { proposedName?: string }) {
    this.groupJoins.push({ code, proposedName: options?.proposedName });
    return Promise.resolve({
      conversationId: 'group-joined',
      groupName: 'Crew',
      memberCount: 2,
      inviter: { inboxId: 'inbox-dana' },
    });
  }

  listPendingGroupJoins() {
    return Promise.resolve([]);
  }

  pollRequests: Array<{ cursorName?: string; advance?: boolean }> = [];
  pollResult: { messages: ConeMessage[]; cursor: string } = { messages: [], cursor: 'cursor-1' };

  pollMessages(options?: { cursorName?: string; advance?: boolean }) {
    this.pollRequests.push({ cursorName: options?.cursorName, advance: options?.advance });
    return Promise.resolve(this.pollResult);
  }

  cancelGroupJoin(_conversationId: string) {
    return Promise.resolve();
  }

  createGroupInviteLink(conversationId: string, options?: { ttlMs?: number; maxUses?: number }) {
    this.inviteLinks.push({ conversationId, maxUses: options?.maxUses, ttlMs: options?.ttlMs });
    return Promise.resolve({
      linkId: 'link-1',
      conversationId,
      token: 'cone_gi_v1_test-token',
      nonce: 'nonce-1',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUses: options?.maxUses ?? 1,
      uses: 0,
      servicedParticipantIds: [],
    });
  }

  listGroupInviteLinks() {
    return Promise.resolve([{
      linkId: 'link-1',
      conversationId: 'group-crew',
      token: 'cone_gi_v1_test-token',
      nonce: 'nonce-1',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUses: 1,
      uses: 0,
      servicedParticipantIds: [],
    }]);
  }

  revokeGroupInviteLink(linkId: string) {
    this.revokedLinks.push(linkId);
    return Promise.resolve();
  }

  serviceGroupInviteLinks() {
    return Promise.resolve([]);
  }

  pairWithCode(code: string, options?: { proposedName?: string }) {
    this.pairRequests.push({ code, proposedName: options?.proposedName });
    return Promise.resolve({
      contact: {
        contactId: 'contact-dana',
        createdAt: new Date().toISOString(),
        inboxId: 'inbox-dana',
        name: 'Dana',
        source: 'paired' as const,
        updatedAt: new Date().toISOString(),
      },
      peer: {
        env: 'dev' as const,
        inboxId: 'inbox-dana',
      },
      sentConfirmation: true,
    });
  }

  exportBackup(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  importBackup(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
