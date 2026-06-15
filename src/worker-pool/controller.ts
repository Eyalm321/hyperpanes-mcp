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
import {
  deriveBranch,
  worktreePath,
  decodeSpec,
  type Task,
  type TaskSpec,
  type EnqueueRequest,
  type DispatchedTask
} from './kinds.js';
import { QueueClient } from './queue-client.js';
import {
  reviewDiff,
  collectWorkerDiff,
  spawnClaudeReviewRunner,
  type ReviewRunner,
  type ReviewResult
} from './review.js';

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
  /** Logical work queue this controller produces into and claims from. */
  queue: string;
  /** Private dir (outside any checkout) for short-lived handshake files. */
  handshakeDir: string;
  /** Executable that runs the worker entry (default "node"). */
  workerNode: string;
  /** Absolute path to the built worker entry. */
  workerEntry: string;
  /** Explicit target window; defaults to the first window. */
  windowId?: number;
  /**
   * Local LLM-review gate (default ON). When set, a SUCCESS worker's diff is reviewed
   * with `claude -p` BEFORE the task is acked/finalized; a `block` verdict holds the
   * merge (the task is nacked `review-blocked`). Disable with `--no-review` for the
   * unguarded path. The gate FAILS CLOSED — a missing/failed judge blocks.
   */
  review: boolean;
  /** Claude model alias for the review judge (env `HP_REVIEW_MODEL`); default model if unset. */
  reviewModel?: string;
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
    queue: env.HP_QUEUE || 'default',
    handshakeDir: env.HP_HANDSHAKE_DIR || join(root, '.handshakes'),
    workerNode: env.HP_WORKER_NODE || 'node',
    workerEntry: env.HP_WORKER_ENTRY || defaultWorkerEntry(),
    // The review gate is ON by default (HP_REVIEW=0/false opts out); fail-closed.
    review: !/^(0|false|off|no)$/i.test((env.HP_REVIEW ?? '').trim()),
    ...(env.HP_REVIEW_MODEL ? { reviewModel: env.HP_REVIEW_MODEL } : {}),
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
  /** The task frame handed to the worker via the handshake file (NOT the inbox bus). */
  dispatch: DispatchedTask;
}

/**
 * Pure planner — single source of truth for both dry-run and the live path. Takes the
 * canonical {@link Task} (id/title/kind/priority are queue columns) plus the {@link TaskSpec}
 * decoded from its opaque `payload` (prompt/base/repo live there, doc 05 "typed at the edges").
 */
export function planTask(task: Task, spec: TaskSpec, cfg: ControllerConfig): TaskPlan {
  const branch = deriveBranch(task);
  const worktree = worktreePath(cfg.worktreeRoot, cfg.poolId, task);
  const base = spec.base || cfg.base;
  const handshake = join(cfg.handshakeDir, `handshake-${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const dispatch: DispatchedTask = {
    id: task.id,
    kind: task.kind,
    title: task.title,
    prompt: spec.prompt,
    base,
    branch,
    worktree
  };
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
    dispatch
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
  /** The LLM-review verdict, when the gate ran (a SUCCESS worker + `review` on). */
  review?: ReviewResult;
}

interface Outcome {
  ok: boolean;
  reason: string;
  exitCode?: number;
}

export class Controller {
  private client!: ControlClient;
  private queue!: QueueClient;
  private readonly git: Git;
  private readonly reviewRunner: ReviewRunner;

  /**
   * @param cfg controller configuration.
   * @param reviewRunner injectable LLM-review judge (the {@link ReviewRunner} seam,
   *   mirroring the worker's {@link AgentRunner}). Defaults to the real
   *   {@link spawnClaudeReviewRunner} (`claude -p`); unit tests inject a FAKE so they
   *   never spawn `claude`.
   */
  constructor(
    private readonly cfg: ControllerConfig,
    reviewRunner: ReviewRunner = spawnClaudeReviewRunner()
  ) {
    this.git = new Git(cfg.repo);
    this.reviewRunner = reviewRunner;
  }

  /** Connect to the master control API (control.json) and verify it's live. The same
   *  master discovery backs both the pane client and the work-queue client. */
  async connect(): Promise<{ pid: number; version: string; port: number }> {
    const discovery = readDiscovery();
    this.client = new ControlClient(discovery);
    this.queue = new QueueClient(discovery);
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

  /**
   * Repointed onto the durable work queue: PRODUCE the backlog (enqueue), then CONSUME it
   * through a bounded pool of competing consumers. Each slot claims a task, runs it in an
   * isolated worktree, and reports terminal state via `ack`/`nack` (carrying the fencing
   * token) — the inbox bus is no longer the dispatch substrate. Results come back in
   * completion order. With an empty backlog the pool simply drains whatever is already queued.
   */
  async run(backlog: EnqueueRequest[]): Promise<TaskRunResult[]> {
    for (const req of backlog) {
      await this.queue.enqueue(this.cfg.queue, req);
    }
    const results: TaskRunResult[] = [];
    const worker = async (slot: number): Promise<void> => {
      const workerId = `${this.cfg.poolId}-w${slot}`;
      for (;;) {
        // lease the task for at least its wall-clock budget so it isn't reaped mid-run
        const claimed = await this.queue.claim(this.cfg.queue, workerId, {
          leaseMs: this.cfg.taskTimeoutMs
        });
        const task = claimed[0];
        if (!task) return; // queue drained
        results.push(await this.runClaim(task));
      }
    };
    const slots = Math.max(1, Math.min(this.cfg.maxConcurrent, backlog.length || this.cfg.maxConcurrent));
    await Promise.all(Array.from({ length: slots }, (_unused, i) => worker(i)));
    return results;
  }

  /**
   * One CLAIMED task, full lifecycle, with cleanup guaranteed in the safe order and the
   * terminal state reported back to the queue (fencing-guarded). The typed instruction is
   * decoded from the task's opaque `payload`; the task is handed to the worker via the
   * handshake file (not the inbox bus).
   */
  async runClaim(task: Task): Promise<TaskRunResult> {
    const spec = decodeSpec(task, this.cfg.base);
    const plan = planTask(task, spec, this.cfg);
    const fencingToken = task.fencingToken;
    let paneId: string | null = null;
    try {
      if (fencingToken == null) throw new Error('claimed task is missing its fencingToken');

      // 1. isolated checkout on a throwaway branch off the base ref
      await this.git.worktreeAdd(plan.worktree, plan.branch, plan.base);

      // 2. open the pane running the worker (it blocks on the handshake file)
      paneId = await this.openWorkerPane(plan);

      // 3. mint a token scoped to JUST this pane, now that its id exists
      const minted = await this.client.mintToken({ paneIds: [paneId] }, this.cfg.tokenTtlMs);
      if (!minted.token || minted.port == null) throw new Error('mint_token returned no token/port');

      // 4. hand the scoped creds AND the task to the worker via the file it polls — the
      //    queue is the dispatch substrate now, so nothing rides the inbox bus.
      writeFileSync(
        plan.handshake,
        JSON.stringify({ token: minted.token, port: minted.port, paneId, task: plan.dispatch }),
        'utf8'
      );

      // 5. poll for completion (worker DONE/FAIL liveness notice first, then process-gone)
      const outcome = await this.pollUntilDone(paneId, Date.now() + this.cfg.taskTimeoutMs);

      // 6. collect the durable artifact
      const resultPath = join(plan.worktree, 'RESULT.md');
      const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : null;

      // 6b. LOCAL LLM-REVIEW GATE — runs BETWEEN a SUCCESS worker and the ack/finalize.
      //     Only a worker that SUCCEEDED is reviewed (a failed/timed-out run is already
      //     nacked below). The gate FAILS CLOSED: a `block` verdict (or a missing/failed
      //     judge) flips the outcome to a non-ok `review-blocked`, so `report` NACKS the
      //     task — the merge never happens. The teardown still discards the worktree.
      let review: ReviewResult | undefined;
      let finalOutcome = outcome;
      if (this.cfg.review && outcome.ok) {
        review = await this.reviewClaim(plan, spec);
        if (review.verdict !== 'approve') {
          finalOutcome = { ok: false, reason: 'review-blocked' };
        }
      }

      // 7. report terminal state to the QUEUE (ack on approve/success, nack otherwise)
      await this.report(task.id, fencingToken, finalOutcome, result);

      return {
        id: task.id,
        ok: finalOutcome.ok,
        reason: finalOutcome.reason,
        paneId,
        branch: plan.branch,
        worktree: plan.worktree,
        ...(finalOutcome.exitCode != null ? { exitCode: finalOutcome.exitCode } : {}),
        result,
        ...(review ? { review } : {})
      };
    } catch (err) {
      // best-effort requeue so a crashed run doesn't strand the task as `claimed`
      if (fencingToken != null) {
        await this.queue
          .nack(task.id, fencingToken, { requeue: true, error: errMessage(err) })
          .catch(() => {});
      }
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

  /**
   * Translate a worker outcome into the queue's terminal signal, fencing-guarded.
   * A timeout is requeued (worth retrying); an explicit fail / non-zero exit gives up.
   * Best-effort: a 409 means the lease was already superseded, so there's nothing to record.
   */
  private async report(
    taskId: string,
    fencingToken: number,
    outcome: Outcome,
    result: string | null
  ): Promise<void> {
    try {
      if (outcome.ok) {
        await this.queue.ack(taskId, fencingToken, result ?? undefined);
      } else {
        await this.queue.nack(taskId, fencingToken, {
          requeue: outcome.reason === 'timeout',
          error: outcome.reason
        });
      }
    } catch {
      /* lease superseded (409) or queue unreachable — non-fatal */
    }
  }

  /**
   * The LLM-review gate for one CLAIMED, SUCCEEDED task: collect the worker's diff
   * (committed + uncommitted edits on the throwaway branch vs. the base ref) and judge
   * it with `claude -p` via the injected {@link ReviewRunner}. An EMPTY diff is treated
   * as nothing-to-merge and approved (the worker changed no files). Otherwise the verdict
   * is exactly what {@link reviewDiff} returns — and that already FAILS CLOSED to `block`
   * on a missing/failed/unparseable judge, so this method never throws the gate open.
   */
  private async reviewClaim(plan: TaskPlan, spec: TaskSpec): Promise<ReviewResult> {
    const diff = await collectWorkerDiff(this.cfg.repo, plan.worktree, plan.base);
    if (!diff.trim()) {
      return { verdict: 'approve', risk: 0, summary: 'no changes to review (empty diff)' };
    }
    return reviewDiff(
      {
        diff,
        title: plan.title,
        body: spec.prompt,
        ...(this.cfg.reviewModel ? { model: this.cfg.reviewModel } : {})
      },
      this.reviewRunner
    );
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
