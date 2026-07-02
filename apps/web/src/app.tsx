import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  createConeClient,
  deriveAccount,
  errorMessage,
  filterMatchSnippet,
  formatConnectionStatus,
  formatConversationPreview,
  formatGroupUpdate,
  formatRetention,
  formatTranscriptTime,
  generateSecretKey,
  groupHistoryNotice,
  HttpRendezvousClient,
  isAllowedConversation,
  isDeniedConversation,
  isGroupUpdateEnvelope,
  isGroupUpdateMessage,
  isRequestConversation,
  isVisibleChatMessage,
  laterIso,
  latestInboundAt,
  latestReadOutboundId,
  matchConversationFilter,
  matchesPendingSend,
  messageBody,
  parseSecretKey,
  RETENTION_PRESETS_MS,
  type ConeConnectionStatus,
  type ConversationFilterMatch,
  type FilterMatchSnippet,
  type ConeClient,
  type ConeConversation,
  type ConeGroupMember,
  type ConeIdentity,
  type ConeMessage,
  type Contact,
  type GroupInviteLink,
  type GroupMemberLevel,
  type HandshakeCode,
  type XmtpEnv,
} from '@cone/core';
import { browserAccountNamespace, createBrowserXmtpAdapter, IndexedDbStore } from '@cone/xmtp-browser';

import { clamp, countdown, hashHue, initials, relativeTime, shortId } from './format';

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
  chatScope?: 'chats' | 'requests';
  filter?: string;
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
  // Set for group sends: groups are addressed by conversation, not identity.
  conversationId?: string;
  text: string;
}

const VIEWS: { key: View; label: string }[] = [
  { key: 'chats', label: 'Chats' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'pair', label: 'Pair' },
  { key: 'backup', label: 'Backup' },
  { key: 'settings', label: 'Settings' },
];

const DEFAULT_RENDEZVOUS_URL = import.meta.env.VITE_CONE_RENDEZVOUS_URL ?? 'http://localhost:8787';

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
  // Within the Chats section, the list shows the allowed inbox or the
  // unknown-sender Requests sub-surface.
  const [chatScope, setChatScope] = useState<'chats' | 'requests'>(() => bootstrap?.chatScope ?? 'chats');
  const [showRequests, setShowRequests] = useState(true);
  const [filter, setFilter] = useState(() => bootstrap?.filter ?? '');
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

  // Synchronous group invite code (inviter side, shown in the group info
  // panel while waiting) and the joiner-side fields on the Pair tab.
  const [groupInviteCode, setGroupInviteCode] = useState('');
  const [groupInviteExpiresAt, setGroupInviteExpiresAt] = useState('');
  const [groupInviteLink, setGroupInviteLink] = useState<GroupInviteLink | null>(null);
  const [groupJoinCode, setGroupJoinCode] = useState('');
  const [groupJoinShareName, setGroupJoinShareName] = useState('');

  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  // Keyboard-stepped (not yet applied) value of the disappearing-messages
  // select; Enter commits it, Esc/blur discards it. Pointer selection commits
  // directly and never uses the draft.
  const [timerDraft, setTimerDraft] = useState<string | null>(null);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  // DM header "name this contact" row — the Chats-side way to (re)create a
  // local alias for a peer, matching the TUI's `r`.
  const [peerNameOpen, setPeerNameOpen] = useState(false);
  const [peerNameDraft, setPeerNameDraft] = useState('');
  const [groupMembers, setGroupMembers] = useState<ConeGroupMember[]>([]);
  const [memberInput, setMemberInput] = useState('');
  const [groupNameDraft, setGroupNameDraft] = useState('');
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
  const timerRef = useRef<HTMLSelectElement>(null);

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

  // Consent partitions the chat list: the allowed inbox, the unknown-sender
  // Requests sub-surface, and the blocked (denied) list managed in Settings.
  const allowedConversations = useMemo(() => sortedConversations.filter(isAllowedConversation), [sortedConversations]);
  const requestConversations = useMemo(() => sortedConversations.filter(isRequestConversation), [sortedConversations]);
  const deniedConversations = useMemo(() => sortedConversations.filter(isDeniedConversation), [sortedConversations]);
  const requestCount = requestConversations.length;

  // Matching lives in @cone/core (matchConversationFilter) so this list and
  // the rendered match highlights can never disagree about why a row matched.
  const filteredConversations = useMemo(() => {
    const base = chatScope === 'requests' ? requestConversations : allowedConversations;
    if (!filter.trim()) {
      return base;
    }
    return base.filter((conversation) => matchConversationFilter(conversation, filter) !== null);
  }, [allowedConversations, requestConversations, chatScope, filter]);

  // Unread counts cover the allowed inbox only; Requests have their own badge
  // and must not inflate the main "new" count.
  const unreadByConv = useMemo(() => {
    const map: Record<string, number> = {};
    for (const conversation of conversations) {
      if (!isAllowedConversation(conversation)) {
        continue;
      }
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
  // The rendered transcript also carries group updates ("Alice added Bob") as
  // system lines; they stay excluded from previews/unread counts.
  const transcriptMessages = (messagesByConv[selectedConversationId] ?? []).filter(
    (message) => isVisibleChatMessage(message) || isGroupUpdateMessage(message),
  );
  const lastVisibleId = transcriptMessages[transcriptMessages.length - 1]?.messageId ?? '';
  const contactNameByInbox = useMemo(() => {
    const map = new Map<string, string>();
    for (const contact of contacts) {
      if (contact.source !== 'self') {
        map.set(contact.inboxId, contact.name);
      }
    }
    return map;
  }, [contacts]);
  // Contacts-first display name for group members and senders.
  const memberLabel = (inboxId: string) =>
    inboxId === session?.identity.inboxId ? 'you' : contactNameByInbox.get(inboxId) ?? shortId(inboxId);
  const activeGroup = activeConversation?.kind === 'group' ? activeConversation : undefined;
  const activeGroupInactive = activeGroup?.active === false;
  // Pending rows for the open pane; a 'sending' row hides as soon as its
  // delivered copy is in the local store.
  const panePending = pendingSends.filter(
    (entry) =>
      entry.paneKey === (selectedConversationId || 'compose') &&
      (entry.status === 'failed' || !visibleMessages.some((message) => matchesPendingSend(message, entry))),
  );
  const pendingStamp = panePending.map((entry) => `${entry.id}:${entry.status}`).join('|');
  // Single "Read" marker: the most recent of our messages the peer has read.
  const readMarkerId = readReceipts ? latestReadOutboundId(messagesByConv[selectedConversationId] ?? []) : undefined;
  const nonSelfContacts = contacts.filter((contact) => contact.source !== 'self');
  const suggestions = composing ? buildTargetSuggestions(to, contacts, conversations) : [];
  // Timer select choices: off + presets, plus the conversation's current value
  // when it's custom (set as free text in the TUI or by another client) so a
  // custom timer is always visible, never silently misrendered as a preset.
  const timerValue = String(activeConversation?.retention?.durationMs ?? 0);
  const timerOptions = ['0', ...RETENTION_PRESETS_MS.map(String)];
  if (activeConversation?.retention && !RETENTION_PRESETS_MS.includes(activeConversation.retention.durationMs)) {
    timerOptions.push(timerValue);
  }

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
      // Reconcile network state into the local mirrors before first paint:
      // consent and disappearing-messages settings changed from other devices
      // or by peers never ride the message stream, only sync. Best-effort so
      // an offline open still shows the cached read model.
      await client.sync().catch(() => undefined);
      await refresh(client);
      // Human surface: stream allowed + unknown so Requests update live. Denied
      // is never streamed.
      unsubscribe = await client.streamMessages(async () => {
        if (cancelled) {
          return;
        }
        setConnectionStatus('live');
        await refresh(client);
      }, { consentStates: ['allowed', 'unknown'] });
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

    // Periodic network sync (TUI parity, 60s): pulls conversation-level state
    // the stream never carries and purges expired disappearing messages.
    const syncTimer = window.setInterval(() => {
      void client.sync()
        .then(async (result) => {
          if (cancelled) {
            return;
          }
          await refresh(client);
          setConnectionStatus((previous) =>
            result.ok ? (previous === 'stale' || previous === 'offline' ? 'live' : previous) : 'stale');
        })
        .catch(() => {
          if (!cancelled) {
            setConnectionStatus('stale');
          }
        });
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(syncTimer);
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
    try {
      const pref = localStorage.getItem(showRequestsKey(session.accountId));
      setShowRequests(pref === null ? true : pref === '1');
    } catch {
      setShowRequests(true);
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
    // Never acknowledge a Request: previewing an unknown sender must not tell
    // them you read it. Receipts are only for allowed conversations, and
    // DM-only — in a group they would broadcast to every member.
    if (readReceipts && conversation && isAllowedConversation(conversation) && visible && conversation.kind !== 'group' && conversation.peerInboxId) {
      const newestInbound = latestInboundAt(list);
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
        } else if (event.key === 'Escape' && isEditable(document.activeElement)) {
          (document.activeElement as HTMLElement | null)?.blur();
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
        } else if (event.key === 'e' && ctx.selected) {
          // TUI parity: e opens the disappearing-messages timer for the
          // selected chat (arrows change it, change applies immediately).
          event.preventDefault();
          timerRef.current?.focus();
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

  // The group info panel belongs to one conversation; switching chats closes
  // it. Opening it fetches a fresh member list (the cached mirror is the
  // offline fallback).
  useEffect(() => {
    setGroupInfoOpen(false);
    setMemberInput('');
    setPeerNameOpen(false);
    setPeerNameDraft('');
  }, [selectedConversationId]);

  useEffect(() => {
    if (!groupInfoOpen || !session || !activeGroup) {
      return;
    }
    setGroupNameDraft(activeGroup.groupName ?? '');
    setGroupMembers(activeGroup.members ?? []);
    if (activeGroup.active === false) {
      return;
    }
    let cancelled = false;
    void session.client.listGroupMembers(activeGroup.conversationId)
      .then((members) => {
        if (!cancelled) {
          setGroupMembers(members);
        }
      })
      .catch(() => {
        /* offline — the cached mirror is already shown */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupInfoOpen, session, activeGroup?.conversationId, activeGroup?.active]);

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
    const group = activeConversation?.kind === 'group' ? activeConversation : undefined;
    if (group?.active === false) {
      note('You are no longer a member of this group');
      return;
    }
    const target = activeConversation ? activeConversation.peerInboxId ?? '' : to.trim();
    if (!body || (!target && !group)) {
      return;
    }
    sendSequence.current += 1;
    const entry: PendingSend = {
      id: `send-${sendSequence.current}`,
      paneKey: activeConversation?.conversationId ?? 'compose',
      sentAt: new Date().toISOString(),
      status: 'sending',
      target,
      conversationId: group?.conversationId,
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
      const sent = entry.conversationId
        ? await session.client.sendToConversation(entry.conversationId, entry.text)
        : await session.client.sendText(entry.target, entry.text);
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

  function discardSend(entry: PendingSend) {
    setPendingSends((previous) => previous.filter((candidate) => candidate.id !== entry.id));
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

  // ── Group management (the info panel) ──────────────────────────────────
  async function reloadGroupMembers(conversationId: string) {
    if (!session) {
      return;
    }
    setGroupMembers(await session.client.listGroupMembers(conversationId));
  }

  async function renameActiveGroup() {
    if (!session || !activeGroup || !groupNameDraft.trim()) {
      return;
    }
    await run(async () => {
      await session.client.renameGroup(activeGroup.conversationId, groupNameDraft);
      await refresh(session.client);
      note('Group renamed — every member sees the new name');
    }, 'Renaming…');
  }

  async function addGroupMember() {
    if (!session || !activeGroup || !memberInput.trim()) {
      return;
    }
    await run(async () => {
      await session.client.addGroupMembers(activeGroup.conversationId, [memberInput.trim()]);
      setMemberInput('');
      await reloadGroupMembers(activeGroup.conversationId);
      await refresh(session.client);
      note('Member added');
    }, 'Adding…');
  }

  async function removeGroupMember(member: ConeGroupMember) {
    if (!session || !activeGroup || !confirm(`Remove ${memberLabel(member.inboxId)} from ${activeGroup.title}? Everyone in the group will see it.`)) {
      return;
    }
    await run(async () => {
      await session.client.removeGroupMembers(activeGroup.conversationId, [{ inboxId: member.inboxId }]);
      await reloadGroupMembers(activeGroup.conversationId);
      await refresh(session.client);
      note(`Removed ${memberLabel(member.inboxId)}`);
    }, 'Removing…');
  }

  async function setMemberLevel(member: ConeGroupMember, level: GroupMemberLevel) {
    if (!session || !activeGroup) {
      return;
    }
    await run(async () => {
      await session.client.setGroupMemberLevel(activeGroup.conversationId, { inboxId: member.inboxId }, level);
      await reloadGroupMembers(activeGroup.conversationId);
      await refresh(session.client);
      note(`${memberLabel(member.inboxId)} is now ${level === 'superAdmin' ? 'an owner' : level === 'admin' ? 'an admin' : 'a member'}`);
    }, 'Updating role…');
  }

  async function leaveActiveGroup() {
    if (!session || !activeGroup) {
      return;
    }
    const self = groupMembers.find((member) => member.inboxId === session.identity.inboxId);
    const otherOwner = groupMembers.some((member) => member.level === 'superAdmin' && member.inboxId !== session.identity.inboxId);
    // XMTP forbids the last owner leaving; explain the transfer move instead.
    if (self?.level === 'superAdmin' && !otherOwner) {
      note('You are the only owner — promote another member to owner first');
      return;
    }
    if (!confirm(`Leave ${activeGroup.title}? Everyone in the group will see that you left. Your local history is kept.`)) {
      return;
    }
    await run(async () => {
      await session.client.leaveGroup(activeGroup.conversationId);
      await refresh(session.client);
      note(`Left ${activeGroup.title}`);
    }, 'Leaving…');
  }

  async function blockActiveGroup() {
    if (!session || !activeGroup) {
      return;
    }
    if (!confirm(`Block ${activeGroup.title}? It disappears from your chats without telling anyone — unlike leaving, nobody sees it.`)) {
      return;
    }
    await run(async () => {
      await session.client.setConversationConsent(activeGroup.conversationId, 'denied');
      setSelectedConversationId('');
      setGroupInfoOpen(false);
      await refresh(session.client);
      note(`Blocked ${activeGroup.title}`);
    }, 'Blocking…');
  }

  // Accept a Request: mark the sender allowed (moves them to the inbox) and,
  // optionally, save a contact under a chosen name in the same flow.
  async function acceptRequest(conversation: ConeConversation, saveName?: string) {
    if (!session) {
      return;
    }
    await run(async () => {
      // Conversation-scoped: DMs allow the peer's inbox, groups allow the group.
      await session.client.setConversationConsent(conversation.conversationId, 'allowed');
      if (saveName?.trim() && conversation.kind !== 'group' && conversation.peerInboxId) {
        await session.client.saveContact({
          name: saveName.trim(),
          inboxId: conversation.peerInboxId,
          address: conversation.peerAddress,
          source: 'manual',
        });
      }
      await refresh(session.client);
      setChatScope('chats');
      openConversation(conversation, false);
      note(`Accepted ${peerLabel(conversation)}`);
    }, 'Accepting…');
  }

  async function blockRequest(conversation: ConeConversation) {
    if (!session || !confirm(`Block ${peerLabel(conversation)}? They’ll be hidden and can’t reach you. You can unblock from Settings.`)) {
      return;
    }
    await run(async () => {
      await session.client.setConversationConsent(conversation.conversationId, 'denied');
      if (selectedConversationId === conversation.conversationId) {
        setSelectedConversationId('');
      }
      await refresh(session.client);
      note(`Blocked ${peerLabel(conversation)}`);
    }, 'Blocking…');
  }

  async function unblockConversation(conversation: ConeConversation) {
    if (!session) {
      return;
    }
    await run(async () => {
      await session.client.setConversationConsent(conversation.conversationId, 'allowed');
      await refresh(session.client);
      note(`Unblocked ${peerLabel(conversation)}`);
    }, 'Unblocking…');
  }

  // Set the conversation's disappearing-messages timer (0 = off). Applies to
  // both sides via XMTP settings; expired messages are hidden immediately and
  // purged from local storage on sync.
  async function setTimer(conversation: ConeConversation, durationMs: number) {
    if (!session) {
      return;
    }
    await run(async () => {
      await session.client.setRetention(conversation.conversationId, durationMs > 0 ? durationMs : null);
      await refresh(session.client);
      note(durationMs > 0 ? `Disappearing messages: ${formatRetention(durationMs)}` : 'Disappearing messages off');
    }, 'Setting timer…');
  }

  // Minting a code immediately joins its room: pairing needs both sides
  // waiting, so "create, then separately join your own code" was a trap.
  async function createCode() {
    if (!session) {
      return;
    }
    let generated: HandshakeCode | undefined;
    await run(async () => {
      generated = await session.client.createHandshakeCode();
      setPairCode(generated.code);
      setPairExpiresAt(generated.expiresAt);
    }, 'Creating code…');
    if (generated) {
      await joinCode(generated.code);
    }
  }

  // Synchronous group invite, inviter side: mint a single-use code and wait
  // for the join request. The joiner is added directly — the code was created
  // seconds ago, so intent is unambiguous. No contact is auto-saved.
  async function inviteToActiveGroup() {
    if (!session || !activeGroup) {
      return;
    }
    const group = activeGroup;
    await run(async () => {
      const generated = await session.client.createHandshakeCode();
      setGroupInviteCode(generated.code);
      setGroupInviteExpiresAt(generated.expiresAt);
      try {
        const result = await session.client.inviteToGroupWithCode(generated.code, group.conversationId);
        await reloadGroupMembers(group.conversationId);
        await refresh(session.client);
        note(`Added ${result.joiner.proposedName ?? shortId(result.joiner.inboxId)} to ${group.title}`);
      } finally {
        setGroupInviteCode('');
        setGroupInviteExpiresAt('');
      }
    }, 'Waiting for someone to join the code…');
  }

  // Save (or rename) a local contact for the open DM's peer — the Chats-side
  // equivalent of the TUI's `r`, and the way back after deleting a contact.
  async function savePeerName() {
    const peerInboxId = activeConversation?.peerInboxId;
    const name = peerNameDraft.trim();
    if (!session || !peerInboxId || !name) {
      return;
    }
    await run(async () => {
      await session.client.saveContact({
        name,
        inboxId: peerInboxId,
        address: activeConversation?.peerAddress,
        source: 'manual',
      });
      setPeerNameOpen(false);
      setPeerNameDraft('');
      await refresh(session.client);
      note(`Saved ${name}`);
    }, 'Saving…');
  }

  // Async invite link: a capability token with a long TTL, admitted by this
  // account's periodic sync — nothing to wait for at mint time.
  async function createLinkForActiveGroup() {
    if (!session || !activeGroup) {
      return;
    }
    const group = activeGroup;
    await run(async () => {
      const link = await session.client.createGroupInviteLink(group.conversationId);
      setGroupInviteLink(link);
      note('Share the token; joiners are admitted when this app syncs.');
    }, 'Creating invite link…');
  }

  async function revokeActiveGroupLink() {
    if (!session || !groupInviteLink) {
      return;
    }
    const link = groupInviteLink;
    await run(async () => {
      await session.client.revokeGroupInviteLink(link.linkId);
      setGroupInviteLink(null);
      note('Invite link revoked.');
    }, 'Revoking…');
  }

  // Joiner side: the join request reaches the inviter over rendezvous; the
  // membership itself arrives as an XMTP welcome, which the recorded pending
  // join auto-allows (requesting to join is implied consent).
  async function joinGroupCode() {
    if (!session || !groupJoinCode.trim()) {
      return;
    }
    await run(async () => {
      const result = await session.client.joinGroupWithCode(groupJoinCode, {
        proposedName: groupJoinShareName.trim() || undefined,
      });
      setGroupJoinCode('');
      setGroupJoinShareName('');
      // Sync right away so the welcome lands as soon as the add propagates.
      await session.client.sync();
      await refresh(session.client);
      note(`Join requested — ${result.groupName ?? 'the group'} appears once the inviter's add arrives.`);
    }, 'Waiting for the inviter…');
  }

  async function joinCode(codeOverride?: string) {
    const code = (codeOverride ?? pairCode).trim();
    if (!session || !code) {
      return;
    }
    await run(async () => {
      const result = await session.client.pairWithCode(code, { proposedName: pairShareName || undefined });
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
    setChatScope('chats');
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
                <b>Cone</b>
              </div>
              <p class="muted">
                Private XMTP messaging unlocked by a portable secret key. The raw key is held in memory for this browser
                session only — never written to disk.
              </p>
              <ul class="keyhints">
                <li><kbd>/</kbd> focus secret key</li>
                <li><kbd>Tab</kbd> move between fields</li>
                <li><kbd>↵</kbd> unlock</li>
                <li><kbd>esc</kbd> unfocus — leave the field, back to keys</li>
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
                  placeholder="cone_sk_v1_…"
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
            <b>{allowedConversations.length}</b> chats · <b>{nonSelfContacts.length}</b> contacts
            {totalUnread > 0 ? <> · <b>{totalUnread}</b> new</> : null}
            {requestCount > 0 ? <> · <b>{requestCount}</b> request{requestCount === 1 ? '' : 's'}</> : null}
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
                {showRequests && (requestCount > 0 || chatScope === 'requests') && (
                  <div class="scope-tabs" role="tablist" aria-label="Inbox or requests">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={chatScope === 'chats'}
                      class={chatScope === 'chats' ? 'active' : ''}
                      onClick={() => { setChatScope('chats'); setFilter(''); setSelectedConversationId(''); }}
                    >
                      Chats
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={chatScope === 'requests'}
                      class={chatScope === 'requests' ? 'active' : ''}
                      onClick={() => { setChatScope('requests'); setFilter(''); setSelectedConversationId(''); setComposing(false); }}
                    >
                      Requests {requestCount > 0 ? <span class="badge">{requestCount}</span> : null}
                    </button>
                  </div>
                )}
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
                    placeholder={chatScope === 'requests' ? 'Filter requests   /' : 'Filter chats   /'}
                    aria-label={chatScope === 'requests' ? 'Filter requests' : 'Filter chats'}
                  />
                  {filter.trim() && (
                    <small class="list__count">
                      {filteredConversations.length} of {(chatScope === 'requests' ? requestConversations : allowedConversations).length} {chatScope === 'requests' ? 'requests' : 'chats'} · esc clears
                    </small>
                  )}
                </div>
                <div class="list__scroll">
                  {chatScope === 'chats' && (
                    <button
                      type="button"
                      class={`conv conv--new${composing ? ' active' : ''}`}
                      onClick={beginCompose}
                    >
                      <span>+ New message</span>
                      <kbd>n</kbd>
                    </button>
                  )}
                  {filteredConversations.map((conversation) => {
                    const last = lastVisibleByConv[conversation.conversationId];
                    const unread = unreadByConv[conversation.conversationId] ?? 0;
                    const preview = last ? formatConversationPreview(last) : 'No messages yet';
                    // While filtering, mark the matched characters in the name;
                    // a match on the (not displayed) full inbox ID is revealed
                    // in place of the preview instead.
                    const match = filter.trim() ? matchConversationFilter(conversation, filter) : null;
                    const idSnippet = match?.field === 'inboxId' ? filterMatchSnippet(match) : null;
                    if (chatScope === 'requests') {
                      return (
                        <div
                          key={conversation.conversationId}
                          data-conv-id={conversation.conversationId}
                          class={`conv conv--request${conversation.conversationId === selectedConversationId ? ' active' : ''}`}
                        >
                          <button type="button" class="conv__open" onClick={() => openConversation(conversation, false)}>
                            <span class="avatar" style={`--hue:${hashHue(conversation.peerInboxId ?? conversation.conversationId)}`} aria-hidden="true">
                              {initials(conversation.title)}
                            </span>
                            <span class="conv__body">
                              <span class="conv__top">
                                <span class="conv__name"><MatchedLabel conversation={conversation} match={match} /></span>
                                <time class="conv__time">{relativeTime(laterIso(conversation.updatedAt, last?.sentAt), nowTick)}</time>
                              </span>
                              <span class="conv__sub">
                                <span class="conv__preview">
                                  {idSnippet ? <MatchedSnippet snippet={idSnippet} /> : preview}
                                </span>
                              </span>
                            </span>
                          </button>
                          <span class="conv__req-actions">
                            <button type="button" class="primary" onClick={() => void acceptRequest(conversation)}>Accept</button>
                            <button type="button" class="ghost danger" onClick={() => void blockRequest(conversation)}>Block</button>
                          </span>
                        </div>
                      );
                    }
                    return (
                      <button
                        type="button"
                        key={conversation.conversationId}
                        data-conv-id={conversation.conversationId}
                        class={`conv${conversation.conversationId === selectedConversationId ? ' active' : ''}${unread > 0 ? ' unread' : ''}`}
                        aria-current={conversation.conversationId === selectedConversationId ? 'true' : undefined}
                        onClick={() => openConversation(conversation, pointerFine())}
                      >
                        <span class="avatar" style={`--hue:${hashHue(conversation.peerInboxId ?? conversation.conversationId)}`} aria-hidden="true">
                          {initials(conversation.title)}
                        </span>
                        <span class="conv__body">
                          <span class="conv__top">
                            <span class="conv__name"><MatchedLabel conversation={conversation} match={match} /></span>
                            {conversation.retention && (
                              <span class="conv__timer" title={`Disappearing messages: ${formatRetention(conversation.retention.durationMs)}`} aria-label="Disappearing messages on">⌛</span>
                            )}
                            <time class="conv__time">{relativeTime(laterIso(conversation.updatedAt, last?.sentAt), nowTick)}</time>
                          </span>
                          <span class="conv__sub">
                            <span class="conv__preview">
                              {idSnippet ? <MatchedSnippet snippet={idSnippet} /> : preview}
                            </span>
                            {unread > 0 ? <span class="badge">{unread}</span> : null}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {filteredConversations.length === 0 && (
                    <p class="list__empty">
                      {chatScope === 'requests'
                        ? (filter.trim() ? 'No requests match that filter.' : 'No requests. Messages from people you haven’t accepted will appear here.')
                        : (filter.trim() ? 'No chats match that filter.' : 'No chats yet. Press n or + New message to start one, or pair from the Pair tab.')}
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
                      <span class="avatar sm" style={`--hue:${hashHue(activeConversation.peerInboxId ?? activeConversation.conversationId)}`} aria-hidden="true">
                        {initials(activeConversation.title)}
                      </span>
                      <span class="thread__title">{peerLabel(activeConversation)}</span>
                      {activeConversation.kind === 'group' ? (
                        <button
                          type="button"
                          class={`thread__peer thread__peer--btn${groupInfoOpen ? ' active' : ''}`}
                          onClick={() => setGroupInfoOpen((open) => !open)}
                          title="Group info — members, roles, and settings"
                        >
                          group · {activeConversation.memberCount ?? '?'} members{activeGroupInactive ? ' · left' : ''} ▾
                        </button>
                      ) : (
                        <button
                          type="button"
                          class={`thread__peer thread__peer--btn${peerNameOpen ? ' active' : ''}`}
                          onClick={() => {
                            setPeerNameDraft(contacts.find((contact) => contact.inboxId === activeConversation.peerInboxId)?.name ?? '');
                            setPeerNameOpen((open) => !open);
                          }}
                          title="Name this contact — a local alias, visible only to you"
                        >
                          {shortId(activeConversation.peerInboxId ?? '')} ✎
                        </button>
                      )}
                      <span class="thread__spacer" />
                      {isRequestConversation(activeConversation) ? (
                        <>
                          <span class="thread__tag">request</span>
                          <button class="primary" type="button" onClick={() => void acceptRequest(activeConversation)}>Accept</button>
                          <button class="ghost danger" type="button" onClick={() => void blockRequest(activeConversation)}>Block</button>
                        </>
                      ) : (
                        <>
                          <label class="thread__timer" title="Disappearing messages — applies to both sides">
                            <span aria-hidden="true">⌛</span>
                            <select
                              ref={timerRef}
                              aria-label="Disappearing messages timer"
                              aria-keyshortcuts="e"
                              value={timerDraft ?? timerValue}
                              onChange={(event) => {
                                // Pointer (or native popup) selection commits immediately.
                                const durationMs = Number(event.currentTarget.value);
                                setTimerDraft(null);
                                event.currentTarget.blur();
                                void setTimer(activeConversation, durationMs);
                              }}
                              onKeyDown={(event) => {
                                // App-wide vocabulary on the focused select: j/k or
                                // arrows step a draft, Enter applies, Esc leaves.
                                const current = timerDraft ?? timerValue;
                                if (event.key === 'j' || event.key === 'ArrowDown' || event.key === 'k' || event.key === 'ArrowUp') {
                                  event.preventDefault();
                                  const delta = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1;
                                  const index = timerOptions.indexOf(current);
                                  setTimerDraft(timerOptions[clamp(index + delta, 0, timerOptions.length - 1)]!);
                                } else if (event.key === 'Enter') {
                                  event.preventDefault();
                                  setTimerDraft(null);
                                  event.currentTarget.blur();
                                  if (current !== timerValue) {
                                    void setTimer(activeConversation, Number(current));
                                  }
                                } else if (event.key === 'Escape') {
                                  event.preventDefault();
                                  setTimerDraft(null);
                                  event.currentTarget.blur();
                                }
                              }}
                              onBlur={() => setTimerDraft(null)}
                            >
                              {timerOptions.map((value) => (
                                <option key={value} value={value}>{value === '0' ? 'off' : formatRetention(Number(value))}</option>
                              ))}
                            </select>
                          </label>
                          <button class="ghost danger" type="button" onClick={() => void removeConversation(activeConversation)}>
                            Delete
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <span class="thread__title">New message</span>
                      <span class="thread__peer">contact · XMTP inbox ID · 0x address</span>
                    </>
                  )}
                </header>

                {peerNameOpen && activeConversation && activeConversation.kind !== 'group' && activeConversation.peerInboxId && (
                  <div class="group-info" aria-label="Name this contact">
                    <div class="group-info__rename">
                      <input
                        value={peerNameDraft}
                        onInput={(event) => setPeerNameDraft(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void savePeerName();
                          } else if (event.key === 'Escape') {
                            setPeerNameOpen(false);
                          }
                        }}
                        placeholder="Contact name — a local alias, visible only to you"
                        aria-label="Contact name"
                      />
                      <button type="button" class="ghost" disabled={!peerNameDraft.trim() || busy} onClick={() => void savePeerName()}>
                        Save
                      </button>
                    </div>
                  </div>
                )}

                {groupInfoOpen && activeGroup && (
                  <div class="group-info" aria-label="Group info">
                    {activeGroup.groupDescription && <p class="group-info__desc">{activeGroup.groupDescription}</p>}
                    {activeGroupInactive ? (
                      <p class="group-info__note">You are no longer a member. Your local history is kept.</p>
                    ) : (
                      <div class="group-info__rename">
                        <input
                          value={groupNameDraft}
                          onInput={(event) => setGroupNameDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void renameActiveGroup();
                            }
                          }}
                          placeholder="Group name"
                          aria-label="Group name (shared — every member sees it)"
                        />
                        <button
                          type="button"
                          class="ghost"
                          disabled={!groupNameDraft.trim() || groupNameDraft.trim() === (activeGroup.groupName ?? '')}
                          onClick={() => void renameActiveGroup()}
                        >
                          Rename
                        </button>
                      </div>
                    )}
                    <div class="group-info__members">
                      {groupMembers.map((member) => {
                        const self = member.inboxId === session?.identity.inboxId;
                        return (
                          <div class="group-info__member" key={member.inboxId}>
                            <span class="avatar sm" style={`--hue:${hashHue(member.inboxId)}`} aria-hidden="true">
                              {initials(memberLabel(member.inboxId))}
                            </span>
                            <span class="group-info__name">
                              {memberLabel(member.inboxId)}
                              {member.level !== 'member' && (
                                <span class={`role-chip${member.level === 'superAdmin' ? ' owner' : ''}`}>
                                  {member.level === 'superAdmin' ? 'owner' : 'admin'}
                                </span>
                              )}
                              {member.consentState === 'denied' && <span class="role-chip blocked">blocked</span>}
                            </span>
                            {!self && !activeGroupInactive && (
                              <span class="group-info__actions">
                                {member.level !== 'superAdmin' && (
                                  <button
                                    type="button"
                                    class="ghost"
                                    title={member.level === 'member' ? 'Make admin' : 'Make owner'}
                                    onClick={() => void setMemberLevel(member, member.level === 'member' ? 'admin' : 'superAdmin')}
                                  >
                                    ↑
                                  </button>
                                )}
                                {member.level !== 'member' && (
                                  <button
                                    type="button"
                                    class="ghost"
                                    title={member.level === 'superAdmin' ? 'Demote to admin' : 'Demote to member'}
                                    onClick={() => void setMemberLevel(member, member.level === 'superAdmin' ? 'admin' : 'member')}
                                  >
                                    ↓
                                  </button>
                                )}
                                <button type="button" class="ghost danger" title="Remove from group" onClick={() => void removeGroupMember(member)}>
                                  ×
                                </button>
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {groupMembers.length === 0 && <p class="muted">No member list yet — it fills in after a sync.</p>}
                    </div>
                    {!activeGroupInactive && (
                      <div class="group-info__add">
                        <input
                          value={memberInput}
                          onInput={(event) => setMemberInput(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void addGroupMember();
                            }
                          }}
                          placeholder="Add member — contact, XMTP inbox ID, or 0x address"
                          aria-label="Add member"
                        />
                        <button type="button" class="ghost" disabled={!memberInput.trim()} onClick={() => void addGroupMember()}>
                          Add
                        </button>
                      </div>
                    )}
                    {!activeGroupInactive && (
                      <div class="group-info__invite">
                        {groupInviteCode ? (
                          <>
                            <span class="code">{groupInviteCode}</span>
                            <button type="button" class="ghost" onClick={() => void copy(groupInviteCode)}>Copy</button>
                            <span class="muted">
                              waiting for the joiner — expires in {countdown(groupInviteExpiresAt, nowTick)}
                            </span>
                          </>
                        ) : (
                          <button
                            type="button"
                            class="ghost"
                            disabled={busy}
                            title="Mint a single-use code; whoever enters it within 10 minutes is added directly"
                            onClick={() => void inviteToActiveGroup()}
                          >
                            Invite by code
                          </button>
                        )}
                      </div>
                    )}
                    {!activeGroupInactive && (
                      <div class="group-info__invite">
                        {groupInviteLink && groupInviteLink.conversationId === activeGroup.conversationId ? (
                          <>
                            <span class="code">{groupInviteLink.token}</span>
                            <button type="button" class="ghost" onClick={() => void copy(groupInviteLink.token)}>Copy</button>
                            <button type="button" class="ghost danger" onClick={() => void revokeActiveGroupLink()}>Revoke</button>
                            <span class="muted">joiners are admitted when this app syncs</span>
                          </>
                        ) : (
                          <button
                            type="button"
                            class="ghost"
                            disabled={busy}
                            title="Mint an async token — anyone holding it is added when this app syncs. Single use by default."
                            onClick={() => void createLinkForActiveGroup()}
                          >
                            Invite link
                          </button>
                        )}
                      </div>
                    )}
                    {!activeGroupInactive && (
                      <div class="group-info__foot">
                        <button type="button" class="ghost" onClick={() => void leaveActiveGroup()} title="Everyone in the group sees that you left">
                          Leave group
                        </button>
                        <button type="button" class="ghost danger" onClick={() => void blockActiveGroup()} title="Hides the group without telling anyone">
                          Block group
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div class="transcript" ref={transcriptRef} role="log" aria-live="polite" aria-relevant="additions text">
                  {transcriptMessages.length === 0 && panePending.length === 0 ? (
                    <div class="sys">
                      <p>· <b>{sessionLabel(sessionStartedAt)}</b> — session ready</p>
                      {activeGroup && session && <p>· {groupHistoryNotice(activeGroup, session.identity.inboxId)}</p>}
                      <p>· {activeConversation ? 'No messages yet.' : 'Pick a recipient below, then write your message.'}</p>
                      <p>· {activeConversation
                        ? 'Type below and press Enter to send.'
                        : 'Recipients can be a contact name, XMTP inbox ID, or 0x address — type to see matches.'}</p>
                      {!activeConversation && <p>· Pressing <b>Enter</b> or <b>n</b> from the chat list jumps straight here.</p>}
                    </div>
                  ) : (
                    <>
                      {activeGroup && session && (
                        <div class="sys">
                          <p>· {groupHistoryNotice(activeGroup, session.identity.inboxId)}</p>
                        </div>
                      )}
                      {transcriptMessages.map((message) =>
                        isGroupUpdateEnvelope(message.json) ? (
                          <div class="sys sys--inline" key={message.messageId}>
                            {formatGroupUpdate(message.json, memberLabel).map((line) => (
                              <p key={line}>
                                <span class="msg__time">{formatTranscriptTime(message.sentAt)}</span> · {line}
                              </p>
                            ))}
                          </div>
                        ) : (
                          <MessageRow
                            key={message.messageId}
                            message={message}
                            sender={
                              message.direction === 'outbound'
                                ? 'me'
                                : activeGroup
                                  ? memberLabel(message.senderInboxId)
                                  : activeConversation?.title ?? shortId(message.senderInboxId)
                            }
                            reserveStatus={readReceipts}
                            readMarker={message.messageId === readMarkerId}
                          />
                        ),
                      )}
                      {panePending.map((entry) => (
                        <article class={`msg outbound${entry.status === 'failed' ? ' failed' : ''}`} key={entry.id}>
                          <span class="msg__content">
                            {entry.status === 'failed' && <span class="msg__fail" aria-label="Not delivered">✗ </span>}
                            <span class="msg__time">{formatTranscriptTime(entry.sentAt)}</span>
                            <span class="msg__sep"> - </span>
                            <span class="msg__sender">me</span>
                            <span class="msg__sep">: </span>
                            <span class="msg__body">{entry.text}</span>
                            {entry.status === 'failed' && (
                              <span class="msg__actions">
                                <span class="msg__fail-note">not delivered</span>
                                <button type="button" class="retry" onClick={() => retrySend(entry)}>retry</button>
                                <button type="button" class="discard" onClick={() => discardSend(entry)}>delete</button>
                              </span>
                            )}
                          </span>
                          {readReceipts && <span class="msg__status" />}
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
                      disabled={activeGroupInactive}
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
                      placeholder={activeGroupInactive ? 'You are no longer a member of this group' : `Message ${recipientName}…`}
                      aria-label="Message"
                    />
                    <button
                      class="primary composer__send"
                      type="submit"
                      disabled={!text.trim() || activeGroupInactive || (!activeConversation && !to.trim())}
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
                  Two people or agents enter the same one-time code. Creating a code starts waiting immediately — just
                  have the other side enter it within ten minutes (CLI: <code>cone pair &lt;code&gt;</code>). Once both
                  sides are present you confirm over XMTP and save each other as contacts; the pairing is permanent and
                  the code is never needed again. No messages pass through rendezvous.
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
                  <span>save their name as</span>
                  <input value={pairPeerName} onInput={(event) => setPairPeerName(event.currentTarget.value)} placeholder="Alice, Codex, Agent A…" />
                </label>
                <label class="field">
                  <span>offer them a name for you</span>
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
              <section class="panel">
                <div class="panel__head">Join a group</div>
                <p class="lede">
                  Someone in a group creates an invite from the group's info panel: a spoken code (ten minutes, they
                  wait and add you directly) or a link token (they add you the next time their app syncs). Enter
                  either here — the group appears in Chats once their add arrives. Invites are single use by default
                  and nobody is saved as a contact.
                </p>
                <label class="field">
                  <span>invite code or token</span>
                  <input
                    value={groupJoinCode}
                    onInput={(event) => setGroupJoinCode(event.currentTarget.value)}
                    placeholder="anchor-beacon-cedar… or cone_gi_v1_…"
                  />
                </label>
                <label class="field">
                  <span>offer them a name for you</span>
                  <input
                    value={groupJoinShareName}
                    onInput={(event) => setGroupJoinShareName(event.currentTarget.value)}
                    placeholder="My laptop, bot1…"
                  />
                </label>
                <div class="row">
                  <button class="primary" type="button" disabled={busy || !groupJoinCode.trim()} onClick={() => void joinGroupCode()}>
                    Join group
                  </button>
                </div>
              </section>
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
                      accept=".backup,.cone,application/octet-stream"
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
                <p class="lede">
                  The inbox ID and the address both name this account — either one reaches you. The XMTP inbox ID is
                  your identity inside Cone; the EVM address is the wallet key that registered it, shown so people on
                  other XMTP-based messengers can reach you by address. Cone uses it for nothing on-chain.
                </p>
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
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={showRequests}
                    onChange={(event) => {
                      const next = event.currentTarget.checked;
                      setShowRequests(next);
                      if (!next) {
                        setChatScope('chats');
                      }
                      try {
                        localStorage.setItem(showRequestsKey(session.accountId), next ? '1' : '0');
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  <span class="toggle__text">
                    <strong>Show requests</strong>
                    <small>
                      Messages from people you haven’t accepted wait in a separate Requests tab in Chats, shown when there
                      are any. Turn this off to hide that tab entirely. New senders never reach your main inbox until you
                      accept them.
                    </small>
                  </span>
                </label>
                {deniedConversations.length > 0 && (
                  <div class="blocked">
                    <div class="panel__head">Blocked <small class="muted">{deniedConversations.length}</small></div>
                    {deniedConversations.map((conversation) => (
                      <div class="blocked__row" key={conversation.conversationId}>
                        <span class="avatar sm" style={`--hue:${hashHue(conversation.peerInboxId ?? conversation.conversationId)}`} aria-hidden="true">
                          {initials(conversation.title)}
                        </span>
                        <span class="blocked__name">{peerLabel(conversation)}</span>
                        <button type="button" class="ghost" onClick={() => void unblockConversation(conversation)}>Unblock</button>
                      </div>
                    ))}
                  </div>
                )}
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
                <span><kbd>1</kbd>–<kbd>5</kbd> switch sections · <kbd>j</kbd>/<kbd>k</kbd> move through chats · <kbd>↵</kbd> opens the selected chat, or starts a new message when none is selected · <kbd>esc</kbd> unfocuses the field, back to keys</span>
              </div>
              <div class="help-row">
                <b>Write</b>
                <span><kbd>↵</kbd> sends instantly — your message appears immediately, and a successful send is silent. Only a message that fails to reach the network is marked (✗ “not delivered”), with retry or delete. <kbd>shift</kbd>+<kbd>↵</kbd> newline</span>
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
                <b>Requests</b>
                <span>Messages from people you haven’t accepted wait in the <b>Requests</b> tab in Chats, never your main inbox. Open one to preview it (no read receipt is sent), then <b>Accept</b> to move it to your inbox or <b>Block</b> to hide them. Unblock from Settings. Toggle the tab off in Settings.</span>
              </div>
              <div class="help-row">
                <b>Disappearing</b>
                <span>The ⌛ control in a chat’s header (or <kbd>e</kbd>) sets a disappearing-messages timer — off, 30s up to 4w. With it focused, <kbd>j</kbd>/<kbd>k</kbd> or arrows step, <kbd>↵</kbd> applies, <kbd>esc</kbd> leaves. Either side can change it (custom durations from other clients show as-is); messages sent while a timer is on vanish for both sides after it elapses — earlier history stays. Cooperative, not cryptographic: a client that doesn’t honor timers can keep its copies.</span>
              </div>
              <div class="help-row">
                <b>Read receipts</b>
                <span>On by default (toggle in Settings). When on, peers can see when you’ve read them and you’ll see “✓✓ Read” on the last message they’ve read. When off, you neither send nor see them — only failed sends are marked. Requests never send receipts.</span>
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

function MessageRow({
  message,
  sender,
  reserveStatus,
  readMarker,
}: {
  message: ConeMessage;
  sender: string;
  reserveStatus?: boolean;
  readMarker?: boolean;
}) {
  return (
    <article class={`msg ${message.direction}`}>
      <span class="msg__content">
        <span class="msg__time">{formatTranscriptTime(message.sentAt)}</span>
        <span class="msg__sep"> - </span>
        <span class="msg__sender">{sender}</span>
        <span class="msg__sep">: </span>
        <span class="msg__body">{messageBody(message)}</span>
      </span>
      {message.direction === 'outbound' && reserveStatus && (
        <span class="msg__status">{readMarker ? '✓✓ Read' : ''}</span>
      )}
    </article>
  );
}

// Tab switching lives in the tabs row (each shows its number), so the footer
// only carries keys unique to the current view, plus help.
function FooterHints({ view, hasSelection }: { view: View; hasSelection: boolean }) {
  const hints: [string, string][] =
    view === 'chats'
      ? hasSelection
        ? [['↵', 'send'], ['esc', 'unfocus'], ['j/k', 'switch chat'], ['n', 'new'], ['e', 'timer'], ['/', 'filter'], ['?', 'help']]
        : [['j/k', 'move'], ['↵', 'start message'], ['n', 'new message'], ['/', 'filter'], ['esc', 'unfocus'], ['?', 'help']]
      : view === 'pair'
        ? [['c', 'create code'], ['p', 'join code'], ['esc', 'unfocus'], ['?', 'help']]
        : [['esc', 'unfocus'], ['?', 'help']];
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
    const isGroup = conversation.kind === 'group';
    if (conversation.title.toLowerCase().includes(normalized) || (conversation.peerInboxId ?? '').toLowerCase().includes(normalized)) {
      suggestions.set(isGroup ? `group:${conversation.conversationId}` : `inbox:${conversation.peerInboxId}`, {
        conversationId: conversation.conversationId,
        kind: 'conversation',
        label: conversation.title,
        meta: isGroup ? `group · ${conversation.memberCount ?? '?'} members` : `chat · ${shortId(conversation.peerInboxId ?? '')}`,
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

// An unnamed peer's conversation title is its raw XMTP inbox ID; show a short
// form until it's named via a contact. Named conversations keep their name.
function peerLabel(conversation: Pick<ConeConversation, 'title' | 'peerInboxId'>): string {
  return conversation.title === conversation.peerInboxId ? shortId(conversation.peerInboxId) : conversation.title;
}

// The conversation name with the live filter's matched characters marked.
// Inbox-ID matches aren't visible in the name — MatchedSnippet reveals those.
function MatchedLabel({ conversation, match }: { conversation: ConeConversation; match: ConversationFilterMatch | null }) {
  if (!match || match.field !== 'title') {
    return <>{peerLabel(conversation)}</>;
  }
  return (
    <>
      {match.value.slice(0, match.index)}
      <mark>{match.value.slice(match.index, match.index + match.length)}</mark>
      {match.value.slice(match.index + match.length)}
    </>
  );
}

// Shown in place of the preview while a filter matches the peer's full inbox
// ID: the fragment of the ID that matched, so the row explains itself.
function MatchedSnippet({ snippet }: { snippet: FilterMatchSnippet }) {
  return (
    <span class="conv__match">
      id {snippet.before}<mark>{snippet.hit}</mark>{snippet.after}
    </span>
  );
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

function sessionLabel(startedAt: Date | null): string {
  return startedAt ? startedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : 'now';
}

function seenKey(accountId: string): string {
  return `cone:seen:${accountId}`;
}

function readReceiptsKey(accountId: string): string {
  return `cone:readReceipts:${accountId}`;
}

function showRequestsKey(accountId: string): string {
  return `cone:showRequests:${accountId}`;
}
