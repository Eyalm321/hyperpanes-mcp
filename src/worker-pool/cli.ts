#!/usr/bin/env node
/**
 * CLI for the Phase-1 worktree-per-worker controller (doc 03).
 *
 *   node dist/worker-pool/cli.js [--dry-run] [--tasks tasks.json] [options]
 *
 * `--dry-run` plans every task — branch, worktree path, the `open_pane` spec, the
 * mint scope, the dispatched bus message — WITHOUT touching git or the app, so it
 * needs no running hyperpanes instance. Without it, the controller connects to the
 * master control API (control.json), reconciles orphans, then runs the pool.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Controller, defaultConfig, planTask, type ControllerConfig } from './controller.js';
import { normalizeTasks, type Task } from './kinds.js';

const USAGE = `worker-pool controller (Phase 1)

Usage:
  node dist/worker-pool/cli.js [--dry-run] [--tasks <file>] [options]

Options:
  --dry-run                Plan every task without touching git or the app
  --tasks <file>           JSON file: an array of tasks, or { "tasks": [...] }
  --repo <path>            Git repo to fork worktrees from         (env HP_REPO)
  --pool <id>              Pool id, stamped into pane meta.pool     (env HP_POOL_ID)
  --concurrency <n>        Max simultaneous workers                 (env HP_MAX_CONCURRENT)
  --base <ref>             Default base ref for worktrees           (env HP_BASE)
  --worktree-root <path>   Parent dir for checkouts                 (env HP_WORKTREE_ROOT)
  --timeout-ms <n>         Per-task wall-clock budget               (env HP_TASK_TIMEOUT_MS)
  --window <n>             Target window id (default: first window)
  -h, --help               Show this help

A task is { "id", "prompt", "kind"?, "title"?, "priority"?, "base"? }. Only id and
prompt are required; the rest default. With no --tasks, a built-in sample backlog
runs (each worker writes a mock RESULT.md).`;

/** Built-in sample backlog so the loop runs end-to-end with no input file. */
function defaultTasks(): Task[] {
  return normalizeTasks([
    { id: 't1', kind: 'manual', prompt: 'Summarize the top-level README.' },
    { id: 't2', kind: 'manual', prompt: 'List every TODO/FIXME comment.' },
    { id: 't3', kind: 'manual', prompt: 'Report the language breakdown by line count.' },
    { id: 't4', kind: 'manual', prompt: 'Name the three largest source files.' },
    { id: 't5', kind: 'manual', prompt: 'Describe the build/test commands.' }
  ]);
}

function configFromArgs(values: Record<string, string | boolean | undefined>): ControllerConfig {
  const overrides: Partial<ControllerConfig> = {};
  if (typeof values.repo === 'string') overrides.repo = values.repo;
  if (typeof values.pool === 'string') overrides.poolId = values.pool;
  if (typeof values.base === 'string') overrides.base = values.base;
  if (typeof values['worktree-root'] === 'string') overrides.worktreeRoot = values['worktree-root'];
  if (typeof values.concurrency === 'string') overrides.maxConcurrent = Number(values.concurrency);
  if (typeof values['timeout-ms'] === 'string') overrides.taskTimeoutMs = Number(values['timeout-ms']);
  if (typeof values.window === 'string') overrides.windowId = Number(values.window);
  return defaultConfig(overrides);
}

function loadTasks(file: string | undefined, base: string): Task[] {
  if (!file) return defaultTasks();
  return normalizeTasks(JSON.parse(readFileSync(file, 'utf8')), base);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      tasks: { type: 'string' },
      repo: { type: 'string' },
      pool: { type: 'string' },
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
  const tasks = loadTasks(typeof values.tasks === 'string' ? values.tasks : undefined, cfg.base);

  if (values['dry-run']) {
    runDryRun(cfg, tasks);
    return;
  }

  await runLive(cfg, tasks);
}

function runDryRun(cfg: ControllerConfig, tasks: Task[]): void {
  const plans = tasks.map((t) => planTask(t, cfg));
  console.error(
    `[controller] DRY RUN pool=${cfg.poolId} repo=${cfg.repo} tasks=${tasks.length} cap=${cfg.maxConcurrent}`
  );
  console.error(`[controller] worktreeRoot=${cfg.worktreeRoot} worker=${cfg.workerNode} ${cfg.workerEntry}`);
  for (const p of plans) {
    console.error(
      `\n - ${p.id} (${p.kind}) "${p.title}"\n` +
        `   git: git -C ${cfg.repo} ${p.gitAdd.join(' ')}\n` +
        `   open_pane: ${p.pane.command} ${p.pane.args.join(' ')}  cwd=${p.pane.cwd}\n` +
        `   meta: ${JSON.stringify(p.pane.meta)}\n` +
        `   mint_token: ${p.mintScope} ttlMs=${p.tokenTtlMs}\n` +
        `   handshake: ${p.handshake}\n` +
        `   dispatch → ${p.id}: ${p.dispatchBody}`
    );
  }
  console.log(JSON.stringify({ dryRun: true, pool: cfg.poolId, plans }, null, 2));
}

async function runLive(cfg: ControllerConfig, tasks: Task[]): Promise<void> {
  const controller = new Controller(cfg);
  const conn = await controller.connect();
  console.error(`[controller] connected pid=${conn.pid} version=${conn.version} port=${conn.port}`);

  const reaped = await controller.reconcileOrphans();
  if (reaped.panesClosed || reaped.worktreesRemoved) {
    console.error(
      `[controller] reconciled orphans: ${reaped.panesClosed} pane(s), ${reaped.worktreesRemoved} worktree(s)`
    );
  }

  console.error(`[controller] pool=${cfg.poolId} tasks=${tasks.length} cap=${cfg.maxConcurrent}`);
  const results = await controller.run(tasks);

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
