/**
 * WebSocket client for the /ws contract:
 *   out: {op:'subscribe'|'unsubscribe', channel, market?} and {op:'auth', token}
 *   in:  {channel, data, seq, reset?}
 * Ref-counted subscriptions, exponential-backoff reconnect with full
 * resubscribe (auth frame first), and status events.
 *
 * `seq` is a PER-CHANNEL monotonic counter from the server: consecutive frames
 * on the same channel differ by exactly 1. The client tracks the last-seen seq
 * per channel and, when a frame's seq is neither a `reset` snapshot nor exactly
 * previous+1, fires the channel's `onGap` callbacks so the consumer can resync
 * (e.g. refetch a REST snapshot). It then resumes from the new seq.
 */

export type WsStatus = 'connecting' | 'open' | 'closed';

export type WsHandler = (data: unknown, seq?: number) => void;

export interface WsSubscribeOptions {
  /**
   * Called when a gap is detected on this channel: the incoming seq is not the
   * first frame, not a server `reset` snapshot, and not exactly previous+1.
   * Use it to trigger a one-shot resync (refetch a snapshot). The frame is still
   * delivered to handlers and the baseline resumes from its seq.
   */
  onGap?: (channel: string) => void;
}

export interface WsClientOptions {
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

interface WsFrame {
  op: 'subscribe' | 'unsubscribe';
  channel: string;
  market?: string;
}

function frameFor(op: 'subscribe' | 'unsubscribe', channel: string): WsFrame {
  const colon = channel.indexOf(':');
  if (colon === -1) return { op, channel };
  return { op, channel, market: channel.slice(colon + 1) };
}

const WS_OPEN = 1;

export class WsClient {
  private readonly url: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  private socket: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<WsHandler>>();
  /** per-channel gap callbacks, fired when a frame's seq skips ahead */
  private readonly gapListeners = new Map<string, Set<(channel: string) => void>>();
  /** last per-channel seq observed; absent until the first seq'd frame on it */
  private readonly lastSeq = new Map<string, number>();
  private readonly statusListeners = new Set<(s: WsStatus) => void>();
  private token: string | null = null;
  private attempts = 0;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statusValue: WsStatus = 'closed';

  constructor(url: string, opts: WsClientOptions = {}) {
    this.url = url;
    this.minBackoffMs = opts.minBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.connect();
  }

  get status(): WsStatus {
    return this.statusValue;
  }

  private connect(): void {
    if (this.destroyed) return;
    this.emitStatus('connecting');
    const ws = new WebSocket(this.url);
    this.socket = ws;

    ws.onopen = () => {
      if (ws !== this.socket) return;
      this.attempts = 0;
      this.emitStatus('open');
      // auth first so the server can attach user state before subscriptions
      if (this.token !== null) {
        this.sendRaw({ op: 'auth', token: this.token });
      }
      for (const channel of this.handlers.keys()) {
        this.sendRaw(frameFor('subscribe', channel));
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg === null || typeof msg !== 'object') return;
      const { channel, data, seq, reset } = msg as {
        channel?: unknown;
        data?: unknown;
        seq?: unknown;
        reset?: unknown;
      };
      if (typeof channel !== 'string') return;
      if (channel === 'ping') {
        // server heartbeat — echo so it knows we're alive (else it reaps us)
        this.sendRaw({ op: 'ping' });
        return;
      }
      const seqNum = typeof seq === 'number' ? seq : undefined;
      if (seqNum !== undefined) this.checkSeq(channel, seqNum, reset === true);
      const set = this.handlers.get(channel);
      if (set === undefined) return;
      for (const handler of [...set]) {
        handler(data, seqNum);
      }
    };

    ws.onclose = () => {
      if (ws !== this.socket) return;
      this.socket = null;
      this.emitStatus('closed');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // close always follows; reconnect handled there
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return;
    const delay = Math.min(this.minBackoffMs * 2 ** this.attempts, this.maxBackoffMs);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  private sendRaw(frame: unknown): void {
    if (this.isOpen()) {
      this.socket?.send(JSON.stringify(frame));
    }
  }

  /**
   * Per-channel gap detection. A `reset` snapshot (server's fresh-subscribe
   * frame) or the very first seq seen on a channel just sets the baseline. A
   * frame whose seq is exactly previous+1 advances normally. Anything else is a
   * gap (dropped or duplicate/out-of-order frame): fire the channel's onGap
   * callbacks, then resume the baseline from this frame's seq.
   */
  private checkSeq(channel: string, seq: number, reset: boolean): void {
    const prev = this.lastSeq.get(channel);
    this.lastSeq.set(channel, seq);
    if (reset || prev === undefined) return;
    if (seq === prev + 1) return;
    const set = this.gapListeners.get(channel);
    if (set !== undefined) {
      for (const cb of [...set]) cb(channel);
    }
  }

  /** Set (and immediately send, when open) the auth token. Re-sent on every reconnect. */
  auth(token: string): void {
    this.token = token;
    if (this.isOpen()) {
      this.sendRaw({ op: 'auth', token });
    }
  }

  /**
   * Ref-counted subscribe. The subscribe frame goes out on the 0→1 transition
   * (and again after every reconnect); unsubscribe on the 1→0 transition.
   * Returns an idempotent unsubscribe function.
   */
  subscribe(channel: string, handler: WsHandler, opts: WsSubscribeOptions = {}): () => void {
    let set = this.handlers.get(channel);
    const isFirst = set === undefined;
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);

    const onGap = opts.onGap;
    if (onGap !== undefined) {
      let gaps = this.gapListeners.get(channel);
      if (gaps === undefined) {
        gaps = new Set();
        this.gapListeners.set(channel, gaps);
      }
      gaps.add(onGap);
    }

    if (isFirst) {
      this.sendRaw(frameFor('subscribe', channel));
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (onGap !== undefined) {
        const gaps = this.gapListeners.get(channel);
        if (gaps !== undefined) {
          gaps.delete(onGap);
          if (gaps.size === 0) this.gapListeners.delete(channel);
        }
      }
      const current = this.handlers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        // forget the per-channel seq baseline so a future (re)subscribe starts
        // fresh from the server's next reset snapshot rather than a stale gap
        this.lastSeq.delete(channel);
        this.sendRaw(frameFor('unsubscribe', channel));
      }
    };
  }

  onStatus(cb: (s: WsStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private emitStatus(s: WsStatus): void {
    this.statusValue = s;
    for (const cb of [...this.statusListeners]) cb(s);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.socket;
    this.socket = null;
    ws?.close();
  }
}

// ---------------------------------------------------------------------------
// app-wide singleton (created lazily so tests can construct their own clients)
// ---------------------------------------------------------------------------

let singleton: WsClient | null = null;

export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function getWs(): WsClient {
  if (singleton === null) {
    singleton = new WsClient(defaultWsUrl());
  }
  return singleton;
}
