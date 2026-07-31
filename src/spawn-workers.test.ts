import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';
import {
  workerAccountEnv,
  workerPaneEnv,
  workerPaneMeta,
  validateAccountsRotation
} from './control-tools.js';

// The spawn_workers tool must stay registered (regression guard for the #6 worker-pool
// surface: a dropped registration or rename silently removes one-call pool spawning).
describe('spawn_workers tool registration', () => {
  it('registers spawn_workers on the server', () => {
    const server = createServer();
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    );
    expect(names).toContain('spawn_workers');
  });
});

// Account rotation (env.CLAUDE_CONFIG_DIR) for spawn_workers({ accounts }).
describe('workerAccountEnv / workerPaneEnv', () => {
  const accounts = ['/accts/a', '/accts/b'];

  it('round-robins accounts across pane-per-worker panes (count=3, 2 accounts)', () => {
    expect(workerAccountEnv(0, true, accounts)).toEqual({ CLAUDE_CONFIG_DIR: '/accts/a' });
    expect(workerAccountEnv(1, true, accounts)).toEqual({ CLAUDE_CONFIG_DIR: '/accts/b' });
    expect(workerAccountEnv(2, true, accounts)).toEqual({ CLAUDE_CONFIG_DIR: '/accts/a' });
  });

  it('single-pane with a single worker gets accounts[0] (count > 1 is rejected before this)', () => {
    expect(workerAccountEnv(0, false, accounts)).toEqual({ CLAUDE_CONFIG_DIR: '/accts/a' });
  });

  it('rejects accounts rotation under single-pane with count > 1 (one process env cannot rotate)', () => {
    expect(() => validateAccountsRotation(false, 2, accounts)).toThrow(
      /accounts rotation requires layout:"pane-per-worker"/
    );
  });

  it('allows accounts under single-pane with count 1, any pane-per-worker count, or no accounts', () => {
    expect(() => validateAccountsRotation(false, 1, accounts)).not.toThrow();
    expect(() => validateAccountsRotation(true, 5, accounts)).not.toThrow();
    expect(() => validateAccountsRotation(false, 5, undefined)).not.toThrow();
    expect(() => validateAccountsRotation(false, 5, [])).not.toThrow();
  });

  it('is undefined when no accounts are given', () => {
    expect(workerAccountEnv(0, true, undefined)).toBeUndefined();
    expect(workerAccountEnv(0, true, [])).toBeUndefined();
  });

  it('merges explicit env with account rotation, explicit env untouched', () => {
    expect(workerPaneEnv(1, true, { FOO: 'bar' }, accounts)).toEqual({
      FOO: 'bar',
      CLAUDE_CONFIG_DIR: '/accts/b'
    });
  });

  it('produces no env key at all when neither env nor accounts are given (existing specs unchanged)', () => {
    expect(workerPaneEnv(0, true, undefined, undefined)).toBeUndefined();
  });
});

// Org metadata (stamped defaults + caller override) for spawn_workers({ meta }).
describe('workerPaneMeta', () => {
  it('stamps default org meta role/task and defaults parent to the caller pane id', () => {
    expect(workerPaneMeta(undefined, 'pane-123', 'q1')).toEqual({
      role: 'worker',
      task: 'queue:q1',
      parent: 'pane-123'
    });
  });

  it('caller meta merges OVER the defaults (explicit role/task/parent win)', () => {
    expect(workerPaneMeta({ role: 'reviewer', task: 'T1' }, 'pane-123', 'q1')).toEqual({
      parent: 'pane-123',
      role: 'reviewer',
      task: 'T1'
    });
    expect(workerPaneMeta({ parent: 'explicit-parent' }, 'pane-123', 'q1')).toEqual({
      role: 'worker',
      task: 'queue:q1',
      parent: 'explicit-parent'
    });
  });

  it('omits parent (but still stamps role/task) when HYPERPANES_PANE_ID is unset', () => {
    expect(workerPaneMeta(undefined, undefined, 'q1')).toEqual({
      role: 'worker',
      task: 'queue:q1'
    });
  });
});
