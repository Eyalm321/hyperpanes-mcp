/**
 * Worktree-per-worker pool controller (Phase 1) — doc 03 (`03-worktree-controller.md`).
 *
 * Drives a fleet of isolated workers using ONLY existing hyperpanes control
 * primitives (no core/Rust changes): it is a plain control-API *client*, reusing
 * this repo's own {@link ControlClient} (the same HTTP layer the MCP tools wrap).
 *
 * Per task: `git worktree add` an isolated checkout → `open_pane` (newPane) a
 * worker cwd'd there → `mint_token` scoped to JUST that pane → hand the scoped
 * creds over a short-lived handshake file → dispatch the task on the message bus
 * → poll liveness (explicit DONE/FAIL on the bus, else pane `exited`) → collect
 * `RESULT.md` → tear down (pane FIRST, then the directory it lived in). A fixed
 * concurrency cap bounds live worktrees/panes/tokens; orphan reconciliation reaps
 * a previous run's debris from `meta` alone.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlClient } from '../control/client.js';
import { readDiscovery } from '../control/discovery.js';
import { flattenPanes, firstWindowId, type ControlPane } from '../control/model.js';
import { Git } from './git.js';
import { deriveBranch, worktreePath, type Task } from './kinds.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const WORKER_COLOR = '#5b8def';
const PANE_CLOSE_WAIT_MS = 5_000;

export interface ControllerConfig {
  /** Git repo to fork worktrees from. */
  repo: string;
  /** Parent dir for the isolated checkouts. */
  worktreeRoot: string;
  /** Pool identity, stamped into pane `meta.pool`; STABLE ⇒ cross-restart reaping. */
  poolId: string;
  /** Max simultaneous workers (the only throttle; the bridge enforces none). */
  maxConcurrent: number;
  /** Per-task wall-clock budget before a hung worker is force-closed. */
  taskTimeoutMs: number;
  /** Liveness poll cadence. */
  pollIntervalMs: number;
  /** Scoped-token TTL — the only cleanup backstop (no revoke primitive). */
  tokenTtlMs: number;
  /** Default base ref worktrees fork from when a task doesn't set its own. */
  base: string;
  /** Private dir (outside any checkout) for short-lived handshake files. */
  handshakeDir: string;
  /** Executable that runs the worker entry (default "node"). */
  workerNode: string;
  /** Absolute path to the built worker entry. */
  workerEntry: string;
  /** Explicit target window; defaults to the first window. */
  windowId?: number;
}

/** Resolve the built worker entry that sits next to this compiled module. */
export function defaultWorkerEntry(): string {
  return fileURLToPath(new URL('./worker.js', import.meta.url));
}

export function defaultConfig(overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  const env = process.env;
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  // Worktrees + handshakes live OUTSIDE the repo by default: a checkout nested in
  // the working tree both pollutes `git status` and risks nested-worktree foot-guns.
  const root = env.HP_WORKTREE_ROOT || join(tmpdir(), 'hp-worktrees');
  return {
    repo: env.HP_REPO || process.cwd(),
    worktreeRoot: root,
    poolId: env.HP_POOL_ID || `pool-${process.pid}`,
    maxConcurrent: num(env.HP_MAX_CONCURRENT, 4),
    taskTimeoutMs: num(env.HP_TASK_TIMEOUT_MS, 10 * 60_000),
    pollIntervalMs: num(env.HP_POLL_INTERVAL_MS, 1_500),
    tokenTtlMs: num(env.HP_TOKEN_TTL_MS, 30 * 60_000),
    base: env.HP_BASE || 'HEAD',
    handshakeDir: env.HP_HANDSHAKE_DIR || join(root, '.handshakes'),
    workerNode: env.HP_WORKER_NODE || 'node',
    workerEntry: env.HP_WORKER_ENTRY || defaultWorkerEntry(),
    ...overrides
  };
}

/** Everything about a task's run that is knowable BEFORE the pane exists. */
export interface TaskPlan {
  id: string;
  kind: Task['kind'];
  title: string;
  base: string;
  branch: string;
  worktree: string;
  handshake: string;
  /** `git worktree add` argv (after `git -C <repo>`). */
  gitAdd: string[];
  /** The `open_pane` spec for the worker. */
  pane: {
    command: string;
    args: string[];
    cwd: string;
    label: string;
    color: string;
    meta: Record<string, string>;
    env: Record<string, string>;
  };
  /** What `mint_token` will be scoped to (the paneId is filled in post-open). */
  mintScope: string;
  tokenTtlMs: number;
  /** The bus message dispatched to the worker's inbox. */
  dispatchBody: string;
}

/** Pure planner — single source of truth for both dry-run and the live path. */
export function planTask(task: Task, cfg: ControllerConfig): TaskPlan {
  const branch = deriveBranch(task);
  const worktree = worktreePath(cfg.worktreeRoot, cfg.poolId, task);
  const base = task.base || cfg.base;
  const handshake = join(cfg.handshakeDir, `handshake-${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const dispatchBody = JSON.stringify({
    type: 'task',
    id: task.id,
    kind: task.kind,
    title: task.title,
    prompt: task.prompt,
    base,
    branch,
    worktree
  });
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    base,
    branch,
    worktree,
    handshake,
    gitAdd: ['worktree', 'add', '-f', '-b', branch, worktree, base],
    pane: {
      command: cfg.workerNode,
      args: [cfg.workerEntry],
      cwd: worktree,
      label: `worker:${task.title}`.slice(0, 80),
      color: WORKER_COLOR,
      meta: { role: 'worker', pool: cfg.poolId, task: task.id, parent: 'controller' },
      env: { HP_HANDSHAKE: handshake, HP_POOL_ID: cfg.poolId, HP_TASK_ID: task.id }
    },
    mintScope: 'paneIds:[<thisPane>]',
    tokenTtlMs: cfg.tokenTtlMs,
    dispatchBody
  };
}

export interface TaskRunResult {
  id: string;
  ok: boolean;
  reason: string;
  paneId?: string;
  branch: string;
  worktree: string;
  exitCode?: number;
  result?: string | null;
  error?: string;
}

interface Outcome {
  ok: boolean;
  reason: string;
  exitCode?: number;
}

export class Controller {
  private client!: ControlClient;
  private readonly git: Git;

  constructor(private readonly cfg: ControllerConfig) {
    this.git = new Git(cfg.repo);
  }

  /** Connect to the master control API (control.json) and verify it's live. */
  async connect(): Promise<{ pid: number; version: string; port: number }> {
    this.client = new ControlClient(readDiscovery());
    const health = await this.client.health();
    mkdirSync(this.cfg.worktreeRoot, { recursive: true });
    mkdirSync(this.cfg.handshakeDir, { recursive: true });
    return { pid: health.pid, version: health.version, port: this.client.discovery.port };
  }

  /**
   * Reap a previous run's debris using only `meta` + git (no controller-side
   * state): close stale exited worker panes of THIS pool, and remove leftover
   * worktrees under this pool's prefix. Pool-prefixed so concurrent pools don't
   * clobber each other.
   */
  async reconcileOrphans(): Promise<{ panesClosed: number; worktreesRemoved: number }> {
    let panesClosed = 0;
    let worktreesRemoved = 0;
    try {
      const state = await this.client.state();
      for (const { pane } of flattenPanes(state)) {
        const m = pane.meta;
        if (m && m.role === 'worker' && m.pool === this.cfg.poolId && pane.status === 'exited') {
          await this.client.command({ type: 'closePane', paneId: pane.id }).catch(() => {});
          panesClosed++;
        }
      }
    } catch {
      /* bridge not ready / no panes — non-fatal */
    }
    const prefix = join(this.cfg.worktreeRoot, `${this.cfg.poolId}-`);
    try {
      for (const wt of await this.git.worktreeList()) {
        if (wt.path.startsWith(prefix)) {
          await this.git.worktreeRemove(wt.path).catch(() => {});
          worktreesRemoved++;
        }
      }
      await this.git.worktreePrune().catch(() => {});
    } catch {
      /* repo may have no worktrees */
    }
    return { panesClosed, worktreesRemoved };
  }

  /** Run a backlog through a bounded pool; results come back in completion order. */
  async run(tasks: Task[]): Promise<TaskRunResult[]> {
    const queue = [...tasks].sort((a, b) => b.priority - a.priority);
    const results: TaskRunResult[] = [];
    const next = (): Task | undefined => queue.shift();
    const runner = async (): Promise<void> => {
      for (let task = next(); task; task = next()) {
        results.push(await this.runTask(task));
      }
    };
    const n = Math.max(1, Math.min(this.cfg.maxConcurrent, queue.length));
    await Promise.all(Array.from({ length: n }, () => runner()));
    return results;
  }

  /** One task, full lifecycle, with cleanup guaranteed in the safe order. */
  async runTask(task: Task): Promise<TaskRunResult> {
    const plan = planTask(task, this.cfg);
    let paneId: string | null = null;
    try {
      // 1. isolated checkout on a throwaway branch off the base ref
      await this.git.worktreeAdd(plan.worktree, plan.branch, plan.base);

      // 2. open the pane running the worker (it blocks on the handshake file)
      paneId = await this.openWorkerPane(plan);

      // 3. mint a token scoped to JUST this pane, now that its id exists
      const minted = await this.client.mintToken({ paneIds: [paneId] }, this.cfg.tokenTtlMs);
      if (!minted.token || minted.port == null) throw new Error('mint_token returned no token/port');

      // 4. hand the scoped creds to the worker via the file it is polling
      writeFileSync(
        plan.handshake,
        JSON.stringify({ token: minted.token, port: minted.port, paneId }),
        'utf8'
      );

      // 5. dispatch the task over the durable bus
      await this.client.sendMessage(paneId, 'controller', plan.dispatchBody);

      // 6. poll for completion (explicit signal first, then process-gone)
      const outcome = await this.pollUntilDone(paneId, Date.now() + this.cfg.taskTimeoutMs);

      // 7. collect the durable artifact
      const resultPath = join(plan.worktree, 'RESULT.md');
      const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : null;
      return {
        id: task.id,
        ok: outcome.ok,
        reason: outcome.reason,
        paneId,
        branch: plan.branch,
        worktree: plan.worktree,
        ...(outcome.exitCode != null ? { exitCode: outcome.exitCode } : {}),
        result
      };
    } catch (err) {
      return {
        id: task.id,
        ok: false,
        reason: 'exception',
        ...(paneId ? { paneId } : {}),
        branch: plan.branch,
        worktree: plan.worktree,
        error: errMessage(err)
      };
    } finally {
      // 8. always tear down — pane FIRST, then the directory it cwd'd into
      await this.teardown({ paneId, worktree: plan.worktree, branch: plan.branch, handshake: plan.handshake });
    }
  }

  private async openWorkerPane(plan: TaskPlan): Promise<string> {
    const state = await this.client.state();
    const windowId = this.cfg.windowId ?? firstWindowId(state);
    if (windowId == null) throw new Error('no windows open to add a worker pane to');
    const res = await this.client.command({
      type: 'newPane',
      windowId,
      pane: {
        label: plan.pane.label,
        command: plan.pane.command,
        args: plan.pane.args,
        cwd: plan.pane.cwd,
        color: plan.pane.color,
        meta: plan.pane.meta,
        env: plan.pane.env
      }
    });
    const paneId = typeof res.result === 'string' ? res.result : undefined;
    if (!paneId) throw new Error('open_pane returned no paneId (renderer reply lost?)');
    await this.client.waitForPane(paneId);
    return paneId;
  }

  /**
   * Completion is keyed off an explicit DONE/FAIL on the bus and the authoritative
   * `status:'exited'` — never off `activity:'idle'`, which the read-model documents
   * as "not a guarantee work is complete."
   */
  private async pollUntilDone(paneId: string, deadline: number): Promise<Outcome> {
    let cursor = 0;
    for (;;) {
      const inbox = await this.client.readMessages(paneId, cursor).catch(() => null);
      if (inbox) {
        for (const m of inbox.messages) {
          cursor = Math.max(cursor, m.seq);
          // Our own dispatched task body is JSON ('{…'); only the worker's
          // self-addressed status notice starts with DONE/FAIL.
          if (m.body.startsWith('DONE')) return { ok: true, reason: 'reported-done' };
          if (m.body.startsWith('FAIL')) return { ok: false, reason: 'reported-fail' };
        }
      }
      const pane = await this.findPane(paneId);
      if (!pane || pane.status === 'exited') {
        const exitCode = pane?.exitCode;
        return { ok: exitCode === 0, reason: 'pane-exited', ...(exitCode != null ? { exitCode } : {}) };
      }
      if (Date.now() > deadline) return { ok: false, reason: 'timeout' };
      await sleep(this.cfg.pollIntervalMs);
    }
  }

  private async findPane(paneId: string): Promise<ControlPane | undefined> {
    try {
      const state = await this.client.state();
      return flattenPanes(state).find((p) => p.pane.id === paneId)?.pane;
    } catch {
      return undefined;
    }
  }

  private async waitGone(paneId: string, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const pane = await this.findPane(paneId);
      if (!pane || pane.status === 'exited') return;
      await sleep(300);
    }
  }

  private async teardown(ref: {
    paneId: string | null;
    worktree: string;
    branch: string;
    handshake: string;
  }): Promise<void> {
    if (ref.paneId) {
      const pane = await this.findPane(ref.paneId);
      if (pane && pane.status !== 'exited') {
        await this.client.command({ type: 'closePane', paneId: ref.paneId }).catch(() => {});
      }
      // Never rm a checkout a live process still cwd's into.
      await this.waitGone(ref.paneId, PANE_CLOSE_WAIT_MS);
    }
    rmIfExists(ref.handshake);
    await this.git.worktreeRemove(ref.worktree).catch(() => {});
    await this.git.worktreePrune().catch(() => {});
    await this.git.branchDelete(ref.branch).catch(() => {});
    // The scoped token has no revoke primitive — it lapses via tokenTtlMs.
  }
}

function rmIfExists(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
