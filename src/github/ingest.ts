/** Orchestrates `--github-issues`: config → source → dedupe → (dry-run | enqueue). */

import { enqueueBacklog, generateBacklog, type EnqueueOutcome, type GenerateResult } from '../backlog/backlog.js';
import type { EnqueueRequest, Task } from '../worker-pool/kinds.js';
import type { EnqueueResult } from '../worker-pool/queue-client.js';
import type { GitHubClient } from './client.js';
import { isRepoActive, loadConfig, repoFromCwd, requireOptedIn } from './config.js';
import { githubIssuesSource, type Decision } from './issues-source.js';
import { listAllTasks, type TaskLister } from './queue.js';

export interface IngestQueue extends TaskLister {
  enqueue(queue: string, req: EnqueueRequest): Promise<EnqueueResult>;
}

export interface IngestOptions {
  /** `owner/name`, or `.` / undefined to derive from the cwd's origin. */
  repoArg?: string | undefined;
  label?: string | undefined;
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
  gen?: GenerateResult;
  outcomes?: EnqueueOutcome[];
}

export async function runIssuesIngest(o: IngestOptions): Promise<IngestResult> {
  const log = o.log ?? ((l) => console.error(l));
  const cfg = loadConfig(o.configPath);
  const arg = o.repoArg && o.repoArg !== '.' ? o.repoArg : await repoFromCwd(o.cwd);
  const { repo, config } = requireOptedIn(cfg, arg);
  if (!isRepoActive(cfg, repo)) {
    log(`[github] ${repo}: disabled`);
    return { disabled: true, repo, queueChecked: false, decisions: [] };
  }

  let queueKeys: Set<string> | undefined;
  let queue: IngestQueue | undefined;
  try {
    queue = o.queue();
    const tasks: Task[] = await listAllTasks(queue, config.queue);
    queueKeys = new Set(tasks.flatMap((t) => (t.dedupeKey ? [t.dedupeKey] : [])));
  } catch (err) {
    if (!o.dryRun) throw err;
    log('[github] queue unreachable: dedupe against the queue was not checked');
    queueKeys = undefined;
  }

  const source = githubIssuesSource({
    client: o.client(),
    repo,
    label: o.label ?? config.label,
    base: config.base,
    limit: config.limit,
    trustedActors: config.trustedActors,
    queueKeys
  });
  const gen = await generateBacklog([source], { base: config.base });
  for (const d of source.decisions) {
    log(d.action === 'enqueue' ? `enqueue ${repo}#${d.number} "${d.title}"` : `skip ${repo}#${d.number} ${d.reason}`);
  }
  const base = { disabled: false, repo, queue: config.queue, queueChecked: queueKeys !== undefined, decisions: source.decisions, gen };
  if (o.dryRun || !queue) return base;
  // kill switch re-check right before the writes
  if (!isRepoActive(loadConfig(o.configPath), repo)) {
    log(`[github] ${repo}: disabled`);
    return { ...base, disabled: true };
  }
  const outcomes = await enqueueBacklog(queue, config.queue, gen);
  return { ...base, outcomes };
}
