/**
 * Minimal GitHub client (fetch-based, no octokit). `GitHubClient` is the mockable seam;
 * `FetchGitHubClient` is the real implementation. The token lives only in a private field /
 * closure — never in logs, errors, payloads, argv, or `JSON.stringify(client)`.
 */

import { execFile } from 'node:child_process';

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  createdAt: string;
  isPullRequest: boolean;
}

export interface IssueEvent {
  id: number;
  event: string;
  actor?: string;
  label?: string;
  createdAt: string;
}

export interface IssueEditInfo {
  lastEditedAt?: string;
  editor?: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  name: string;
  headBranch: string;
  headSha: string;
  event: string;
  url: string;
  createdAt: string;
  runAttempt: number;
  displayTitle: string;
  /** `full_name` of the head repository ('' when GitHub omits it, e.g. a deleted fork). */
  headRepo: string;
  /** failure, success, cancelled, … ('' while in progress). */
  conclusion: string;
  /** Workflow file path (e.g. `.github/workflows/ci.yml`), '' when unknown. */
  path: string;
}

export interface JobStep {
  name: string;
  number: number;
  conclusion: string;
}

export interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string;
  url: string;
  steps: JobStep[];
}

/** The GitHub surface slices 1-2 need. `repo` is `owner/name`. */
export interface GitHubClient {
  listOpenIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]>;
  getIssue(repo: string, number: number): Promise<GitHubIssue>;
  listIssueEvents(repo: string, number: number): Promise<IssueEvent[]>;
  getCollaboratorPermission(repo: string, login: string): Promise<Permission>;
  getIssueEditInfo(repo: string, number: number): Promise<IssueEditInfo>;
  listIssueComments(repo: string, number: number): Promise<IssueComment[]>;
  createIssueComment(repo: string, number: number, body: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  removeLabel(repo: string, number: number, label: string): Promise<void>;
  /** Failed workflow runs on `branch` created at/after `since` (ISO). Read-only. */
  listFailedRuns(repo: string, branch: string, since: string): Promise<WorkflowRun[]>;
  /** Newest completed run of a workflow on a branch, or null. */
  getLatestCompletedRun(repo: string, workflowId: number, branch: string): Promise<WorkflowRun | null>;
  /** Jobs (latest attempt) of a run. Never fetches logs. */
  listRunJobs(repo: string, runId: number): Promise<WorkflowJob[]>;
}

export const NO_TOKEN_MESSAGE = "no GitHub token: set GITHUB_TOKEN or run 'gh auth login'";

export class NoTokenError extends Error {
  constructor() {
    super(NO_TOKEN_MESSAGE);
    this.name = 'NoTokenError';
  }
}

export class GitHubAuthError extends Error {
  constructor() {
    super('GitHub rejected the token (401)');
    this.name = 'GitHubAuthError';
  }
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    method: string,
    path: string
  ) {
    super(`GitHub API ${status} for ${method} ${path}`);
    this.name = 'GitHubApiError';
  }
}

/** Thrown when the rate-limit budget is exhausted; `resumeAt` is epoch ms. */
export class RateLimitError extends Error {
  constructor(public readonly resumeAt: number) {
    super(`GitHub rate limit exhausted; resumes at ${new Date(resumeAt).toISOString()}`);
    this.name = 'RateLimitError';
  }
}

export type ExecFn = (cmd: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve({ stdout: String(stdout) })
    );
  });

/** GITHUB_TOKEN → GH_TOKEN → `gh auth token` (5 s timeout, stdout in memory only). */
export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  exec: ExecFn = defaultExec
): Promise<string> {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 5000 });
    const t = stdout.trim();
    if (t) return t;
  } catch {
    // fall through
  }
  throw new NoTokenError();
}

/** Process-wide rate-limit gate: once blocked, every request waits until the resume time. */
export class RateLimiter {
  resumeAt = 0;
  block(until: number): void {
    if (until > this.resumeAt) this.resumeAt = until;
  }
  async gate(now: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
    const wait = this.resumeAt - now();
    if (wait > 0) {
      await sleep(wait);
      this.resumeAt = 0;
    }
  }
}

export const sharedLimiter = new RateLimiter();

export interface FetchClientOptions {
  /** Token or lazy token provider (default: {@link resolveToken}). */
  token?: string | (() => Promise<string>);
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  limiter?: RateLimiter;
  baseUrl?: string;
}

interface CacheEntry {
  etag: string;
  data: unknown;
  link: string | null;
}
interface Reply {
  status: number;
  data: unknown;
  link: string | null;
}

const MAX_WAIT_MS = 15 * 60 * 1000;
const MAX_RETRIES = 3;
const MAX_PAGES = 20;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class FetchGitHubClient implements GitHubClient {
  readonly #token: () => Promise<string>;
  #tokenValue: Promise<string> | undefined;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #limiter: RateLimiter;
  readonly #base: string;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(opts: FetchClientOptions = {}) {
    const t = opts.token;
    this.#token = typeof t === 'string' ? () => Promise.resolve(t) : (t ?? (() => resolveToken()));
    this.#fetch = opts.fetch ?? fetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = opts.now ?? Date.now;
    this.#limiter = opts.limiter ?? sharedLimiter;
    this.#base = opts.baseUrl ?? 'https://api.github.com';
  }

  toJSON(): Record<string, never> {
    return {};
  }

  async #request(method: string, url: string, body?: unknown): Promise<Reply> {
    this.#tokenValue ??= this.#token();
    const token = await this.#tokenValue;
    const path = url.startsWith(this.#base) ? url.slice(this.#base.length) : url;
    let attempt = 0;
    for (;;) {
      await this.#limiter.gate(this.#now, this.#sleep);
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'hyperpanes-mcp',
        authorization: `Bearer ${token}`
      };
      const cached = method === 'GET' ? this.#cache.get(url) : undefined;
      if (cached) headers['if-none-match'] = cached.etag;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await this.#fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      if (res.status === 304 && cached) return { status: 200, data: cached.data, link: cached.link };
      if (res.status === 401) throw new GitHubAuthError();
      const remaining = res.headers.get('x-ratelimit-remaining');
      const limited =
        res.status === 429 ||
        (res.status === 403 && (remaining === '0' || res.headers.get('retry-after') !== null));
      if (limited) {
        attempt++;
        const wait = Math.min(this.#waitMs(res.headers, attempt), MAX_WAIT_MS);
        this.#limiter.block(this.#now() + wait);
        if (attempt > MAX_RETRIES) throw new RateLimitError(this.#limiter.resumeAt);
        continue;
      }
      if (res.status >= 500) {
        attempt++;
        if (attempt > MAX_RETRIES) throw new GitHubApiError(res.status, method, path);
        await this.#sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      // A 404 on a read is a meaningful answer (no permission row, no such label); callers decide.
      // A failed write must never look like success, or the sync would think it had posted.
      if (res.status === 404 && method === 'GET') return { status: res.status, data: null, link: null };
      if (!res.ok) throw new GitHubApiError(res.status, method, path);
      const text = await res.text();
      const data = text ? (JSON.parse(text) as unknown) : null;
      const link = res.headers.get('link');
      const etag = res.headers.get('etag');
      if (method === 'GET' && etag) this.#cache.set(url, { etag, data, link });
      return { status: res.status, data, link };
    }
  }

  #waitMs(h: Headers, attempt: number): number {
    const ra = h.get('retry-after');
    if (ra !== null && Number.isFinite(Number(ra))) return Math.max(0, Number(ra) * 1000);
    const reset = h.get('x-ratelimit-reset');
    if (h.get('x-ratelimit-remaining') === '0' && reset !== null && Number.isFinite(Number(reset))) {
      return Math.max(0, Number(reset) * 1000 - this.#now());
    }
    return 1000 * 2 ** (attempt - 1);
  }

  async #get(path: string): Promise<Reply> {
    return this.#request('GET', this.#base + path);
  }

  async #getAll(path: string): Promise<Json[]> {
    const out: Json[] = [];
    let url: string | undefined = this.#base + path;
    for (let i = 0; url && i < MAX_PAGES; i++) {
      const r: Reply = await this.#request('GET', url);
      if (r.status === 404) throw new GitHubApiError(404, 'GET', url.slice(this.#base.length));
      if (Array.isArray(r.data)) out.push(...(r.data as Json[]));
      const m = r.link ? /<([^>]+)>;\s*rel="next"/.exec(r.link) : null;
      // never follow a Link off the API host (the Authorization header would go with it)
      url = m?.[1] && m[1].startsWith(this.#base) ? m[1] : undefined;
    }
    return out;
  }

  #issue(j: Json): GitHubIssue {
    return {
      number: j.number,
      title: String(j.title ?? ''),
      body: String(j.body ?? ''),
      state: String(j.state ?? ''),
      url: String(j.html_url ?? ''),
      labels: ((j.labels ?? []) as Array<string | Json>).map((l) => (typeof l === 'string' ? l : String(l.name))),
      createdAt: String(j.created_at ?? ''),
      isPullRequest: j.pull_request !== undefined && j.pull_request !== null
    };
  }

  async listOpenIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]> {
    const q = `state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=100`;
    return (await this.#getAll(`/repos/${repo}/issues?${q}`)).map((j) => this.#issue(j));
  }

  async getIssue(repo: string, number: number): Promise<GitHubIssue> {
    const r = await this.#get(`/repos/${repo}/issues/${number}`);
    if (!r.data) throw new GitHubApiError(r.status, 'GET', `/repos/${repo}/issues/${number}`);
    return this.#issue(r.data as Json);
  }

  #run(j: Json): WorkflowRun {
    return {
      id: Number(j.id),
      workflowId: Number(j.workflow_id),
      name: String(j.name ?? ''),
      headBranch: String(j.head_branch ?? ''),
      headSha: String(j.head_sha ?? ''),
      event: String(j.event ?? ''),
      url: String(j.html_url ?? ''),
      createdAt: String(j.created_at ?? ''),
      runAttempt: Number(j.run_attempt ?? 1),
      displayTitle: String(j.display_title ?? ''),
      headRepo: String(j.head_repository?.full_name ?? ''),
      conclusion: String(j.conclusion ?? ''),
      path: String(j.path ?? '')
    };
  }

  async #getRuns(path: string): Promise<WorkflowRun[]> {
    const r = await this.#get(path);
    // fail closed: a 404 is "unknown", not "no failures"
    if (r.status === 404 || !r.data) throw new GitHubApiError(r.status, 'GET', path);
    const rows = (r.data as Json).workflow_runs;
    return Array.isArray(rows) ? (rows as Json[]).map((j) => this.#run(j)) : [];
  }

  async listFailedRuns(repo: string, branch: string, since: string): Promise<WorkflowRun[]> {
    const q = `status=failure&branch=${encodeURIComponent(branch)}&created=${encodeURIComponent('>=' + since)}&per_page=100`;
    return this.#getRuns(`/repos/${repo}/actions/runs?${q}`);
  }

  async getLatestCompletedRun(repo: string, workflowId: number, branch: string): Promise<WorkflowRun | null> {
    const q = `branch=${encodeURIComponent(branch)}&status=completed&per_page=1`;
    return (await this.#getRuns(`/repos/${repo}/actions/workflows/${workflowId}/runs?${q}`))[0] ?? null;
  }

  async listRunJobs(repo: string, runId: number): Promise<WorkflowJob[]> {
    const path = `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;
    const r = await this.#get(path);
    if (r.status === 404 || !r.data) throw new GitHubApiError(r.status, 'GET', path);
    const rows = (r.data as Json).jobs;
    return (Array.isArray(rows) ? (rows as Json[]) : []).map((j) => ({
      id: Number(j.id),
      name: String(j.name ?? ''),
      conclusion: String(j.conclusion ?? ''),
      url: String(j.html_url ?? ''),
      steps: ((j.steps ?? []) as Json[]).map((st) => ({
        name: String(st.name ?? ''),
        number: Number(st.number),
        conclusion: String(st.conclusion ?? '')
      }))
    }));
  }

  async listIssueEvents(repo: string, number: number): Promise<IssueEvent[]> {
    const rows = await this.#getAll(`/repos/${repo}/issues/${number}/events?per_page=100`);
    return rows.map((j) => ({
      id: Number(j.id),
      event: String(j.event),
      ...(j.actor?.login ? { actor: String(j.actor.login) } : {}),
      ...(j.label?.name ? { label: String(j.label.name) } : {}),
      createdAt: String(j.created_at)
    }));
  }

  async getCollaboratorPermission(repo: string, login: string): Promise<Permission> {
    const r = await this.#get(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
    if (r.status === 404 || !r.data) return 'none';
    const d = r.data as Json;
    const p = String(d.role_name ?? d.permission ?? 'none');
    return (['admin', 'maintain', 'write', 'triage', 'read'] as const).find((x) => x === p) ?? 'none';
  }

  async getIssueEditInfo(repo: string, number: number): Promise<IssueEditInfo> {
    const [owner, name] = repo.split('/');
    const query =
      'query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){lastEditedAt editor{login}}}}';
    const r = await this.#request('POST', `${this.#base}/graphql`, {
      query,
      variables: { o: owner, n: name, i: number }
    });
    const reply = r.data as Json | null;
    const issue = reply?.data?.repository?.issue as Json | undefined;
    // Fail closed: without a real answer we can't prove the text wasn't edited after the label.
    if (!issue || (Array.isArray(reply?.errors) && reply.errors.length > 0)) {
      throw new GitHubApiError(r.status, 'POST', `/graphql (issue edit info for ${repo}#${number})`);
    }
    return {
      ...(issue?.lastEditedAt ? { lastEditedAt: String(issue.lastEditedAt) } : {}),
      ...(issue?.editor?.login ? { editor: String(issue.editor.login) } : {})
    };
  }

  async listIssueComments(repo: string, number: number): Promise<IssueComment[]> {
    const rows = await this.#getAll(`/repos/${repo}/issues/${number}/comments?per_page=100`);
    return rows.map((j) => ({ id: Number(j.id), body: String(j.body ?? '') }));
  }

  async createIssueComment(repo: string, number: number, body: string): Promise<void> {
    await this.#request('POST', `${this.#base}/repos/${repo}/issues/${number}/comments`, { body });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#request('POST', `${this.#base}/repos/${repo}/issues/${number}/labels`, { labels });
  }

  async removeLabel(repo: string, number: number, label: string): Promise<void> {
    try {
      await this.#request('DELETE', `${this.#base}/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
    } catch (err) {
      // 404 = the label is already off the issue, which is the state we wanted
      if (!(err instanceof GitHubApiError && err.status === 404)) throw err;
    }
  }
}
