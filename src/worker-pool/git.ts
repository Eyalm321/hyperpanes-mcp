/**
 * Thin `git worktree` wrapper for the worker pool — the controller shells out to
 * plain git for filesystem isolation (no core changes; doc 03 §1). Every method
 * is scoped to one repo via `git -C <repo>` and uses `execFile` (no shell), so
 * paths/refs with odd characters are passed verbatim as argv.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
}

export class Git {
  constructor(private readonly repo: string) {}

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP('git', ['-C', this.repo, ...args], { maxBuffer: 16 * 1024 * 1024 });
  }

  /**
   * Add an isolated checkout at `path` on a fresh branch forked from `base`.
   * Idempotent across re-runs: if the (id-derived) branch already exists — e.g. a
   * crash left it behind — fall back to `-B`, which resets it to `base` rather
   * than failing. `-f` lets a stale registration be reused.
   */
  async worktreeAdd(path: string, branch: string, base: string): Promise<void> {
    try {
      await this.run(['worktree', 'add', '-f', '-b', branch, path, base]);
    } catch (err) {
      if (/already exists/i.test(errText(err))) {
        await this.run(['worktree', 'add', '-f', '-B', branch, path, base]);
        return;
      }
      throw err;
    }
  }

  /** Force-remove a worktree directory (the pane that cwd'd into it must be gone). */
  async worktreeRemove(path: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', path]);
  }

  /** Drop administrative records for worktrees whose directories are gone. */
  async worktreePrune(): Promise<void> {
    await this.run(['worktree', 'prune']);
  }

  /** Delete a (throwaway) branch. */
  async branchDelete(branch: string): Promise<void> {
    await this.run(['branch', '-D', branch]);
  }

  /** Parse `git worktree list --porcelain` into structured records. */
  async worktreeList(): Promise<GitWorktree[]> {
    const { stdout } = await this.run(['worktree', 'list', '--porcelain']);
    const out: GitWorktree[] = [];
    let cur: GitWorktree | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) out.push(cur);
        cur = { path: line.slice('worktree '.length).trim() };
      } else if (cur && line.startsWith('HEAD ')) {
        cur.head = line.slice('HEAD '.length).trim();
      } else if (cur && line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).trim();
      }
    }
    if (cur) out.push(cur);
    return out;
  }
}

function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    return String(e.stderr ?? '') + String(e.message ?? '');
  }
  return String(err);
}
