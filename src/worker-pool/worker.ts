/**
 * In-pane worker entry (Phase 1) — doc 03 §6.
 *
 * Launched by the controller via `open_pane`, cwd'd into its isolated worktree.
 * It (1) blocks until the controller writes a handshake file, (2) opens a control
 * client SCOPED to its own pane (token+port from the handshake — it is NEVER
 * handed control.json or the master token), (3) pulls its task off its own durable
 * inbox over the message bus, (4) does the work, (5) reports DONE on the bus and
 * exits so the pane becomes `exited`.
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Handshake {
  token: string;
  port: number;
  paneId: string;
}

interface Dispatched {
  type: 'task';
  id: string;
  prompt: string;
  title?: string;
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

/** Pull the dispatched task off our own inbox (over the bus). */
async function awaitTask(client: ControlClient, paneId: string): Promise<Dispatched | null> {
  let cursor = 0;
  for (let i = 0; i < 240; i++) {
    // up to ~120s
    const inbox = await client.readMessages(paneId, cursor).catch(() => null);
    if (inbox) {
      for (const m of inbox.messages) {
        cursor = Math.max(cursor, m.seq);
        try {
          const body = JSON.parse(m.body) as Partial<Dispatched>;
          if (body.type === 'task' && typeof body.id === 'string' && typeof body.prompt === 'string') {
            return body as Dispatched;
          }
        } catch {
          /* not our JSON task frame — ignore */
        }
      }
    }
    await sleep(500);
  }
  return null;
}

async function main(): Promise<void> {
  const handshakePath = process.env.HP_HANDSHAKE;
  if (!handshakePath) throw new Error('HP_HANDSHAKE not set — worker launched without a handshake path');

  const hs = await waitHandshake(handshakePath);
  const client = scopedClient(hs);

  const task = await awaitTask(client, hs.paneId);
  if (!task) {
    writeFileSync('RESULT.md', '# FAILED\n\nno task received on the bus\n', 'utf8');
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

  // Report completion over the bus (to our own inbox), then exit → pane 'exited'.
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
