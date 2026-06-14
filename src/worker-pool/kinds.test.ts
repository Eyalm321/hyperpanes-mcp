import { describe, it, expect } from 'vitest';
import {
  normalizeTask,
  normalizeTasks,
  slugify,
  deriveBranch,
  worktreePath,
  safeName
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

describe('normalizeTask', () => {
  it('requires id + prompt and fills defaults', () => {
    const t = normalizeTask({ id: 'tsk_1', prompt: 'Do the thing' });
    expect(t.kind).toBe('manual');
    expect(t.priority).toBe(50);
    expect(t.base).toBe('HEAD');
    expect(t.title).toBe('Do the thing');
  });
  it('derives a title from the first line of the prompt', () => {
    const t = normalizeTask({ id: 'x', prompt: 'First line\nsecond line' });
    expect(t.title).toBe('First line');
  });
  it('passes source/payload through verbatim (queue-opaque)', () => {
    const t = normalizeTask({ id: 'x', prompt: 'p', source: { kind: 'issue', number: 920 } });
    expect(t.source).toEqual({ kind: 'issue', number: 920 });
  });
  it('honors an explicit base override', () => {
    const t = normalizeTask({ id: 'x', prompt: 'p', base: 'main' }, 'HEAD');
    expect(t.base).toBe('main');
  });
  it('rejects a task with no prompt', () => {
    expect(() => normalizeTask({ id: 'x' })).toThrow();
  });
});

describe('normalizeTasks', () => {
  it('accepts a bare array or a { tasks } wrapper', () => {
    const a = normalizeTasks([{ id: '1', prompt: 'p' }]);
    const b = normalizeTasks({ tasks: [{ id: '1', prompt: 'p' }] });
    expect(a).toEqual(b);
  });
  it('rejects a non-array, non-wrapper shape', () => {
    expect(() => normalizeTasks({ nope: true })).toThrow();
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

describe('planTask', () => {
  const cfg: ControllerConfig = defaultConfig({
    repo: '/repo',
    worktreeRoot: '/wt',
    poolId: 'pool-test',
    handshakeDir: '/hs',
    workerNode: 'node',
    workerEntry: '/abs/dist/worker-pool/worker.js',
    base: 'HEAD'
  });

  it('plans git, pane, mint, and dispatch coherently for one task', () => {
    const task = normalizeTask({ id: 'tsk_9', kind: 'ci_failure', title: 'Fix x', prompt: 'fix it', base: 'main' });
    const p = planTask(task, cfg);

    expect(p.branch).toBe('agent/tsk_9-fix-x');
    expect(p.worktree).toBe('/wt/pool-test-tsk_9');
    expect(p.base).toBe('main'); // task.base wins over cfg.base
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

    // dispatch body is the typed task frame the worker pulls off the bus
    expect(JSON.parse(p.dispatchBody)).toMatchObject({ type: 'task', id: 'tsk_9', prompt: 'fix it', branch: p.branch });
  });

  it('falls back to cfg.base when the task omits one', () => {
    const task = { ...normalizeTask({ id: 'z', prompt: 'p' }), base: '' };
    expect(planTask(task, cfg).base).toBe('HEAD');
  });
});
