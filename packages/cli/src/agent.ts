import { ConeError, type ConeClient, type ConeMessage, type Unsubscribe } from '@cone/core';

/** One connection, durable mail, and a wake-up signal shared by CLI and adapters. */
export class AgentSession {
  private unsubscribe?: Unsubscribe;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private stopped = false;
  private streamBroken = false;
  private failure?: unknown;
  private retryMs = 1000;
  private revision = 0;
  private readonly waiters = new Set<() => void>();

  constructor(readonly client: ConeClient, private readonly report: (error: unknown) => void = console.error) {}

  async start(): Promise<void> {
    await this.refresh();
    if (this.failure) throw this.failure;
  }

  async receive(options: {
    consumer?: string; limit?: number; waitMs?: number; excludeConversationIds?: string[];
    signal?: AbortSignal;
  } = {}): Promise<{ messages: ConeMessage[]; more: boolean }> {
    const waitMs = options.waitMs ?? 0;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('waitMs must be a nonnegative integer');
    const deadline = Date.now() + waitMs;
    while (!this.stopped) {
      options.signal?.throwIfAborted();
      const observed = this.revision;
      const result = await this.client.receiveMessages(options);
      if (result.messages.length || Date.now() >= deadline) {
        if (!result.messages.length && this.failure) throw this.failure;
        return result;
      }
      if (this.failure) throw this.failure;
      await this.waitForChange(observed, deadline - Date.now(), options.signal);
    }
    throw new Error('Cone session closed');
  }

  async acknowledge(messageIds: string[], consumer?: string): Promise<{ acknowledged: string[] }> {
    await this.client.acknowledgeMessages(messageIds, { consumer });
    this.wake();
    return { acknowledged: messageIds };
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) return this.refreshing;
    clearTimeout(this.timer);
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    try {
      if (this.streamBroken && this.unsubscribe) {
        await this.unsubscribe();
        this.unsubscribe = undefined;
      }
      if (!this.unsubscribe) {
        this.streamBroken = false;
        // Subscribe before catch-up so a message cannot fall between them.
        this.unsubscribe = await this.client.streamMessages(() => this.wake(), {
          consentStates: ['allowed'],
          onError: error => {
            this.streamBroken = true;
            this.failure = error;
            this.wake();
            if (!this.stopped) {
              clearTimeout(this.timer);
              this.timer = setTimeout(() => { void this.refresh(); }, this.retryMs);
            }
          },
        });
      }
      const sync = await this.client.sync();
      if (!sync.ok) throw new ConeError('SYNC_FAILED', sync.errors.join('; '));
      // A failed outgoing message must not prevent other conversations from
      // receiving work. Keep it durable and report each retry failure.
      try { await this.client.retryPendingSends(); }
      catch (error) { this.report(error); }
      if (this.streamBroken) throw this.failure ?? new Error('XMTP stream ended during synchronization');
      this.failure = undefined;
      this.retryMs = 1000;
    } catch (error) {
      this.failure = error;
      this.report(error);
      this.retryMs = Math.min(this.retryMs * 2, 30000);
    } finally {
      this.wake();
      if (!this.stopped) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.refresh(); }, this.failure ? this.retryMs : 30000);
      }
    }
  }

  private wake(): void {
    this.revision++;
    for (const resolve of this.waiters) resolve();
  }

  private waitForChange(observed: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
      if (observed !== this.revision || this.stopped || signal?.aborted) done();
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wake();
    await this.refreshing;
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
