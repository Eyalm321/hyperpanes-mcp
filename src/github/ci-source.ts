/** Failed GitHub Actions runs → `ci_failure` tasks (#4). A {@link BacklogSource} that reports every skip. */

import { decodeSpec, type Task, type TaskInput } from '../worker-pool/kinds.js';
import type { BacklogSource } from '../backlog/sources.js';
import type { GitHubClient, WorkflowRun } from './client.js';
import { buildCiPrompt } from './payload.js';

export type CiSkipReason = 'fork' | 'pull-request-event' | 'superseded' | 'already-queued';

export interface CiDecision {
  runId: number;
  workflow: string;
  branch: string;
  action: 'enqueue' | 'skip';
  reason?: CiSkipReason;
}

export interface CiSourceOptions {
  client: GitHubClient;
  repo: string;
  limit: number;
  ci: { branches: string[]; workflows: string[]; maxAgeHours: number };
  /** every task in the queue (any state); undefined = queue unchecked. */
  queueTasks?: Task[] | undefined;
  now?: () => number;
  nonce?: () => string;
}

export function ciDedupeKey(repo: string, workflowId: number, branch: string): string {
  return `gh-ci:${repo}:${workflowId}:${branch}`;
}

const basename = (p: string): string => p.split('/').pop() ?? p;

function workflowMatches(run: WorkflowRun, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const names = [run.name, run.path ? basename(run.path) : ''].filter(Boolean).map((n) => n.toLowerCase());
  return wanted.some((w) => names.includes(w.toLowerCase()) || names.includes(basename(w).toLowerCase()));
}

const newest = (a: WorkflowRun, b: WorkflowRun): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id;

export function githubCiSource(opts: CiSourceOptions): BacklogSource & { decisions: CiDecision[] } {
  const decisions: CiDecision[] = [];
  return {
    name: 'github-ci',
    decisions,
    async collect(): Promise<TaskInput[]> {
      decisions.length = 0;
      const { client, repo, ci } = opts;
      const now = (opts.now ?? Date.now)();
      const since = new Date(now - ci.maxAgeHours * 3600_000).toISOString();
      const queued = opts.queueTasks ?? [];
      const queuedRunIds = new Set<number>();
      const liveKeys = new Set<string>();
      for (const t of queued) {
        let s: { runId?: unknown } | undefined;
        try {
          s = decodeSpec(t).source as { runId?: unknown } | undefined;
        } catch {
          s = undefined;
        }
        if (typeof s?.runId === 'number') queuedRunIds.add(s.runId);
        if (t.dedupeKey && (t.state === 'queued' || t.state === 'claimed')) liveKeys.add(t.dedupeKey);
      }

      const out: TaskInput[] = [];
      const seen = new Set<string>(); // workflow+branch groups already judged
      for (const branch of ci.branches) {
        if (out.length >= opts.limit) break;
        const runs = (await client.listFailedRuns(repo, branch, since))
          .filter(
            (r) =>
              r.conclusion === 'failure' &&
              ci.branches.includes(r.headBranch) &&
              Date.parse(r.createdAt) >= Date.parse(since) &&
              workflowMatches(r, ci.workflows)
          )
          .sort(newest);
        for (const run of runs) {
          if (out.length >= opts.limit) break;
          const skip = (reason: CiSkipReason): void => {
            decisions.push({ runId: run.id, workflow: run.name, branch: run.headBranch, action: 'skip', reason });
          };
          if (run.headRepo.toLowerCase() !== repo.toLowerCase()) {
            skip('fork');
            continue;
          }
          if (run.event.startsWith('pull_request')) {
            skip('pull-request-event');
            continue;
          }
          const key = ciDedupeKey(repo, run.workflowId, run.headBranch);
          const group = `${run.workflowId}:${run.headBranch}`;
          // only the newest failure per workflow+branch is a candidate
          if (seen.has(group)) {
            skip('superseded');
            continue;
          }
          seen.add(group);
          const latest = await client.getLatestCompletedRun(repo, run.workflowId, run.headBranch);
          if (latest && latest.id !== run.id) {
            skip('superseded');
            continue;
          }
          if (queuedRunIds.has(run.id) || liveKeys.has(key)) {
            skip('already-queued');
            continue;
          }
          const jobs = (await client.listRunJobs(repo, run.id))
            .filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out')
            .map((j) => ({
              name: j.name,
              url: j.url,
              failedSteps: j.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name)
            }));
          const url = run.url || `https://github.com/${repo}/actions/runs/${run.id}`;
          out.push({
            kind: 'ci_failure',
            title: `CI: ${run.name} failed on ${run.headBranch}`.replace(/\s+/g, ' ').slice(0, 80),
            prompt: buildCiPrompt({
              repo,
              runId: run.id,
              runUrl: url,
              workflowName: run.name,
              branch: run.headBranch,
              headSha: run.headSha,
              displayTitle: run.displayTitle,
              jobs,
              ...(opts.nonce ? { nonce: opts.nonce() } : {})
            }),
            base: run.headBranch,
            dedupeKey: key,
            source: {
              kind: 'github_ci',
              repo,
              runId: run.id,
              workflowId: run.workflowId,
              workflowName: run.name,
              branch: run.headBranch,
              headSha: run.headSha,
              url
            }
          });
          decisions.push({ runId: run.id, workflow: run.name, branch: run.headBranch, action: 'enqueue' });
        }
      }
      return out;
    }
  };
}
