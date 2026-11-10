/**
 * PR on completion (#6): design note §9. Draft PR only, review-gated, never merges.
 * Everything with side effects is injected (GitHub client, git, review judge, state file),
 * so tests use fakes. Dry runs do the reads and write nothing.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { decodeSpec, deriveBranch, type Task } from '../worker-pool/kinds.js';
import { reviewDiff, type ReviewRunner } from '../worker-pool/review.js';
import type { GitHubClient, IssueComment } from './client.js';
import { RateLimitError } from './client.js';
import { parseRemoteUrl, type RepoConfig } from './config.js';
import { NonFastForwardError, type GitOps } from './git-ops.js';
import { formatMarker, parseMarkers } from './markers.js';

export type PrFinalKind = 'pr-opened' | 'pr-exists' | 'no-commits' | 'review-blocked';

export type PrOutcome =
  | { final: true; kind: PrFinalKind; number?: number; url?: string; risk?: number; draft?: boolean }
  /** Not done yet: an error (retried next cycle) or a dry run that stopped at a would-do. */
  | { final: false; error?: string };

export interface PrTarget {
  task: Task;
  repo: string;
  /** `issue` has a thread to comment on; `ci` does not. */
  kind: 'issue' | 'ci';
  /** issue number or CI run id */
  ref: number;
  gen: number;
  /** issue title (issue) or run url (ci) — set by the caller */
  title: string;
  runUrl?: string;
}

const id8 = (t: Task): string => t.id.slice(0, 8);

export const remoteBranchFor = (t: PrTarget): string =>
  t.kind === 'issue' ? `hp/issue-${t.ref}-${id8(t.task)}` : `hp/ci-${t.ref}-${id8(t.task)}`;

export const safeQueue = (queue: string): string => queue.replace(/[/ ]/g, '-');

export function prTitle(title: string): string {
  const clean = `[hp] ${title}`.replace(/\s+/g, ' ').trim();
  return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
}

export function prBody(t: PrTarget, review: { verdict: 'approve'; risk: number } | null): string {
  const first = t.kind === 'issue' ? `Closes #${t.ref}` : `Fixes the failing run: ${t.runUrl ?? ''}`;
  return [
    first,
    '',
    `Task \`${id8(t.task)}\``,
    review ? `Review: approve (risk ${review.risk})` : 'Review: skipped (pr.review is off)',
    '',
    'Merge is a human decision; this PR is never auto-merged.',
    '',
    formatMarker(t.task.id, 'pr', t.gen)
  ].join('\n');
}

// ---------- local verdict / outcome cache (needed for CI tasks, which have no issue thread) ----------

export interface PrStateEntry {
  verdict?: 'approve' | 'block';
  risk?: number;
  final?: PrFinalKind;
}
export type PrState = Record<string, PrStateEntry>;

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(dir, 'hyperpanes-mcp', 'github-sync-state.json');
}

export function loadPrState(path: string): PrState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PrState) : {};
  } catch {
    return {};
  }
}

function savePrState(path: string, state: PrState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// ---------- the step ----------

export interface PrStepOptions {
  client: GitHubClient;
  git: GitOps;
  runner: ReviewRunner;
  statePath: string;
  repo: string;
  repoCfg: RepoConfig;
  target: PrTarget;
  /** The issue's comments (issue targets): the `review-blocked` marker is the verdict cache. */
  comments: IssueComment[];
  dryRun: boolean;
  /** Re-reads the config; false = kill switch is on. */
  active: () => boolean;
  log: (line: string) => void;
  onAction?: (kind: 'push' | 'pr', detail: string) => void;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runPrStep(o: PrStepOptions): Promise<PrOutcome> {
  try {
    return await step(o);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    return { final: false, error: errMsg(err) };
  }
}

async function step(o: PrStepOptions): Promise<PrOutcome> {
  const { client, git, repo, repoCfg, target: t, log } = o;
  const pr = repoCfg.pr;
  const spec = decodeSpec(t.task);
  const remoteBranch = remoteBranchFor(t);
  const state = loadPrState(o.statePath);
  const cached = state[t.task.id] ?? {};
  const remember = (patch: PrStateEntry): void => {
    if (o.dryRun) return;
    state[t.task.id] = { ...(state[t.task.id] ?? {}), ...patch };
    savePrState(o.statePath, state);
  };
  const finish = (out: Extract<PrOutcome, { final: true }>): PrOutcome => {
    // CI tasks have no thread to dedupe against, so remember the final outcome locally.
    if (t.kind === 'ci') remember({ final: out.kind });
    return out;
  };

  if (t.kind === 'ci' && cached.final) {
    // already handled in an earlier cycle: nothing to do and nothing to write
    return { final: true, kind: cached.final, ...(cached.risk !== undefined ? { risk: cached.risk } : {}) };
  }

  // a. the local branch
  const candidates = [`worker/${safeQueue(t.task.queue)}/${id8(t.task)}`, deriveBranch(t.task)];
  let local: string | undefined;
  for (const c of candidates) {
    if (await git.branchExists(c)) {
      local = c;
      break;
    }
  }
  if (!local || (await git.commitsAhead(spec.base, local)) === 0) return finish({ final: true, kind: 'no-commits' });

  // b. the remote must be the opted-in repo
  const remoteRepo = parseRemoteUrl(await git.remoteUrl(pr.remote));
  if (!remoteRepo || remoteRepo.toLowerCase() !== repo.toLowerCase()) {
    return { final: false, error: `remote '${pr.remote}' does not point at ${repo}; nothing was pushed` };
  }

  // d. an existing PR (any state) wins: no review, no push
  const owner = repo.split('/')[0] as string;
  const existing = (await client.listPullsByHead(repo, owner, remoteBranch))[0];
  if (existing) return finish({ final: true, kind: 'pr-exists', number: existing.number, url: existing.url });

  const title = prTitle(t.title);

  // e. review gate (cached verdicts never re-run the judge)
  let review: { verdict: 'approve'; risk: number } | null = null;
  if (pr.review) {
    const marked = o.comments
      .filter((c) => parseMarkers(c.body).some((m) => m.task === t.task.id && m.state === 'review-blocked'))
      .map((c) => c.body)[0];
    if (marked !== undefined || cached.verdict === 'block') {
      const risk = Number(/risk (\d+)/.exec(marked ?? '')?.[1] ?? cached.risk ?? 10);
      return finish({ final: true, kind: 'review-blocked', risk });
    }
    if (cached.verdict === 'approve') {
      review = { verdict: 'approve', risk: cached.risk ?? 0 };
    } else if (o.dryRun) {
      log(`would review ${repo} ${t.kind === 'issue' ? '#' : 'run '}${t.ref}`);
    } else {
      const diff = await git.diff(spec.base, local);
      const res = await reviewDiff({ diff, title, body: spec.prompt }, o.runner);
      remember({ verdict: res.verdict, risk: res.risk });
      log(`review ${repo} ${t.kind === 'issue' ? '#' : 'run '}${t.ref}: ${res.verdict} (risk ${res.risk})`);
      if (res.verdict !== 'approve') return finish({ final: true, kind: 'review-blocked', risk: res.risk });
      review = { verdict: 'approve', risk: res.risk };
    }
  }

  if (o.dryRun) {
    log(`would push ${local} → ${remoteBranch}`);
    log(`would open ${pr.draft ? 'draft ' : ''}PR "${title}"`);
    o.onAction?.('push', `${local} → ${remoteBranch}`);
    o.onAction?.('pr', title);
    return { final: false };
  }

  // f+g. kill switch, then a plain push
  if (!o.active()) return { final: false, error: 'disabled' };
  try {
    await git.push(pr.remote, local, remoteBranch);
  } catch (err) {
    if (err instanceof NonFastForwardError) {
      return { final: false, error: `${remoteBranch}: remote branch exists at a different commit; not forcing` };
    }
    throw err;
  }
  o.onAction?.('push', `${local} → ${remoteBranch}`);
  log(`push ${local} → ${remoteBranch}`);

  // f+h. kill switch again, then the draft PR
  if (!o.active()) return { final: false, error: 'disabled' };
  const created = await client.createPull(repo, {
    title,
    head: remoteBranch,
    base: spec.base,
    body: prBody(t, review),
    draft: pr.draft
  });
  o.onAction?.('pr', title);
  log(`opened ${pr.draft ? 'draft ' : ''}PR #${created.number} ${created.url}`);
  return finish({ final: true, kind: 'pr-opened', number: created.number, url: created.url, draft: pr.draft });
}

/** Issue-comment text (without marker) and marker state for a final PR outcome. */
export function doneComment(
  out: Extract<PrOutcome, { final: true }>,
  id: string,
  draft: boolean
): { state: 'done' | 'review-blocked'; text: string } {
  switch (out.kind) {
    case 'pr-opened':
      return { state: 'done', text: `Done (task \`${id}\`). ${draft ? 'Draft PR' : 'PR'} #${out.number}: ${out.url}` };
    case 'pr-exists':
      return { state: 'done', text: `Done (task \`${id}\`). PR #${out.number} already exists: ${out.url}` };
    case 'no-commits':
      return { state: 'done', text: `Done (task \`${id}\`), no commits on the branch, so no PR was opened.` };
    case 'review-blocked':
      return {
        state: 'review-blocked',
        text: `Done (task \`${id}\`), but the local review gate blocked the change (risk ${out.risk ?? 10}); no PR was opened.`
      };
  }
}
