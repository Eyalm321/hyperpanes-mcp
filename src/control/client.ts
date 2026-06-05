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

  async readPane(paneId: string, tail?: number, strip?: boolean): Promise<PaneOutput> {
    const params = new URLSearchParams();
    if (tail && tail > 0) params.set('tail', String(Math.floor(tail)));
    if (strip) params.set('strip', '1');
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

  async sendInput(paneId: string, data: string, owner?: string): Promise<void> {
    const r = await this.req(`/panes/${encodeURIComponent(paneId)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, ...(owner ? { owner } : {}) })
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
    if (!r.ok) throw new Error(`input -> ${r.status}`);
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
