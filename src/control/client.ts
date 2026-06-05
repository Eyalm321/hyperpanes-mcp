import { ControlUnavailableError, type Discovery } from './discovery.js';
import type { ControlCommand, ControlState, PaneMessage } from './model.js';

export interface Health {
  ok: boolean;
  app: string;
  pid: number;
  version: string;
  allowInput: boolean;
}

export interface PaneOutput {
  paneId: string;
  status: 'running' | 'exited';
  output: string;
  stripped?: boolean;
  // Byte cursor for delta reads (interactive-pane-driving plan B2): pass it back
  // as `since` on the next read to get only newer output. Always present.
  cursor?: number;
  since?: number;
  truncated?: boolean; // the `since` cursor fell off the back of the replay buffer
  // Present only on a waitForIdle read (B1): whether the pane went quiet (settled)
  // within the window or the wait timed out.
  waited?: boolean;
  settled?: boolean;
  timedOut?: boolean;
  // Rendered-screen reads (C1/C2): the mode served, and the blocked-prompt heuristic.
  mode?: 'raw' | 'screen';
  awaitingInput?: boolean;
}

// Read options for `read_pane`. `waitForIdle`/settleMs/timeoutMs make the read
// block until the pane is output-quiet; `since` returns only newer output;
// `mode:"screen"` returns the rendered cell grid instead of the raw pty stream.
export interface ReadPaneOpts {
  tail?: number;
  strip?: boolean;
  since?: number;
  waitForIdle?: boolean;
  settleMs?: number;
  timeoutMs?: number;
  mode?: 'raw' | 'screen';
}

export interface InboxRead {
  paneId: string;
  messages: PaneMessage[];
  dropped: number;
  latestSeq: number;
}

export interface MintedToken {
  ok: boolean;
  token: string;
  scope: Record<string, unknown>;
  expiresAt: number | null;
  port: number | null;
  events: string | null;
}

export interface Scope {
  windowIds?: number[];
  tabIds?: string[];
  paneIds?: string[];
}

/**
 * HTTP client for the hyperpanes control API. One instance wraps one discovered
 * `{ port, token }`; create a fresh one per operation so an app restart (new
 * port/token) is picked up. Uses Node's global `fetch`.
 */
export class ControlClient {
  private readonly base: string;
  private readonly auth: Record<string, string>;

  constructor(public readonly discovery: Discovery) {
    this.base = `http://127.0.0.1:${discovery.port}`;
    this.auth = { authorization: `Bearer ${discovery.token}` };
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(this.base + path, {
        ...init,
        headers: { ...this.auth, ...(init?.headers ?? {}) }
      });
    } catch (err) {
      throw new ControlUnavailableError(
        `cannot reach hyperpanes control API at ${this.base} (${String(err)}). Is the app still running with control enabled?`
      );
    }
  }

  async health(): Promise<Health> {
    const r = await this.req('/health');
    if (!r.ok) throw new Error(`/health -> ${r.status}`);
    return (await r.json()) as Health;
  }

  async state(): Promise<ControlState> {
    const r = await this.req('/state');
    if (r.status === 401) throw new Error('/state -> 401 unauthorized (stale token? restart bridge)');
    if (!r.ok) throw new Error(`/state -> ${r.status}`);
    return (await r.json()) as ControlState;
  }

  // Poll /state until a pane id is present in the read-model, or timeout. The
  // app's structure publish is DEBOUNCED, so a freshly-opened pane is briefly
  // absent from /state even though open_pane's command round-trip already
  // returned its id — a read/input in that gap 404s "no such pane". open_pane
  // awaits this so its contract is "when it returns, the pane is drivable".
  async waitForPane(paneId: string, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      const present = (await this.state()).windows.some((w) =>
        w.tabs.some((t) => t.panes.some((p) => p.id === paneId))
      );
      if (present) return true;
      if (Date.now() - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 75));
    }
  }

  async readPane(paneId: string, opts: ReadPaneOpts = {}): Promise<PaneOutput> {
    const params = new URLSearchParams();
    if (opts.tail && opts.tail > 0) params.set('tail', String(Math.floor(opts.tail)));
    if (opts.strip) params.set('strip', '1');
    if (opts.since !== undefined && opts.since >= 0) params.set('since', String(Math.floor(opts.since)));
    if (opts.waitForIdle) params.set('waitForIdle', '1');
    if (opts.settleMs && opts.settleMs > 0) params.set('settleMs', String(Math.floor(opts.settleMs)));
    if (opts.timeoutMs && opts.timeoutMs > 0) params.set('timeoutMs', String(Math.floor(opts.timeoutMs)));
    if (opts.mode) params.set('mode', opts.mode);
    const q = params.toString();
    const r = await this.req(`/panes/${encodeURIComponent(paneId)}/output${q ? `?${q}` : ''}`);
    if (r.status === 404) throw new Error(`no such pane: ${paneId}`);
    if (r.status === 403) throw new Error(`pane out of scope: ${paneId}`);
    if (!r.ok) throw new Error(`output -> ${r.status}`);
    return (await r.json()) as PaneOutput;
  }

  // ---- message bus (agent-orchestration E) ----
  async readMessages(paneId: string, after?: number): Promise<InboxRead> {
    const q = after && after > 0 ? `?after=${Math.floor(after)}` : '';
    const r = await this.req(`/panes/${encodeURIComponent(paneId)}/messages${q}`);
    if (r.status === 404) throw new Error(`no such pane: ${paneId}`);
    if (r.status === 403) throw new Error(`pane out of scope: ${paneId}`);
    if (!r.ok) throw new Error(`messages -> ${r.status}`);
    return (await r.json()) as InboxRead;
  }

  async sendMessage(paneId: string, from: string, body: string): Promise<{ ok: boolean; seq: number }> {
    const r = await this.req(`/panes/${encodeURIComponent(paneId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, body })
    });
    if (r.status === 404) throw new Error(`no such pane: ${paneId}`);
    if (r.status === 403) throw new Error(`pane out of scope: ${paneId}`);
    if (!r.ok) throw new Error(`message -> ${r.status}`);
    return (await r.json()) as { ok: boolean; seq: number };
  }

  // ---- scoping (agent-orchestration F) ----
  async mintToken(scope: Scope, ttlMs?: number): Promise<MintedToken> {
    const r = await this.req('/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, ...(ttlMs ? { ttlMs } : {}) })
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(`mint token -> ${r.status}${b.error ? ` (${b.error})` : ''}`);
    }
    return (await r.json()) as MintedToken;
  }

  // ---- advisory lock (agent-orchestration H) ----
  async lock(paneId: string, owner: string, ttlMs?: number): Promise<{ ok: boolean; owner: string; expiresAt: number }> {
    const r = await this.req(`/panes/${encodeURIComponent(paneId)}/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, ...(ttlMs ? { ttlMs } : {}) })
    });
    if (r.status === 404) throw new Error(`no such pane: ${paneId}`);
    if (r.status === 403) throw new Error(`pane out of scope: ${paneId}`);
    return (await r.json()) as { ok: boolean; owner: string; expiresAt: number };
  }

  async unlock(paneId: string, owner: string): Promise<{ ok: boolean }> {
    const r = await this.req(`/panes/${encodeURIComponent(paneId)}/lock`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner })
    });
    if (r.status === 404) throw new Error(`no such pane: ${paneId}`);
    if (r.status === 403) throw new Error(`pane out of scope: ${paneId}`);
    return (await r.json()) as { ok: boolean };
  }

  // POST to a pane's input route with shared error mapping. Both `send_input`
  // (text, optional submit) and `send_keys` (named keys) ride this one path —
  // same triple gate (403), advisory lock (423), missing pane (404), bad request
  // / unknown key (400). The body shape decides which the app does.
  private async postInput(paneId: string, body: Record<string, unknown>): Promise<void> {
    const r = await this.req(`/panes/${encodeURIComponent(paneId)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.status === 403) {
      throw new Error(
        'hyperpanes refused input (allowInput is off, or the pane is out of this token\'s scope). Enable input under Preferences → "Allow agent control".'
      );
    }
    if (r.status === 423) {
      const b = (await r.json().catch(() => ({}))) as { owner?: string };
      throw new Error(
        `pane is locked by "${b.owner ?? 'another writer'}" — pass that owner, or wait for the lock to expire.`
      );
    }
    if (r.status === 404) throw new Error(`no such pane: ${paneId}`);
    if (r.status === 400) {
      const b = (await r.json().catch(() => ({}))) as { unknown?: string[]; error?: string };
      throw new Error(
        b.unknown?.length ? `unknown key(s): ${b.unknown.join(', ')}` : (b.error ?? 'bad input request')
      );
    }
    if (!r.ok) throw new Error(`input -> ${r.status}`);
  }

  async sendInput(
    paneId: string,
    data: string,
    owner?: string,
    submit?: boolean,
    submitDelayMs?: number
  ): Promise<void> {
    await this.postInput(paneId, {
      data,
      ...(owner ? { owner } : {}),
      ...(submit ? { submit: true } : {}),
      ...(submitDelayMs !== undefined ? { submitDelayMs } : {})
    });
  }

  // Send a sequence of named keys (enter/escape/tab/arrows/ctrl+c…) as VT bytes
  // (interactive-pane-driving plan A2). Same gate as sendInput — it IS input.
  async sendKeys(paneId: string, keys: string[], owner?: string): Promise<void> {
    await this.postInput(paneId, { keys, ...(owner ? { owner } : {}) });
  }

  async command(cmd: ControlCommand): Promise<{ ok: boolean; result?: unknown }> {
    const r = await this.req('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(`command ${cmd.type} -> ${r.status}${body.error ? ` (${body.error})` : ''}`);
    }
    // The app may return a command-specific result (newPane → the new pane id).
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: unknown };
    return { ok: body.ok !== false, result: body.result };
  }
}
