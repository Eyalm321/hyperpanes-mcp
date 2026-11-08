import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueClient } from './queue-client.js';
import { createServer } from '../server.js';

/** Stub global fetch: record each request's URL + parsed JSON body, answer an empty claim. */
function stubFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, tasks: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const disco = { port: 4321, token: 't', events: 'ws://127.0.0.1:4321/events?token=t' };

describe('QueueClient.claim holderPid', () => {
  it('sends holderPid when given', async () => {
    const calls = stubFetch();
    await new QueueClient(disco).claim('q', 'w', { holderPid: 1234, leaseMs: 5000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4321/queues/q/claim');
    expect(calls[0]!.body).toEqual({ worker: 'w', leaseMs: 5000, holderPid: 1234 });
  });

  it('omits holderPid when not given (legacy body unchanged)', async () => {
    const calls = stubFetch();
    await new QueueClient(disco).claim('q', 'w');
    expect(calls[0]!.body).toEqual({ worker: 'w' });
  });
});

describe('claim_task tool', () => {
  it("names this bridge's pid as the claim holder", async () => {
    // Scoped-child discovery from env, so the tool never reads a real control.json.
    vi.stubEnv('HYPERPANES_CONTROL_TOKEN', 't');
    vi.stubEnv('HYPERPANES_CONTROL_PORT', '4321');
    const calls = stubFetch();
    const server = createServer();
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools;
    await tools.claim_task!.handler({ queue: 'q', worker: 'agent-1' }, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ worker: 'agent-1', holderPid: process.pid });
  });
});
