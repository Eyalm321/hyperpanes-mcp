import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, defaultConfig, type ControllerConfig } from './controller.js';
import { encodeSpec, type Task } from './kinds.js';
import type { ReviewRunner, ReviewRunInput, ReviewRunResult } from './review.js';

/**
 * Controller-level gate test: a worker SUCCEEDS, then the LLM-review gate runs against
 * the worker's REAL diff (a real temp git repo + worktree). A `block` verdict must
 * prevent the merge — i.e. the queue is NACKED, never ACKED — while an `approve`
 * verdict acks. The ControlClient/QueueClient are stubbed; the ReviewRunner is FAKE so
 * `claude` is never spawned.
 */

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** A FAKE review runner returning a canned verdict; asserts no `claude` spawn. */
function fakeReviewRunner(stdout: string): { runner: ReviewRunner; calls: ReviewRunInput[] } {
  const calls: ReviewRunInput[] = [];
  return {
    calls,
    runner: {
      run(input: ReviewRunInput): Promise<ReviewRunResult> {
        calls.push(input);
        return Promise.resolve({ exitCode: 0, stdout, stderr: '', timedOut: false });
      }
    }
  };
}

/** Records ack/nack calls so the test can assert the merge decision. */
interface QueueSpy {
  acks: Array<{ taskId: string; result?: string }>;
  nacks: Array<{ taskId: string; error?: string; requeue?: boolean }>;
}

/**
 * Stub the controller's collaborators (private fields) so `runClaim` runs end-to-end
 * without a live hyperpanes app: the pane "opens", reports DONE, and exits 0; the queue
 * records ack/nack. The git wrapper stays REAL so the gate reviews a real diff.
 */
function wireStubs(controller: Controller, spy: QueueSpy): void {
  const c = controller as unknown as {
    client: unknown;
    queue: unknown;
    git: { worktreeAdd: (...a: unknown[]) => Promise<void> };
    openWorkerPane: (plan: unknown) => Promise<string>;
    pollUntilDone: () => Promise<{ ok: boolean; reason: string; exitCode?: number }>;
    teardown: () => Promise<void>;
  };
  // The test pre-seeds the worktree (with a committed change); don't let runClaim's
  // own `worktree add -B` reset the branch back to base and wipe that change.
  c.git.worktreeAdd = () => Promise.resolve();
  c.client = {
    mintToken: () => Promise.resolve({ token: 'tok', port: 1234 }),
    command: () => Promise.resolve({ ok: true })
  };
  c.queue = {
    ack: (taskId: string, _fence: number, result?: string) => {
      spy.acks.push({ taskId, result });
      return Promise.resolve({ ok: true });
    },
    nack: (taskId: string, _fence: number, opts: { error?: string; requeue?: boolean } = {}) => {
      spy.nacks.push({ taskId, error: opts.error, requeue: opts.requeue });
      return Promise.resolve({ ok: true });
    }
  };
  c.openWorkerPane = () => Promise.resolve('pane-1');
  c.pollUntilDone = () => Promise.resolve({ ok: true, reason: 'reported-done' });
  c.teardown = () => Promise.resolve();
}

describe('Controller LLM-review gate (block prevents merge)', () => {
  let repo: string;
  let worktreeRoot: string;
  let handshakeDir: string;
  let cfg: ControllerConfig;
  let task: Task;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'hp-review-repo-'));
    worktreeRoot = mkdtempSync(join(tmpdir(), 'hp-review-wt-'));
    handshakeDir = join(worktreeRoot, '.handshakes');
    mkdirSync(handshakeDir, { recursive: true });

    // a real repo with one base commit
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);

    cfg = defaultConfig({
      repo,
      worktreeRoot,
      handshakeDir,
      base: 'main',
      poolId: 'pool-test',
      maxConcurrent: 1
    });

    task = {
      id: 'tsk_review',
      queue: 'default',
      seq: 1,
      kind: 'manual',
      title: 'Add a feature',
      state: 'claimed',
      payload: encodeSpec({ prompt: 'add a feature', base: 'main' }),
      priority: 50,
      attempts: 1,
      maxAttempts: 5,
      availableAt: 0,
      fencingToken: 7,
      createdAt: 0,
      updatedAt: 0
    };
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  });

  /** Materialize the worktree the way step 1 of runClaim would, then add a real change
   *  so the gate has a non-empty diff to review. */
  function seedWorktreeChange(): string {
    const branch = `agent/${task.id}-add-a-feature`;
    const wt = join(worktreeRoot, `${cfg.poolId}-${task.id}`);
    git(repo, ['worktree', 'add', '-f', '-b', branch, wt, 'main']);
    // The worker commits its work — `git diff main` from the worktree then shows it.
    writeFileSync(join(wt, 'feature.txt'), 'a brand new feature\n');
    git(wt, ['add', '-A']);
    git(wt, ['config', 'user.email', 't@t']);
    git(wt, ['config', 'user.name', 't']);
    git(wt, ['commit', '-qm', 'add feature']);
    writeFileSync(join(wt, 'RESULT.md'), '# Result for tsk_review\n\nstatus: success\n');
    return wt;
  }

  it('BLOCK verdict ⇒ task is NACKED (merge prevented), never acked', async () => {
    const { runner, calls } = fakeReviewRunner('{"verdict":"block","risk":9,"summary":"weakens auth"}');
    const controller = new Controller(cfg, runner);
    const spy: QueueSpy = { acks: [], nacks: [] };
    wireStubs(controller, spy);
    seedWorktreeChange();

    const res = await controller.runClaim(task);

    // the gate ran (real diff reached the FAKE judge — never `claude`)
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain('a brand new feature');
    // merge prevented
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('review-blocked');
    expect(res.review?.verdict).toBe('block');
    expect(spy.acks).toHaveLength(0);
    expect(spy.nacks).toHaveLength(1);
    expect(spy.nacks[0]?.taskId).toBe('tsk_review');
    expect(spy.nacks[0]?.error).toBe('review-blocked');
  });

  it('APPROVE verdict ⇒ task is ACKED (success path continues)', async () => {
    const { runner } = fakeReviewRunner('{"verdict":"approve","risk":1,"summary":"clean"}');
    const controller = new Controller(cfg, runner);
    const spy: QueueSpy = { acks: [], nacks: [] };
    wireStubs(controller, spy);
    seedWorktreeChange();

    const res = await controller.runClaim(task);

    expect(res.ok).toBe(true);
    expect(res.review?.verdict).toBe('approve');
    expect(spy.acks).toHaveLength(1);
    expect(spy.acks[0]?.taskId).toBe('tsk_review');
    expect(spy.nacks).toHaveLength(0);
  });

  it('review disabled (--no-review) ⇒ no judge call, success acks straight through', async () => {
    const { runner, calls } = fakeReviewRunner('{"verdict":"block","risk":9,"summary":"would block"}');
    const controller = new Controller({ ...cfg, review: false }, runner);
    const spy: QueueSpy = { acks: [], nacks: [] };
    wireStubs(controller, spy);
    seedWorktreeChange();

    const res = await controller.runClaim(task);

    expect(calls).toHaveLength(0); // gate skipped entirely
    expect(res.ok).toBe(true);
    expect(res.review).toBeUndefined();
    expect(spy.acks).toHaveLength(1);
    expect(spy.nacks).toHaveLength(0);
  });
});
