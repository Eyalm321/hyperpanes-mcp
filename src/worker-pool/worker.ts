/**
 * In-pane worker entry (Phase 1) — doc 03 §6, repointed onto the work queue (phase-3).
 *
 * Launched by the controller via `open_pane`, cwd'd into its isolated worktree.
 * It (1) blocks until the controller writes a handshake file, (2) reads its TASK and
 * pane-scoped creds (token+port) straight from that handshake — the queue is now the
 * dispatch substrate, so the task no longer arrives over the inbox bus, and the worker
 * is NEVER handed control.json or the master token — (3) does the work, (4) writes the
 * durable `RESULT.md`, (5) emits a DONE/FAIL liveness notice to its own inbox (the
 * controller polls this) and exits so the pane becomes `exited`. The controller maps
 * that outcome onto the queue via `ack`/`nack`.
 *
 * The "do the work" block is a mock by default (writes a trivial RESULT.md) so the
 * whole loop runs end-to-end with no API key; swap it for a real `claude` per doc
 * 03 §7. This file reuses the repo's own {@link ControlClient}, which depends only
 * on Node built-ins + global `fetch` — so the worker needs nothing installed in
 * the checkout.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { ControlClient } from '../control/client.js';
import type { Discovery } from '../control/discovery.js';
import type { DispatchedTask } from './kinds.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Handshake {
  token: string;
  port: number;
  paneId: string;
  /** The task to run — delivered IN the handshake (not the inbox bus) now that the
   *  controller sources work from the durable queue. */
  task: DispatchedTask;
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

  // ===== DO THE WORK =====  (mock; replace with a real agent — doc 03 §7)
  const out =
    `# Result for ${task.id}\n\n` +
    `## Task\n${task.title ?? task.id}\n\n` +
    `## Prompt\n${task.prompt}\n\n` +
    `Worked in: ${process.cwd()}\n` +
    `Finished: ${new Date().toISOString()}\n`;
  writeFileSync('RESULT.md', out, 'utf8');

  // Liveness notice to our own inbox (the controller polls it), then exit → pane 'exited'.
  await client.sendMessage(hs.paneId, hs.paneId, `DONE ${task.id}`).catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  try {
    writeFileSync('RESULT.md', `# FAILED\n\n${err instanceof Error ? err.stack : String(err)}\n`, 'utf8');
  } catch {
    /* best effort */
  }
  process.exit(1);
});
