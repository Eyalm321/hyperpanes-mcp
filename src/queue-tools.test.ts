import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';

// The work-queue MCP tools must be registered on the server (regression guard: a missing
// registerQueueTools() call or a renamed tool silently drops the worker-pool surface).
describe('work-queue tools registration', () => {
  const EXPECTED = [
    'list_queues',
    'enqueue_task',
    'claim_task',
    'ack_task',
    'nack_task',
    'extend_task',
    'get_task',
    'list_tasks',
    'purge_queue'
  ];

  it('registers every work-queue tool', () => {
    const server = createServer();
    // The SDK keeps registered tools in `_registeredTools` (name -> def).
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    for (const t of EXPECTED) expect(names).toContain(t);
  });
});
