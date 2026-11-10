/**
 * Git seam for the PR step (#6). Every call is `git -C <checkout> ...` through `execFile`
 * (argv, no shell). Pushing is a plain push of one refspec: never `--force`, never `+refspec`.
 * Credentials come from the checkout's own git config; no token is ever put in argv or a URL.
 */

import { execFile } from 'node:child_process';

export class NonFastForwardError extends Error {
  constructor() {
    super('push rejected: the remote branch already exists at a different commit (non-fast-forward)');
    this.name = 'NonFastForwardError';
  }
}

export interface GitOps {
  branchExists(ref: string): Promise<boolean>;
  /** Commits reachable from `branch` but not from `base`. */
  commitsAhead(base: string, branch: string): Promise<number>;
  remoteUrl(remote: string): Promise<string>;
  /** Three-dot diff `base...branch`. */
  diff(base: string, branch: string): Promise<string>;
  /** `git push <remote> <localBranch>:refs/heads/<remoteRef>`; throws {@link NonFastForwardError} on rejection. */
  push(remote: string, localBranch: string, remoteRef: string): Promise<void>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

type Runner = (args: string[]) => Promise<RunResult>;

function runner(checkout: string): Runner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        'git',
        ['-C', checkout, ...args],
        { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        }
      );
    });
}

export function execGitOps(checkout: string, run: Runner = runner(checkout)): GitOps {
  const must = async (args: string[]): Promise<string> => {
    const r = await run(args);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed (exit ${r.code})`);
    return r.stdout;
  };
  return {
    async branchExists(ref) {
      return (await run(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])).code === 0;
    },
    async commitsAhead(base, branch) {
      const n = Number((await must(['rev-list', '--count', `${base}..${branch}`])).trim());
      if (!Number.isInteger(n)) throw new Error('git rev-list returned no count');
      return n;
    },
    async remoteUrl(remote) {
      return (await must(['remote', 'get-url', remote])).trim();
    },
    async diff(base, branch) {
      return must(['diff', `${base}...${branch}`]);
    },
    async push(remote, localBranch, remoteRef) {
      const r = await run(['push', remote, `${localBranch}:refs/heads/${remoteRef}`]);
      if (r.code === 0) return;
      if (/non-fast-forward|\[rejected\]|fetch first|stale info/i.test(r.stderr)) throw new NonFastForwardError();
      throw new Error(`git push failed (exit ${r.code})`);
    }
  };
}
