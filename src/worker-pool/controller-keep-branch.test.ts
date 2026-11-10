import { describe, expect, it } from 'vitest';
import { Controller, defaultConfig } from './controller.js';
import { encodeSpec, type Task } from './kinds.js';

/** Teardown keeps the branch for GitHub-sourced tasks (so the PR step has something to push). */
async function run(source: unknown): Promise<string[]> {
  const cfg = defaultConfig({ repo: '/nonexistent', worktreeRoot: '/nonexistent', handshakeDir: '/nonexistent', base: 'main', poolId: 'p', maxConcurrent: 1 });
  const c = new Controller(cfg);
  const deleted: string[] = [];
  const priv = c as unknown as Record<string, unknown>;
  priv.git = {
    worktreeAdd: async () => {},
    worktreeRemove: async () => {},
    worktreePrune: async () => {},
    branchDelete: async (b: string) => void deleted.push(b)
  };
  priv.openWorkerPane = async () => 'pane-1';
  priv.client = { mintToken: async () => ({ token: 't', port: 1 }), command: async () => ({ ok: true }) };
  priv.queue = { ack: async () => ({ ok: true }), nack: async () => ({ ok: true }) };
  priv.pollUntilDone = async () => ({ ok: false, reason: 'failed' });
  priv.findPane = async () => undefined;
  const task: Task = {
    id: 'tsk1', queue: 'q', seq: 1, kind: 'manual', title: 'T', state: 'claimed',
    payload: encodeSpec({ prompt: 'p', base: 'main', ...(source ? { source } : {}) }),
    priority: 50, attempts: 1, maxAttempts: 3, availableAt: 0, fencingToken: 1, createdAt: 0, updatedAt: 0
  };
  await c.runClaim(task);
  return deleted;
}

describe('controller teardown branch retention', () => {
  it('keeps the branch for github_issue and github_ci tasks', async () => {
    expect(await run({ kind: 'github_issue', repo: 'acme/widgets', number: 1, gen: 1 })).toEqual([]);
    expect(await run({ kind: 'github_ci', repo: 'acme/widgets', runId: 1 })).toEqual([]);
  });
  it('still deletes the branch for everything else', async () => {
    expect(await run(undefined)).toHaveLength(1);
    expect(await run({ kind: 'todo' })).toHaveLength(1);
  });
});
