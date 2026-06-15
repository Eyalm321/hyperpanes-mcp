/**
 * In-pane worker entry (Phase 1) — doc 03 §6, repointed onto the work queue (phase-3),
 * with a REAL agent body (doc 03 §7).
 *
 * Launched by the controller via `open_pane`, cwd'd into its isolated worktree.
 * It (1) blocks until the controller writes a handshake file, (2) reads its TASK and
 * pane-scoped creds (token+port) straight from that handshake — the queue is now the
 * dispatch substrate, so the task no longer arrives over the inbox bus, and the worker
 * is NEVER handed control.json or the master token — (3) RUNS THE CODING AGENT as a
 * headless subprocess in that worktree, (4) writes the durable `RESULT.md` from the
 * agent's real output, (5) emits a DONE/FAIL liveness notice to its own inbox (the
 * controller polls this) and exits with a code the controller maps onto the queue via
 * `ack`/`nack`.
 *
 * The agent run is gated behind an injectable {@link AgentRunner} so unit tests use a
 * FAKE runner and never spawn `claude`. The default runner ({@link spawnAgentRunner})
 * shells out to the configured command (default
 * `claude --permission-mode acceptEdits -p "<prompt>"`, overridable via
 * `HP_WORKER_AGENT_CMD`) with a wall-clock timeout. This file reuses the repo's own
 * {@link ControlClient}, which depends only on Node built-ins + global `fetch` — so the
 * worker needs nothing installed in the checkout.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ControlClient } from '../control/client.js';
import type { Discovery } from '../control/discovery.js';
import type { DispatchedTask } from './kinds.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Default agent budget if the controller doesn't pass one through the env. */
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;

interface Handshake {
  token: string;
  port: number;
  paneId: string;
  /** The task to run — delivered IN the handshake (not the inbox bus) now that the
   *  controller sources work from the durable queue. */
  task: DispatchedTask;
}

/** What the controller-facing caller learns about one agent run. */
export interface AgentOutcome {
  /** `'success'` only on a clean exit-0 within the budget. */
  status: 'success' | 'failed' | 'timeout';
  /** Process exit code (absent if the agent never produced one, e.g. on timeout). */
  exitCode?: number;
  /** Captured stdout (+ stderr tail), the body that seeds RESULT.md. */
  output: string;
  /** Set when the agent overran its wall-clock budget. */
  timedOut: boolean;
}

/** The command this worker will spawn for an agent run. */
export interface AgentCommand {
  command: string;
  args: string[];
}

/** Inputs to a single agent invocation. */
export interface AgentRunInput {
  /** The full instruction handed to the agent. */
  prompt: string;
  /** Working directory for the run (the task's isolated worktree). */
  cwd: string;
  /** Wall-clock budget; the run is killed and reported `timeout` past this. */
  timeoutMs: number;
}

/** The raw result of executing the agent command — what a runner returns. */
export interface AgentRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Injectable seam: anything that can run an agent and return its captured output.
 * Production uses {@link spawnAgentRunner}; unit tests inject a FAKE so they never
 * spawn `claude`.
 */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/**
 * Resolve the agent command. `HP_WORKER_AGENT_CMD`, when set, is a whitespace-split
 * argv whose `{prompt}` token (if present) is substituted with the task prompt;
 * otherwise the prompt is appended as the final argument. The default is
 * `claude --permission-mode acceptEdits -p <prompt>`.
 */
export function resolveAgentCommand(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env
): AgentCommand {
  const raw = (env.HP_WORKER_AGENT_CMD ?? '').trim();
  if (!raw) {
    return { command: 'claude', args: ['--permission-mode', 'acceptEdits', '-p', prompt] };
  }
  const parts = raw.split(/\s+/);
  const command = parts[0] as string;
  const rest = parts.slice(1);
  const hasSlot = rest.some((a) => a.includes('{prompt}'));
  const args = hasSlot ? rest.map((a) => a.replace('{prompt}', prompt)) : [...rest, prompt];
  return { command, args };
}

/**
 * The default, real runner: spawns the agent command in `cwd`, captures stdout/stderr,
 * and enforces `timeoutMs` (SIGTERM, then SIGKILL). Never throws on a non-zero exit —
 * a failed agent is data, returned as a result.
 */
export function spawnAgentRunner(env: NodeJS.ProcessEnv = process.env): AgentRunner {
  return {
    run(input: AgentRunInput): Promise<AgentRunResult> {
      const { command, args } = resolveAgentCommand(input.prompt, env);
      return new Promise<AgentRunResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const child = spawn(command, args, { cwd: input.cwd, env });

        const finish = (res: AgentRunResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          resolve(res);
        };

        const killTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          // Hard-kill if it ignores the polite signal.
          setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        }, input.timeoutMs);
        killTimer.unref();

        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('error', (err) => {
          // spawn failure (e.g. command not found) — surface as a failed run.
          finish({ exitCode: null, stdout, stderr: stderr + String(err), timedOut });
        });
        child.on('close', (code) => {
          finish({ exitCode: code, stdout, stderr, timedOut });
        });
      });
    }
  };
}

/** Map a raw runner result to a controller-facing outcome. */
export function classifyRun(res: AgentRunResult): AgentOutcome {
  const output = res.stderr ? `${res.stdout}\n--- stderr ---\n${res.stderr}` : res.stdout;
  if (res.timedOut) {
    return {
      status: 'timeout',
      ...(res.exitCode != null ? { exitCode: res.exitCode } : {}),
      output,
      timedOut: true
    };
  }
  const status = res.exitCode === 0 ? 'success' : 'failed';
  return {
    status,
    ...(res.exitCode != null ? { exitCode: res.exitCode } : {}),
    output,
    timedOut: false
  };
}

/** Render the durable RESULT.md from a task + the agent outcome. */
export function renderResult(task: DispatchedTask, outcome: AgentOutcome, cwd: string): string {
  const heading =
    outcome.status === 'success'
      ? `# Result for ${task.id}`
      : outcome.status === 'timeout'
        ? `# TIMEOUT for ${task.id}`
        : `# FAILED for ${task.id}`;
  const code = outcome.exitCode != null ? String(outcome.exitCode) : 'n/a';
  return (
    `${heading}\n\n` +
    `## Task\n${task.title || task.id}\n\n` +
    `## Prompt\n${task.prompt}\n\n` +
    `## Agent output\n${outcome.output || '(no output)'}\n\n` +
    `---\n` +
    `status: ${outcome.status}\n` +
    `exitCode: ${code}\n` +
    `worktree: ${cwd}\n` +
    `finished: ${new Date().toISOString()}\n`
  );
}

/**
 * Run ONE task end-to-end with an injected runner: invoke the agent, classify the
 * outcome, and write RESULT.md into `cwd`. Pure of any process/exit/control concerns
 * so it's directly unit-testable with a FAKE runner.
 */
export async function runTask(
  task: DispatchedTask,
  runner: AgentRunner,
  opts: { cwd: string; timeoutMs: number }
): Promise<AgentOutcome> {
  let outcome: AgentOutcome;
  try {
    const res = await runner.run({ prompt: task.prompt, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    outcome = classifyRun(res);
  } catch (err) {
    outcome = {
      status: 'failed',
      output: `agent runner threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      timedOut: false
    };
  }
  writeFileSync(`${opts.cwd}/RESULT.md`, renderResult(task, outcome, opts.cwd), 'utf8');
  return outcome;
}

/** Block until the controller mints a token and writes the handshake, then consume it. */
async function waitHandshake(path: string): Promise<Handshake> {
  for (let i = 0; i < 120; i++) {
    // up to ~60s for the controller to mint + write
    if (existsSync(path)) {
      const h = JSON.parse(readFileSync(path, 'utf8')) as Handshake;
      try {
        rmSync(path, { force: true }); // consume the secret the instant it's read
      } catch {
        /* best effort */
      }
      return h;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for controller handshake at ${path}`);
}

function scopedClient(hs: Handshake): ControlClient {
  const discovery: Discovery = {
    port: hs.port,
    token: hs.token,
    events: `ws://127.0.0.1:${hs.port}/events?token=${hs.token}`
  };
  return new ControlClient(discovery);
}

/** Wall-clock budget for the agent, from the controller (HP_TASK_TIMEOUT_MS) or default. */
function agentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HP_TASK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AGENT_TIMEOUT_MS;
}

async function main(): Promise<void> {
  const handshakePath = process.env.HP_HANDSHAKE;
  if (!handshakePath) throw new Error('HP_HANDSHAKE not set — worker launched without a handshake path');

  const hs = await waitHandshake(handshakePath);
  const client = scopedClient(hs);

  const task = hs.task;
  if (!task || typeof task.prompt !== 'string' || typeof task.id !== 'string') {
    writeFileSync('RESULT.md', '# FAILED\n\nno task delivered in the handshake\n', 'utf8');
    await client.sendMessage(hs.paneId, hs.paneId, 'FAIL no-task').catch(() => {});
    process.exit(2);
  }

  // ===== DO THE WORK ===== (real agent — doc 03 §7; gated behind the injectable runner)
  const outcome = await runTask(task, spawnAgentRunner(), {
    cwd: process.cwd(),
    timeoutMs: agentTimeoutMs()
  });

  // Liveness notice to our own inbox (the controller polls it), then exit. The exit
  // CODE is the queue signal: 0 ⇒ ack, non-zero ⇒ nack (timeout is requeued upstream).
  const ok = outcome.status === 'success';
  await client.sendMessage(hs.paneId, hs.paneId, `${ok ? 'DONE' : 'FAIL'} ${task.id} ${outcome.status}`).catch(() => {});
  process.exit(ok ? 0 : 1);
}

/** Run `main()` only when executed as the entry point — never on import (tests). */
const isEntry = (() => {
  const argv1 = process.argv[1];
  return argv1 ? import.meta.url === pathToFileURL(argv1).href : false;
})();

if (isEntry) {
  main().catch((err) => {
    try {
      writeFileSync('RESULT.md', `# FAILED\n\n${err instanceof Error ? err.stack : String(err)}\n`, 'utf8');
    } catch {
      /* best effort */
    }
    process.exit(1);
  });
}
