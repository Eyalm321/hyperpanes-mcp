import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeSpec, type Task } from '../worker-pool/kinds.js';
import type { ReviewRunner } from '../worker-pool/review.js';
import { runSyncCycle } from './cli.js';
import { GithubConfigSchema } from './config.js';
import { execGitOps, NonFastForwardError, type GitOps } from './git-ops.js';
import { MockGitHub } from './mock-client.js';

const ID = '1234abcd-0000-0000-0000-000000000000';
const QUEUE = 'private-proj queue/x';
const SENTINEL = 'ghp_SENTINEL_TOKEN_123';
const LOCAL = `worker/private-proj-queue-x/1234abcd`;

const issueSrc = { kind: 'github_issue', repo: 'acme/widgets', number: 12, url: 'u', gen: 77 };
const ciSrc = { kind: 'github_ci', repo: 'acme/widgets', runId: 555, url: 'https://github.com/acme/widgets/actions/runs/555' };

function task(source: unknown, over: Partial<Task> = {}): Task {
  return {
    id: ID, queue: QUEUE, seq: 1, kind: 'issue', title: 'CI: failed on main', state: 'done',
    payload: encodeSpec({ prompt: 'do the thing', base: 'main', source }),
    priority: 50, attempts: 1, maxAttempts: 3, availableAt: 0, createdAt: 0, updatedAt: 0, ...over
  };
}
const lister = (tasks: Task[]) => ({ list: async (_q: string, o?: { after?: number }) => ({ tasks: tasks.filter((t) => t.seq > (o?.after ?? 0)) }) });

interface FakeGit extends GitOps { pushes: string[][]; diffs: number; opts: { branches: string[]; ahead: number; url: string; pushError?: Error } }
function fakeGit(init: Partial<FakeGit['opts']> = {}): FakeGit {
  const opts = { branches: [LOCAL], ahead: 2, url: 'https://github.com/acme/widgets.git', ...init };
  const g: FakeGit = {
    pushes: [], diffs: 0, opts,
    branchExists: async (r) => g.opts.branches.includes(r),
    commitsAhead: async () => g.opts.ahead,
    remoteUrl: async () => g.opts.url,
    diff: async () => { g.diffs++; return 'diff --git a/x b/x\n+x'; },
    push: async (...a) => { if (g.opts.pushError) throw g.opts.pushError; g.pushes.push(a); }
  };
  return g;
}
function judge(verdict = 'approve', risk = 2) {
  const calls: unknown[] = [];
  const runner: ReviewRunner = { run: async (i) => { calls.push(i); return { exitCode: 0, stdout: JSON.stringify({ verdict, risk, summary: 'SECRET-SUMMARY /home/x' }), stderr: '', timedOut: false }; } };
  return { runner, calls };
}

function setup(tasks: Task[], prCfg: Record<string, unknown> = {}, top: Record<string, unknown> = {}, repoOver: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hppr-'));
  const cfgPath = join(dir, 'github.json');
  const write = (o: Record<string, unknown> = {}) => writeFileSync(cfgPath, JSON.stringify({ ...top, repos: { 'acme/widgets': { queue: QUEUE, ci: { enabled: true }, pr: { enabled: true, checkout: '/clone', ...prCfg }, ...repoOver, ...o } } }));
  write();
  const gh = new MockGitHub();
  gh.addIssue({ number: 12, title: 'Widget is broken', labels: [] });
  const git = fakeGit();
  const j = judge();
  const logs: string[] = [];
  const statePath = join(dir, 'state', 'github-sync-state.json');
  const cycle = (extra: Record<string, unknown> = {}) =>
    runSyncCycle({ configPath: cfgPath, dryRun: false, client: () => gh, queue: () => lister(tasks), git: () => git, reviewRunner: j.runner, prStatePath: statePath, log: (l) => logs.push(l), ...extra });
  return { gh, git, j, logs, cycle, cfgPath, write, statePath, dir };
}
const bodies = (gh: MockGitHub) => (gh.comments.get(12) ?? []).map((c) => c.body);
const createPulls = (gh: MockGitHub) => gh.calls.filter((c) => c.method === 'createPull');

describe('config', () => {
  it('pr.enabled requires checkout', () => {
    const r = GithubConfigSchema.safeParse({ repos: { 'acme/widgets': { queue: 'q', pr: { enabled: true } } } });
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: unknown }).error)).toContain('pr.checkout is required');
    expect(GithubConfigSchema.safeParse({ repos: { 'acme/widgets': { queue: 'q' } } }).success).toBe(true);
    const ok = GithubConfigSchema.parse({ repos: { 'acme/widgets': { queue: 'q', pr: { enabled: true, checkout: '/c' } } } });
    expect(ok.repos['acme/widgets']!.pr).toMatchObject({ draft: true, review: true, remote: 'origin' });
  });
});

describe('PR on completion', () => {
  it('issue done + approve: exact refspec, draft PR with body, done comment with link', async () => {
    const s = setup([task(issueSrc)]);
    const res = await s.cycle();
    expect(res.errors).toEqual([]);
    expect(s.git.pushes).toEqual([['origin', LOCAL, 'hp/issue-12-1234abcd']]);
    const [call] = createPulls(s.gh);
    const input = call!.args[1] as { title: string; head: string; base: string; body: string; draft: boolean };
    expect(input).toMatchObject({ title: '[hp] Widget is broken', head: 'hp/issue-12-1234abcd', base: 'main', draft: true });
    expect(input.body).toContain('Closes #12');
    expect(input.body).toContain('Task `1234abcd`');
    expect(input.body).toContain('Review: approve (risk 2)');
    expect(input.body).toContain('Merge is a human decision; this PR is never auto-merged.');
    expect(input.body).toContain(`<!-- hyperpanes:task=${ID} state=pr gen=77 -->`);
    expect(bodies(s.gh)).toHaveLength(1);
    expect(bodies(s.gh)[0]).toContain('Done (task `1234abcd`). Draft PR #900: https://github.com/acme/widgets/pull/900');
    expect(bodies(s.gh)[0]).toContain(`state=done gen=77`);
    expect(JSON.stringify(s.git.pushes)).not.toMatch(/force|\+/);
  });

  it('CI done: PR body links the run, no issue comment, no queue/local names leak', async () => {
    const s = setup([task(ciSrc, { kind: 'ci_failure' })]);
    await s.cycle();
    const input = createPulls(s.gh)[0]!.args[1] as { title: string; head: string; body: string };
    expect(input.head).toBe('hp/ci-555-1234abcd');
    expect(input.title).toBe('[hp] CI: failed on main');
    expect(input.body).toContain('Fixes the failing run: https://github.com/acme/widgets/actions/runs/555');
    expect(input.body).toContain('state=pr gen=555');
    expect(s.gh.writeCalls.filter((c) => c.method === 'createIssueComment')).toHaveLength(0);
  });

  it('second run: no pushes, no createPull, no comments, judge not re-run', async () => {
    for (const src of [issueSrc, ciSrc]) {
      const s = setup([task(src)]);
      await s.cycle();
      const writes = s.gh.writeCalls.length, pushes = s.git.pushes.length, judged = s.j.calls.length;
      await s.cycle();
      expect(s.gh.writeCalls.length).toBe(writes);
      expect(s.git.pushes.length).toBe(pushes);
      expect(s.j.calls.length).toBe(judged);
      expect(judged).toBe(1);
    }
  });

  it('existing PR (open or closed): no push, no PR, no review; done comment references it', async () => {
    for (const state of ['open', 'closed']) {
      const s = setup([task(issueSrc)]);
      s.gh.pulls.push({ number: 7, url: 'https://github.com/acme/widgets/pull/7', state, draft: true, head: 'acme:hp/issue-12-1234abcd', base: 'main', title: '', body: '' });
      await s.cycle();
      expect(s.git.pushes).toHaveLength(0);
      expect(createPulls(s.gh)).toHaveLength(0);
      expect(s.j.calls).toHaveLength(0);
      expect(bodies(s.gh)[0]).toContain('Done (task `1234abcd`). PR #7 already exists: https://github.com/acme/widgets/pull/7');
    }
  });

  it('no branch / zero commits → no-commits comment, no push', async () => {
    for (const git of [{ branches: [] as string[] }, { ahead: 0 }]) {
      const s = setup([task(issueSrc)]);
      Object.assign(s.git.opts, git);
      await s.cycle();
      expect(s.git.pushes).toHaveLength(0);
      expect(createPulls(s.gh)).toHaveLength(0);
      expect(bodies(s.gh)).toHaveLength(1);
      expect(bodies(s.gh)[0]).toContain('no commits on the branch, so no PR was opened.');
    }
  });

  it('falls back to the TS controller branch name', async () => {
    const s = setup([task(issueSrc, { title: 'Fix it' })]);
    const { deriveBranch } = await import('../worker-pool/kinds.js');
    s.git.opts.branches = [deriveBranch({ id: ID, title: 'Fix it' })];
    await s.cycle();
    expect(s.git.pushes).toHaveLength(1);
    expect(s.git.pushes[0]![1]).toBe(deriveBranch({ id: ID, title: 'Fix it' }));
  });

  it('review block: no push/PR, risk-only comment, judge not re-run (issue via marker, CI via state file)', async () => {
    const s = setup([task(issueSrc)]);
    s.j.calls.length = 0;
    const blocking = judge('block', 8);
    await s.cycle({ reviewRunner: blocking.runner });
    expect(s.git.pushes).toHaveLength(0);
    expect(createPulls(s.gh)).toHaveLength(0);
    expect(bodies(s.gh)).toHaveLength(1);
    expect(bodies(s.gh)[0]).toContain('Done (task `1234abcd`), but the local review gate blocked the change (risk 8); no PR was opened.');
    expect(bodies(s.gh)[0]).toContain('state=review-blocked');
    expect(bodies(s.gh)[0]).not.toContain('SECRET-SUMMARY');
    // new state file: marker alone is the cache
    await s.cycle({ reviewRunner: blocking.runner, prStatePath: join(s.dir, 'other.json') });
    expect(blocking.calls).toHaveLength(1);
    expect(bodies(s.gh)).toHaveLength(1);

    const c = setup([task(ciSrc, { kind: 'ci_failure' })]);
    const b2 = judge('block', 9);
    await c.cycle({ reviewRunner: b2.runner });
    await c.cycle({ reviewRunner: b2.runner });
    expect(b2.calls).toHaveLength(1);
    expect(c.git.pushes).toHaveLength(0);
    expect(createPulls(c.gh)).toHaveLength(0);
    expect(JSON.parse(readFileSync(c.statePath, 'utf8'))[ID]).toMatchObject({ verdict: 'block', risk: 9 });
  });

  it('pr.review off: judge never runs, body says skipped', async () => {
    const s = setup([task(issueSrc)], { review: false });
    await s.cycle();
    expect(s.j.calls).toHaveLength(0);
    expect((createPulls(s.gh)[0]!.args[1] as { body: string }).body).toContain('Review: skipped (pr.review is off)');
  });

  it('remote URL mismatch: no push, error recorded, no done comment', async () => {
    const s = setup([task(issueSrc)]);
    s.git.opts.url = 'git@github.com:evil/other.git';
    const res = await s.cycle();
    expect(s.git.pushes).toHaveLength(0);
    expect(res.errors.join()).toContain('does not point at acme/widgets');
    expect(bodies(s.gh)).toHaveLength(0);
  });

  it('non-fast-forward: error recorded, no force, retried next cycle', async () => {
    const s = setup([task(issueSrc)]);
    s.git.opts.pushError = new NonFastForwardError();
    const res = await s.cycle();
    expect(res.errors.join()).toContain('not forcing');
    expect(bodies(s.gh)).toHaveLength(0);
    expect(createPulls(s.gh)).toHaveLength(0);
    delete s.git.opts.pushError;
    await s.cycle();
    expect(s.git.pushes).toHaveLength(1);
    expect(bodies(s.gh)[0]).toContain('Draft PR #');
  });

  it('kill switch flipped between review and push: no push', async () => {
    const s = setup([task(issueSrc)]);
    const flip: ReviewRunner = { run: async (i) => { s.write({ enabled: false }); return judge().runner.run(i); } };
    await s.cycle({ reviewRunner: flip });
    expect(s.git.pushes).toHaveLength(0);
    expect(createPulls(s.gh)).toHaveLength(0);
  });

  it('kill switch flipped between push and createPull: no PR', async () => {
    const s = setup([task(issueSrc)]);
    const origPush = s.git.push;
    s.git.push = async (...a) => { await origPush(...a); s.write({ enabled: false }); };
    await s.cycle();
    expect(createPulls(s.gh)).toHaveLength(0);
  });

  it('pr.enabled false: slice-1 behavior unchanged', async () => {
    const s = setup([task(issueSrc)], { enabled: false });
    await s.cycle();
    expect(bodies(s.gh)[0]).toContain('Done (task `1234abcd`). The branch stayed local; no PR was opened.');
    expect(s.git.pushes).toHaveLength(0);
    expect(s.gh.calls.some((c) => c.method === 'listPullsByHead')).toBe(false);
  });

  it('dry run: reads only; would-lines; zero writes/pushes/judge', async () => {
    const s = setup([task(issueSrc), task(ciSrc, { id: 'cccccccc-0000', seq: 2, kind: 'ci_failure' })]);
    s.git.opts.branches = [LOCAL, 'worker/private-proj-queue-x/cccccccc'];
    await s.cycle({ dryRun: true });
    expect(s.gh.writeCalls).toHaveLength(0);
    expect(s.git.pushes).toHaveLength(0);
    expect(s.j.calls).toHaveLength(0);
    expect(existsSync(s.statePath)).toBe(false);
    const out = s.logs.join('\n');
    expect(out).toContain('would review');
    expect(out).toContain(`would push ${LOCAL} → hp/issue-12-1234abcd`);
    expect(out).toContain('would open draft PR "[hp] Widget is broken"');
  });

  it('local branch / queue names never reach GitHub; sentinel token never in argv or output', async () => {
    const s = setup([task(issueSrc), task(ciSrc, { id: 'cccccccc-0000', seq: 2, kind: 'ci_failure' })]);
    s.git.opts.branches = [LOCAL, 'worker/private-proj-queue-x/cccccccc'];
    process.env.GITHUB_TOKEN = SENTINEL;
    try {
      await s.cycle();
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    const written = JSON.stringify(s.gh.calls.filter((c) => c.method === 'createPull' || c.method === 'createIssueComment'));
    expect(written).not.toContain('worker/');
    expect(written).not.toContain('private-proj');
    expect(written).not.toContain('queue/x');
    expect(JSON.stringify(s.git.pushes) + s.logs.join('\n') + written).not.toContain(SENTINEL);
  });

  it('long titles are cut to 72 chars', async () => {
    const s = setup([task(issueSrc)]);
    s.gh.issues[0]!.title = 'x'.repeat(200);
    await s.cycle();
    expect((createPulls(s.gh)[0]!.args[1] as { title: string }).title.length).toBeLessThanOrEqual(72);
  });
});

describe('execGitOps argv', () => {
  it('uses git -C <checkout>, a plain refspec push, and maps rejections', async () => {
    const seen: string[][] = [];
    let reply = { code: 0, stdout: '', stderr: '' };
    const g = execGitOps('/clone', async (a) => { seen.push(a); return reply; });
    await g.push('origin', 'worker/q/abc', 'hp/issue-1-abc');
    expect(seen[0]).toEqual(['push', 'origin', 'worker/q/abc:refs/heads/hp/issue-1-abc']);
    reply = { code: 1, stdout: '', stderr: ' ! [rejected] a -> b (non-fast-forward)' };
    await expect(g.push('origin', 'a', 'b')).rejects.toBeInstanceOf(NonFastForwardError);
    reply = { code: 0, stdout: '3\n', stderr: '' };
    expect(await g.commitsAhead('main', 'x')).toBe(3);
    await g.diff('main', 'x');
    expect(seen.at(-1)).toEqual(['diff', 'main...x']);
    for (const a of seen) expect(a.some((x) => x === '--force' || x === '-f' || x.startsWith('+'))).toBe(false);
  });
});
