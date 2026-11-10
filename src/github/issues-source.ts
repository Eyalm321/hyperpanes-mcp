/** GitHub issues → queued tasks (#3). A {@link BacklogSource} that reports every skip. */

import type { TaskInput } from '../worker-pool/kinds.js';
import type { BacklogSource } from '../backlog/sources.js';
import type { GitHubClient } from './client.js';
import { parseMarkers } from './markers.js';
import { buildIssuePrompt } from './payload.js';
import { trustChecker } from './trust.js';

export type SkipReason =
  | 'pull-request'
  | 'untrusted-labeler'
  | 'edited-after-label'
  | 'no-label-event'
  | 'already-queued'
  | 'already-handled';

export interface Decision {
  number: number;
  title: string;
  action: 'enqueue' | 'skip';
  reason?: SkipReason;
}

export interface IssuesSourceOptions {
  client: GitHubClient;
  repo: string;
  label: string;
  base: string;
  limit: number;
  trustedActors: string[];
  /** dedupe keys of every task in the queue (any state); undefined = queue unchecked. */
  queueKeys?: Set<string> | undefined;
  nonce?: () => string;
}

export function issueDedupeKey(repo: string, number: number, gen: number): string {
  return `gh-issue:${repo}#${number}@${gen}`;
}

export function githubIssuesSource(opts: IssuesSourceOptions): BacklogSource & { decisions: Decision[] } {
  const decisions: Decision[] = [];
  return {
    name: 'github-issues',
    decisions,
    async collect(): Promise<TaskInput[]> {
      decisions.length = 0;
      const { client, repo } = opts;
      const issues = (await client.listOpenIssuesByLabel(repo, opts.label)).sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number
      );
      const check = trustChecker(client, repo, opts.trustedActors);
      const out: TaskInput[] = [];
      for (const issue of issues) {
        if (out.length >= opts.limit) break;
        const skip = (reason: SkipReason): void => {
          decisions.push({ number: issue.number, title: issue.title, action: 'skip', reason });
        };
        if (issue.isPullRequest) {
          skip('pull-request');
          continue;
        }
        const trust = await check(issue.number, opts.label);
        if (!trust.ok) {
          skip(trust.reason);
          continue;
        }
        const gen = trust.labelEvent.id;
        const key = issueDedupeKey(repo, issue.number, gen);
        if (opts.queueKeys?.has(key)) {
          skip('already-queued');
          continue;
        }
        const comments = await client.listIssueComments(repo, issue.number);
        if (comments.some((c) => parseMarkers(c.body).some((m) => m.gen === String(gen)))) {
          skip('already-handled');
          continue;
        }
        const url = issue.url || `https://github.com/${repo}/issues/${issue.number}`;
        out.push({
          kind: 'issue',
          title: `#${issue.number} ${issue.title}`.replace(/\s+/g, ' ').slice(0, 80),
          prompt: buildIssuePrompt({
            repo,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            ...(opts.nonce ? { nonce: opts.nonce() } : {})
          }),
          base: opts.base,
          dedupeKey: key,
          source: { kind: 'github_issue', repo, number: issue.number, url, gen }
        });
        decisions.push({ number: issue.number, title: issue.title, action: 'enqueue' });
      }
      return out;
    }
  };
}
