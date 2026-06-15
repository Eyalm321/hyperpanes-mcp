/**
 * Backlog SOURCES (worker-pool phase 7) — each source ingests some external signal
 * and emits canonical {@link TaskInput}s (the producer-edge shape from `kinds.ts`).
 * The backlog generator ({@link generateBacklog}) fans these out, normalizes each
 * into an {@link EnqueueRequest}, and either prints them (`--dry-run`) or POSTs them
 * through the existing {@link QueueClient}.
 *
 * Every source returns `TaskInput[]` and is otherwise opaque to the generator, so a
 * new source (e.g. a failing-test ingester) drops in by implementing {@link BacklogSource}
 * with no change to the orchestration. `source` provenance rides into the queue-opaque
 * payload verbatim, discriminated by `kind` (doc 05).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskInput } from '../worker-pool/kinds.js';

const execFileP = promisify(execFile);

/** A backlog producer: turns some signal into canonical task inputs. */
export interface BacklogSource {
  /** Stable id for logs / provenance. */
  readonly name: string;
  collect(): Promise<TaskInput[]>;
}

// ---------------------------------------------------------------------------
// Source 1 — TODO/FIXME code scan
// ---------------------------------------------------------------------------

/** One TODO/FIXME hit discovered by the scan. */
export interface TodoHit {
  file: string;
  line: number;
  /** The marker that matched, e.g. `TODO` / `FIXME`. */
  marker: string;
  /** The comment text after the marker. */
  text: string;
}

/** Pluggable scanner so tests inject hits instead of shelling out to git/grep. */
export type TodoScanner = (opts: { repo: string; markers: string[] }) => Promise<TodoHit[]>;

export interface TodoScanOptions {
  repo: string;
  /** Markers to hunt for (default TODO + FIXME). */
  markers?: string[];
  /** Cap the number of tasks emitted (avoid flooding the queue). */
  limit?: number;
  /** Branch/ref the generated worktrees fork from. */
  base?: string;
  /** Override the scanner (default {@link gitGrepScanner}). */
  scanner?: TodoScanner;
}

const TODO_LINE = /\b(TODO|FIXME)\b[:\s]*(.*)$/;

/**
 * Default scanner: `git grep -n` for the markers across tracked files (respects
 * .gitignore, no node_modules noise). Parses `path:line:content`. A repo with no
 * matches exits non-zero — that's an empty result, not an error.
 */
export const gitGrepScanner: TodoScanner = async ({ repo, markers }) => {
  const pattern = markers.join('|');
  let stdout = '';
  try {
    const r = await execFileP(
      'git',
      ['-C', repo, 'grep', '-n', '-I', '-E', pattern],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    stdout = r.stdout;
  } catch (err) {
    // git grep exits 1 when there are simply no matches — treat as empty.
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1) return [];
    if (typeof e.stdout === 'string') stdout = e.stdout;
    else throw err;
  }
  return parseGrepOutput(stdout);
};

/** Parse `path:line:content` grep output into structured {@link TodoHit}s. */
export function parseGrepOutput(stdout: string): TodoHit[] {
  const hits: TodoHit[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const first = raw.indexOf(':');
    const second = raw.indexOf(':', first + 1);
    if (first < 0 || second < 0) continue;
    const file = raw.slice(0, first);
    const line = Number(raw.slice(first + 1, second));
    const content = raw.slice(second + 1);
    const m = TODO_LINE.exec(content);
    if (!m || !Number.isFinite(line)) continue;
    hits.push({ file, line, marker: m[1] as string, text: (m[2] ?? '').trim() });
  }
  return hits;
}

/** Build the agent prompt for one TODO/FIXME hit. */
export function todoPrompt(hit: TodoHit): string {
  const desc = hit.text ? `: ${hit.text}` : '';
  return (
    `Resolve the ${hit.marker} comment at ${hit.file}:${hit.line}${desc}.\n\n` +
    `Implement the change the comment asks for (or, if it is stale, remove it and ` +
    `explain why), keeping the existing code style and tests passing.`
  );
}

/** Turn TODO/FIXME hits into canonical task inputs (kind `lint`). */
export function todoSource(opts: TodoScanOptions): BacklogSource {
  const markers = opts.markers ?? ['TODO', 'FIXME'];
  const scanner = opts.scanner ?? gitGrepScanner;
  return {
    name: 'todo-scan',
    async collect(): Promise<TaskInput[]> {
      const hits = await scanner({ repo: opts.repo, markers });
      const limited = opts.limit && opts.limit > 0 ? hits.slice(0, opts.limit) : hits;
      return limited.map((hit) => ({
        kind: 'lint' as const,
        title: `${hit.marker} ${hit.file}:${hit.line}`.slice(0, 80),
        prompt: todoPrompt(hit),
        ...(opts.base ? { base: opts.base } : {}),
        // stable id so re-running the scan idempotently re-enqueues the SAME task.
        dedupeKey: `todo:${hit.file}:${hit.line}:${hit.marker}`,
        source: { kind: 'todo', file: hit.file, line: hit.line, marker: hit.marker, text: hit.text }
      }));
    }
  };
}

// ---------------------------------------------------------------------------
// Source 2 — explicit list / JSON input
// ---------------------------------------------------------------------------

/**
 * Pass-through source for an explicit list of task inputs (e.g. parsed from a JSON
 * file, a `--tasks` flag, or a programmatic caller). Validation happens downstream
 * in `toEnqueueRequest`, so this just hands the raw inputs through.
 */
export function listSource(inputs: unknown[]): BacklogSource {
  return {
    name: 'explicit-list',
    collect(): Promise<TaskInput[]> {
      return Promise.resolve(inputs as TaskInput[]);
    }
  };
}

/** Parse a JSON file body (a bare array or `{ tasks: [...] }`) into a list source. */
export function jsonFileSource(raw: unknown): BacklogSource {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : null;
  if (!arr) throw new Error('tasks file must be a JSON array or { "tasks": [...] }');
  return listSource(arr);
}

// ---------------------------------------------------------------------------
// Source 3 (stub seam) — failing tests
// ---------------------------------------------------------------------------

/** One failing test the scan would turn into a fix task. */
export interface FailingTest {
  name: string;
  file?: string;
  message?: string;
}

/**
 * Failing-test source seam. The collector that produces {@link FailingTest}s (parsing a
 * JUnit/TAP report, a `vitest --reporter=json` run, etc.) is injected, so this module
 * stays free of any test-runner specifics — exactly the extension point doc 05 calls for.
 */
export function failingTestSource(
  collector: () => Promise<FailingTest[]>,
  opts: { base?: string } = {}
): BacklogSource {
  return {
    name: 'failing-tests',
    async collect(): Promise<TaskInput[]> {
      const failing = await collector();
      return failing.map((t) => ({
        kind: 'ci_failure' as const,
        title: `Fix failing test ${t.name}`.slice(0, 80),
        prompt:
          `The test \`${t.name}\`${t.file ? ` in ${t.file}` : ''} is failing` +
          `${t.message ? ` with:\n\n${t.message}\n\n` : '. '}` +
          `Diagnose the root cause and fix it so the test passes, without weakening the assertion.`,
        ...(opts.base ? { base: opts.base } : {}),
        dedupeKey: `failtest:${t.file ?? ''}:${t.name}`,
        source: { kind: 'failing_test', name: t.name, ...(t.file ? { file: t.file } : {}) }
      }));
    }
  };
}
