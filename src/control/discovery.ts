import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Discovery of a running hyperpanes control API (M2/M2b). The app writes
 * `userData/control.json` while the loopback control server is enabled:
 *
 *   { port, token, pid, version, events }
 *
 * where `events` is the ready-to-use WebSocket URL
 * `ws://127.0.0.1:{port}/events?token={token}`. Absent file ⇒ the app is not
 * running, or "Allow agent control" is off.
 */
export interface Discovery {
  port: number;
  token: string;
  pid?: number;
  version?: string;
  /** ws://127.0.0.1:{port}/events?token={token} */
  events: string;
}

/** Thrown when the control API can't be located or reached. */
export class ControlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlUnavailableError';
  }
}

/** hyperpanes' Electron `userData` dir, per platform (app name "hyperpanes"). */
export function defaultUserDataDir(appName = 'hyperpanes'): string {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), appName);
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', appName);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), appName);
}

/**
 * Where to look for control.json. Precedence:
 *   1. explicit argument
 *   2. HYPERPANES_CONTROL_FILE (full path to control.json)
 *   3. HYPERPANES_USER_DATA / <dir>/control.json
 *   4. platform default userData/control.json
 * (In dev the app may run under a different Electron name — set
 * HYPERPANES_CONTROL_FILE if the default path is wrong.)
 */
export function controlFilePath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.HYPERPANES_CONTROL_FILE) return process.env.HYPERPANES_CONTROL_FILE;
  const dir = process.env.HYPERPANES_USER_DATA ?? defaultUserDataDir();
  return join(dir, 'control.json');
}

/**
 * A scoped control token delivered via pane env (agent-orchestration F): a pane
 * launched as a subtree-scoped worker carries `HYPERPANES_CONTROL_TOKEN` (+
 * `HYPERPANES_CONTROL_PORT`) and is deliberately NOT given control.json, so it
 * can't read the master token. When present this takes precedence over the file.
 */
export function discoveryFromEnv(env: NodeJS.ProcessEnv = process.env): Discovery | null {
  const token = env.HYPERPANES_CONTROL_TOKEN;
  if (!token) return null;
  const port = Number(env.HYPERPANES_CONTROL_PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new ControlUnavailableError(
      'HYPERPANES_CONTROL_TOKEN is set but HYPERPANES_CONTROL_PORT is missing/invalid'
    );
  }
  return { port, token, events: `ws://127.0.0.1:${port}/events?token=${token}` };
}

/** Validate a parsed discovery object, synthesizing `events` if an older app omitted it. */
export function normalizeDiscovery(raw: unknown, source: string): Discovery {
  if (!raw || typeof raw !== 'object') {
    throw new ControlUnavailableError(`malformed control file at ${source}`);
  }
  const o = raw as Record<string, unknown>;
  const port = typeof o.port === 'number' ? o.port : NaN;
  const token = typeof o.token === 'string' ? o.token : '';
  if (!Number.isFinite(port) || !token) {
    throw new ControlUnavailableError(`control file at ${source} is missing port/token`);
  }
  const events =
    typeof o.events === 'string' && o.events
      ? o.events
      : `ws://127.0.0.1:${port}/events?token=${token}`;
  return {
    port,
    token,
    pid: typeof o.pid === 'number' ? o.pid : undefined,
    version: typeof o.version === 'string' ? o.version : undefined,
    events
  };
}

/** Read + validate control.json. Throws ControlUnavailableError if absent/invalid. */
export function readDiscovery(path?: string): Discovery {
  // A scoped child (F) gets its token + port from env and no control.json; prefer
  // it unless the caller named an explicit file path.
  if (!path) {
    const fromEnv = discoveryFromEnv();
    if (fromEnv) return fromEnv;
  }
  const file = controlFilePath(path);
  if (!existsSync(file)) {
    throw new ControlUnavailableError(
      `hyperpanes control API not found (no control.json at ${file}). Start hyperpanes and enable Preferences → General → "Allow agent control". If the app uses a non-default data dir, set HYPERPANES_CONTROL_FILE.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ControlUnavailableError(`failed to read control file ${file}: ${String(err)}`);
  }
  return normalizeDiscovery(parsed, file);
}
