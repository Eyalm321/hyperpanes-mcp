import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';
import { workerAccountEnv, workerPaneEnv, workerPaneMeta } from './control-tools.js';

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

  it('single-pane layout always gets accounts[0] (one process, no per-worker slot)', () => {
    expect(workerAccountEnv(0, false, accounts)).toEqual({ CLAUDE_CONFIG_DIR: '/accts/a' });
    // Even if called with a nonzero index, single-pane has only pane i=0 anyway.
    expect(workerAccountEnv(2, false, accounts)).toEqual({ CLAUDE_CONFIG_DIR: '/accts/a' });
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

// Org metadata (meta.parent default + explicit override) for spawn_workers({ meta }).
describe('workerPaneMeta', () => {
  it('defaults meta.parent to the caller pane id when meta omits it', () => {
    expect(workerPaneMeta(undefined, 'pane-123')).toEqual({ parent: 'pane-123' });
  });

  it('passes through arbitrary org keys like role/task', () => {
    expect(workerPaneMeta({ role: 'reviewer', task: 'T1' }, 'pane-123')).toEqual({
      parent: 'pane-123',
      role: 'reviewer',
      task: 'T1'
    });
  });

  it('an explicit meta.parent overrides the HYPERPANES_PANE_ID default', () => {
    expect(workerPaneMeta({ parent: 'explicit-parent' }, 'pane-123')).toEqual({
      parent: 'explicit-parent'
    });
  });

  it('produces no meta key at all when neither meta nor a caller pane id are given', () => {
    expect(workerPaneMeta(undefined, undefined)).toBeUndefined();
  });
});
