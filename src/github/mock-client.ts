/** Test double for {@link GitHubClient}: records every call, no network. Test-only. */
import type {
  GitHubClient,
  GitHubIssue,
  IssueComment,
  IssueEditInfo,
  IssueEvent,
  Permission,
  WorkflowJob,
  WorkflowRun
} from './client.js';

export const WRITE_METHODS = ['createIssueComment', 'addLabels', 'removeLabel'];

export class MockGitHub implements GitHubClient {
  calls: Array<{ method: string; args: unknown[] }> = [];
  issues: GitHubIssue[] = [];
  events = new Map<number, IssueEvent[]>();
  perms = new Map<string, Permission>();
  edits = new Map<number, IssueEditInfo>();
  comments = new Map<number, IssueComment[]>();
  /** every run (any conclusion); listFailedRuns/getLatestCompletedRun derive from it */
  runs: WorkflowRun[] = [];
  jobs = new Map<number, WorkflowJob[]>();

  addRun(r: Partial<WorkflowRun> & { id: number }): WorkflowRun {
    const run: WorkflowRun = {
      workflowId: 7,
      name: 'CI',
      headBranch: 'main',
      headSha: 'abc1234',
      event: 'push',
      url: `https://github.com/acme/widgets/actions/runs/${r.id}`,
      createdAt: new Date(Date.now() - 3600_000 + r.id).toISOString(),
      runAttempt: 1,
      displayTitle: 'Fix the widget',
      headRepo: 'acme/widgets',
      conclusion: 'failure',
      path: '.github/workflows/ci.yml',
      ...r
    };
    this.runs.push(run);
    return run;
  }

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  get writeCalls() {
    return this.calls.filter((c) => WRITE_METHODS.includes(c.method));
  }

  addIssue(i: Partial<GitHubIssue> & { number: number }, labeledBy = 'octocat', labelId = 100, label = 'agent-ready'): void {
    this.issues.push({
      title: `Issue ${i.number}`,
      body: 'Please fix the widget.',
      state: 'open',
      url: `https://github.com/acme/widgets/issues/${i.number}`,
      labels: [label],
      createdAt: `2026-01-0${(i.number % 9) + 1}T00:00:00Z`,
      isPullRequest: false,
      ...i
    });
    this.events.set(i.number, [
      { id: labelId, event: 'labeled', actor: labeledBy, label, createdAt: '2026-02-01T00:00:00Z' }
    ]);
  }

  async listOpenIssuesByLabel(repo: string, label: string) {
    this.rec('listOpenIssuesByLabel', repo, label);
    return this.issues.filter((i) => i.labels.includes(label));
  }
  async getIssue(repo: string, n: number) {
    this.rec('getIssue', repo, n);
    const i = this.issues.find((x) => x.number === n);
    if (!i) throw new Error('404');
    return { ...i, labels: [...i.labels] };
  }
  async listIssueEvents(repo: string, n: number) {
    this.rec('listIssueEvents', repo, n);
    return this.events.get(n) ?? [];
  }
  async getCollaboratorPermission(repo: string, login: string) {
    this.rec('getCollaboratorPermission', repo, login);
    return this.perms.get(login) ?? 'none';
  }
  async getIssueEditInfo(repo: string, n: number) {
    this.rec('getIssueEditInfo', repo, n);
    return this.edits.get(n) ?? {};
  }
  async listIssueComments(repo: string, n: number) {
    this.rec('listIssueComments', repo, n);
    return [...(this.comments.get(n) ?? [])];
  }
  async createIssueComment(repo: string, n: number, body: string) {
    this.rec('createIssueComment', repo, n, body);
    this.comments.set(n, [...(this.comments.get(n) ?? []), { id: Math.random(), body }]);
  }
  async addLabels(repo: string, n: number, labels: string[]) {
    this.rec('addLabels', repo, n, labels);
    const i = this.issues.find((x) => x.number === n);
    if (i) i.labels = [...new Set([...i.labels, ...labels])];
  }
  async removeLabel(repo: string, n: number, label: string) {
    this.rec('removeLabel', repo, n, label);
    const i = this.issues.find((x) => x.number === n);
    if (i) i.labels = i.labels.filter((l) => l !== label);
  }

  async listFailedRuns(repo: string, branch: string, since: string) {
    this.rec('listFailedRuns', repo, branch, since);
    return this.runs.filter(
      (r) => r.conclusion === 'failure' && r.headBranch === branch && Date.parse(r.createdAt) >= Date.parse(since)
    );
  }
  async getLatestCompletedRun(repo: string, workflowId: number, branch: string) {
    this.rec('getLatestCompletedRun', repo, workflowId, branch);
    const c = this.runs
      .filter((r) => r.workflowId === workflowId && r.headBranch === branch && r.conclusion !== '')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
    return c[0] ?? null;
  }
  async listRunJobs(repo: string, runId: number) {
    this.rec('listRunJobs', repo, runId);
    return this.jobs.get(runId) ?? [];
  }
}
