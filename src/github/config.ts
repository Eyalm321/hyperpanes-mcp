/** Opt-in config for GitHub sources (design note §2). Strict: unknown keys are errors. */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const RepoConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    queue: z.string().min(1),
    base: z.string().default('main'),
    label: z.string().default('agent-ready'),
    limit: z.number().int().positive().default(20),
    trustedActors: z.array(z.string()).default([]),
    syncBack: z
      .object({ comments: z.boolean().default(true), labels: z.boolean().default(true) })
      .strict()
      .default({ comments: true, labels: true }),
    ci: z
      .object({
        enabled: z.boolean().default(false),
        branches: z.array(z.string()).default(['main']),
        workflows: z.array(z.string()).default([]),
        maxAgeHours: z.number().positive().default(72)
      })
      .strict()
      .default({ enabled: false, branches: ['main'], workflows: [], maxAgeHours: 72 }),
    pr: z
      .object({
        enabled: z.boolean().default(false),
        draft: z.boolean().default(true),
        review: z.boolean().default(true),
        checkout: z.string().optional(),
        remote: z.string().default('origin')
      })
      .strict()
      .default({ enabled: false, draft: true, review: true, remote: 'origin' })
  })
  .strict();

export const GithubConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    repos: z.record(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be owner/name'), RepoConfigSchema)
  })
  .strict();

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

/** `--github-config` > `HP_GITHUB_CONFIG` > `$XDG_CONFIG_HOME/hyperpanes-mcp/github.json` > `~/.config/...`. */
export function resolveConfigPath(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (flag) return flag;
  if (env.HP_GITHUB_CONFIG) return env.HP_GITHUB_CONFIG;
  const dir = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(dir, 'hyperpanes-mcp', 'github.json');
}

export function loadConfig(path: string): GithubConfig {
  if (!existsSync(path)) {
    throw new Error(`GitHub config not found: ${path} (see docs/github-sources.md)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`GitHub config ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = GithubConfigSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`invalid GitHub config ${path}: ${msg}`);
  }
  return r.data;
}

/** Look a repo up (case-insensitive); refuse with `not opted in: <repo>` if unlisted. */
export function requireOptedIn(cfg: GithubConfig, repo: string): { repo: string; config: RepoConfig } {
  const key = Object.keys(cfg.repos).find((k) => k.toLowerCase() === repo.toLowerCase());
  if (!key) throw new Error(`not opted in: ${repo}`);
  return { repo: key, config: cfg.repos[key] as RepoConfig };
}

/** Kill switch: top-level and per-repo `enabled`. */
export function isRepoActive(cfg: GithubConfig, repo: string): boolean {
  if (!cfg.enabled) return false;
  const key = Object.keys(cfg.repos).find((k) => k.toLowerCase() === repo.toLowerCase());
  return key !== undefined && (cfg.repos[key] as RepoConfig).enabled;
}

/** `owner/name` from an https or ssh remote URL, or null. */
export function parseRemoteUrl(url: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    );
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Derive the repo from the cwd's `origin` remote. */
export function repoFromCwd(cwd: string = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(new Error('cannot derive repo: no origin remote in the current directory'));
      const repo = parseRemoteUrl(String(stdout));
      if (!repo) return reject(new Error('cannot derive repo: origin is not a github.com remote'));
      resolve(repo);
    });
  });
}
