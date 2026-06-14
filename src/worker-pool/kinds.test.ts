import { describe, it, expect } from 'vitest';
import {
  toEnqueueRequest,
  toEnqueueRequests,
  encodeSpec,
  decodeSpec,
  slugify,
  deriveBranch,
  worktreePath,
  safeName,
  type Task,
  type TaskSpec
} from './kinds.js';
import { planTask, defaultConfig, type ControllerConfig } from './controller.js';

describe('slugify', () => {
  it('lowercases, kebabs, and bounds length', () => {
    expect(slugify('Fix flaky test session_expiry')).toBe('fix-flaky-test-session-expiry');
    expect(slugify('  Trailing/Leading!! ')).toBe('trailing-leading');
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
  it('falls back when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('task');
    expect(slugify('')).toBe('task');
  });
});

describe('toEnqueueRequest', () => {
  it('requires prompt, fills column defaults, and encodes the opaque spec', () => {
    const r = toEnqueueRequest({ prompt: 'Do the thing' });
    expect(r.kind).toBe('manual');
    expect(r.priority).toBe(50);
    expect(r.title).toBe('Do the thing');
    expect(JSON.parse(r.payload)).toEqual({ prompt: 'Do the thing', base: 'HEAD' });
  });
  it('derives a title from the first line of the prompt', () => {
    const r = toEnqueueRequest({ prompt: 'First line\nsecond line' });
    expect(r.title).toBe('First line');
  });
  it('carries source/payload into the opaque spec verbatim (queue-opaque)', () => {
    const r = toEnqueueRequest({ prompt: 'p', source: { kind: 'issue', number: 920 } });
    const spec = JSON.parse(r.payload) as TaskSpec;
    expect(spec.source).toEqual({ kind: 'issue', number: 920 });
  });
  it('honors an explicit base override', () => {
    const r = toEnqueueRequest({ prompt: 'p', base: 'main' }, 'HEAD');
    expect((JSON.parse(r.payload) as TaskSpec).base).toBe('main');
  });
  it('rejects a task with no prompt', () => {
    expect(() => toEnqueueRequest({ kind: 'manual' })).toThrow();
  });
});

describe('toEnqueueRequests', () => {
  it('accepts a bare array or a { tasks } wrapper', () => {
    const a = toEnqueueRequests([{ prompt: 'p' }]);
    const b = toEnqueueRequests({ tasks: [{ prompt: 'p' }] });
    expect(a).toEqual(b);
  });
  it('rejects a non-array, non-wrapper shape', () => {
    expect(() => toEnqueueRequests({ nope: true })).toThrow();
  });
});

describe('encodeSpec / decodeSpec', () => {
  it('round-trips a spec through the opaque payload string', () => {
    const spec: TaskSpec = { prompt: 'fix it', base: 'main', repo: 'git@h:r.git' };
    const payload = encodeSpec(spec);
    expect(typeof payload).toBe('string');
    expect(decodeSpec({ payload })).toEqual(spec);
  });
  it('treats a non-JSON payload as raw prompt text', () => {
    expect(decodeSpec({ payload: 'just do it' })).toEqual({ prompt: 'just do it', base: 'HEAD' });
  });
  it('defaults base when the payload omits it', () => {
    expect(decodeSpec({ payload: '{"prompt":"p"}' }, 'develop').base).toBe('develop');
  });
});

describe('deriveBranch', () => {
  it('is a pure function of id + title (idempotent re-runs)', () => {
    const task = { id: 'tsk_01J9X8Z2', title: 'Fix flaky test session_expiry' };
    expect(deriveBranch(task)).toBe(deriveBranch({ ...task }));
    expect(deriveBranch(task)).toBe('agent/tsk_01J9X8Z2-fix-flaky-test-session-expiry');
  });
  it('produces a ref-safe branch from a hostile id', () => {
    const b = deriveBranch({ id: '../evil id', title: 'x' });
    expect(b.startsWith('agent/')).toBe(true);
    expect(b).not.toContain('..');
    expect(b).not.toContain(' ');
  });
});

describe('safeName / worktreePath', () => {
  it('keeps the path under the pool prefix and sanitizes the id', () => {
    expect(safeName('a/b c')).toBe('a_b_c');
    expect(worktreePath('/wt', 'pool-7', { id: 'tsk_1' })).toBe('/wt/pool-7-tsk_1');
  });
});

describe('canonical Task wire shape', () => {
  it('mirrors the Rust queue: camelCase, epoch-ms numbers, FLATTENED lease', () => {
    const claimed: Task = {
      id: 'tsk_1',
      queue: 'build',
      seq: 1,
      kind: 'manual',
      title: 'T',
      state: 'claimed',
      payload: '{}',
      priority: 50,
      attempts: 1,
      maxAttempts: 5,
      availableAt: 0,
      claimedBy: 'wkr-1',
      fencingToken: 1,
      visibilityDeadline: 30000,
      createdAt: 0,
      updatedAt: 0
    };
    // flattened lease — these are TOP-LEVEL fields, never a nested `lease` object
    expect(claimed.claimedBy).toBe('wkr-1');
    expect(typeof claimed.fencingToken).toBe('number');
    expect(typeof claimed.visibilityDeadline).toBe('number');
    expect('lease' in claimed).toBe(false);
    // epoch-ms numbers, not ISO strings
    expect(typeof claimed.createdAt).toBe('number');
    expect(typeof claimed.availableAt).toBe('number');
    expect(typeof claimed.updatedAt).toBe('number');
  });
});

describe('planTask', () => {
  const cfg: ControllerConfig = defaultConfig({
    repo: '/repo',
    worktreeRoot: '/wt',
    poolId: 'pool-test',
    handshakeDir: '/hs',
    workerNode: 'node',
    workerEntry: '/abs/dist/worker-pool/worker.js',
    base: 'HEAD',
    queue: 'build'
  });

  /** A claimed canonical Task whose opaque payload encodes the given spec fields. */
  function claimed(over: Partial<Task> & { payload: string }): Task {
    return {
      id: 'tsk_9',
      queue: 'build',
      seq: 1,
      kind: 'ci_failure',
      title: 'Fix x',
      state: 'claimed',
      priority: 50,
      attempts: 1,
      maxAttempts: 5,
      availableAt: 0,
      fencingToken: 1,
      createdAt: 0,
      updatedAt: 0,
      ...over
    };
  }

  it('plans git, pane, mint, and dispatch coherently for one claimed task', () => {
    const task = claimed({ payload: encodeSpec({ prompt: 'fix it', base: 'main' }) });
    const p = planTask(task, decodeSpec(task, cfg.base), cfg);

    expect(p.branch).toBe('agent/tsk_9-fix-x');
    expect(p.worktree).toBe('/wt/pool-test-tsk_9');
    expect(p.base).toBe('main'); // spec.base wins over cfg.base
    expect(p.gitAdd).toEqual(['worktree', 'add', '-f', '-b', 'agent/tsk_9-fix-x', '/wt/pool-test-tsk_9', 'main']);

    // pane: direct-spawn argv into the worktree, self-describing meta
    expect(p.pane.command).toBe('node');
    expect(p.pane.args).toEqual(['/abs/dist/worker-pool/worker.js']);
    expect(p.pane.cwd).toBe('/wt/pool-test-tsk_9');
    expect(p.pane.meta).toEqual({ role: 'worker', pool: 'pool-test', task: 'tsk_9', parent: 'controller' });
    expect(p.pane.env.HP_HANDSHAKE).toBe(p.handshake);
    expect(p.pane.label.length).toBeLessThanOrEqual(80);

    // the handshake lives in the private dir, never inside the checkout
    expect(p.handshake.startsWith('/hs/')).toBe(true);

    // dispatch frame handed to the worker via the handshake (NOT the inbox bus)
    expect(p.dispatch).toMatchObject({
      id: 'tsk_9',
      kind: 'ci_failure',
      title: 'Fix x',
      prompt: 'fix it',
      base: 'main',
      branch: p.branch,
      worktree: p.worktree
    });
  });

  it('falls back to cfg.base when the spec omits one', () => {
    const task = claimed({ payload: encodeSpec({ prompt: 'p', base: '' }) });
    expect(planTask(task, decodeSpec(task, cfg.base), cfg).base).toBe('HEAD');
  });
});
