import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  createConeClient,
  deriveAccount,
  formatConnectionStatus,
  formatConversationPreview,
  generateSecretKey,
  HttpRendezvousClient,
  isVisibleChatMessage,
  latestReadOutboundId,
  messageBody,
  formatTranscriptTime,
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

import { clamp, countdown, errorMessage, hashHue, initials, relativeTime, shortId } from './format';

export type View = 'chats' | 'contacts' | 'pair' | 'backup' | 'settings';

export interface SessionState {
  accountId: string;
  client: ConeClient;
  env: XmtpEnv;
  identity: ConeIdentity;
}

export interface AppBootstrap {
  session: SessionState;
  view?: View;
  rendezvousUrl?: string;
  selectedConversationId?: string;
  composing?: boolean;
  to?: string;
}

export interface AppProps {
  bootstrap?: AppBootstrap;
}

interface TargetSuggestion {
  conversationId?: string;
  kind: 'contact' | 'conversation';
  label: string;
  meta: string;
  value: string;
}

// Optimistically rendered outbound message. `paneKey` is the conversationId,
// or 'compose' for a first message to a new recipient.
interface PendingSend {
  id: string;
  paneKey: string;
  sentAt: string;
  status: 'sending' | 'failed';
  target: string;
  text: string;
}

const VIEWS: { key: View; label: string }[] = [
  { key: 'chats', label: 'Chats' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'pair', label: 'Pair' },
  { key: 'backup', label: 'Backup' },
  { key: 'settings', label: 'Settings' },
];

const DEFAULT_RENDEZVOUS_URL = import.meta.env.VITE_COS_RENDEZVOUS_URL ?? 'http://localhost:8787';

export function App({ bootstrap }: AppProps = {}) {
  const [session, setSession] = useState<SessionState | null>(() => bootstrap?.session ?? null);
  const [secretInput, setSecretInput] = useState('');
  const [env, setEnv] = useState<XmtpEnv>('dev');
  const [rendezvousUrl, setRendezvousUrl] = useState(bootstrap?.rendezvousUrl ?? DEFAULT_RENDEZVOUS_URL);

  const [view, setView] = useState<View>(bootstrap?.view ?? 'chats');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<ConeConversation[]>([]);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, ConeMessage[]>>({});
  const [selectedConversationId, setSelectedConversationId] = useState(() => bootstrap?.selectedConversationId ?? '');
  const [composing, setComposing] = useState(() => bootstrap?.composing ?? false);
  const [filter, setFilter] = useState('');
  const [to, setTo] = useState(() => bootstrap?.to ?? '');
  const [text, setText] = useState('');
  const [suggestIndex, setSuggestIndex] = useState(0);

  const [contactName, setContactName] = useState('');
  const [contactIdentity, setContactIdentity] = useState('');
  const [editingContactId, setEditingContactId] = useState('');
  const [editingName, setEditingName] = useState('');

  const [pairCode, setPairCode] = useState('');
  const [pairPeerName, setPairPeerName] = useState('');
  const [pairShareName, setPairShareName] = useState('');
  const [pairExpiresAt, setPairExpiresAt] = useState('');

  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const sendSequence = useRef(0);
  const [connectionStatus, setConnectionStatus] = useState<ConeConnectionStatus>('connecting');
  const [sessionStartedAt, setSessionStartedAt] = useState<Date | null>(bootstrap ? new Date() : null);
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [readReceipts, setReadReceipts] = useState(true);
  const ackedRef = useRef<Record<string, string>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());

  const secretRef = useRef<HTMLTextAreaElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // ── Derived view model ────────────────────────────────────────────────
  const lastVisibleByConv = useMemo(() => {
    const map: Record<string, ConeMessage | undefined> = {};
    for (const [id, list] of Object.entries(messagesByConv)) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const candidate = list[i];
        if (candidate && isVisibleChatMessage(candidate)) {
          map[id] = candidate;
          break;
        }
      }
    }
    return map;
  }, [messagesByConv]);

  const sortedConversations = useMemo(() => {
    const time = (conversation: ConeConversation): number => {
      const last = lastVisibleByConv[conversation.conversationId];
      const iso = laterIso(conversation.updatedAt, last?.sentAt);
      return iso ? new Date(iso).getTime() : 0;
    };
    return [...conversations].sort((a, b) => time(b) - time(a));
  }, [conversations, lastVisibleByConv]);

  const filteredConversations = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) {
      return sortedConversations;
    }
    return sortedConversations.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(query) ||
        conversation.peerInboxId.toLowerCase().includes(query),
    );
  }, [sortedConversations, filter]);

  const unreadByConv = useMemo(() => {
    const map: Record<string, number> = {};
    for (const conversation of conversations) {
      const seenAt = lastSeen[conversation.conversationId];
      const seenTime = seenAt ? new Date(seenAt).getTime() : 0;
      let count = 0;
      for (const message of messagesByConv[conversation.conversationId] ?? []) {
        if (message.direction === 'inbound' && isVisibleChatMessage(message) && new Date(message.sentAt).getTime() > seenTime) {
          count += 1;
        }
      }
      if (count > 0) {
        map[conversation.conversationId] = count;
      }
    }
    return map;
  }, [conversations, messagesByConv, lastSeen]);

  const totalUnread = useMemo(
    () => Object.values(unreadByConv).reduce((sum, count) => sum + count, 0),
    [unreadByConv],
  );

  const activeConversation = conversations.find((conversation) => conversation.conversationId === selectedConversationId);
  const visibleMessages = (messagesByConv[selectedConversationId] ?? []).filter(isVisibleChatMessage);
  const lastVisibleId = visibleMessages[visibleMessages.length - 1]?.messageId ?? '';
  // Pending rows for the open pane; a 'sending' row hides as soon as its
  // delivered copy is in the local store.
  const panePending = pendingSends.filter(
    (entry) =>
      entry.paneKey === (selectedConversationId || 'compose') &&
      (entry.status === 'failed' ||
        !visibleMessages.some(
          (message) =>
            message.direction === 'outbound' &&
            messageBody(message).trim() === entry.text &&
            Math.abs(Date.parse(message.sentAt) - Date.parse(entry.sentAt)) < 300_000,
        )),
  );
  const pendingStamp = panePending.map((entry) => `${entry.id}:${entry.status}`).join('|');
  // Single "Read" marker: the most recent of our messages the peer has read.
  const readMarkerId = readReceipts ? latestReadOutboundId(messagesByConv[selectedConversationId] ?? []) : undefined;
  const nonSelfContacts = contacts.filter((contact) => contact.source !== 'self');
  const suggestions = composing ? buildTargetSuggestions(to, contacts, conversations) : [];

  // ── Latest state + actions for the global key handler ──────────────────
  // The handler is registered once per session; everything it touches goes
  // through this ref so it never reads a stale closure.
  const keyRef = useRef({
    view,
    selected: selectedConversationId,
    conversations: filteredConversations,
    pairCode,
    moveSelection,
    beginCompose,
    createCode,
    joinCode,
  });
  keyRef.current = {
    view,
    selected: selectedConversationId,
    conversations: filteredConversations,
    pairCode,
    moveSelection,
    beginCompose,
    createCode,
    joinCode,
  };

  // ── Session lifecycle: subscribe once, poll on a timer ─────────────────
  useEffect(() => {
    if (!session) {
      return;
    }
    const client = session.client;
    let cancelled = false;
    let unsubscribe: (() => void | Promise<void>) | undefined;

    setConnectionStatus('catching-up');
    void (async () => {
      await refresh(client);
      unsubscribe = await client.streamMessages(async () => {
        if (cancelled) {
          return;
        }
        setConnectionStatus('live');
        await refresh(client);
      });
      if (!cancelled) {
        setConnectionStatus('live');
      }
    })().catch((error) => {
      if (!cancelled) {
        setConnectionStatus('offline');
        fail(error);
      }
    });

    const timer = window.setInterval(() => {
      void refresh(client)
        .then(() => {
          // A successful poll clears a transient outage.
          setConnectionStatus((previous) => (previous === 'stale' || previous === 'offline' ? 'live' : previous));
        })
        .catch((error) => {
          setConnectionStatus('stale');
          fail(error);
        });
    }, 8_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void unsubscribe?.();
    };
  }, [session]);

  // Load / reset per-account read markers and the read-receipt preference.
  useEffect(() => {
    if (!session) {
      setLastSeen({});
      return;
    }
    ackedRef.current = {};
    try {
      const raw = localStorage.getItem(seenKey(session.accountId));
      setLastSeen(raw ? (JSON.parse(raw) as Record<string, string>) : {});
    } catch {
      setLastSeen({});
    }
    try {
      const pref = localStorage.getItem(readReceiptsKey(session.accountId));
      setReadReceipts(pref === null ? true : pref === '1');
    } catch {
      setReadReceipts(true);
    }
  }, [session]);

  // Mark the open conversation read, and (if enabled) tell the peer we read it.
  useEffect(() => {
    if (!session || !selectedConversationId) {
      return;
    }
    const list = messagesByConv[selectedConversationId] ?? [];
    const newest = list[list.length - 1]?.sentAt ?? new Date().toISOString();
    setLastSeen((previous) => {
      if ((previous[selectedConversationId] ?? '') >= newest) {
        return previous;
      }
      const next = { ...previous, [selectedConversationId]: newest };
      try {
        localStorage.setItem(seenKey(session.accountId), JSON.stringify(next));
      } catch {
        /* ignore quota / private mode */
      }
      return next;
    });

    const conversation = conversations.find((entry) => entry.conversationId === selectedConversationId);
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    if (readReceipts && conversation && visible) {
      let newestInbound = '';
      for (const message of list) {
        if (message.direction === 'inbound' && isVisibleChatMessage(message) && message.sentAt > newestInbound) {
          newestInbound = message.sentAt;
        }
      }
      if (newestInbound && (ackedRef.current[selectedConversationId] ?? '') < newestInbound) {
        ackedRef.current[selectedConversationId] = newestInbound;
        void session.client.sendReadReceipt(conversation.peerInboxId);
      }
    }
  }, [session, selectedConversationId, messagesByConv, conversations, readReceipts]);

  // Keep the transcript pinned to the newest message (including optimistic rows).
  useEffect(() => {
    const element = transcriptRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [selectedConversationId, lastVisibleId, visibleMessages.length, pendingStamp]);

  // Keep the selected row visible while navigating with the keyboard.
  useEffect(() => {
    if (!selectedConversationId) {
      return;
    }
    document
      .querySelector(`[data-conv-id="${cssId(selectedConversationId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedConversationId]);

  // Tick relative timestamps; tick faster while a pairing code is live.
  useEffect(() => {
    const slow = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(slow);
  }, []);
  useEffect(() => {
    if (view !== 'pair' || !pairExpiresAt) {
      return;
    }
    const fast = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(fast);
  }, [view, pairExpiresAt]);

  // ── Global keyboard accelerators ───────────────────────────────────────
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!session) {
        if (event.key === '/' && !isEditable(event.target)) {
          event.preventDefault();
          secretRef.current?.focus();
        }
        return;
      }

      const editing = isEditable(document.activeElement);
      if (editing) {
        if (event.key === 'Escape') {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        setHelpVisible((visible) => !visible);
        return;
      }
      if (event.key === 'Escape') {
        setHelpVisible(false);
        return;
      }

      const ctx = keyRef.current;

      const viewIndex = '12345'.indexOf(event.key);
      if (viewIndex >= 0) {
        event.preventDefault();
        setView(VIEWS[viewIndex]!.key);
        return;
      }

      if (ctx.view === 'chats') {
        if (event.key === 'j' || event.key === 'ArrowDown') {
          event.preventDefault();
          ctx.moveSelection(1, ctx.conversations);
        } else if (event.key === 'k' || event.key === 'ArrowUp') {
          event.preventDefault();
          ctx.moveSelection(-1, ctx.conversations);
        } else if (event.key === 'n') {
          event.preventDefault();
          ctx.beginCompose();
        } else if (event.key === '/') {
          event.preventDefault();
          filterRef.current?.focus();
        } else if (event.key === 'Enter' && document.activeElement === document.body) {
          event.preventDefault();
          if (ctx.selected) {
            requestAnimationFrame(() => messageRef.current?.focus());
          } else {
            ctx.beginCompose();
          }
        }
        return;
      }

      if (ctx.view === 'pair') {
        if (event.key === 'c') {
          event.preventDefault();
          void ctx.createCode();
        } else if (event.key === 'p' && ctx.pairCode.trim()) {
          event.preventDefault();
          void ctx.joinCode();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session]);

  // ── Actions ────────────────────────────────────────────────────────────
  async function run(action: () => Promise<void>, pending = 'Working…') {
    setBusy(true);
    setStatus(pending);
    setStatusError(false);
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function fail(error: unknown) {
    setStatus(errorMessage(error));
    setStatusError(true);
  }

  function note(message: string) {
    setStatus(message);
    setStatusError(false);
  }

  async function refresh(client: ConeClient | undefined = session?.client) {
    if (!client) {
      return;
    }
    const [nextContacts, nextConversations, allMessages] = await Promise.all([
      client.listContacts(),
      client.listConversations(),
      client.listMessages(),
    ]);
    const grouped: Record<string, ConeMessage[]> = {};
    for (const message of allMessages) {
      (grouped[message.conversationId] ??= []).push(message);
    }
    for (const list of Object.values(grouped)) {
      list.sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));
    }
    setContacts(nextContacts);
    setConversations(nextConversations);
    setMessagesByConv(grouped);
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
      setView('chats');
      note('Unlocked for this browser session. Your secret key stays in memory only.');
    }, 'Unlocking XMTP account…');
  }

  // Optimistic send: the message lands in the transcript and the composer
  // clears before the network round-trip. Only a failure changes anything —
  // the row turns red with a retry affordance.
  function send() {
    if (!session) {
      return;
    }
    const body = text.trim();
    const target = activeConversation ? activeConversation.peerInboxId : to.trim();
    if (!body || !target) {
      return;
    }
    sendSequence.current += 1;
    const entry: PendingSend = {
      id: `send-${sendSequence.current}`,
      paneKey: activeConversation?.conversationId ?? 'compose',
      sentAt: new Date().toISOString(),
      status: 'sending',
      target,
      text: body,
    };
    setPendingSends((previous) => [...previous, entry]);
    setText('');
    requestAnimationFrame(() => messageRef.current?.focus());
    void deliver(entry);
  }

  async function deliver(entry: PendingSend) {
    if (!session) {
      return;
    }
    try {
      const sent = await session.client.sendText(entry.target, entry.text);
      await refresh(session.client);
      let conversationId = sent.conversationId;
      if (!conversationId) {
        const all = await session.client.listConversations();
        conversationId =
          all.find((conversation) => conversation.updatedAt === sent.sentAt)?.conversationId ??
          all.reduce<ConeConversation | undefined>(
            (best, candidate) => (!best || (candidate.updatedAt ?? '') > (best.updatedAt ?? '') ? candidate : best),
            undefined,
          )?.conversationId;
      }
      setPendingSends((previous) => previous.filter((candidate) => candidate.id !== entry.id));
      if (entry.paneKey === 'compose' && conversationId) {
        setSelectedConversationId(conversationId);
        setComposing(false);
        setTo('');
      }
    } catch (error) {
      setPendingSends((previous) =>
        previous.map((candidate) => (candidate.id === entry.id ? { ...candidate, status: 'failed' as const } : candidate)),
      );
      fail(error);
    }
  }

  function retrySend(entry: PendingSend) {
    const refreshed = { ...entry, sentAt: new Date().toISOString(), status: 'sending' as const };
    setPendingSends((previous) => previous.map((candidate) => (candidate.id === entry.id ? refreshed : candidate)));
    void deliver(refreshed);
  }

  async function saveContact() {
    if (!session || !contactName.trim() || !contactIdentity.trim()) {
      return;
    }
    await run(async () => {
      const resolved = await session.client.resolveIdentity(contactIdentity);
      const contact = await session.client.saveContact({
        name: contactName,
        inboxId: resolved.inboxId,
        address: resolved.address,
      });
      setContactName('');
      setContactIdentity('');
      await refresh(session.client);
      note(`Saved ${contact.name}`);
    }, 'Saving contact…');
  }

  async function renameContact(contact: Contact) {
    if (!session || !editingName.trim()) {
      return;
    }
    await run(async () => {
      const updated = await session.client.saveContact({
        address: contact.address,
        inboxId: contact.inboxId,
        name: editingName,
        source: contact.source,
      });
      setEditingContactId('');
      setEditingName('');
      await refresh(session.client);
      note(`Renamed to ${updated.name}`);
    }, 'Renaming…');
  }

  async function removeContact(contact: Contact) {
    if (!session || !confirm(`Delete contact “${contact.name}”? This only removes the local alias.`)) {
      return;
    }
    await run(async () => {
      await session.client.deleteContact(contact.contactId);
      await refresh(session.client);
      note('Contact deleted');
    }, 'Deleting…');
  }

  async function removeConversation(conversation: ConeConversation) {
    if (!session || !confirm(`Delete the local copy of this chat with ${conversation.title}?`)) {
      return;
    }
    await run(async () => {
      await session.client.deleteConversation(conversation.conversationId);
      setSelectedConversationId('');
      await refresh(session.client);
      note('Local chat deleted');
    }, 'Deleting…');
  }

  async function createCode() {
    if (!session) {
      return;
    }
    await run(async () => {
      const generated = await session.client.createHandshakeCode();
      setPairCode(generated.code);
      setPairExpiresAt(generated.expiresAt);
      note('Share this code with the other side.');
    }, 'Creating code…');
  }

  async function joinCode() {
    if (!session || !pairCode.trim()) {
      return;
    }
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
      await refresh(session.client);
      setPairCode('');
      setPairExpiresAt('');
      setPairPeerName('');
      setPairShareName('');
      openContactConversation(contact);
      note(`Paired with ${contact.name}.`);
    }, 'Waiting for the other side…');
  }

  async function exportBackup() {
    if (!session) {
      return;
    }
    await run(async () => {
      const data = await session.client.exportBackup();
      const blob = new Blob([new Uint8Array(data)], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cone-${session.identity.inboxId.slice(0, 8)}.backup`;
      anchor.click();
      URL.revokeObjectURL(url);
      note('Backup exported');
    }, 'Exporting backup…');
  }

  async function importBackup(file: File | null) {
    if (!session || !file) {
      return;
    }
    await run(async () => {
      await session.client.importBackup(new Uint8Array(await file.arrayBuffer()));
      await refresh(session.client);
      note('Backup imported');
    }, 'Importing backup…');
  }

  async function lock() {
    await session?.client.close().catch(() => undefined);
    setSession(null);
    setContacts([]);
    setConversations([]);
    setMessagesByConv({});
    setSelectedConversationId('');
    setComposing(false);
    setTo('');
    setText('');
    setFilter('');
    setSessionStartedAt(null);
    setConnectionStatus('connecting');
    note('Locked. The secret key was only ever in memory.');
    requestAnimationFrame(() => secretRef.current?.focus());
  }

  function moveSelection(delta: 1 | -1, list: ConeConversation[]) {
    if (list.length === 0) {
      beginCompose();
      return;
    }
    const current = list.findIndex((conversation) => conversation.conversationId === selectedConversationId);
    const next = current < 0 ? (delta === 1 ? 0 : list.length - 1) : clamp(current + delta, 0, list.length - 1);
    const conversation = list[next];
    if (conversation) {
      setSelectedConversationId(conversation.conversationId);
      setComposing(false);
      // Keyboard navigation owns the selection: release any pointer focus so
      // Enter always opens the highlighted chat, not a previously clicked row.
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    }
  }

  function openConversation(conversation: ConeConversation, focus: boolean) {
    setSelectedConversationId(conversation.conversationId);
    setComposing(false);
    if (focus) {
      requestAnimationFrame(() => messageRef.current?.focus());
    }
  }

  function beginCompose() {
    setComposing(true);
    setSelectedConversationId('');
    setTo('');
    setView('chats');
    requestAnimationFrame(() => toRef.current?.focus());
  }

  function openContactConversation(contact: Contact) {
    setView('chats');
    const conversation = conversations.find((candidate) => candidate.peerInboxId === contact.inboxId);
    if (conversation) {
      openConversation(conversation, true);
    } else {
      setComposing(true);
      setSelectedConversationId('');
      setTo(contact.name);
      requestAnimationFrame(() => messageRef.current?.focus());
    }
  }

  function acceptSuggestion(suggestion: TargetSuggestion) {
    setTo(suggestion.value);
    if (suggestion.conversationId) {
      const conversation = conversations.find((candidate) => candidate.conversationId === suggestion.conversationId);
      if (conversation) {
        openConversation(conversation, true);
        return;
      }
    }
    setComposing(true);
    requestAnimationFrame(() => messageRef.current?.focus());
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      note('Copied to clipboard');
    } catch {
      fail(new Error('Clipboard unavailable'));
    }
  }

  // ── Render: login ──────────────────────────────────────────────────────
  if (!session) {
    return (
      <main class="screen screen--login">
        <section class="login" aria-label="Cone login">
          <header class="login__bar">
            <span class="b">cone</span>
            <span>·{env}</span>
            <span>locked</span>
            <span class="spacer" />
            <span><kbd>/</kbd> focus key</span>
          </header>
          <div class="login__body">
            <div class="login__intro">
              <div class="wordmark">
                Cone<br />of<br /><b>Silence</b>
              </div>
              <p class="muted">
                Private XMTP messaging unlocked by a portable secret key. The raw key is held in memory for this browser
                session only — never written to disk.
              </p>
              <ul class="keyhints">
                <li><kbd>/</kbd> focus secret key</li>
                <li><kbd>Tab</kbd> move between fields</li>
                <li><kbd>↵</kbd> unlock</li>
              </ul>
            </div>
            <form
              class="login__form"
              onSubmit={(event) => {
                event.preventDefault();
                void unlock(secretInput);
              }}
            >
              <label class="field">
                <span>secret key <kbd>/</kbd></span>
                <textarea
                  ref={secretRef}
                  value={secretInput}
                  onInput={(event) => setSecretInput(event.currentTarget.value)}
                  placeholder="cos_sk_v1_…"
                  rows={3}
                  autocomplete="off"
                  spellcheck={false}
                  aria-label="Secret key"
                />
              </label>
              <div class="row2">
                <label class="field">
                  <span>network</span>
                  <select value={env} onChange={(event) => setEnv(event.currentTarget.value as XmtpEnv)}>
                    <option value="dev">dev</option>
                    <option value="production">production</option>
                    <option value="local">local</option>
                  </select>
                </label>
                <label class="field">
                  <span>rendezvous</span>
                  <input value={rendezvousUrl} onInput={(event) => setRendezvousUrl(event.currentTarget.value)} />
                </label>
              </div>
              <div class="row">
                <button class="primary" type="submit" disabled={busy || !secretInput.trim()}>
                  Unlock <kbd>↵</kbd>
                </button>
                <button
                  type="button"
                  class="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSecretInput(generateSecretKey());
                    note('Generated a key — save it somewhere safe before unlocking.');
                    requestAnimationFrame(() => secretRef.current?.focus());
                  }}
                >
                  Generate key
                </button>
              </div>
              <p class={`status${statusError ? ' is-error' : ''}`} role="status">
                {busy ? 'Working…' : status || 'Paste a Cone secret key, or generate one to get started.'}
              </p>
            </form>
          </div>
        </section>
      </main>
    );
  }

  // ── Render: app ─────────────────────────────────────────────────────────
  const connectionLabel = formatConnectionStatus(connectionStatus);
  const recipientName = activeConversation?.title ?? (to.trim() || 'someone');
  const detail = Boolean(selectedConversationId) || composing;

  return (
    <main class="screen">
      <div class="app">
        <header class="topbar">
          <span class="topbar__brand">cone <span class="muted">·{session.env}</span></span>
          <span class="topbar__id">{shortId(session.identity.inboxId)}</span>
          <span class="topbar__status">
            <i class={`dot ${connectionDot(connectionStatus)}`} /> {connectionLabel}
          </span>
          <span class="topbar__counts">
            <b>{conversations.length}</b> chats · <b>{nonSelfContacts.length}</b> contacts
            {totalUnread > 0 ? <> · <b>{totalUnread}</b> new</> : null}
          </span>
          <span class={`topbar__msg${statusError ? ' is-error' : ''}`}>{busy ? 'Working…' : status}</span>
          <button class="topbar__lock" type="button" aria-keyshortcuts="?" onClick={() => setHelpVisible((visible) => !visible)}>
            ?
          </button>
          <button class="topbar__lock" type="button" onClick={() => void lock()}>
            Lock
          </button>
        </header>

        <nav class="tabs" aria-label="Sections">
          {VIEWS.map((entry, index) => (
            <button
              key={entry.key}
              type="button"
              class={view === entry.key ? 'active' : ''}
              aria-current={view === entry.key ? 'page' : undefined}
              onClick={() => setView(entry.key)}
            >
              {entry.label}
              {entry.key === 'chats' && totalUnread > 0 ? <span class="badge">{totalUnread}</span> : null}
              <kbd>{index + 1}</kbd>
            </button>
          ))}
          <span class="tabs__spacer" />
        </nav>

        <div class="view">
          {view === 'chats' && (
            <div class="chats" data-detail={String(detail)}>
              <aside class="list" aria-label="Chats">
                <div class="list__head">
                  <input
                    ref={filterRef}
                    class="filter"
                    value={filter}
                    onInput={(event) => setFilter(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setFilter('');
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="Filter chats   /"
                    aria-label="Filter chats"
                  />
                  {filter.trim() && (
                    <small class="list__count">
                      {filteredConversations.length} of {sortedConversations.length} chats · esc clears
                    </small>
                  )}
                </div>
                <div class="list__scroll">
                  <button
                    type="button"
                    class={`conv conv--new${composing ? ' active' : ''}`}
                    onClick={beginCompose}
                  >
                    <span>+ New message</span>
                    <kbd>n</kbd>
                  </button>
                  {filteredConversations.map((conversation) => {
                    const last = lastVisibleByConv[conversation.conversationId];
                    const unread = unreadByConv[conversation.conversationId] ?? 0;
                    const preview = last ? formatConversationPreview(last) : 'No messages yet';
                    return (
                      <button
                        type="button"
                        key={conversation.conversationId}
                        data-conv-id={conversation.conversationId}
                        class={`conv${conversation.conversationId === selectedConversationId ? ' active' : ''}${unread > 0 ? ' unread' : ''}`}
                        aria-current={conversation.conversationId === selectedConversationId ? 'true' : undefined}
                        onClick={() => openConversation(conversation, pointerFine())}
                      >
                        <span class="avatar" style={`--hue:${hashHue(conversation.peerInboxId)}`} aria-hidden="true">
                          {initials(conversation.title)}
                        </span>
                        <span class="conv__body">
                          <span class="conv__top">
                            <span class="conv__name">{conversation.title}</span>
                            <time class="conv__time">{relativeTime(laterIso(conversation.updatedAt, last?.sentAt), nowTick)}</time>
                          </span>
                          <span class="conv__sub">
                            <span class="conv__preview">{preview}</span>
                            {unread > 0 ? <span class="badge">{unread}</span> : null}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {filteredConversations.length === 0 && (
                    <p class="list__empty">
                      {filter.trim() ? 'No chats match that filter.' : 'No chats yet. Press n or + New message to start one, or pair from the Pair tab.'}
                    </p>
                  )}
                </div>
              </aside>

              <section class="thread" aria-label="Conversation">
                <header class="thread__head">
                  <button class="back ghost" type="button" onClick={() => { setSelectedConversationId(''); setComposing(false); }}>
                    ← Chats
                  </button>
                  {activeConversation ? (
                    <>
                      <span class="avatar sm" style={`--hue:${hashHue(activeConversation.peerInboxId)}`} aria-hidden="true">
                        {initials(activeConversation.title)}
                      </span>
                      <span class="thread__title">{activeConversation.title}</span>
                      <span class="thread__peer">{shortId(activeConversation.peerInboxId)}</span>
                      <span class="thread__spacer" />
                      <button class="ghost danger" type="button" onClick={() => void removeConversation(activeConversation)}>
                        Delete
                      </button>
                    </>
                  ) : (
                    <>
                      <span class="thread__title">New message</span>
                      <span class="thread__peer">contact · XMTP inbox ID · 0x address</span>
                    </>
                  )}
                </header>

                <div class="transcript" ref={transcriptRef} role="log" aria-live="polite" aria-relevant="additions text">
                  {visibleMessages.length === 0 && panePending.length === 0 ? (
                    <div class="sys">
                      <p>· <b>{sessionLabel(sessionStartedAt)}</b> — session ready</p>
                      <p>· {activeConversation ? 'No messages yet.' : 'Pick a recipient below, then write your message.'}</p>
                      <p>· {activeConversation
                        ? 'Type below and press Enter to send.'
                        : 'Recipients can be a contact name, XMTP inbox ID, or 0x address — type to see matches.'}</p>
                      {!activeConversation && <p>· Pressing <b>Enter</b> or <b>n</b> from the chat list jumps straight here.</p>}
                    </div>
                  ) : (
                    <>
                      {visibleMessages.map((message) => (
                        <Fragment key={message.messageId}>
                          <MessageRow
                            message={message}
                            sender={message.direction === 'outbound' ? 'me' : activeConversation?.title ?? shortId(message.senderInboxId)}
                          />
                          {message.messageId === readMarkerId && (
                            <p class="read-receipt" aria-label="Read by recipient">✓✓ Read</p>
                          )}
                        </Fragment>
                      ))}
                      {panePending.map((entry) => (
                        <article class={`msg outbound${entry.status === 'failed' ? ' failed' : ''}`} key={entry.id}>
                          {entry.status === 'failed' && <span class="msg__fail" aria-label="Not delivered">✗ </span>}
                          <span class="msg__time">{formatTranscriptTime(entry.sentAt)}</span>
                          <span class="msg__sep"> - </span>
                          <span class="msg__sender">me</span>
                          <span class="msg__sep">: </span>
                          <span class="msg__body">{entry.text}</span>
                          {entry.status === 'failed' && (
                            <button type="button" class="retry" onClick={() => retrySend(entry)}>
                              retry
                            </button>
                          )}
                        </article>
                      ))}
                    </>
                  )}
                </div>

                <form
                  class="composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  {!activeConversation && (
                    <div class="composer__to">
                      <input
                        ref={toRef}
                        value={to}
                        onFocus={() => setComposing(true)}
                        onInput={(event) => {
                          setTo(event.currentTarget.value);
                          setSuggestIndex(0);
                        }}
                        onKeyDown={(event) => {
                          if (suggestions.length === 0) {
                            return;
                          }
                          if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setSuggestIndex((index) => clamp(index + 1, 0, suggestions.length - 1));
                          } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setSuggestIndex((index) => clamp(index - 1, 0, suggestions.length - 1));
                          } else if (event.key === 'Enter') {
                            const choice = suggestions[suggestIndex];
                            if (choice) {
                              event.preventDefault();
                              acceptSuggestion(choice);
                            }
                          }
                        }}
                        placeholder="To — contact, XMTP inbox ID, or 0x address"
                        aria-label="Recipient"
                      />
                      {suggestions.length > 0 && (
                        <div class="suggestions" role="listbox" aria-label="Matches">
                          {suggestions.map((suggestion, index) => (
                            <button
                              type="button"
                              role="option"
                              aria-selected={index === suggestIndex}
                              key={`${suggestion.kind}:${suggestion.value}`}
                              class={index === suggestIndex ? 'active' : ''}
                              onClick={() => acceptSuggestion(suggestion)}
                            >
                              <span class="avatar sm" style={`--hue:${hashHue(suggestion.value)}`} aria-hidden="true">
                                {initials(suggestion.label)}
                              </span>
                              <span class="s-name">{suggestion.label}</span>
                              <span class="s-meta">{suggestion.meta}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div class="composer__row">
                    <textarea
                      ref={messageRef}
                      class="composer__input"
                      value={text}
                      onFocus={() => activeConversation && setComposing(false)}
                      onInput={(event) => setText(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void send();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                      rows={1}
                      placeholder={`Message ${recipientName}…`}
                      aria-label="Message"
                    />
                    <button
                      class="primary composer__send"
                      type="submit"
                      disabled={!text.trim() || (!activeConversation && !to.trim())}
                    >
                      Send <kbd>↵</kbd>
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}

          {view === 'contacts' && (
            <div class="cols two">
              <section class="panel">
                <div class="panel__head">
                  Contacts <small class="muted">{nonSelfContacts.length}</small>
                </div>
                {contacts.length === 0 && (
                  <div class="empty-card">
                    <strong>No contacts yet.</strong>
                    <span>Add an XMTP-reachable identity below, or use Pair when neither side wants to share an address first.</span>
                  </div>
                )}
                {contacts.map((contact) => (
                  <div class="contact" key={contact.contactId}>
                    <span class="avatar" style={`--hue:${hashHue(contact.inboxId)}`} aria-hidden="true">
                      {initials(contact.name)}
                    </span>
                    {editingContactId === contact.contactId ? (
                      <>
                        <input
                          class="contact__body"
                          value={editingName}
                          onInput={(event) => setEditingName(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void renameContact(contact);
                            } else if (event.key === 'Escape') {
                              setEditingContactId('');
                            }
                          }}
                          aria-label="New name"
                          ref={(node: HTMLInputElement | null) => {
                            if (node && document.activeElement !== node) {
                              node.focus();
                            }
                          }}
                        />
                        <div class="contact__actions">
                          <button type="button" class="primary" onClick={() => void renameContact(contact)}>Save</button>
                          <button type="button" class="ghost" onClick={() => setEditingContactId('')}>Cancel</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div class="contact__body">
                          <span class="contact__name">{contact.name}</span>
                          <small class="contact__meta">{contact.address ?? shortId(contact.inboxId)} · {contact.source}</small>
                        </div>
                        {contact.source === 'self' ? (
                          <span class="tag">you</span>
                        ) : (
                          <div class="contact__actions">
                            <button type="button" onClick={() => openContactConversation(contact)}>Message</button>
                            <button type="button" class="ghost" onClick={() => { setEditingContactId(contact.contactId); setEditingName(contact.name); }}>Rename</button>
                            <button type="button" class="ghost danger" onClick={() => void removeContact(contact)}>Delete</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </section>
              <section class="panel">
                <div class="panel__head">Add contact</div>
                <label class="field">
                  <span>name</span>
                  <input value={contactName} onInput={(event) => setContactName(event.currentTarget.value)} placeholder="Alice" />
                </label>
                <label class="field">
                  <span>identity</span>
                  <input value={contactIdentity} onInput={(event) => setContactIdentity(event.currentTarget.value)} placeholder="XMTP inbox ID or 0x address" />
                </label>
                <div class="row">
                  <button class="primary" type="button" disabled={busy || !contactName.trim() || !contactIdentity.trim()} onClick={() => void saveContact()}>
                    Add contact
                  </button>
                </div>
                <p class="lede">Contact names are local aliases. They never become global usernames and don’t change anyone’s XMTP identity.</p>
              </section>
            </div>
          )}

          {view === 'pair' && (
            <div class="cols two">
              <section class="panel">
                <div class="panel__head">Pair</div>
                <p class="lede">
                  Two people or agents enter the same one-time code. Each posts an encrypted offer to the rendezvous
                  service; once both are present you confirm over XMTP and save each other as contacts. A code works for
                  exactly two participants and expires after ten minutes — the pairing itself is permanent and the code is
                  never needed again. No messages pass through rendezvous.
                </p>
                <label class="field">
                  <span>handshake code</span>
                  <input
                    value={pairCode}
                    onInput={(event) => setPairCode(event.currentTarget.value)}
                    placeholder="forest-wormhole-direction"
                  />
                </label>
                <div class="row">
                  <button type="button" disabled={busy} onClick={() => void createCode()}>Create code <kbd>c</kbd></button>
                  <button class="primary" type="button" disabled={busy || !pairCode.trim()} onClick={() => void joinCode()}>Join code <kbd>p</kbd></button>
                </div>
                <label class="field">
                  <span>save the other side as</span>
                  <input value={pairPeerName} onInput={(event) => setPairPeerName(event.currentTarget.value)} placeholder="Alice, Codex, Agent A…" />
                </label>
                <label class="field">
                  <span>share my name with them</span>
                  <input value={pairShareName} onInput={(event) => setPairShareName(event.currentTarget.value)} placeholder="My laptop, bot1…" />
                </label>
              </section>
              <aside class="panel log" aria-label="Pairing status">
                <div class="panel__head">Code to share</div>
                <div class="code-card">
                  <span class={`code${pairCode ? '' : ' placeholder'}`}>{pairCode || 'no code yet'}</span>
                  <div class="row">
                    <button type="button" disabled={!pairCode} onClick={() => void copy(pairCode)}>Copy</button>
                    {pairExpiresAt && <span class="muted">code expires in {countdown(pairExpiresAt, nowTick)}</span>}
                  </div>
                </div>
                <p class="log__line"><span>rzv</span><em>{rendezvousUrl}</em></p>
                <p class="log__line"><span>net</span><em>{session.env}</em></p>
                <p class="log__line"><span>you</span><em>{shortId(session.identity.inboxId)}</em></p>
              </aside>
            </div>
          )}

          {view === 'backup' && (
            <div class="cols">
              <section class="panel center">
                <div class="panel__head">Backup</div>
                <p class="lede">
                  A backup contains your contacts and cached messages, encrypted with a key derived from your secret. You
                  can only restore it by unlocking with the same secret key.
                </p>
                <div class="row">
                  <button class="primary" type="button" disabled={busy} onClick={() => void exportBackup()}>Export backup</button>
                  <label class="field" style="display:inline-flex">
                    <button type="button" onClick={(event) => (event.currentTarget.nextElementSibling as HTMLInputElement)?.click()}>Import backup</button>
                    <input
                      type="file"
                      accept=".backup,.cos,application/octet-stream"
                      style="display:none"
                      onChange={(event) => void importBackup(event.currentTarget.files?.[0] ?? null)}
                    />
                  </label>
                </div>
              </section>
            </div>
          )}

          {view === 'settings' && (
            <div class="cols">
              <section class="panel center">
                <div class="panel__head">Settings</div>
                <dl class="kv">
                  <div>
                    <dt>XMTP inbox ID</dt>
                    <dd>
                      <span class="kv__val">{session.identity.inboxId}</span>
                      <button class="copy ghost" type="button" onClick={() => void copy(session.identity.inboxId)}>copy</button>
                    </dd>
                  </div>
                  <div>
                    <dt>EVM address</dt>
                    <dd>
                      <span class="kv__val">{session.identity.address ?? 'unavailable'}</span>
                      {session.identity.address && <button class="copy ghost" type="button" onClick={() => void copy(session.identity.address!)}>copy</button>}
                    </dd>
                  </div>
                  <div>
                    <dt>network</dt>
                    <dd><span class="kv__val">{session.env}</span></dd>
                  </div>
                  <div>
                    <dt>rendezvous</dt>
                    <dd><span class="kv__val">{rendezvousUrl}</span></dd>
                  </div>
                </dl>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={readReceipts}
                    onChange={(event) => {
                      const next = event.currentTarget.checked;
                      setReadReceipts(next);
                      ackedRef.current = {};
                      try {
                        localStorage.setItem(readReceiptsKey(session.accountId), next ? '1' : '0');
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  <span class="toggle__text">
                    <strong>Read receipts</strong>
                    <small>
                      When on, people you chat with can see when you’ve read their messages, and you’ll see “✓✓ Read” on the
                      last message they’ve read. When off, you send and see neither — only failed sends are ever marked.
                    </small>
                  </span>
                </label>
                <p class="lede">
                  The raw secret key is never written to localStorage or IndexedDB. Unlock again with the same secret on a
                  new browser session.
                </p>
              </section>
            </div>
          )}
        </div>

        <footer class="hints">
          <FooterHints view={view} hasSelection={Boolean(activeConversation)} />
        </footer>

        {helpVisible && (
          <div class="help-overlay" role="dialog" aria-modal="true" aria-label="Help" onClick={() => setHelpVisible(false)}>
            <section class="help-card" onClick={(event) => event.stopPropagation()}>
              <header>
                <strong>Help</strong>
                <button type="button" class="ghost" onClick={() => setHelpVisible(false)}>
                  close <kbd>esc</kbd>
                </button>
              </header>
              <div class="help-row">
                <b>Navigate</b>
                <span><kbd>1</kbd>–<kbd>5</kbd> switch sections · <kbd>j</kbd>/<kbd>k</kbd> move through chats · <kbd>↵</kbd> opens the selected chat, or starts a new message when none is selected · <kbd>esc</kbd> stops typing</span>
              </div>
              <div class="help-row">
                <b>Write</b>
                <span><kbd>↵</kbd> sends instantly — your message appears immediately and is only marked if delivery fails (✗ with a retry) · <kbd>shift</kbd>+<kbd>↵</kbd> newline</span>
              </div>
              <div class="help-row">
                <b>Filter</b>
                <span><kbd>/</kbd> focuses the chat filter · typing narrows the list live · <kbd>esc</kbd> clears it</span>
              </div>
              <div class="help-row">
                <b>New message</b>
                <span><kbd>n</kbd> · the recipient can be a contact name, XMTP inbox ID, or 0x address · <kbd>↑</kbd>/<kbd>↓</kbd> pick a suggestion</span>
              </div>
              <div class="help-row">
                <b>Read receipts</b>
                <span>On by default (toggle in Settings). When on, peers can see when you’ve read them and you’ll see “✓✓ Read” on the last message they’ve read. When off, you neither send nor see them — only failed sends are marked.</span>
              </div>
              <div class="help-row">
                <b>Pair</b>
                <span>From the Pair tab: <kbd>c</kbd> creates a one-time code, <kbd>p</kbd> joins one. A code lasts ten minutes and works for exactly two participants — the pairing itself is permanent.</span>
              </div>
              <div class="help-row">
                <b>Privacy</b>
                <span>Your secret key lives in memory only; Lock wipes it. Contact names are local aliases, never global usernames.</span>
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

function MessageRow({ message, sender }: { message: ConeMessage; sender: string }) {
  return (
    <article class={`msg ${message.direction}`}>
      <span class="msg__time">{formatTranscriptTime(message.sentAt)}</span>
      <span class="msg__sep"> - </span>
      <span class="msg__sender">{sender}</span>
      <span class="msg__sep">: </span>
      <span class="msg__body">{messageBody(message)}</span>
    </article>
  );
}

// Tab switching lives in the tabs row (each shows its number), so the footer
// only carries keys unique to the current view, plus help.
function FooterHints({ view, hasSelection }: { view: View; hasSelection: boolean }) {
  const hints: [string, string][] =
    view === 'chats'
      ? hasSelection
        ? [['↵', 'send'], ['esc', 'navigate'], ['j/k', 'switch chat'], ['n', 'new'], ['/', 'filter'], ['?', 'help']]
        : [['j/k', 'move'], ['↵', 'start message'], ['n', 'new message'], ['/', 'filter'], ['?', 'help']]
      : view === 'pair'
        ? [['c', 'create code'], ['p', 'join code'], ['?', 'help']]
        : [['?', 'help']];
  return (
    <>
      {hints.map(([key, label]) => (
        <span key={key}>
          <kbd>{key}</kbd> <b>{label}</b>
        </span>
      ))}
    </>
  );
}

function buildTargetSuggestions(query: string, contacts: Contact[], conversations: ConeConversation[]): TargetSuggestion[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const suggestions = new Map<string, TargetSuggestion>();
  // Prefer existing chats: a contact who already has a conversation is offered
  // as that conversation (so we reuse the thread) rather than as a duplicate.
  const conversationInboxes = new Set(conversations.map((conversation) => conversation.peerInboxId));
  for (const conversation of conversations) {
    if (conversation.title.toLowerCase().includes(normalized) || conversation.peerInboxId.toLowerCase().includes(normalized)) {
      suggestions.set(`inbox:${conversation.peerInboxId}`, {
        conversationId: conversation.conversationId,
        kind: 'conversation',
        label: conversation.title,
        meta: `chat · ${shortId(conversation.peerInboxId)}`,
        value: conversation.title,
      });
    }
  }
  for (const contact of contacts) {
    if (contact.source === 'self' || conversationInboxes.has(contact.inboxId)) {
      continue;
    }
    if (contact.name.toLowerCase().includes(normalized) || contact.inboxId.toLowerCase().includes(normalized)) {
      suggestions.set(`inbox:${contact.inboxId}`, {
        kind: 'contact',
        label: contact.name,
        meta: `${contact.source} · ${shortId(contact.inboxId)}`,
        value: contact.name,
      });
    }
  }
  return Array.from(suggestions.values()).slice(0, 6);
}

function connectionDot(status: ConeConnectionStatus): string {
  if (status === 'live') {
    return 'ok';
  }
  if (status === 'offline' || status === 'stale') {
    return 'bad';
  }
  return 'warn';
}

function cssId(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function pointerFine(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: fine)').matches
    : true;
}

function laterIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}

function sessionLabel(startedAt: Date | null): string {
  return startedAt ? startedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : 'now';
}

function seenKey(accountId: string): string {
  return `cos:seen:${accountId}`;
}

function readReceiptsKey(accountId: string): string {
  return `cos:readReceipts:${accountId}`;
}
