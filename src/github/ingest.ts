/** Orchestrates `--github-issues`: config → source → dedupe → (dry-run | enqueue). */

import { enqueueBacklog, generateBacklog, type EnqueueOutcome, type GenerateResult } from '../backlog/backlog.js';
import type { EnqueueRequest, Task } from '../worker-pool/kinds.js';
import type { EnqueueResult } from '../worker-pool/queue-client.js';
import type { GitHubClient } from './client.js';
import { isRepoActive, loadConfig, repoFromCwd, requireOptedIn } from './config.js';
import { githubCiSource, type CiDecision } from './ci-source.js';
import { githubIssuesSource, type Decision } from './issues-source.js';
import { listAllTasks, type TaskLister } from './queue.js';

export interface IngestQueue extends TaskLister {
  enqueue(queue: string, req: EnqueueRequest): Promise<EnqueueResult>;
}

export interface IngestOptions {
  /** `owner/name`, or `.` / undefined to derive from the cwd's origin. */
  repoArg?: string | undefined;
  label?: string | undefined;
  /** ingest failed CI runs (needs `ci.enabled` for the repo). */
  ci?: boolean;
  /** ingest labelled issues (default true unless `ci` is the only mode). */
  issues?: boolean;
  now?: () => number;
  configPath: string;
  dryRun: boolean;
  client: () => GitHubClient;
  queue: () => IngestQueue;
  cwd?: string;
  log?: (line: string) => void;
}

export interface IngestResult {
  disabled: boolean;
  repo?: string;
  queue?: string;
  queueChecked: boolean;
  decisions: Decision[];
  ciDecisions: CiDecision[];
  gen?: GenerateResult;
  outcomes?: EnqueueOutcome[];
}

export async function runIssuesIngest(o: IngestOptions): Promise<IngestResult> {
  return runGithubIngest(o);
}

/** Issues and/or CI ingest for ONE repo; both land in that repo's queue. */
export async function runGithubIngest(o: IngestOptions): Promise<IngestResult> {
  const wantCi = o.ci === true;
  const wantIssues = o.issues ?? !wantCi;
  const log = o.log ?? ((l) => console.error(l));
  const cfg = loadConfig(o.configPath);
  const arg = o.repoArg && o.repoArg !== '.' ? o.repoArg : await repoFromCwd(o.cwd);
  const { repo, config } = requireOptedIn(cfg, arg);
  if (!isRepoActive(cfg, repo)) {
    log(`[github] ${repo}: disabled`);
    return { disabled: true, repo, queueChecked: false, decisions: [], ciDecisions: [] };
  }

  if (wantCi && !config.ci.enabled) throw new Error(`ci not enabled for ${repo}`);

  let queueTasks: Task[] | undefined;
  let queueKeys: Set<string> | undefined;
  let queue: IngestQueue | undefined;
  try {
    queue = o.queue();
    const tasks: Task[] = await listAllTasks(queue, config.queue);
    queueTasks = tasks;
    queueKeys = new Set(tasks.flatMap((t) => (t.dedupeKey ? [t.dedupeKey] : [])));
  } catch (err) {
    if (!o.dryRun) throw err;
    log('[github] queue unreachable: dedupe against the queue was not checked');
    queueKeys = undefined;
    queueTasks = undefined;
  }

  const client = o.client();
  const sources = [];
  const issuesSrc = wantIssues
    ? githubIssuesSource({
        client,
        repo,
        label: o.label ?? config.label,
        base: config.base,
        limit: config.limit,
        trustedActors: config.trustedActors,
        queueKeys
      })
    : undefined;
  const ciSrc = wantCi
    ? githubCiSource({
        client,
        repo,
        limit: config.limit,
        ci: config.ci,
        queueTasks,
        ...(o.now ? { now: o.now } : {})
      })
    : undefined;
  if (issuesSrc) sources.push(issuesSrc);
  if (ciSrc) sources.push(ciSrc);
  const gen = await generateBacklog(sources, { base: config.base });
  const decisions = issuesSrc?.decisions ?? [];
  const ciDecisions = ciSrc?.decisions ?? [];
  for (const d of decisions) {
    log(d.action === 'enqueue' ? `enqueue ${repo}#${d.number} "${d.title}"` : `skip ${repo}#${d.number} ${d.reason}`);
  }
  for (const d of ciDecisions) {
    log(
      d.action === 'enqueue'
        ? `enqueue ${repo} run ${d.runId} "${d.workflow}" on ${d.branch}`
        : `skip ${repo} run ${d.runId} ${d.reason}`
    );
  }
  const base = { disabled: false, repo, queue: config.queue, queueChecked: queueKeys !== undefined, decisions, ciDecisions, gen };
  if (o.dryRun || !queue) return base;
  // kill switch re-check right before the writes
  if (!isRepoActive(loadConfig(o.configPath), repo)) {
    log(`[github] ${repo}: disabled`);
    return { ...base, disabled: true };
  }
  const outcomes = await enqueueBacklog(queue, config.queue, gen);
  return { ...base, outcomes };
}
