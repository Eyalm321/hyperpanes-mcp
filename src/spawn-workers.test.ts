import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';

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
