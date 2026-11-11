import { describe, it, expect, afterEach, vi } from 'vitest';
import { ControlClient } from './client.js';
import type { Discovery } from './discovery.js';

// The project-registry client methods are thin HTTP wrappers over the app's `/projects`
// routes. These tests stub `fetch` to assert the exact request shape (method, path, body,
// bearer auth) and the response parsing — the byte-level route contract is golden-tested on
// the Rust side (`control/routes.rs`).

const discovery: Discovery = {
  port: 6123,
  token: 'tok-test',
  events: 'ws://127.0.0.1:6123/events?token=tok-test'
};

function stubFetch(status: number, json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json
  }));
  // @ts-expect-error - override the global for the test
  globalThis.fetch = fn;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ControlClient project methods', () => {
  const sample = { id: 'p1', path: '/home/me/repo', name: 'repo', color: '#a855f7', lastOpenedAt: 1 };

  it('listProjects GETs /projects with bearer auth and unwraps the array', async () => {
    const fn = stubFetch(200, { projects: [sample] });
    const out = await new ControlClient(discovery).listProjects();
    expect(out).toEqual([sample]);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:6123/projects');
    expect(init?.method ?? 'GET').toBe('GET');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-test');
  });

  it('listProjects tolerates a missing projects field', async () => {
    stubFetch(200, {});
    expect(await new ControlClient(discovery).listProjects()).toEqual([]);
  });

  it('addProject POSTs { dir } and returns { ok, added, project }', async () => {
    const fn = stubFetch(200, { ok: true, added: true, project: sample });
    const out = await new ControlClient(discovery).addProject('/home/me/repo');
    expect(out).toEqual({ ok: true, added: true, project: sample });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:6123/projects');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ dir: '/home/me/repo' });
  });

  it('addProject surfaces the server error message on a 400', async () => {
    stubFetch(400, { error: "path doesn't exist or isn't a directory" });
    await expect(new ControlClient(discovery).addProject('/no/such')).rejects.toThrow(
      /path doesn't exist/
    );
  });

  it('patchProject PATCHes /projects/{id} with the partial body (id url-encoded)', async () => {
    const fn = stubFetch(200, { ok: true });
    await new ControlClient(discovery).patchProject('a/b', { name: 'new', color: '#fff' });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:6123/projects/a%2Fb');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'new', color: '#fff' });
  });

  it('removeProject DELETEs /projects/{id}', async () => {
    const fn = stubFetch(200, { ok: true });
    const out = await new ControlClient(discovery).removeProject('p1');
    expect(out).toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:6123/projects/p1');
    expect(init?.method).toBe('DELETE');
  });
});

describe('ControlClient message bus (t36)', () => {
  it('sendMessage omits nudge by default so the app keeps its nudge', async () => {
    const fn = stubFetch(200, { ok: true, seq: 3, epoch: 9, nudged: true });
    const out = await new ControlClient(discovery).sendMessage('p1', 'me', 'hi');
    expect(out).toEqual({ ok: true, seq: 3, epoch: 9, nudged: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:6123/panes/p1/messages');
    expect(JSON.parse(init?.body as string)).toEqual({ from: 'me', body: 'hi' });
  });

  it('sendMessage sends nudge:false only when asked', async () => {
    const fn = stubFetch(200, { ok: true, seq: 4, nudged: false });
    await new ControlClient(discovery).sendMessage('p1', 'me', 'hi', { nudge: false });
    expect(JSON.parse(fn.mock.calls[0]![1]?.body as string)).toEqual({ from: 'me', body: 'hi', nudge: false });
    await new ControlClient(discovery).sendMessage('p1', 'me', 'hi', { nudge: true });
    expect(JSON.parse(fn.mock.calls[1]![1]?.body as string)).toEqual({ from: 'me', body: 'hi' });
  });

  it('readMessages passes epoch and reset through', async () => {
    const body = { paneId: 'p1', messages: [], dropped: 0, latestSeq: 1, epoch: 5, reset: true };
    const fn = stubFetch(200, body);
    expect(await new ControlClient(discovery).readMessages('p1', 48)).toEqual(body);
    expect(fn.mock.calls[0]![0]).toBe('http://127.0.0.1:6123/panes/p1/messages?after=48');
  });
});
