import { useEffect, useRef, useState } from 'preact/hooks';

import {
  createConeClient,
  deriveAccount,
  formatConeMessageLine,
  formatConnectionStatus,
  generateSecretKey,
  HttpRendezvousClient,
  isVisibleChatMessage,
  parseSecretKey,
  type ConeConnectionStatus,
  type ConeClient,
  type ConeConversation,
  type ConeIdentity,
  type ConeMessage,
  type Contact,
  type XmtpEnv,
} from '@cone/core';
import { browserAccountNamespace, createBrowserXmtpAdapter, IndexedDbStore } from '@cone/xmtp-browser';

type View = 'inbox' | 'contacts' | 'pair' | 'backup' | 'settings';
type ChatMode = 'select' | 'talk';

interface SessionState {
  accountId: string;
  client: ConeClient;
  env: XmtpEnv;
  identity: ConeIdentity;
}

interface TargetSuggestion {
  conversationId?: string;
  kind: 'contact' | 'conversation';
  label: string;
  meta: string;
  value: string;
}

const DEFAULT_RENDEZVOUS_URL = import.meta.env.VITE_COS_RENDEZVOUS_URL ?? 'http://localhost:8787';

export function App() {
  const [secretInput, setSecretInput] = useState('');
  const [env, setEnv] = useState<XmtpEnv>('dev');
  const [session, setSession] = useState<SessionState | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<ConeConversation[]>([]);
  const [messages, setMessages] = useState<ConeMessage[]>([]);
  const [view, setView] = useState<View>('inbox');
  const [chatMode, setChatMode] = useState<ChatMode>('select');
  const [selectedConversationId, setSelectedConversationId] = useState<string>('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactIdentity, setContactIdentity] = useState('');
  const [editingContactId, setEditingContactId] = useState('');
  const [editingName, setEditingName] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairPeerName, setPairPeerName] = useState('');
  const [pairShareName, setPairShareName] = useState('');
  const [rendezvousUrl, setRendezvousUrl] = useState(DEFAULT_RENDEZVOUS_URL);
  const [status, setStatus] = useState('Paste a Cone secret key or generate one.');
  const [busy, setBusy] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConeConnectionStatus>('connecting');
  const [sessionStartedAt, setSessionStartedAt] = useState<Date | null>(null);
  const secretRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!session) return;
    const currentSession = session;
    let cancelled = false;
    let unsubscribe: (() => void | Promise<void>) | undefined;

    async function start() {
      setConnectionStatus('catching-up');
      await refresh(currentSession.client, selectedConversationId);
      unsubscribe = await currentSession.client.streamMessages(async (message) => {
        if (cancelled) return;
        setConnectionStatus('live');
        await refresh(currentSession.client, selectedConversationId || message.conversationId);
        if (!selectedConversationId) {
          setSelectedConversationId(message.conversationId);
        }
      });
      setConnectionStatus('live');
    }

    void start().catch((error) => {
      setConnectionStatus('offline');
      setStatus(errorMessage(error));
    });
    const timer = window.setInterval(() => {
      void refresh(session.client, selectedConversationId).catch((error) => {
        setConnectionStatus('stale');
        setStatus(errorMessage(error));
      });
    }, 8_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void unsubscribe?.();
    };
  }, [session, selectedConversationId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Tab') {
        event.preventDefault();
        focusByTab(event.shiftKey ? -1 : 1);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        const viewForKey = hotkeyView(event.key);
        if (viewForKey) {
          event.preventDefault();
          setView(viewForKey);
          if (viewForKey === 'inbox') {
            setChatMode('select');
          }
          return;
        }
      }

      if (session && !isEditableTarget(event.target)) {
        const key = event.key.toLowerCase();
        if (key === 'l') {
          event.preventDefault();
          void lock();
          return;
        }
        if (view === 'inbox' && key === 'n') {
          event.preventDefault();
          beginNewMessage();
          return;
        }
        if (view === 'inbox' && (key === 'j' || event.key === 'ArrowDown')) {
          event.preventDefault();
          moveConversation(1);
          return;
        }
        if (view === 'inbox' && (key === 'k' || event.key === 'ArrowUp')) {
          event.preventDefault();
          moveConversation(-1);
          return;
        }
        if (view === 'inbox' && event.key === 'Enter') {
          event.preventDefault();
          enterTalkMode();
          return;
        }
        if (view === 'pair' && key === 'c') {
          event.preventDefault();
          void createCode();
          return;
        }
        if (view === 'pair' && key === 'j' && pairCode.trim()) {
          event.preventDefault();
          void joinCode();
          return;
        }
      }

      if (session && view === 'inbox' && event.key === 'Escape' && isEditableTarget(event.target)) {
        event.preventDefault();
        setChatMode('select');
        (event.target as HTMLElement).blur();
        return;
      }

      if (event.key === '/' && !session) {
        event.preventDefault();
        secretRef.current?.focus();
      } else if (event.key === '/' && !isEditableTarget(event.target)) {
        event.preventDefault();
        setView('inbox');
        setChatMode('talk');
        window.requestAnimationFrame(() => messageRef.current?.focus());
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session, view, pairCode]);

  async function run(action: () => Promise<void>, pending = 'Working...') {
    setBusy(true);
    setStatus(pending);
    try {
      await action();
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function unlock(input: string) {
    await run(async () => {
      const secret = parseSecretKey(input);
      const account = deriveAccount(secret, { env });
      const namespace = browserAccountNamespace(account);
      const xmtp = await createBrowserXmtpAdapter({ account });
      const store = new IndexedDbStore(namespace, account.coneStorageKey);
      const cone = await createConeClient({
        account,
        rendezvous: new HttpRendezvousClient(rendezvousUrl),
        store,
        xmtp,
      });
      const identity = await cone.identity();
      setSession({ accountId: account.accountId, client: cone, env, identity });
      setSessionStartedAt(new Date());
      setConnectionStatus('connecting');
      setSecretInput('');
      setPairPeerName('');
      setPairShareName('');
      setStatus('Unlocked for this browser session. Keep your secret key saved outside the app.');
      await refresh(cone);
      setChatMode('select');
    }, 'Unlocking XMTP account...');
  }

  async function refresh(client = session?.client, conversationId = selectedConversationId) {
    if (!client) return;
    const [nextContacts, nextConversations] = await Promise.all([
      client.listContacts(),
      client.listConversations(),
    ]);
    setContacts(nextContacts);
    setConversations(nextConversations);
    if (conversationId) {
      setMessages(await client.listMessages(conversationId));
    } else {
      setMessages(await client.listMessages());
    }
  }

  async function sendMessage() {
    if (!session || !to.trim() || !text.trim()) return;
    await run(async () => {
      const sent = await session.client.sendText(to, text);
      setText('');
      if (sent.conversationId) {
        setSelectedConversationId(sent.conversationId);
        setChatMode('talk');
        await refresh(session.client, sent.conversationId);
      } else {
        await refresh(session.client);
      }
      setStatus(`Sent ${shortId(sent.messageId)}`);
      window.requestAnimationFrame(() => messageRef.current?.focus());
    }, 'Sending message...');
  }

  async function saveContact() {
    if (!session) return;
    await run(async () => {
      const resolved = await session.client.resolveIdentity(contactIdentity);
      const contact = await session.client.saveContact({ name: contactName, inboxId: resolved.inboxId, address: resolved.address });
      setContactName('');
      setContactIdentity('');
      setStatus(`Saved ${contact.name}`);
      await refresh(session.client);
    }, 'Saving contact...');
  }

  async function renameContact(contact: Contact) {
    if (!session || !editingName.trim()) return;
    await run(async () => {
      const updated = await session.client.saveContact({
        address: contact.address,
        inboxId: contact.inboxId,
        name: editingName,
        source: contact.source,
      });
      setEditingContactId('');
      setEditingName('');
      setStatus(`Renamed contact to ${updated.name}`);
      await refresh(session.client);
    }, 'Renaming contact...');
  }

  async function deleteContact(contactId: string) {
    if (!session) return;
    await run(async () => {
      await session.client.deleteContact(contactId);
      setStatus('Contact deleted');
      await refresh(session.client);
    }, 'Deleting contact...');
  }

  async function createCode() {
    if (!session) return;
    await run(async () => {
      const generated = await session.client.createHandshakeCode();
      setPairCode(generated.code);
      setStatus(`Code expires at ${formatTime(generated.expiresAt)}`);
    }, 'Creating handshake code...');
  }

  async function joinCode() {
    if (!session) return;
    await run(async () => {
      const result = await session.client.pairWithCode(pairCode, { proposedName: pairShareName || undefined });
      const contact = pairPeerName.trim()
        ? await session.client.saveContact({
            address: result.contact.address,
            inboxId: result.contact.inboxId,
            name: pairPeerName.trim(),
            source: 'paired',
          })
        : result.contact;
      setTo(contact.name);
      setView('inbox');
      setChatMode('talk');
      setStatus(`Paired with ${contact.name}. You can message them now.`);
      await refresh(session.client);
      window.requestAnimationFrame(() => messageRef.current?.focus());
    }, 'Waiting for peer...');
  }

  async function exportBackup() {
    if (!session) return;
    await run(async () => {
      const data = await session.client.exportBackup();
      const copy = new Uint8Array(data);
      const url = URL.createObjectURL(new Blob([copy], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cone-${session.identity.inboxId.slice(0, 8)}.backup`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus('Backup exported');
    }, 'Exporting backup...');
  }

  async function importBackup(file: File | null) {
    if (!session || !file) return;
    await run(async () => {
      await session.client.importBackup(new Uint8Array(await file.arrayBuffer()));
      await refresh(session.client);
      setStatus('Backup imported');
    }, 'Importing backup...');
  }

  async function lock() {
    await session?.client.close();
    setSession(null);
    setContacts([]);
    setConversations([]);
    setMessages([]);
    setSessionStartedAt(null);
    setConnectionStatus('connecting');
    setSelectedConversationId('');
    setTo('');
    setText('');
    setChatMode('select');
    setStatus('Locked. Secret key is only in memory.');
    window.requestAnimationFrame(() => secretRef.current?.focus());
  }

  function beginNewMessage() {
    setView('inbox');
    setSelectedConversationId('');
    setMessages([]);
    setTo('');
    setChatMode('talk');
    window.requestAnimationFrame(() => toRef.current?.focus());
  }

  function selectConversation(conversation: ConeConversation | null) {
    if (!session) return;
    if (!conversation) {
      setSelectedConversationId('');
      setMessages([]);
      setTo('');
      setChatMode('select');
      return;
    }
    setSelectedConversationId(conversation.conversationId);
    setTo(conversation.title);
    setChatMode('select');
    void refresh(session.client, conversation.conversationId);
  }

  function moveConversation(delta: 1 | -1) {
    if (conversations.length === 0) {
      beginNewMessage();
      return;
    }
    const selectedIndex = selectedConversationId
      ? conversations.findIndex((conversation) => conversation.conversationId === selectedConversationId)
      : -1;
    const virtualIndex = selectedIndex + 1;
    const nextVirtualIndex = clamp(virtualIndex + delta, 0, conversations.length);
    selectConversation(nextVirtualIndex === 0 ? null : conversations[nextVirtualIndex - 1] ?? null);
  }

  function enterTalkMode() {
    setChatMode('talk');
    window.requestAnimationFrame(() => {
      if (!to.trim()) {
        toRef.current?.focus();
      } else {
        messageRef.current?.focus();
      }
    });
  }

  if (!session) {
    return (
      <main class="terminal-login">
        <section class="window login-window" aria-label="Cone login terminal">
          <div class="window-title login-titlebar">
            <span class="brand-cell">cone@{env}:login</span>
            <span>xmtp:locked</span>
            <span>key:none</span>
            <span class="state-ok">ready</span>
            <span class="dim">[/] secret / [TAB] focus</span>
          </div>
          <div class="login-grid">
            <div class="login-copy">
              <p class="prompt-line">[cos] XMTP account unlock</p>
              <h1>
                <span>Cone</span>
                <span>of</span>
                <span>Silence</span>
              </h1>
              <p class="terminal-copy">Paste a portable Cone secret key. The raw secret is only held in memory for this browser session.</p>
              <div class="help-grid" aria-label="Login hotkeys">
                <span><kbd>/</kbd> focus secret</span>
                <span><kbd>TAB</kbd> next field</span>
                <span><kbd>S-TAB</kbd> previous field</span>
              </div>
            </div>
            <form class="terminal-form" onSubmit={(event) => {
              event.preventDefault();
              void unlock(secretInput);
            }}>
              <label>
                <span>secret key <kbd>/</kbd></span>
                <textarea
                  ref={secretRef}
                  data-kbd-focus="true"
                  value={secretInput}
                  onInput={(event) => setSecretInput(event.currentTarget.value)}
                  placeholder="cos_sk_v1_..."
                  rows={4}
                  aria-label="Secret key"
                />
              </label>
              <div class="split">
                <label>
                  <span>XMTP env</span>
                  <select data-kbd-focus="true" value={env} onChange={(event) => setEnv(event.currentTarget.value as XmtpEnv)}>
                    <option value="dev">dev</option>
                    <option value="production">production</option>
                    <option value="local">local</option>
                  </select>
                </label>
                <label>
                  <span>rendezvous URL</span>
                  <input data-kbd-focus="true" value={rendezvousUrl} onInput={(event) => setRendezvousUrl(event.currentTarget.value)} />
                </label>
              </div>
              <div class="action-bar">
                <button data-kbd-focus="true" type="submit" disabled={busy || !secretInput.trim()}>
                  unlock <kbd>Enter</kbd>
                </button>
                <button data-kbd-focus="true" type="button" class="secondary" disabled={busy} onClick={() => {
                  setSecretInput(generateSecretKey());
                  setStatus('Generated a key. Save it somewhere before unlocking.');
                  window.requestAnimationFrame(() => secretRef.current?.focus());
                }}>
                  generate key
                </button>
              </div>
              <p class="status-line" role="status">{busy ? 'busy...' : status}</p>
            </form>
          </div>
        </section>
      </main>
    );
  }

  const activeConversation = conversations.find((conversation) => conversation.conversationId === selectedConversationId);
  const visibleMessages = messages.filter(isVisibleChatMessage);
  const channelTitle = activeConversation ? activeConversation.title : 'new message';
  const surfaceTitle = viewLabel(view);
  const xmtpLabel = formatConnectionStatus(connectionStatus).toUpperCase().replaceAll(' ', '-');
  const logTime = sessionStartedAt ?? new Date();
  const targetSuggestions = buildTargetSuggestions(to, contacts, conversations);
  const modeLabel = view === 'inbox' ? `CHAT:${chatMode.toUpperCase()}` : '';
  const localStats = `${conversations.length} chats / ${contacts.filter((contact) => contact.source !== 'self').length} contacts`;

  return (
    <main class="irc-shell">
      <section class="window app-window" aria-label="Cone IRC client">
        <header class="topbar">
          <span class="status-cell brand-cell">CONE@{session.env}:{session.accountId}</span>
          <span class="status-cell">INBOX:{shortId(session.identity.inboxId)}</span>
          <span class="status-cell">{surfaceTitle}</span>
          {modeLabel && <span class="status-cell mode-cell">{modeLabel}</span>}
          <span class={`status-cell connection-cell ${connectionClass(connectionStatus)}`}>XMTP:{xmtpLabel}</span>
          <span class="status-cell">{localStats}</span>
          <span class="status-message">{status}</span>
          <button data-kbd-focus="true" type="button" class="lock-button" aria-keyshortcuts="L" onClick={() => void lock()}>
            [L] LOCK
          </button>
        </header>

        <nav class="modebar" aria-label="Primary views">
          <button data-kbd-focus="true" aria-current={view === 'inbox' ? 'page' : undefined} aria-keyshortcuts="Control+1" class={view === 'inbox' ? 'active' : ''} onClick={() => setView('inbox')}>
            <kbd>C-1</kbd> CHAT
          </button>
          <button data-kbd-focus="true" aria-current={view === 'contacts' ? 'page' : undefined} aria-keyshortcuts="Control+2" class={view === 'contacts' ? 'active' : ''} onClick={() => setView('contacts')}>
            <kbd>C-2</kbd> CONTACTS
          </button>
          <button data-kbd-focus="true" aria-current={view === 'pair' ? 'page' : undefined} aria-keyshortcuts="Control+3" class={view === 'pair' ? 'active' : ''} onClick={() => setView('pair')}>
            <kbd>C-3</kbd> PAIR
          </button>
          <button data-kbd-focus="true" aria-current={view === 'backup' ? 'page' : undefined} aria-keyshortcuts="Control+4" class={view === 'backup' ? 'active' : ''} onClick={() => setView('backup')}>
            <kbd>C-4</kbd> BACKUP
          </button>
          <button data-kbd-focus="true" aria-current={view === 'settings' ? 'page' : undefined} aria-keyshortcuts="Control+," class={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            <kbd>C-,</kbd> CONFIG
          </button>
        </nav>

        {view === 'inbox' && (
          <div class="irc-grid">
            <aside class="channel-pane" aria-label="Channels and conversations">
              <div class="pane-title">
                <span>switchboard</span>
                <small><kbd>j/k</kbd> select</small>
              </div>
              <button
                data-kbd-focus="true"
                aria-current={!selectedConversationId ? 'true' : undefined}
                class={!selectedConversationId ? 'channel active' : 'channel'}
                onClick={() => {
                  beginNewMessage();
                }}
              >
                <span>+ NEW MESSAGE</span>
                <small><kbd>N</kbd></small>
              </button>
              {conversations.map((conversation) => (
                <button
                  data-kbd-focus="true"
                  aria-current={selectedConversationId === conversation.conversationId ? 'true' : undefined}
                  class={selectedConversationId === conversation.conversationId ? 'channel active' : 'channel'}
                  key={conversation.conversationId}
                  onClick={() => {
                    selectConversation(conversation);
                  }}
                >
                  <span>{conversation.title}</span>
                  <small>{shortId(conversation.peerInboxId)}</small>
                </button>
              ))}
              {conversations.length === 0 && <p class="empty">no chats yet<br />pair or send first</p>}
            </aside>

            <section class="transcript-pane" aria-label="Message transcript">
              <div class="pane-title">
                <span>{activeConversation ? channelTitle : 'new message'}</span>
                <span class="dim">{activeConversation ? shortId(activeConversation.peerInboxId) : 'contact / inbox / address'}</span>
              </div>
              <div class="transcript" role="log" aria-live="polite" aria-relevant="additions text">
                {visibleMessages.length === 0 && (
                  <div class="system-log" aria-label="Empty channel instructions">
                    <p class="system-line"><time>{formatClock(logTime)}</time><span>*</span><em>system joined local session</em></p>
                    <p class="system-line"><time>{formatClock(logTime)}</time><span>***</span><em>no visible messages</em></p>
                    <p class="system-line"><time>{formatClock(logTime)}</time><span>hint</span><em>{activeConversation ? 'Press Enter to write. Esc returns to selection.' : 'Press N, type a contact or inbox ID, then write below.'}</em></p>
                  </div>
                )}
                {visibleMessages.map((message) => {
                  const sender = message.direction === 'outbound' ? 'me' : activeConversation?.title ?? shortId(message.senderInboxId);
                  return (
                    <article class={`message-line ${message.direction}`} key={message.messageId}>
                      <p>{formatConeMessageLine(message, sender)}</p>
                    </article>
                  );
                })}
              </div>
              <form class={`composer ${chatMode === 'talk' ? 'is-talking' : 'is-selecting'}`} onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}>
                <label class="to-field">
                  <span>To <small>type for matches, click a suggestion</small></span>
                  <input
                    ref={toRef}
                    data-kbd-focus="true"
                    value={to}
                    onFocus={() => setChatMode('talk')}
                    onInput={(event) => setTo(event.currentTarget.value)}
                    placeholder="contact, inbox ID, or EVM address"
                  />
                  {targetSuggestions.length > 0 && (
                    <div class="suggestion-rail" aria-label="Target suggestions">
                      {targetSuggestions.map((suggestion) => (
                        <button
                          data-kbd-focus="true"
                          type="button"
                          key={`${suggestion.kind}:${suggestion.value}`}
                          onClick={() => {
                            setTo(suggestion.value);
                            if (suggestion.conversationId) {
                              const conversation = conversations.find((candidate) => candidate.conversationId === suggestion.conversationId);
                              if (conversation) {
                                selectConversation(conversation);
                              }
                            }
                            setChatMode('talk');
                            window.requestAnimationFrame(() => messageRef.current?.focus());
                          }}
                        >
                          {suggestion.label}
                          <small>{suggestion.meta}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </label>
                <label class="command-input">
                  <span>Message <small><kbd>Enter</kbd> send <kbd>Shift+Enter</kbd> newline <kbd>Esc</kbd> select</small></span>
                  <textarea
                    ref={messageRef}
                    data-kbd-focus="true"
                    value={text}
                    onFocus={() => setChatMode('talk')}
                    onInput={(event) => setText(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setChatMode('select');
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    rows={4}
                    placeholder="Type a message..."
                  />
                </label>
                <button data-kbd-focus="true" type="submit" disabled={busy || !to.trim() || !text.trim()}>
                  transmit <kbd>ENTER</kbd>
                </button>
              </form>
            </section>
          </div>
        )}

        {view === 'contacts' && (
          <div class="utility-grid">
            <section class="pane">
              <div class="pane-title">
                <span>address book</span>
                <small><kbd>C-1</kbd> chat</small>
              </div>
              {contacts.length === 0 && (
                <div class="empty-card">
                  <strong>No contacts saved.</strong>
                  <p>Add an XMTP-reachable identity, or use pairing when neither side wants to exchange identifiers first.</p>
                </div>
              )}
              {contacts.map((contact) => (
                <div class="user-row" key={contact.contactId}>
                  {editingContactId === contact.contactId ? (
                    <>
                      <input data-kbd-focus="true" value={editingName} onInput={(event) => setEditingName(event.currentTarget.value)} aria-label="New contact name" />
                      <button data-kbd-focus="true" type="button" onClick={() => void renameContact(contact)}>save</button>
                      <button data-kbd-focus="true" type="button" class="ghost" onClick={() => setEditingContactId('')}>cancel</button>
                    </>
                  ) : (
                    <>
                      <div>
                        <strong>{contact.name}</strong>
                        <small>{contact.address ?? shortId(contact.inboxId)} / {contact.source}</small>
                      </div>
                      {contact.source === 'self' ? (
                        <span class="self-badge">local identity</span>
                      ) : (
                        <>
                          <button data-kbd-focus="true" type="button" class="ghost" onClick={() => {
                            const conversation = conversations.find((candidate) => candidate.peerInboxId === contact.inboxId);
                            setTo(contact.name);
                            setView('inbox');
                            setChatMode('talk');
                            setSelectedConversationId(conversation?.conversationId ?? '');
                            if (conversation) {
                              void refresh(session.client, conversation.conversationId);
                            } else {
                              setMessages([]);
                            }
                            window.requestAnimationFrame(() => messageRef.current?.focus());
                          }}>talk</button>
                          <button data-kbd-focus="true" type="button" class="ghost" onClick={() => {
                            setEditingContactId(contact.contactId);
                            setEditingName(contact.name);
                          }}>rename</button>
                          <button data-kbd-focus="true" type="button" class="danger" onClick={() => void deleteContact(contact.contactId)}>delete</button>
                        </>
                      )}
                    </>
                  )}
                </div>
              ))}
            </section>
            <section class="pane">
              <div class="pane-title">save contact</div>
              <label>
                <span>name</span>
                <input data-kbd-focus="true" value={contactName} onInput={(event) => setContactName(event.currentTarget.value)} placeholder="Alice" />
              </label>
              <label>
                <span>identity</span>
                <input data-kbd-focus="true" value={contactIdentity} onInput={(event) => setContactIdentity(event.currentTarget.value)} placeholder="inbox ID or EVM address" />
              </label>
              <button data-kbd-focus="true" type="button" disabled={busy || !contactName.trim() || !contactIdentity.trim()} onClick={() => void saveContact()}>
                save contact
              </button>
            </section>
          </div>
        )}

        {view === 'pair' && (
          <div class="pair-grid">
            <section class="pane">
              <div class="pane-title">
                <span>pairing room</span>
                <small><kbd>C</kbd> create <kbd>J</kbd> join</small>
              </div>
              <p class="terminal-copy">Encrypted rendezvous. Two participants. Ten minute room TTL. No application messages pass through rendezvous.</p>
              <label>
                <span>save this peer as</span>
                <input data-kbd-focus="true" value={pairPeerName} onInput={(event) => setPairPeerName(event.currentTarget.value)} placeholder="Codex, Alice, Agent A..." />
              </label>
              <label>
                <span>share my name with the peer</span>
                <input data-kbd-focus="true" value={pairShareName} onInput={(event) => setPairShareName(event.currentTarget.value)} placeholder="My laptop, bot1, Alice..." />
              </label>
              <label>
                <span>handshake code</span>
                <input data-kbd-focus="true" value={pairCode} onInput={(event) => setPairCode(event.currentTarget.value)} placeholder="forest-wormhole-direction" />
              </label>
              <div class="action-bar">
                <button data-kbd-focus="true" type="button" disabled={busy} aria-keyshortcuts="C" onClick={() => void createCode()}><kbd>C</kbd> create code</button>
                <button data-kbd-focus="true" type="button" class="secondary" disabled={busy || !pairCode.trim()} aria-keyshortcuts="J" onClick={() => void joinCode()}><kbd>J</kbd> join code</button>
              </div>
            </section>
            <aside class="pane telemetry-pane" aria-label="Pairing diagnostics">
              <div class="pane-title">rendezvous log</div>
              <p class="system-line"><time>{formatClock(logTime)}</time><span>rzv</span><em>{rendezvousUrl}</em></p>
              <p class="system-line"><time>{formatClock(logTime)}</time><span>env</span><em>{session.env}</em></p>
              <p class="system-line"><time>{formatClock(logTime)}</time><span>me</span><em>{shortId(session.identity.inboxId)}</em></p>
              <p class="system-line"><time>{formatClock(logTime)}</time><span>code</span><em>{pairCode || 'waiting for code input'}</em></p>
              <p class="system-line matrix-label"><time>{formatClock(logTime)}</time><span>print</span><em>code print</em></p>
              <pre aria-hidden="true">{pairingGlyph(pairCode)}</pre>
            </aside>
          </div>
        )}

        {view === 'backup' && (
          <section class="pane narrow">
            <div class="pane-title">encrypted vault</div>
            <p class="terminal-copy">Backups contain Cone contacts and cached messages encrypted with a key derived from your secret.</p>
            <div class="action-bar">
              <button data-kbd-focus="true" type="button" disabled={busy} onClick={() => void exportBackup()}>export backup</button>
              <label class="file-button">
                import backup
                <input type="file" accept=".backup,.cos,application/octet-stream" onChange={(event) => void importBackup(event.currentTarget.files?.[0] ?? null)} />
              </label>
            </div>
          </section>
        )}

        {view === 'settings' && (
          <section class="pane narrow">
            <div class="pane-title">station config</div>
            <dl class="terminal-dl">
              <dt>inbox ID</dt>
              <dd>{session.identity.inboxId}</dd>
              <dt>EVM address</dt>
              <dd>{session.identity.address ?? 'unavailable'}</dd>
              <dt>rendezvous</dt>
              <dd>{rendezvousUrl}</dd>
            </dl>
            <p class="terminal-copy">The raw secret key is not written to localStorage or IndexedDB by this app. Unlock again with the same secret on a new browser session.</p>
          </section>
        )}

        <footer class="footerbar">
          {footerHints(view, chatMode).map((hint) => <span key={hint}>{hint}</span>)}
        </footer>
      </section>
    </main>
  );
}

function hotkeyView(key: string): View | null {
  switch (key) {
    case '1':
      return 'inbox';
    case '2':
      return 'contacts';
    case '3':
      return 'pair';
    case '4':
      return 'backup';
    case ',':
      return 'settings';
    default:
      return null;
  }
}

function footerHints(view: View, chatMode: ChatMode): string[] {
  switch (view) {
    case 'inbox':
      return chatMode === 'select'
        ? ['[J/K] select', '[ENTER] talk', '[N] new message', '[C-2] contacts', '[/] focus composer']
        : ['[ENTER] transmit', '[ESC] select', '[TAB] next field', '[S-TAB] previous field', '[C-3] pair'];
    case 'contacts':
      return ['[TAB] next', '[S-TAB] prev', '[C-1] chat', '[TALK] opens composer', '[C-3] pair'];
    case 'pair':
      return ['[TAB] next', '[S-TAB] prev', '[C] create code', '[J] join code', '[C-1] chat'];
    case 'backup':
      return ['[TAB] next', '[S-TAB] prev', '[EXPORT] encrypted state', '[IMPORT] restore'];
    case 'settings':
      return ['[TAB] next', '[S-TAB] prev', '[C-1] chat', '[L] lock'];
  }
}

function viewLabel(view: View): string {
  switch (view) {
    case 'inbox':
      return 'CHAT';
    case 'contacts':
      return 'CONTACTS';
    case 'pair':
      return 'PAIR';
    case 'backup':
      return 'BACKUP';
    case 'settings':
      return 'CONFIG';
  }
}

function buildTargetSuggestions(query: string, contacts: Contact[], conversations: ConeConversation[]): TargetSuggestion[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const suggestions = new Map<string, TargetSuggestion>();
  for (const contact of contacts) {
    if (contact.source === 'self') {
      continue;
    }
    if (contact.name.toLocaleLowerCase().includes(normalizedQuery) || contact.inboxId.toLocaleLowerCase().includes(normalizedQuery)) {
      suggestions.set(`contact:${contact.contactId}`, {
        kind: 'contact',
        label: contact.name,
        meta: `${contact.source} / ${shortId(contact.inboxId)}`,
        value: contact.name,
      });
    }
  }
  for (const conversation of conversations) {
    if (conversation.title.toLocaleLowerCase().includes(normalizedQuery) || conversation.peerInboxId.toLocaleLowerCase().includes(normalizedQuery)) {
      suggestions.set(`conversation:${conversation.conversationId}`, {
        conversationId: conversation.conversationId,
        kind: 'conversation',
        label: conversation.title,
        meta: `chat / ${shortId(conversation.peerInboxId)}`,
        value: conversation.title,
      });
    }
  }
  return Array.from(suggestions.values()).slice(0, 5);
}

function connectionClass(status: ConeConnectionStatus): string {
  if (status === 'live') {
    return 'state-ok';
  }
  if (status === 'offline' || status === 'stale') {
    return 'state-bad';
  }
  return 'state-warn';
}

function focusByTab(direction: 1 | -1): void {
  const focusable = Array.from(document.querySelectorAll<HTMLElement>('[data-kbd-focus="true"]'))
    .filter((element) => {
      return !element.hasAttribute('disabled') && element.getClientRects().length > 0;
    });
  if (focusable.length === 0) {
    return;
  }

  const currentIndex = focusable.findIndex((element) => element === document.activeElement);
  const nextIndex = currentIndex === -1
    ? direction === 1 ? 0 : focusable.length - 1
    : (currentIndex + direction + focusable.length) % focusable.length;
  focusable[nextIndex]?.focus();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function formatClock(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pairingGlyph(code: string): string {
  const seed = code || 'cone-of-silence';
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const chars = Array.from({ length: 48 }, (_, index) => {
    const charCode = seed.charCodeAt(index % seed.length) || 0;
    return alphabet[(charCode + index * 13) % alphabet.length] ?? '0';
  });
  return [
    'CODE-PRINT',
    chars.slice(0, 16).join('').match(/.{1,4}/gu)?.join('-') ?? '',
    chars.slice(16, 32).join('').match(/.{1,4}/gu)?.join('-') ?? '',
    chars.slice(32, 48).join('').match(/.{1,4}/gu)?.join('-') ?? '',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
