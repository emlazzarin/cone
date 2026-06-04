import { useEffect, useState } from 'preact/hooks';

import {
  createConeClient,
  deriveAccount,
  generateSecretKey,
  HttpRendezvousClient,
  parseSecretKey,
  type ConeClient,
  type ConeConversation,
  type ConeIdentity,
  type Contact,
} from '@cone/core';
import { createBrowserXmtpAdapter, IndexedDbStore } from '@cone/xmtp-browser';

type View = 'conversations' | 'contacts' | 'pair' | 'backup';

export function App() {
  const [secretInput, setSecretInput] = useState('');
  const [client, setClient] = useState<ConeClient | null>(null);
  const [identity, setIdentity] = useState<ConeIdentity | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<ConeConversation[]>([]);
  const [view, setView] = useState<View>('conversations');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactIdentity, setContactIdentity] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!client) return;
    void refresh(client);
    const timer = window.setInterval(() => void refresh(client), 5000);
    void client.streamMessages(() => refresh(client));
    return () => window.clearInterval(timer);
  }, [client]);

  async function unlock(input: string) {
    setStatus('Unlocking account...');
    const secret = parseSecretKey(input);
    const account = deriveAccount(secret, { env: 'dev' });
    const xmtp = await createBrowserXmtpAdapter({ account });
    const store = new IndexedDbStore(`cone:${account.env}:${account.accountId}`, account.coneStorageKey);
    const rendezvousUrl = import.meta.env.VITE_COS_RENDEZVOUS_URL ?? 'http://localhost:8787';
    const cone = await createConeClient({ account, rendezvous: new HttpRendezvousClient(rendezvousUrl), store, xmtp });
    setClient(cone);
    setIdentity(await cone.identity());
    setSecretInput('');
    setStatus('Ready');
  }

  async function refresh(cone = client) {
    if (!cone) return;
    setContacts(await cone.listContacts());
    setConversations(await cone.listConversations());
  }

  async function sendMessage() {
    if (!client) return;
    await client.sendText(to, text);
    setText('');
    setStatus('Message sent');
    await refresh();
  }

  async function saveContact() {
    if (!client) return;
    const resolved = await client.resolveIdentity(contactIdentity);
    await client.saveContact({ name: contactName, inboxId: resolved.inboxId, address: resolved.address });
    setContactName('');
    setContactIdentity('');
    setStatus('Contact saved');
    await refresh();
  }

  async function createCode() {
    if (!client) return;
    const generated = await client.createHandshakeCode();
    setPairCode(generated.code);
    setStatus(`Code expires at ${generated.expiresAt}`);
  }

  async function joinCode() {
    if (!client) return;
    const result = await client.pairWithCode(pairCode);
    setStatus(`Paired with ${result.contact.name}`);
    await refresh();
  }

  async function exportBackup() {
    if (!client) return;
    const data = await client.exportBackup();
    const copy = new Uint8Array(data);
    const url = URL.createObjectURL(new Blob([copy], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'cone.backup';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!client) {
    return (
      <main class="login">
        <section class="login-panel">
          <div class="mark" aria-hidden="true">COS</div>
          <h1>Cone of Silence</h1>
          <textarea
            value={secretInput}
            onInput={(event) => setSecretInput(event.currentTarget.value)}
            placeholder="cos_sk_v1_..."
            rows={4}
            aria-label="Secret key"
          />
          <div class="button-row">
            <button type="button" onClick={() => unlock(secretInput)}>Unlock</button>
            <button type="button" class="secondary" onClick={() => setSecretInput(generateSecretKey())}>Generate</button>
          </div>
          <p role="status">{status}</p>
        </section>
      </main>
    );
  }

  return (
    <main class="shell">
      <aside>
        <div class="brand">Cone</div>
        <button class={view === 'conversations' ? 'active' : ''} onClick={() => setView('conversations')}>Inbox</button>
        <button class={view === 'contacts' ? 'active' : ''} onClick={() => setView('contacts')}>Contacts</button>
        <button class={view === 'pair' ? 'active' : ''} onClick={() => setView('pair')}>Pair</button>
        <button class={view === 'backup' ? 'active' : ''} onClick={() => setView('backup')}>Backup</button>
      </aside>

      <section class="workspace">
        <header>
          <div>
            <p class="eyebrow">{identity?.env}</p>
            <h1>{shortId(identity?.inboxId ?? '')}</h1>
          </div>
          <p role="status">{status}</p>
        </header>

        {view === 'conversations' && (
          <div class="grid">
            <section class="panel">
              <h2>Conversations</h2>
              {conversations.map((conversation) => (
                <button class="row" key={conversation.conversationId} onClick={() => setTo(conversation.title)}>
                  <span>{conversation.title}</span>
                  <small>{shortId(conversation.peerInboxId)}</small>
                </button>
              ))}
            </section>
            <section class="panel composer">
              <h2>Message</h2>
              <input value={to} onInput={(event) => setTo(event.currentTarget.value)} placeholder="Contact, inbox ID, or address" />
              <textarea value={text} onInput={(event) => setText(event.currentTarget.value)} rows={8} placeholder="Message" />
              <button type="button" onClick={sendMessage}>Send</button>
            </section>
          </div>
        )}

        {view === 'contacts' && (
          <div class="grid">
            <section class="panel">
              <h2>Address Book</h2>
              {contacts.map((contact) => (
                <div class="row" key={contact.contactId}>
                  <span>{contact.name}</span>
                  <small>{contact.address ?? shortId(contact.inboxId)}</small>
                </div>
              ))}
            </section>
            <section class="panel">
              <h2>New Contact</h2>
              <input value={contactName} onInput={(event) => setContactName(event.currentTarget.value)} placeholder="Name" />
              <input value={contactIdentity} onInput={(event) => setContactIdentity(event.currentTarget.value)} placeholder="Inbox ID or address" />
              <button type="button" onClick={saveContact}>Save</button>
            </section>
          </div>
        )}

        {view === 'pair' && (
          <section class="panel narrow">
            <h2>Pair</h2>
            <input value={pairCode} onInput={(event) => setPairCode(event.currentTarget.value)} placeholder="handshake-code" />
            <div class="button-row">
              <button type="button" onClick={createCode}>Create Code</button>
              <button type="button" class="secondary" onClick={joinCode}>Join Code</button>
            </div>
          </section>
        )}

        {view === 'backup' && (
          <section class="panel narrow">
            <h2>Backup</h2>
            <button type="button" onClick={exportBackup}>Export Backup</button>
          </section>
        )}
      </section>
    </main>
  );
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}
