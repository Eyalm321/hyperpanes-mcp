import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockGitHub } from './mock-client.js';
import { runSync, runSyncCycle } from './cli.js';
import { coarseReason } from './sync.js';
import { encodeSpec, type Task } from '../worker-pool/kinds.js';

const ID = '1234abcd-0000-0000-0000-000000000000';

function task(over: Partial<Task> = {}, source: unknown = { kind: 'github_issue', repo: 'acme/widgets', number: 12, url: 'u', gen: 77 }): Task {
  return {
    id: ID, queue: 'widgets-gh', seq: 1, kind: 'issue', title: 't', state: 'queued',
    payload: encodeSpec({ prompt: 'p', base: 'main', source }),
    priority: 50, attempts: 0, maxAttempts: 3, availableAt: 0, createdAt: 0, updatedAt: 0, ...over
  };
}

function lister(tasks: Task[]) {
  return { list: async (_q: string, o?: { after?: number }) => ({ tasks: tasks.filter((t) => t.seq > (o?.after ?? 0)) }) };
}

function writeCfg(obj: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), 'hpgh-')), 'github.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
const repoCfg = (over: Record<string, unknown> = {}) => ({ queue: 'widgets-gh', ...over });
const cfg = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  writeCfg({ repos: { 'acme/widgets': repoCfg(over) }, ...top });

function setup(tasks: Task[]) {
  const gh = new MockGitHub();
  gh.addIssue({ number: 12, labels: [] });
  const logs: string[] = [];
  const opts = (path: string, extra: Record<string, unknown> = {}) => ({
    configPath: path, dryRun: false, client: () => gh, queue: () => lister(tasks), log: (l: string) => logs.push(l), ...extra
  });
  return { gh, logs, opts };
}

describe('sync reconcile', () => {
  it('queued → label only; claimed → comment + labels; second run is a no-op', async () => {
    const tasks = [task({ state: 'claimed', attempts: 1 })];
    const { gh, opts } = setup(tasks);
    const p = cfg();
    await runSyncCycle(opts(p));
    expect(gh.comments.get(12)).toHaveLength(1);
    const body = gh.comments.get(12)![0]!.body;
    expect(body).toContain('An agent picked this up (task `1234abcd`). Work happens on branch `hp/issue-12-1234abcd`.');
    expect(body).toContain(`<!-- hyperpanes:task=${ID} state=claimed gen=77 -->`);
    expect(gh.issues[0]!.labels).toEqual(['hp:working']);
    const before = gh.writeCalls.length;
    await runSyncCycle(opts(p));
    expect(gh.writeCalls.length).toBe(before);
  });

  it('queued posts no comment, adds hp:queued', async () => {
    const { gh, opts } = setup([task()]);
    await runSyncCycle(opts(cfg()));
    expect(gh.comments.get(12)).toBeUndefined();
    expect(gh.issues[0]!.labels).toEqual(['hp:queued']);
  });

  it('retry (attempt 2, same task) posts no duplicate claim comment', async () => {
    const tasks = [task({ state: 'claimed', attempts: 1 })];
    const { gh, opts } = setup(tasks);
    const p = cfg();
    await runSyncCycle(opts(p));
    tasks[0] = task({ state: 'queued', attempts: 1 });
    await runSyncCycle(opts(p));
    tasks[0] = task({ state: 'claimed', attempts: 2 });
    await runSyncCycle(opts(p));
    expect(gh.comments.get(12)).toHaveLength(1);
  });

  it('first seen terminal skips the claimed comment', async () => {
    const { gh, opts } = setup([task({ state: 'done' })]);
    await runSyncCycle(opts(cfg()));
    const bodies = gh.comments.get(12)!.map((c) => c.body);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Done (task `1234abcd`)');
    expect(gh.issues[0]!.labels).toEqual(['hp:done']);
  });

  it('failure comment has a coarse reason only', async () => {
    const { gh, opts } = setup([task({ state: 'dead', error: 'worker exited: exit code 2 at /home/someone/secret/path queue=private' })]);
    await runSyncCycle(opts(cfg()));
    const body = gh.comments.get(12)![0]!.body;
    expect(body).toContain('Failed (task `1234abcd`): exit code 2. To retry, remove and re-add `agent-ready`.');
    expect(body).not.toContain('/home');
    expect(body).not.toContain('private');
    expect(coarseReason('lease timed out')).toBe('timeout');
    expect(coarseReason('review: blocked')).toBe('review blocked');
    expect(coarseReason('???')).toBe('failed');
  });

  it('swaps hp labels on transitions', async () => {
    const tasks = [task({ state: 'queued' })];
    const { gh, opts } = setup(tasks);
    const p = cfg();
    await runSyncCycle(opts(p));
    tasks[0] = task({ state: 'failed', error: 'x' });
    await runSyncCycle(opts(p));
    expect(gh.issues[0]!.labels).toEqual(['hp:failed']);
  });

  it('ignores non-GitHub tasks, other queues, other repos, and CI tasks', async () => {
    const tasks = [
      task({ seq: 1, id: 'a' }, { kind: 'todo' }),
      task({ seq: 2, id: 'b', queue: 'other-queue' }),
      task({ seq: 3, id: 'c' }, { kind: 'github_issue', repo: 'evil/repo', number: 12, gen: 1 }),
      task({ seq: 4, id: 'd', kind: 'ci_failure' }, { kind: 'github_ci', repo: 'acme/widgets', runId: 1 })
    ];
    const { gh, opts } = setup(tasks);
    await runSyncCycle(opts(cfg()));
    expect(gh.calls).toHaveLength(0);
  });

  it('honours syncBack switches', async () => {
    const t = [task({ state: 'done' })];
    let s = setup(t);
    await runSyncCycle(s.opts(cfg({ syncBack: { comments: false } })));
    expect(s.gh.comments.get(12)).toBeUndefined();
    expect(s.gh.issues[0]!.labels).toEqual(['hp:done']);
    s = setup(t);
    await runSyncCycle(s.opts(cfg({ syncBack: { labels: false } })));
    expect(s.gh.comments.get(12)).toHaveLength(1);
    expect(s.gh.issues[0]!.labels).toEqual([]);
  });

  it('dry-run lists actions and makes zero writes', async () => {
    const { gh, logs, opts } = setup([task({ state: 'done' })]);
    await runSyncCycle(opts(cfg(), { dryRun: true }));
    expect(gh.writeCalls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/would comment acme\/widgets#12/);
    expect(logs.join('\n')).toMatch(/would label acme\/widgets#12 \+hp:done/);
  });

  it('kill switch: top-level, per-repo', async () => {
    for (const p of [cfg({}, { enabled: false }), cfg({ enabled: false })]) {
      const { gh, logs, opts } = setup([task({ state: 'done' })]);
      await runSyncCycle(opts(p));
      expect(gh.calls).toHaveLength(0);
      expect(logs.join()).toContain('disabled');
    }
  });

  it('kill switch flipped between watch cycles takes effect', async () => {
    const tasks = [task({ state: 'queued' })];
    const { gh, opts } = setup(tasks);
    const p = cfg();
    let cycles = 0;
    await runSync({
      ...opts(p),
      watchSecs: 30,
      maxCycles: 2,
      sleep: async () => {
        cycles++;
        tasks[0] = task({ state: 'done' });
        writeFileSync(p, JSON.stringify({ enabled: false, repos: { 'acme/widgets': repoCfg() } }));
      }
    });
    expect(cycles).toBe(1);
    expect(gh.issues[0]!.labels).toEqual(['hp:queued']);
    expect(gh.comments.get(12)).toBeUndefined();
  });

  it('kill switch flipped mid-cycle (before writes) aborts the writes', async () => {
    const p = cfg();
    const gh = new MockGitHub();
    gh.addIssue({ number: 12, labels: [] });
    const q = lister([task({ state: 'done' })]);
    await runSyncCycle({
      configPath: p, dryRun: false, client: () => gh, log: () => {},
      queue: () => ({
        list: async (...a) => {
          writeFileSync(p, JSON.stringify({ enabled: false, repos: { 'acme/widgets': repoCfg() } }));
          return q.list(...a);
        }
      })
    });
    expect(gh.writeCalls).toHaveLength(0);
  });

  it('--repo must be opted in', async () => {
    const { gh, opts } = setup([]);
    await expect(runSyncCycle(opts(cfg(), { repo: 'acme/nope' }))).rejects.toThrow('not opted in: acme/nope');
    expect(gh.calls).toHaveLength(0);
  });
});
