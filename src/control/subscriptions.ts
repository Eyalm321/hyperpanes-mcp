import {
  paneOutputUri,
  paneMessagesUri,
  sessionPaneMap,
  type ControlEvent,
  type ControlState
} from './model.js';

/** A live event connection the manager can tear down. */
export interface EventConnection {
  close(): void;
}

export interface SubscriptionDeps {
  /** Current `/events` WebSocket URL, or null if the app/control isn't available. */
  eventsUrl: () => string | null;
  /** Fetch `/state` to (re)build the sessionUid→paneId map. */
  fetchState: () => Promise<ControlState>;
  /** Emit MCP `notifications/resources/updated` for a pane-output URI. */
  onUpdated: (uri: string) => void;
  /** Emit MCP `notifications/resources/list_changed`. */
  onListChanged: () => void;
  /** Open the events stream. Injectable for tests; defaults to a global-WebSocket impl. */
  connect?: (url: string, onEvent: (e: ControlEvent) => void, onClose: () => void) => EventConnection;
}

/**
 * Tracks which pane-output resources are subscribed and bridges the control
 * `/events` stream to MCP resource notifications. One WebSocket is opened lazily
 * on the first subscription and closed when the last unsubscribes.
 *
 * `output`/`exit` events → `resources/updated` for that pane (resolving a null
 * `paneId` via sessionUid). `state` events → `resources/list_changed`.
 */
export class PaneSubscriptions {
  private readonly uris = new Set<string>();
  private sessionToPane = new Map<string, string>();
  private conn: EventConnection | null = null;
  private closing = false;
  private readonly connect: NonNullable<SubscriptionDeps['connect']>;

  constructor(private readonly deps: SubscriptionDeps) {
    this.connect = deps.connect ?? defaultConnect;
  }

  get size(): number {
    return this.uris.size;
  }
  has(uri: string): boolean {
    return this.uris.has(uri);
  }

  /** Seed the sessionUid→paneId map (used by tests and on (re)connect). */
  setSessionMap(map: Map<string, string>): void {
    this.sessionToPane = map;
  }

  async subscribe(uri: string): Promise<void> {
    this.uris.add(uri);
    await this.ensureConnected();
  }

  unsubscribe(uri: string): void {
    this.uris.delete(uri);
    if (this.uris.size === 0) this.teardown();
  }

  /** Apply one event. Pure given the injected callbacks — the unit-test seam. */
  handleEvent(e: ControlEvent): void {
    if (e.type === 'output' || e.type === 'exit') {
      const paneId = e.paneId ?? this.sessionToPane.get(e.sessionUid);
      if (!paneId) return;
      const uri = paneOutputUri(paneId);
      if (this.uris.has(uri)) this.deps.onUpdated(uri);
      return;
    }
    // A new inbox message nudges the target pane's messages resource (E).
    if (e.type === 'message') {
      const uri = paneMessagesUri(e.to);
      if (this.uris.has(uri)) this.deps.onUpdated(uri);
      return;
    }
    // An activity flip (busy⇄idle⇄exited) changes a pane's liveness, surfaced via
    // list_panes. There is no per-activity resource, so nudge the client to
    // re-enumerate (it re-reads activity from list_panes). THE headline
    // orchestration signal: without this case the app's `activity` frames were
    // silently dropped, leaving subscribers to discover idleness only by polling.
    if (e.type === 'activity') {
      this.deps.onListChanged();
      return;
    }
    if (e.type === 'state') {
      this.deps.onListChanged();
      // Refresh the addressing map so subsequent null-paneId events resolve.
      this.deps.fetchState().then(
        (s) => this.setSessionMap(sessionPaneMap(s)),
        () => {
          /* transient; keep the old map */
        }
      );
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.conn) return;
    const url = this.deps.eventsUrl();
    if (!url) return; // app not available yet; a later `state`/subscribe retries
    this.closing = false;
    try {
      this.setSessionMap(sessionPaneMap(await this.deps.fetchState()));
    } catch {
      /* proceed without a seed map; null-paneId events just won't resolve yet */
    }
    this.conn = this.connect(
      url,
      (e) => this.handleEvent(e),
      () => {
        this.conn = null;
        // Reconnect if work remains and we didn't intentionally tear down.
        if (!this.closing && this.uris.size > 0) void this.ensureConnected();
      }
    );
  }

  private teardown(): void {
    this.closing = true;
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }
}

/** Default events connection over Node's global WebSocket (token is in the URL). */
function defaultConnect(
  url: string,
  onEvent: (e: ControlEvent) => void,
  onClose: () => void
): EventConnection {
  const ws = new WebSocket(url);
  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      onEvent(JSON.parse(String(ev.data)) as ControlEvent);
    } catch {
      /* ignore non-JSON frames */
    }
  });
  ws.addEventListener('close', () => onClose());
  ws.addEventListener('error', () => {
    /* close will follow */
  });
  return {
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}
