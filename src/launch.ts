import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCli } from './compile-cli.js';
import type { WorkspaceFile } from './schema.js';

/**
 * hyperpanes ships as an Electron app, not a CLI on PATH (its package.json has
 * no `bin`). So the launcher command must be configured by the operator:
 *   1. an explicit `launcher` argument to launch_workspace, else
 *   2. the `HYPERPANES_BIN` env var (path to the built/installed executable).
 * Optional leading args (e.g. for a dev runner) come from `HYPERPANES_LAUNCH_ARGS`
 * (whitespace-separated). There is intentionally no bare-`hyperpanes` PATH
 * fallback — failing loudly beats spawning the wrong thing.
 */
export function resolveLauncher(explicit?: string): string | null {
  const v = (explicit ?? process.env.HYPERPANES_BIN ?? '').trim();
  return v.length ? v : null;
}

export function resolveLauncherArgs(): string[] {
  const raw = (process.env.HYPERPANES_LAUNCH_ARGS ?? '').trim();
  return raw.length ? raw.split(/\s+/) : [];
}

export type LaunchMode = 'file' | 'cli';

export interface LaunchPlanInput {
  launcher: string;
  launcherArgs?: string[];
  /** A pre-existing workspace .json path. Takes precedence over `workspace`. */
  path?: string;
  /** A workspace to launch (written to a temp file in 'file' mode). */
  workspace?: WorkspaceFile;
  mode?: LaunchMode;
  /** Injectable for tests; defaults to writing a temp file. */
  writeTemp?: (json: string) => string;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  mode: LaunchMode;
  /** The temp file written in 'file' mode, if any. */
  tempFile?: string;
  /** Fields a CLI launch would drop (empty in 'file' mode). */
  lossy: string[];
}

function defaultWriteTemp(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hyperpanes-mcp-'));
  const file = join(dir, 'workspace.json');
  writeFileSync(file, json, 'utf8');
  return file;
}

/**
 * Build the concrete command + args to spawn, without spawning — pure and
 * testable. A positional `.json` path always launches losslessly; a `workspace`
 * launches via a written temp file ('file', lossless) or compiled flags ('cli').
 */
export function planLaunch(input: LaunchPlanInput): LaunchPlan {
  const { launcher, launcherArgs = [], mode = 'file' } = input;
  const writeTemp = input.writeTemp ?? defaultWriteTemp;

  if (input.path) {
    return { command: launcher, args: [...launcherArgs, input.path], mode: 'file', lossy: [] };
  }
  if (!input.workspace) {
    throw new Error('planLaunch requires either `path` or `workspace`');
  }

  if (mode === 'cli') {
    const { argv, lossy } = compileCli(input.workspace);
    return { command: launcher, args: [...launcherArgs, ...argv], mode: 'cli', lossy };
  }

  const tempFile = writeTemp(JSON.stringify(input.workspace, null, 2));
  return { command: launcher, args: [...launcherArgs, tempFile], mode: 'file', tempFile, lossy: [] };
}

/** Spawn the planned command detached so the app outlives this MCP process. */
export function executeLaunch(plan: LaunchPlan): { pid?: number } {
  const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid };
}
