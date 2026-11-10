#!/usr/bin/env node
/**
 * CLI for the backlog generator (worker-pool phase 7).
 *
 *   node dist/backlog/cli.js [--dry-run] [--todos] [--tasks <file>] [options]
 *
 * It assembles a set of backlog SOURCES — a TODO/FIXME code scan (`--todos`) and/or an
 * explicit JSON list (`--tasks <file>`) — normalizes every emitted task into a canonical
 * {@link EnqueueRequest}, and either PRINTS them (`--dry-run`, needs no running app) or
 * POSTs each through the control server's `/queues/{queue}/tasks` route via the existing
 * {@link QueueClient}. New sources (failing tests, GitHub issues, …) plug in with no CLI
 * change.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readDiscovery } from '../control/discovery.js';
import { QueueClient } from '../worker-pool/queue-client.js';
import { generateBacklog, enqueueBacklog, type GenerateResult } from './backlog.js';
import { FetchGitHubClient } from '../github/client.js';
import { resolveConfigPath } from '../github/config.js';
import { runGithubIngest } from '../github/ingest.js';
import { todoSource, jsonFileSource, type BacklogSource } from './sources.js';

const USAGE = `worker-pool backlog generator

Usage:
  node dist/backlog/cli.js [--dry-run] [--todos] [--tasks <file>] [options]

Sources (combine freely; at least one is required):
  --todos                  Scan the repo for TODO/FIXME comments (git grep)
  --tasks <file>           JSON file: an array of tasks, or { "tasks": [...] }
  --github-issues <r|.>    Open issues labelled for agents in <owner/repo> ('.' = cwd's origin).
                           Repo must be opted in (see docs/github-sources.md); the repo's
                           configured queue and base are used, and it can't be combined
                           with other sources.
  --github-ci <r|.>        Failed GitHub Actions runs in <owner/repo> -> ci_failure tasks. Needs
                           ci.enabled in the repo's config. Combine with --github-issues only
                           for the same repo.

Options:
  --dry-run                Print the Tasks that would be enqueued, without POSTing
  --repo <path>            Repo to scan for --todos               (default: cwd)
  --queue <name>           Work queue to enqueue into             (env HP_QUEUE, default "default")
  --base <ref>             Default base ref baked into each task  (env HP_BASE, default "HEAD")
  --markers <a,b>          TODO markers to scan for               (default "TODO,FIXME")
  --limit <n>              Cap tasks emitted by the TODO scan
  --label <name>           Trigger label for --github-issues      (default from config)
  --github-config <path>   GitHub opt-in config (env HP_GITHUB_CONFIG)
  --no-dedupe              Keep within-batch duplicate tasks
  -h, --help               Show this help

A task input is { "prompt", "kind"?, "title"?, "priority"?, "base"?, "dedupeKey"? }.
Only prompt is required; the QUEUE assigns the id on enqueue.`;

export interface BacklogCliConfig {
  dryRun: boolean;
  todos: boolean;
  tasksFile?: string;
  repo: string;
  queue: string;
  base: string;
  markers: string[];
  limit?: number;
  dedupe: boolean;
}

export function configFromArgs(values: Record<string, string | boolean | undefined>): BacklogCliConfig {
  const env = process.env;
  const cfg: BacklogCliConfig = {
    dryRun: values['dry-run'] === true,
    todos: values.todos === true,
    repo: typeof values.repo === 'string' ? values.repo : process.cwd(),
    queue: typeof values.queue === 'string' ? values.queue : env.HP_QUEUE || 'default',
    base: typeof values.base === 'string' ? values.base : env.HP_BASE || 'HEAD',
    markers:
      typeof values.markers === 'string'
        ? values.markers.split(',').map((s) => s.trim()).filter(Boolean)
        : ['TODO', 'FIXME'],
    dedupe: values['no-dedupe'] !== true
  };
  if (typeof values.tasks === 'string') cfg.tasksFile = values.tasks;
  if (typeof values.limit === 'string') {
    const n = Number(values.limit);
    if (Number.isFinite(n) && n > 0) cfg.limit = n;
  }
  return cfg;
}

/** Assemble the active sources from the CLI config (the only place flags → sources). */
export function buildSources(cfg: BacklogCliConfig): BacklogSource[] {
  const sources: BacklogSource[] = [];
  if (cfg.todos) {
    sources.push(
      todoSource({
        repo: cfg.repo,
        markers: cfg.markers,
        base: cfg.base,
        ...(cfg.limit !== undefined ? { limit: cfg.limit } : {})
      })
    );
  }
  if (cfg.tasksFile) {
    const raw = JSON.parse(readFileSync(cfg.tasksFile, 'utf8')) as unknown;
    sources.push(jsonFileSource(raw));
  }
  return sources;
}

function printDryRun(cfg: BacklogCliConfig, gen: GenerateResult): void {
  console.error(
    `[backlog] DRY RUN queue=${cfg.queue} base=${cfg.base} tasks=${gen.items.length} ` +
      `bySource=${JSON.stringify(gen.bySource)}`
  );
  for (const { source, request } of gen.items) {
    console.error(` - [${source}] (${request.kind}) "${request.title}" p=${request.priority}`);
  }
  console.log(
    JSON.stringify(
      { dryRun: true, queue: cfg.queue, bySource: gen.bySource, tasks: gen.items.map((i) => i.request) },
      null,
      2
    )
  );
}

async function runLive(cfg: BacklogCliConfig, gen: GenerateResult): Promise<void> {
  const client = new QueueClient(readDiscovery());
  console.error(`[backlog] enqueueing ${gen.items.length} task(s) onto queue=${cfg.queue}`);
  const outcomes = await enqueueBacklog(client, cfg.queue, gen);
  const ok = outcomes.filter((o) => o.ok).length;
  for (const o of outcomes) {
    console.error(
      ` - [${o.source}] ${o.ok ? `OK id=${o.result?.id} seq=${o.result?.seq}` : `FAIL ${o.error}`} "${o.request.title}"`
    );
  }
  console.error(`[backlog] enqueued ${ok}/${outcomes.length}`);
  console.log(JSON.stringify(outcomes, null, 2));
  process.exitCode = ok === outcomes.length ? 0 : 1;
}

async function runGithubIngestCli(
  issuesArg: string | undefined,
  ciArg: string | undefined,
  label: string | undefined,
  configFlag: string | undefined,
  dryRun: boolean
): Promise<void> {
  try {
    const repoArg = (issuesArg ?? ciArg) as string;
    const r = await runGithubIngest({
      repoArg,
      label,
      ci: ciArg !== undefined,
      issues: issuesArg !== undefined,
      configPath: resolveConfigPath(configFlag),
      dryRun,
      client: () => new FetchGitHubClient(),
      queue: () => new QueueClient(readDiscovery())
    });
    const summary = {
      dryRun,
      repo: r.repo,
      queue: r.queue,
      disabled: r.disabled,
      queueChecked: r.queueChecked,
      decisions: r.decisions.map((d) => ({ number: d.number, action: d.action, ...(d.reason ? { reason: d.reason } : {}) })),
      ciDecisions: r.ciDecisions.map((d) => ({ runId: d.runId, action: d.action, ...(d.reason ? { reason: d.reason } : {}) })),
      ...(dryRun ? { tasks: r.gen?.items.map((i) => i.request) } : { outcomes: r.outcomes })
    };
    console.log(JSON.stringify(summary, null, 2));
    if (r.outcomes?.some((o) => !o.ok)) process.exitCode = 1;
  } catch (err) {
    console.error('[backlog] fatal:', err instanceof Error ? err.message : String(err));
    process.exitCode = /not opted in|config|token/.test(String(err)) ? 2 : 1;
  }
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      todos: { type: 'boolean' },
      tasks: { type: 'string' },
      repo: { type: 'string' },
      queue: { type: 'string' },
      base: { type: 'string' },
      markers: { type: 'string' },
      'github-issues': { type: 'string' },
      'github-ci': { type: 'string' },
      label: { type: 'string' },
      'github-config': { type: 'string' },
      limit: { type: 'string' },
      'no-dedupe': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const cfg = configFromArgs(values);
  const ghIssues = typeof values['github-issues'] === 'string' ? values['github-issues'] : undefined;
  const ghCi = typeof values['github-ci'] === 'string' ? values['github-ci'] : undefined;
  if (ghIssues !== undefined || ghCi !== undefined) {
    if (cfg.todos || cfg.tasksFile) {
      console.error('[backlog] --github-issues/--github-ci cannot be combined with --todos/--tasks');
      process.exitCode = 2;
      return;
    }
    if (ghIssues !== undefined && ghCi !== undefined && ghIssues !== ghCi) {
      console.error('[backlog] --github-issues and --github-ci must name the same repo');
      process.exitCode = 2;
      return;
    }
    await runGithubIngestCli(ghIssues, ghCi, values.label, values['github-config'], cfg.dryRun);
    return;
  }
  const sources = buildSources(cfg);
  if (sources.length === 0) {
    console.error('[backlog] no sources selected — pass --todos and/or --tasks <file> (see --help)');
    process.exitCode = 2;
    return;
  }

  const gen = await generateBacklog(sources, { base: cfg.base, dedupe: cfg.dedupe });

  if (cfg.dryRun) {
    printDryRun(cfg, gen);
    return;
  }
  await runLive(cfg, gen);
}

/** Run `main()` only when executed as the entry point — never on import (tests). */
const isEntry = (() => {
  const argv1 = process.argv[1];
  return argv1 ? import.meta.url === pathToFileURL(argv1).href : false;
})();

if (isEntry) {
  main().catch((err) => {
    console.error('[backlog] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
