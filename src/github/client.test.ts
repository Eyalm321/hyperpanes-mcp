import { describe, expect, it } from 'vitest';
import {
  FetchGitHubClient,
  GitHubAuthError,
  NO_TOKEN_MESSAGE,
  RateLimiter,
  RateLimitError,
  resolveToken
} from './client.js';
import { runIssuesIngest } from './ingest.js';
import { runSyncCycle } from './cli.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTINEL = 'ghp_SENTINEL_TOKEN_9f8e7d6c';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function mk(handler: Handler, extra: { now?: () => number } = {}) {
  const sleeps: number[] = [];
  const urls: string[] = [];
  const client = new FetchGitHubClient({
    token: SENTINEL,
    limiter: new RateLimiter(),
    sleep: async (ms) => void sleeps.push(ms),
    now: extra.now ?? (() => 1_000_000),
    fetch: (async (u: string, i: RequestInit) => {
      urls.push(u);
      return handler(u, i);
    }) as unknown as typeof fetch
  });
  return { client, sleeps, urls };
}
const json = (b: unknown, h: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: h });

describe('token resolution', () => {
  it('order: GITHUB_TOKEN, GH_TOKEN, gh', async () => {
    const exec = async () => ({ stdout: 'fromgh\n' });
    expect(await resolveToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, exec)).toBe('a');
    expect(await resolveToken({ GH_TOKEN: 'b' }, exec)).toBe('b');
    expect(await resolveToken({}, exec)).toBe('fromgh');
  });
  it('no token → exact error', async () => {
    await expect(resolveToken({}, async () => { throw new Error('nope'); })).rejects.toThrow(NO_TOKEN_MESSAGE);
    expect(NO_TOKEN_MESSAGE).toBe("no GitHub token: set GITHUB_TOKEN or run 'gh auth login'");
  });
  it('401 → exact error without the token', async () => {
    const { client } = mk(() => json({ message: 'Bad credentials' }, {}, 401));
    const err = await client.getIssue('acme/widgets', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAuthError);
    expect((err as Error).message).toBe('GitHub rejected the token (401)');
    expect(String(err)).not.toContain(SENTINEL);
  });
});

describe('client behaviour', () => {
  it('follows Link pagination and maps issues', async () => {
    const { client, urls } = mk((u) =>
      u.includes('page=2')
        ? json([{ number: 2, title: 'b', labels: [{ name: 'x' }], pull_request: {} }])
        : json([{ number: 1, title: 'a', labels: ['x'] }], {
            link: '<https://api.github.com/repos/acme/widgets/issues?page=2>; rel="next"'
          })
    );
    const issues = await client.listOpenIssuesByLabel('acme/widgets', 'agent-ready');
    expect(issues.map((i) => [i.number, i.isPullRequest])).toEqual([[1, false], [2, true]]);
    expect(urls).toHaveLength(2);
  });
  it('never follows a Link off the API host', async () => {
    const { client, urls } = mk(() =>
      json([], { link: '<https://evil.example/x>; rel="next"' })
    );
    await client.listIssueComments('acme/widgets', 1);
    expect(urls).toHaveLength(1);
  });
  it('permission 404 → none; role_name preferred', async () => {
    const { client } = mk((u) => (u.includes('ghost') ? json({}, {}, 404) : json({ permission: 'write', role_name: 'triage' })));
    expect(await client.getCollaboratorPermission('acme/widgets', 'ghost')).toBe('none');
    expect(await client.getCollaboratorPermission('acme/widgets', 'octocat')).toBe('triage');
  });
  it('removeLabel 404 ignored; graphql edit info', async () => {
    const { client } = mk((u) =>
      u.endsWith('/graphql')
        ? json({ data: { repository: { issue: { lastEditedAt: 't', editor: { login: 'e' } } } } })
        : json({}, {}, 404)
    );
    await expect(client.removeLabel('acme/widgets', 1, 'x')).resolves.toBeUndefined();
    expect(await client.getIssueEditInfo('acme/widgets', 1)).toEqual({ lastEditedAt: 't', editor: 'e' });
  });
  it('graphql edit info fails closed on errors or a missing issue', async () => {
    const errs = mk(() => json({ data: null, errors: [{ message: 'scope' }] })).client;
    await expect(errs.getIssueEditInfo('acme/widgets', 1)).rejects.toThrow(/graphql/);
    const missing = mk(() => json({ data: { repository: { issue: null } } })).client;
    await expect(missing.getIssueEditInfo('acme/widgets', 1)).rejects.toThrow(/graphql/);
    const notFound = mk(() => json({ message: 'Not Found' }, {}, 404)).client;
    await expect(notFound.getIssueEditInfo('acme/widgets', 1)).rejects.toThrow();
  });
  it('a failed write throws instead of looking like success', async () => {
    const { client } = mk(() => json({ message: 'Validation Failed' }, {}, 422));
    await expect(client.createIssueComment('acme/widgets', 1, 'x')).rejects.toThrow(/422/);
    await expect(client.addLabels('acme/widgets', 1, ['hp:done'])).rejects.toThrow(/422/);
    const gone = mk(() => json({ message: 'Not Found' }, {}, 404)).client;
    await expect(gone.createIssueComment('acme/widgets', 1, 'x')).rejects.toThrow(/404/);
  });
  it('a list on a missing repo throws instead of returning nothing', async () => {
    const { client } = mk(() => json({ message: 'Not Found' }, {}, 404));
    await expect(client.listOpenIssuesByLabel('acme/nope', 'agent-ready')).rejects.toThrow(/404/);
  });
  it('ETag: sends If-None-Match and reuses cached body on 304', async () => {
    let n = 0;
    const seen: Array<string | undefined> = [];
    const { client } = mk((_u, init) => {
      const h = init.headers as Record<string, string>;
      seen.push(h['if-none-match']);
      return n++ === 0 ? json([{ id: 1, body: 'hi' }], { etag: '"abc"' }) : new Response(null, { status: 304 });
    });
    const a = await client.listIssueComments('acme/widgets', 1);
    const b = await client.listIssueComments('acme/widgets', 1);
    expect(seen).toEqual([undefined, '"abc"']);
    expect(b).toEqual(a);
  });
  it('429 waits retry-after then succeeds', async () => {
    let n = 0;
    const { client, sleeps } = mk(() => (n++ === 0 ? json({}, { 'retry-after': '7' }, 429) : json([])));
    await client.listIssueComments('acme/widgets', 1);
    expect(sleeps).toEqual([7000]);
  });
  it('403 with remaining 0 waits until reset; wait capped at 15 min', async () => {
    let n = 0;
    const now = 1_000_000;
    const { client, sleeps } = mk(
      () => (n++ === 0 ? json({}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 10) }, 403) : json([])),
      { now: () => now }
    );
    await client.listIssueComments('acme/widgets', 1);
    expect(sleeps).toEqual([10_000]);
    let m = 0;
    const capped = mk(
      () => (m++ === 0 ? json({}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 99999) }, 403) : json([])),
      { now: () => now }
    );
    await capped.client.listIssueComments('acme/widgets', 1);
    expect(capped.sleeps).toEqual([15 * 60 * 1000]);
  });
  it('429 without headers backs off exponentially, then reports resume time', async () => {
    const { client, sleeps } = mk(() => json({}, {}, 429));
    const err = await client.listIssueComments('acme/widgets', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect((err as RateLimitError).message).toMatch(/resumes at \d{4}-/);
  });
});

describe('token never leaks', () => {
  it('not in JSON.stringify(client), errors, ingest/sync output', async () => {
    const outputs: string[] = [];
    const handler: Handler = (u, init) => {
      outputs.push(JSON.stringify(init.body ?? ''));
      if (u.includes('/graphql')) return json({ data: { repository: { issue: {} } } });
      if (u.includes('/permission')) return json({ permission: 'write' });
      if (u.includes('/events')) return json([{ id: 5, event: 'labeled', actor: { login: 'octocat' }, label: { name: 'agent-ready' }, created_at: '2026-02-01T00:00:00Z' }]);
      if (u.includes('/comments')) return json([]);
      if (u.includes('/issues?')) return json([{ number: 1, title: 'T', body: 'B', labels: ['agent-ready'], created_at: '2026-01-01T00:00:00Z' }]);
      return json({}, {}, 500);
    };
    const { client } = mk(handler);
    expect(JSON.stringify(client)).not.toContain(SENTINEL);
    expect(Object.values(client as object).join()).not.toContain(SENTINEL);
    const dir = mkdtempSync(join(tmpdir(), 'hpgh-'));
    const path = join(dir, 'github.json');
    writeFileSync(path, JSON.stringify({ repos: { 'acme/widgets': { queue: 'q' } } }));
    const lines: string[] = [];
    const r = await runIssuesIngest({
      repoArg: 'acme/widgets', configPath: path, dryRun: true, client: () => client,
      queue: () => ({ list: async () => ({ tasks: [] }), enqueue: async () => ({ ok: true, id: '', seq: 0 }) }),
      log: (l) => lines.push(l)
    });
    expect(r.gen!.items).toHaveLength(1);
    await runSyncCycle({ configPath: path, dryRun: true, client: () => client, queue: () => ({ list: async () => ({ tasks: [] }) }), log: (l) => lines.push(l) });
    const err = await mk(() => json({}, {}, 500)).client.getIssue('acme/widgets', 1).catch((e: Error) => e.message);
    const all = JSON.stringify([r, lines, outputs, err]);
    expect(all).not.toContain(SENTINEL);
  });
});
