#!/usr/bin/env node
/**
 * CLI for the worktree-per-worker controller (doc 03), repointed onto the work queue (phase-3).
 *
 *   node dist/worker-pool/cli.js [--dry-run] [--tasks tasks.json] [options]
 *
 * `--dry-run` plans every task — branch, worktree path, the `open_pane` spec, the
 * mint scope, the handshake-delivered task frame — WITHOUT touching git, the queue,
 * or the app, so it needs no running hyperpanes instance. Without it, the controller
 * connects to the master control API (control.json), reconciles orphans, ENQUEUES the
 * backlog onto the durable queue, then drains it through a bounded claim→run→ack pool.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Controller, defaultConfig, planTask, type ControllerConfig } from './controller.js';
import { toEnqueueRequests, decodeSpec, type EnqueueRequest, type Task } from './kinds.js';

const USAGE = `worker-pool controller (queue-backed)

Usage:
  node dist/worker-pool/cli.js [--dry-run] [--tasks <file>] [options]

Options:
  --dry-run                Plan every task without touching git, the queue, or the app
  --tasks <file>           JSON file: an array of tasks, or { "tasks": [...] }
  --repo <path>            Git repo to fork worktrees from         (env HP_REPO)
  --pool <id>              Pool id, stamped into pane meta.pool     (env HP_POOL_ID)
  --queue <name>           Work queue to produce into / claim from  (env HP_QUEUE)
  --concurrency <n>        Max simultaneous workers                 (env HP_MAX_CONCURRENT)
  --base <ref>             Default base ref for worktrees           (env HP_BASE)
  --worktree-root <path>   Parent dir for checkouts                 (env HP_WORKTREE_ROOT)
  --timeout-ms <n>         Per-task wall-clock budget               (env HP_TASK_TIMEOUT_MS)
  --window <n>             Target window id (default: first window)
  -h, --help               Show this help

A task is { "prompt", "kind"?, "title"?, "priority"?, "base"?, "repo"?, "dedupeKey"? }.
Only prompt is required; the QUEUE assigns the id. With no --tasks, a built-in sample
backlog is enqueued (each worker writes a mock RESULT.md).`;

/** Built-in sample backlog so the loop runs end-to-end with no input file. */
function defaultBacklog(): EnqueueRequest[] {
  return toEnqueueRequests([
    { kind: 'manual', prompt: 'Summarize the top-level README.' },
    { kind: 'manual', prompt: 'List every TODO/FIXME comment.' },
    { kind: 'manual', prompt: 'Report the language breakdown by line count.' },
    { kind: 'manual', prompt: 'Name the three largest source files.' },
    { kind: 'manual', prompt: 'Describe the build/test commands.' }
  ]);
}

function configFromArgs(values: Record<string, string | boolean | undefined>): ControllerConfig {
  const overrides: Partial<ControllerConfig> = {};
  if (typeof values.repo === 'string') overrides.repo = values.repo;
  if (typeof values.pool === 'string') overrides.poolId = values.pool;
  if (typeof values.queue === 'string') overrides.queue = values.queue;
  if (typeof values.base === 'string') overrides.base = values.base;
  if (typeof values['worktree-root'] === 'string') overrides.worktreeRoot = values['worktree-root'];
  if (typeof values.concurrency === 'string') overrides.maxConcurrent = Number(values.concurrency);
  if (typeof values['timeout-ms'] === 'string') overrides.taskTimeoutMs = Number(values['timeout-ms']);
  if (typeof values.window === 'string') overrides.windowId = Number(values.window);
  return defaultConfig(overrides);
}

function loadBacklog(file: string | undefined, base: string): EnqueueRequest[] {
  if (!file) return defaultBacklog();
  return toEnqueueRequests(JSON.parse(readFileSync(file, 'utf8')), base);
}

/** Synthesize a canonical Task from an enqueue request so `--dry-run` can plan it
 *  offline. The id is a placeholder — the live queue assigns a uuid on enqueue. */
function syntheticTask(req: EnqueueRequest, queue: string, i: number): Task {
  return {
    id: `dry-${i + 1}`,
    queue,
    seq: i + 1,
    kind: req.kind,
    title: req.title,
    state: 'queued',
    payload: req.payload,
    priority: req.priority,
    attempts: 0,
    maxAttempts: 5,
    availableAt: 0,
    createdAt: 0,
    updatedAt: 0
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      tasks: { type: 'string' },
      repo: { type: 'string' },
      pool: { type: 'string' },
      queue: { type: 'string' },
      concurrency: { type: 'string' },
      base: { type: 'string' },
      'worktree-root': { type: 'string' },
      'timeout-ms': { type: 'string' },
      window: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const cfg = configFromArgs(values);
  const backlog = loadBacklog(typeof values.tasks === 'string' ? values.tasks : undefined, cfg.base);

  if (values['dry-run']) {
    runDryRun(cfg, backlog);
    return;
  }

  await runLive(cfg, backlog);
}

function runDryRun(cfg: ControllerConfig, backlog: EnqueueRequest[]): void {
  const plans = backlog.map((req, i) => {
    const task = syntheticTask(req, cfg.queue, i);
    return planTask(task, decodeSpec(task, cfg.base), cfg);
  });
  console.error(
    `[controller] DRY RUN pool=${cfg.poolId} queue=${cfg.queue} repo=${cfg.repo} tasks=${backlog.length} cap=${cfg.maxConcurrent}`
  );
  console.error(`[controller] worktreeRoot=${cfg.worktreeRoot} worker=${cfg.workerNode} ${cfg.workerEntry}`);
  console.error('[controller] (dry-run ids are placeholders — the live queue assigns a uuid on enqueue)');
  for (const p of plans) {
    console.error(
      `\n - ${p.id} (${p.kind}) "${p.title}"\n` +
        `   git: git -C ${cfg.repo} ${p.gitAdd.join(' ')}\n` +
        `   open_pane: ${p.pane.command} ${p.pane.args.join(' ')}  cwd=${p.pane.cwd}\n` +
        `   meta: ${JSON.stringify(p.pane.meta)}\n` +
        `   mint_token: ${p.mintScope} ttlMs=${p.tokenTtlMs}\n` +
        `   handshake: ${p.handshake}\n` +
        `   dispatch → ${p.id}: ${JSON.stringify(p.dispatch)}`
    );
  }
  console.log(JSON.stringify({ dryRun: true, pool: cfg.poolId, queue: cfg.queue, plans }, null, 2));
}

async function runLive(cfg: ControllerConfig, backlog: EnqueueRequest[]): Promise<void> {
  const controller = new Controller(cfg);
  const conn = await controller.connect();
  console.error(`[controller] connected pid=${conn.pid} version=${conn.version} port=${conn.port}`);

  const reaped = await controller.reconcileOrphans();
  if (reaped.panesClosed || reaped.worktreesRemoved) {
    console.error(
      `[controller] reconciled orphans: ${reaped.panesClosed} pane(s), ${reaped.worktreesRemoved} worktree(s)`
    );
  }

  console.error(
    `[controller] pool=${cfg.poolId} queue=${cfg.queue} tasks=${backlog.length} cap=${cfg.maxConcurrent}`
  );
  const results = await controller.run(backlog);

  const ok = results.filter((r) => r.ok).length;
  console.error(`\n[controller] done: ${ok}/${results.length} succeeded`);
  for (const r of results) {
    const code = r.exitCode != null ? ` code=${r.exitCode}` : '';
    console.error(` - ${r.id}: ${r.ok ? 'OK' : 'FAIL'} (${r.reason}${code})${r.error ? ` ${r.error}` : ''}`);
  }
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = ok === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error('[controller] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
