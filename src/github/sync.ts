/** Queue → GitHub status sync-back (#5): design note §7–§8. Planning is pure. */

import { decodeSpec, type Task } from '../worker-pool/kinds.js';
import type { GitHubClient } from './client.js';
import { RateLimitError } from './client.js';
import type { RepoConfig } from './config.js';
import { formatMarker, parseMarkers, type MarkerState } from './markers.js';
import { execGitOps, type GitOps } from './git-ops.js';
import { defaultStatePath, doneComment, runPrStep, type PrOutcome, type PrTarget } from './pr.js';
import { listAllTasks, type TaskLister } from './queue.js';
import { spawnClaudeReviewRunner, type ReviewRunner } from '../worker-pool/review.js';

export const HP_LABELS = ['hp:queued', 'hp:working', 'hp:done', 'hp:failed'] as const;

export interface IssueTask {
  task: Task;
  repo: string;
  number: number;
  gen: number;
  /** Final outcome of the PR step (#6), when it ran. */
  pr?: Extract<PrOutcome, { final: true }>;
}

/** Keep only GitHub-issue tasks that name an opted-in repo AND live in that repo's queue. */
export function selectIssueTasks(tasks: Task[], repo: string, repoCfg: RepoConfig): IssueTask[] {
  const out: IssueTask[] = [];
  for (const task of tasks) {
    if (task.queue !== repoCfg.queue) continue;
    const src = decodeSpec(task).source as Record<string, unknown> | undefined;
    if (!src || src.kind !== 'github_issue') continue;
    if (typeof src.repo !== 'string' || src.repo.toLowerCase() !== repo.toLowerCase()) continue;
    if (!Number.isInteger(src.number) || (src.number as number) <= 0) continue;
    const gen = Number(src.gen);
    if (!Number.isFinite(gen)) continue;
    out.push({ task, repo, number: src.number as number, gen });
  }
  return out;
}

export interface CiTask {
  task: Task;
  repo: string;
  runId: number;
  url: string;
}

/** GitHub-CI tasks for an opted-in repo, in that repo's queue. */
export function selectCiTasks(tasks: Task[], repo: string, repoCfg: RepoConfig): CiTask[] {
  const out: CiTask[] = [];
  for (const task of tasks) {
    if (task.queue !== repoCfg.queue) continue;
    const src = decodeSpec(task).source as Record<string, unknown> | undefined;
    if (!src || src.kind !== 'github_ci') continue;
    if (typeof src.repo !== 'string' || src.repo.toLowerCase() !== repo.toLowerCase()) continue;
    if (!Number.isInteger(src.runId) || (src.runId as number) <= 0) continue;
    out.push({ task, repo, runId: src.runId as number, url: typeof src.url === 'string' ? src.url : '' });
  }
  return out;
}

const id8 = (task: Task): string => task.id.slice(0, 8);
export const branchName = (number: number, task: Task): string => `hp/issue-${number}-${id8(task)}`;

export function coarseReason(error: string | undefined): string {
  const e = error ?? '';
  const code = /exit code (\d+)/i.exec(e);
  if (code) return `exit code ${code[1]}`;
  if (/time(d)?[ -]?out/i.test(e)) return 'timeout';
  if (/review.*block|blocked/i.test(e)) return 'review blocked';
  if (/exited non-zero/i.test(e)) return 'the agent exited with an error';
  return 'failed';
}

function desiredLabel(state: Task['state']): (typeof HP_LABELS)[number] {
  switch (state) {
    case 'queued':
      return 'hp:queued';
    case 'claimed':
      return 'hp:working';
    case 'done':
      return 'hp:done';
    default:
      return 'hp:failed';
  }
}

/** The comment (without marker) this task state warrants, or null. */
function commentFor(
  it: IssueTask,
  triggerLabel: string,
  prEnabled: boolean,
  draft: boolean
): { state: MarkerState; text: string } | null {
  const { task } = it;
  const t = id8(task);
  switch (task.state) {
    case 'claimed':
      return {
        state: 'claimed',
        text: `An agent picked this up (task \`${t}\`). Work happens on branch \`${branchName(it.number, task)}\`.`
      };
    case 'done':
      if (prEnabled) {
        // post only once the PR step reached a final outcome; the text reflects it
        return it.pr ? doneComment(it.pr, t, draft) : null;
      }
      return { state: 'done', text: `Done (task \`${t}\`). The branch stayed local; no PR was opened.` };
    case 'failed':
    case 'dead':
      return {
        state: 'failed',
        text: `Failed (task \`${t}\`): ${coarseReason(task.error)}. To retry, remove and re-add \`${triggerLabel}\`.`
      };
    default:
      return null;
  }
}

export interface IssueState {
  labels: string[];
  commentBodies: string[];
}

export interface IssuePlan {
  comments: string[]; // full comment bodies, marker included
  addLabels: string[];
  removeLabels: string[];
}

/** Pure: what to write for one issue given its tasks and its current labels/comments. */
export function planIssue(tasks: IssueTask[], current: IssueState, cfg: RepoConfig): IssuePlan {
  const plan: IssuePlan = { comments: [], addLabels: [], removeLabels: [] };
  if (cfg.syncBack.comments) {
    const seen = new Set(
      current.commentBodies.flatMap((b) => parseMarkers(b).map((m) => `${m.task}:${m.state}`))
    );
    for (const it of [...tasks].sort((a, b) => a.task.seq - b.task.seq)) {
      const c = commentFor(it, cfg.label, cfg.pr.enabled, cfg.pr.draft);
      if (!c || seen.has(`${it.task.id}:${c.state}`)) continue;
      seen.add(`${it.task.id}:${c.state}`);
      plan.comments.push(`${c.text}\n\n${formatMarker(it.task.id, c.state, it.gen)}`);
    }
  }
  if (cfg.syncBack.labels && tasks.length > 0) {
    const latest = tasks.reduce((a, b) => (b.task.seq > a.task.seq ? b : a));
    const want = desiredLabel(latest.task.state);
    if (!current.labels.includes(want)) plan.addLabels.push(want);
    for (const l of HP_LABELS) if (l !== want && current.labels.includes(l)) plan.removeLabels.push(l);
  }
  return plan;
}

export interface SyncAction {
  kind: 'comment' | 'label' | 'push' | 'pr';
  number: number;
  detail: string;
}

export interface ReconcileOptions {
  client: GitHubClient;
  queue: TaskLister;
  repo: string;
  repoCfg: RepoConfig;
  dryRun: boolean;
  /** Called once before the first write for this repo; return false to abort (kill switch). */
  recheck?: () => boolean;
  log?: (line: string) => void;
  /** PR step seams (#6); defaults: real git, real `claude -p` judge, XDG state file. */
  git?: (checkout: string) => GitOps;
  reviewRunner?: ReviewRunner;
  prStatePath?: string;
}

export interface ReconcileResult {
  actions: SyncAction[];
  errors: string[];
  aborted: boolean;
  rateLimitedUntil?: number;
}

export async function reconcileRepo(o: ReconcileOptions): Promise<ReconcileResult> {
  const log = o.log ?? ((l) => console.error(l));
  const res: ReconcileResult = { actions: [], errors: [], aborted: false };
  const { repo, repoCfg, client } = o;
  const prOn = repoCfg.pr.enabled;
  if (!repoCfg.syncBack.comments && !repoCfg.syncBack.labels && !prOn) return res;

  const all = await listAllTasks(o.queue, repoCfg.queue);
  const prDeps = prOn
    ? {
        git: (o.git ?? execGitOps)(repoCfg.pr.checkout as string),
        runner: (o.reviewRunner ??= spawnClaudeReviewRunner()),
        statePath: o.prStatePath ?? defaultStatePath(),
        active: o.recheck ?? (() => true)
      }
    : undefined;
  const pushAction = (kind: 'push' | 'pr', detail: string): void => void res.actions.push({ kind, number: 0, detail });
  const prError = (label: string, out: PrOutcome): void => {
    if (!out.final && out.error) res.errors.push(`${label}: pr: ${out.error}`);
  };

  // CI tasks have no issue thread: the PR link lives in the PR body only
  if (prDeps) {
    for (const ci of selectCiTasks(all, repo, repoCfg)) {
      if (ci.task.state !== 'done') continue;
      try {
        const out = await runPrStep({
          client, repo, repoCfg, ...prDeps, comments: [], dryRun: o.dryRun, log, onAction: pushAction,
          target: { task: ci.task, repo, kind: 'ci', ref: ci.runId, gen: ci.runId, title: ci.task.title, runUrl: ci.url }
        });
        prError(`${repo} ci-run ${ci.runId}`, out);
      } catch (err) {
        if (err instanceof RateLimitError) {
          res.rateLimitedUntil = err.resumeAt;
          return res;
        }
        throw err;
      }
    }
  }

  const byIssue = new Map<number, IssueTask[]>();
  for (const it of selectIssueTasks(all, repo, repoCfg)) {
    byIssue.set(it.number, [...(byIssue.get(it.number) ?? []), it]);
  }

  // reads + plan
  const planned: Array<{ number: number; plan: IssuePlan }> = [];
  for (const [number, tasks] of [...byIssue].sort((a, b) => a[0] - b[0])) {
    try {
      const issue = await client.getIssue(repo, number);
      const comments =
        repoCfg.syncBack.comments || prOn ? await client.listIssueComments(repo, number) : [];
      if (prDeps) {
        const posted = new Set(comments.flatMap((c) => parseMarkers(c.body).map((m) => `${m.task}:${m.state}`)));
        for (const it of tasks) {
          if (it.task.state !== 'done') continue;
          // the done comment (any slice) already went out: the PR step has nothing left to report
          if (posted.has(`${it.task.id}:done`)) continue;
          const target: PrTarget = {
            task: it.task, repo, kind: 'issue', ref: number, gen: it.gen, title: issue.title
          };
          const out = await runPrStep({
            client, repo, repoCfg, ...prDeps, comments, dryRun: o.dryRun, log, onAction: pushAction, target
          });
          if (out.final) it.pr = out;
          prError(`${repo}#${number}`, out);
        }
      }
      const plan = planIssue(tasks, { labels: issue.labels, commentBodies: comments.map((c) => c.body) }, repoCfg);
      if (plan.comments.length || plan.addLabels.length || plan.removeLabels.length) planned.push({ number, plan });
    } catch (err) {
      if (err instanceof RateLimitError) {
        res.rateLimitedUntil = err.resumeAt;
        break;
      }
      res.errors.push(`${repo}#${number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (planned.length === 0) return res;

  if (!o.dryRun && o.recheck && !o.recheck()) {
    log(`[github] ${repo}: disabled`);
    res.aborted = true;
    return res;
  }

  for (const { number, plan } of planned) {
    try {
      for (const body of plan.comments) {
        const state = /state=(\S+)/.exec(body)?.[1] ?? '';
        res.actions.push({ kind: 'comment', number, detail: state });
        log(`${o.dryRun ? 'would ' : ''}comment ${repo}#${number} [${state}]`);
        if (!o.dryRun) await client.createIssueComment(repo, number, body);
      }
      if (plan.addLabels.length || plan.removeLabels.length) {
        const detail = [...plan.addLabels.map((l) => `+${l}`), ...plan.removeLabels.map((l) => `-${l}`)].join(' ');
        res.actions.push({ kind: 'label', number, detail });
        log(`${o.dryRun ? 'would ' : ''}label ${repo}#${number} ${detail}`);
        if (!o.dryRun) {
          if (plan.addLabels.length) await client.addLabels(repo, number, plan.addLabels);
          for (const l of plan.removeLabels) await client.removeLabel(repo, number, l);
        }
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        res.rateLimitedUntil = err.resumeAt;
        break;
      }
      res.errors.push(`${repo}#${number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return res;
}
