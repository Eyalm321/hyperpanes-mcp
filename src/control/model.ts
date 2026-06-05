/**
 * Read-model types + pure helpers for the control API (`GET /state`, `/events`).
 * Mirrors the shapes in hyperpanes' `control-server.ts`. Pure so they're unit-
 * testable without a running app.
 */

export interface ControlPane {
  id: string;
  sessionUid: string;
  label: string;
  subtitle?: string; // secondary header line; set by rename_pane, omitted when unset
  color: string;
  command?: string;
  cwd?: string;
  shell?: string;
  status: 'running' | 'exited';
  exitCode?: number;
  // Liveness HEURISTIC (agent-orchestration B): 'idle' = no output for the app's
  // idle threshold (agent likely waiting at its prompt / done), 'busy' = recently
  // producing output, 'exited' = process gone. Not a guarantee work is complete.
  activity: 'busy' | 'idle' | 'exited';
  // Free-form per-pane metadata (agent-orchestration C): role/parent/agentType/task + open.
  meta?: Record<string, string>;
}

export interface ControlTab {
  id: string;
  title: string;
  layout: string;
  panes: ControlPane[];
}

export interface ControlWindow {
  windowId: number;
  activeTabId: string | null;
  tabs: ControlTab[];
}

export interface ControlState {
  windows: ControlWindow[];
}

/** A POST /command body. `paneId` or `windowId` routes it to the owning window. */
export interface ControlCommand {
  type: string;
  paneId?: string;
  windowId?: number;
  [key: string]: unknown;
}

/** Server→client frames on the `/events` WebSocket. Pane-addressed frames are
 *  scope-filtered by the app to each client's token authority (F). */
export type ControlEvent =
  | { type: 'hello'; pid: number; version: string }
  | { type: 'output'; sessionUid: string; paneId: string | null; data: string }
  | { type: 'exit'; sessionUid: string; paneId: string | null; code: number }
  | { type: 'activity'; paneId: string; activity: 'busy' | 'idle' | 'exited' }
  | { type: 'message'; to: string; from: string; seq: number; body: string }
  | { type: 'state' };

/** A durable inbox message (agent-orchestration E). */
export interface PaneMessage {
  seq: number;
  to: string;
  from: string;
  body: string;
  ts: number;
}

export interface FlatPane {
  pane: ControlPane;
  windowId: number;
  tabId: string;
  tabTitle: string;
  layout: string;
  /** Whether this pane's tab is the active tab of its window. */
  activeTab: boolean;
}

/** Flatten windows→tabs→panes into a list with window/tab context. */
export function flattenPanes(state: ControlState): FlatPane[] {
  const out: FlatPane[] = [];
  for (const w of state.windows) {
    for (const t of w.tabs) {
      for (const pane of t.panes) {
        out.push({
          pane,
          windowId: w.windowId,
          tabId: t.id,
          tabTitle: t.title,
          layout: t.layout,
          activeTab: w.activeTabId === t.id
        });
      }
    }
  }
  return out;
}

/** Find the window that owns a given tab. */
export function resolveWindowIdForTab(state: ControlState, tabId: string): number | undefined {
  for (const w of state.windows) {
    if (w.tabs.some((t) => t.id === tabId)) return w.windowId;
  }
  return undefined;
}

/** The first window's id (newPane/open_pane fallback target). */
export function firstWindowId(state: ControlState): number | undefined {
  return state.windows[0]?.windowId;
}

/** The active tab id of the first window (set_layout fallback target). */
export function firstWindowActiveTabId(state: ControlState): string | undefined {
  const w = state.windows[0];
  return w?.activeTabId ?? w?.tabs[0]?.id;
}

/** sessionUid → paneId, for resolving `output`/`exit` events with a null paneId. */
export function sessionPaneMap(state: ControlState): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of flattenPanes(state)) map.set(p.pane.sessionUid, p.pane.id);
  return map;
}

const PANE_URI_PREFIX = 'hyperpanes://pane/';
const PANE_URI_SUFFIX = '/output';
const MSG_URI_SUFFIX = '/messages';

/** Stable MCP resource URI for a pane's output. */
export function paneOutputUri(paneId: string): string {
  return `${PANE_URI_PREFIX}${encodeURIComponent(paneId)}${PANE_URI_SUFFIX}`;
}

/** Inverse of paneOutputUri; undefined if the URI isn't a pane-output URI. */
export function paneIdFromUri(uri: string): string | undefined {
  return paneIdFromSuffixedUri(uri, PANE_URI_SUFFIX);
}

/** Stable MCP resource URI for a pane's message inbox (agent-orchestration E). */
export function paneMessagesUri(paneId: string): string {
  return `${PANE_URI_PREFIX}${encodeURIComponent(paneId)}${MSG_URI_SUFFIX}`;
}

/** Inverse of paneMessagesUri; undefined if the URI isn't a pane-messages URI. */
export function paneIdFromMessagesUri(uri: string): string | undefined {
  return paneIdFromSuffixedUri(uri, MSG_URI_SUFFIX);
}

function paneIdFromSuffixedUri(uri: string, suffix: string): string | undefined {
  if (!uri.startsWith(PANE_URI_PREFIX) || !uri.endsWith(suffix)) return undefined;
  const mid = uri.slice(PANE_URI_PREFIX.length, uri.length - suffix.length);
  if (!mid) return undefined;
  try {
    return decodeURIComponent(mid);
  } catch {
    return undefined;
  }
}

/** Reserved org-metadata keys + a pane's identity, for the `whoami` tool. */
export interface WhoAmI {
  paneId: string;
  role?: string;
  parent?: string;
  agentType?: string;
  task?: string;
  meta: Record<string, string>;
  windowId: number;
  tabId: string;
  tabTitle: string;
}

/** Resolve a pane's self-description from /state. Pure — the env paneId is read
 *  by the caller (process.env.HYPERPANES_PANE_ID). Returns null if not found. */
export function resolveWhoami(state: ControlState, paneId: string): WhoAmI | null {
  const found = flattenPanes(state).find((p) => p.pane.id === paneId);
  if (!found) return null;
  const meta = found.pane.meta ?? {};
  return {
    paneId,
    role: meta.role,
    parent: meta.parent,
    agentType: meta.agentType,
    task: meta.task,
    meta,
    windowId: found.windowId,
    tabId: found.tabId,
    tabTitle: found.tabTitle
  };
}

/** Pane ids in a pane's subtree, by org `meta.parent` chain (agent-orchestration E).
 *  Returns every pane whose parent-chain passes through `rootPaneId` (excludes the
 *  root itself). Used by broadcast_subtree. */
export function subtreePaneIds(state: ControlState, rootPaneId: string): string[] {
  const panes = flattenPanes(state).map((p) => p.pane);
  const parentOf = new Map<string, string | undefined>();
  for (const p of panes) parentOf.set(p.id, p.meta?.parent);
  const inSubtree = (id: string): boolean => {
    let cur = parentOf.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === rootPaneId) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };
  return panes.map((p) => p.id).filter((id) => id !== rootPaneId && inSubtree(id));
}
