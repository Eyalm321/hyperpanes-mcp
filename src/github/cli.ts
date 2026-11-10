#!/usr/bin/env node
/** `node dist/github/cli.js sync [--repo r] [--once | --watch <secs>] [--dry-run] [--github-config p]` */

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readDiscovery } from '../control/discovery.js';
import { QueueClient } from '../worker-pool/queue-client.js';
import { FetchGitHubClient, NoTokenError, type GitHubClient, RateLimitError } from './client.js';
import { isRepoActive, loadConfig, requireOptedIn, resolveConfigPath } from './config.js';
import type { TaskLister } from './queue.js';
import { reconcileRepo } from './sync.js';

const USAGE = `GitHub sync-back (queue state -> issue comments/labels)

Usage:
  node dist/github/cli.js sync [--repo owner/repo] [--once | --watch <secs>] [--dry-run] [--github-config <path>]

  --repo <owner/repo>      Only this repo (must be opted in)
  --once                   One cycle, then exit (default)
  --watch <secs>           Repeat every N seconds (default 300, minimum 30)
  --dry-run                Print what would be written; make no writes
  --github-config <path>   Config file (env HP_GITHUB_CONFIG)

See docs/github-sources.md.`;

export interface SyncRunOptions {
  configPath: string;
  repo?: string | undefined;
  dryRun: boolean;
  watchSecs?: number | undefined;
  client: () => GitHubClient;
  queue: () => TaskLister;
  sleep?: (ms: number) => Promise<void>;
  maxCycles?: number;
  log?: (line: string) => void;
}

/** One cycle. The config is re-read here and again right before each repo's writes. */
export async function runSyncCycle(o: SyncRunOptions): Promise<{ writes: number; errors: string[] }> {
  const log = o.log ?? ((l) => console.error(l));
  const cfg = loadConfig(o.configPath);
  if (!cfg.enabled) {
    log('[github] disabled');
    return { writes: 0, errors: [] };
  }
  const names = o.repo ? [requireOptedIn(cfg, o.repo).repo] : Object.keys(cfg.repos);
  let writes = 0;
  const errors: string[] = [];
  for (const repo of names) {
    if (!isRepoActive(cfg, repo)) {
      log(`[github] ${repo}: disabled`);
      continue;
    }
    const { config } = requireOptedIn(cfg, repo);
    const r = await reconcileRepo({
      client: o.client(),
      queue: o.queue(),
      repo,
      repoCfg: config,
      dryRun: o.dryRun,
      recheck: () => isRepoActive(loadConfig(o.configPath), repo),
      log
    }).catch((err: unknown) => {
      if (err instanceof RateLimitError) return { actions: [], errors: [], aborted: false, rateLimitedUntil: err.resumeAt };
      throw err;
    });
    writes += o.dryRun ? 0 : r.actions.length;
    errors.push(...r.errors);
    for (const e of r.errors) log(`[github] error ${e}`);
    if (r.rateLimitedUntil) {
      log(`[github] rate limited; resuming at ${new Date(r.rateLimitedUntil).toISOString()}`);
      break;
    }
  }
  if (o.dryRun) log(JSON.stringify({ dryRun: true }));
  return { writes, errors };
}

export async function runSync(o: SyncRunOptions): Promise<void> {
  const log = o.log ?? ((l) => console.error(l));
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  if (o.watchSecs === undefined) {
    await runSyncCycle(o);
    return;
  }
  for (let n = 0; o.maxCycles === undefined || n < o.maxCycles; n++) {
    try {
      await runSyncCycle(o);
    } catch (err) {
      if (n === 0) throw err;
      log(`[github] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (o.maxCycles !== undefined && n + 1 >= o.maxCycles) break;
    await sleep(o.watchSecs * 1000);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === '-h' || cmd === '--help' || cmd === undefined) {
    console.log(USAGE);
    return;
  }
  if (cmd !== 'sync') {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  // `--watch` with no value means the 300 s default
  const args = rest.flatMap((a, i) =>
    a === '--watch' && (rest[i + 1] === undefined || rest[i + 1]?.startsWith('--')) ? [a, '300'] : [a]
  );
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      once: { type: 'boolean' },
      watch: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'github-config': { type: 'string' }
    }
  });
  let watchSecs: number | undefined;
  if (values.watch !== undefined && values.once !== true) {
    watchSecs = Number(values.watch);
    if (!Number.isFinite(watchSecs) || watchSecs < 30) {
      console.error('--watch must be a number of seconds >= 30');
      process.exitCode = 2;
      return;
    }
  }
  const configPath = resolveConfigPath(values['github-config']);
  try {
    let gh: GitHubClient | undefined;
    await runSync({
      configPath,
      repo: values.repo,
      dryRun: values['dry-run'] === true,
      watchSecs,
      client: () => (gh ??= new FetchGitHubClient()),
      queue: () => new QueueClient(readDiscovery())
    });
  } catch (err) {
    console.error('[github] fatal:', err instanceof Error ? err.message : String(err));
    process.exitCode = err instanceof NoTokenError || /not opted in|config/.test(String(err)) ? 2 : 1;
  }
}

const isEntry = (() => {
  const argv1 = process.argv[1];
  return argv1 ? import.meta.url === pathToFileURL(argv1).href : false;
})();

if (isEntry) {
  main().catch((err) => {
    console.error('[github] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
