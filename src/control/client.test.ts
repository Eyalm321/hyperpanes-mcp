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
