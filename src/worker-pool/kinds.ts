/**
 * Canonical `Task` schema — the one record that flows across all worker-pool
 * layers (backlog → queue → controller → worker → CI). Mirrors doc 05
 * (`05-task-schema.md`): opaque at storage, typed at the edges.
 *
 * This is the single shared module the two *edges* — the backlog-generator that
 * emits a Task and the worker that executes it — agree on, keyed by `kind`. The
 * Phase-1 controller (this codebase) reads the instruction fields, OWNS
 * `worktree`/`branch` (placement), and leaves `state`/`lease`/`attempts` (the
 * queue's column-group) untouched. Pure: no I/O, so the helpers are unit-testable.
 */

import { join } from 'node:path';
import { z } from 'zod';

/** Discriminator. `source.kind == kind` for the discriminated kinds (doc 05 invariant). */
export type TaskKind = 'ci_failure' | 'lint' | 'issue' | 'review' | 'manual';

/** Lifecycle state — OWNED by the L2 queue; the controller never writes it. */
export type TaskState = 'queued' | 'claimed' | 'done' | 'failed' | 'dead';

/** Terminal outcome the worker/CI write back. */
export type TaskOutcome = 'success' | 'failed' | 'abandoned';

export interface Lease {
  worker_id: string;
  fencing_token: number;
  expires_at: string;
}

export interface PrRef {
  number: number;
  url: string;
  head_sha: string;
}

export interface TaskResult {
  outcome: TaskOutcome | null;
  summary: string | null;
  error: string | null;
}

/** The canonical record. Fields the Phase-1 controller does not own are optional. */
export interface Task {
  // ---- identity ----
  id: string; // ULID-ish, queue-assigned, stable across retries — THE join key
  kind: TaskKind;
  title: string; // short; seeds pane label + PR title
  priority: number; // higher first

  // ---- instruction (the worker reads this) ----
  repo?: string;
  base: string; // branch/ref the worktree forks from
  prompt: string; // full agent instruction

  // ---- provenance / kind-specific (queue-opaque, discriminated by .kind) ----
  source?: unknown;
  payload?: unknown;

  // ---- queue/lease state (L2 OWNS — the controller does not write these) ----
  state?: TaskState;
  attempts?: number;
  max_attempts?: number;
  not_before?: string | null;
  lease?: Lease | null;

  // ---- placement (controller SETS) ----
  worktree?: string | null;
  branch?: string | null;

  // ---- result (worker / CI write back) ----
  pr?: PrRef | null;
  result?: TaskResult | null;

  created_at?: string;
  updated_at?: string;
}

export const TASK_KINDS: readonly TaskKind[] = ['ci_failure', 'lint', 'issue', 'review', 'manual'];

/**
 * Lenient loader schema. Only `id` + `prompt` are strictly required to dispatch a
 * task; everything else gets a sane default in {@link normalizeTask}. `source` and
 * `payload` are passed through verbatim (queue-opaque) — never parsed here.
 */
export const RawTaskSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(TASK_KINDS).optional(),
    title: z.string().optional(),
    priority: z.number().optional(),
    repo: z.string().optional(),
    base: z.string().optional(),
    prompt: z.string().min(1),
    source: z.unknown().optional(),
    payload: z.unknown().optional()
  })
  .passthrough();

export type RawTask = z.infer<typeof RawTaskSchema>;

/** Fill in the defaults the controller needs, leaving queue-owned fields untouched. */
export function normalizeTask(raw: unknown, fallbackBase = 'HEAD'): Task {
  const r = RawTaskSchema.parse(raw);
  const title = (r.title ?? firstLine(r.prompt)).trim() || r.id;
  return {
    id: r.id,
    kind: r.kind ?? 'manual',
    title,
    priority: r.priority ?? 50,
    ...(r.repo !== undefined ? { repo: r.repo } : {}),
    base: r.base ?? fallbackBase,
    prompt: r.prompt,
    ...(r.source !== undefined ? { source: r.source } : {}),
    ...(r.payload !== undefined ? { payload: r.payload } : {})
  };
}

/** Parse a `--tasks` JSON file body: either a bare array or `{ tasks: [...] }`. */
export function normalizeTasks(raw: unknown, fallbackBase = 'HEAD'): Task[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : null;
  if (!arr) throw new Error('tasks file must be a JSON array or { "tasks": [...] }');
  return arr.map((t) => normalizeTask(t, fallbackBase));
}

const SLUG_FALLBACK = 'task';

/** Lowercase kebab slug, bounded length — for branch names and fs paths. */
export function slugify(input: string, max = 40): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || SLUG_FALLBACK;
}

/** A task id reduced to characters safe in a git ref component. */
function safeRef(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.-]+/, '') || SLUG_FALLBACK;
}

/** A task id reduced to characters safe in a filesystem name. */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_') || SLUG_FALLBACK;
}

/**
 * The worker's branch — a PURE function of the task id (+ a readable title slug),
 * so re-running a task always touches the SAME branch (doc 05 idempotency
 * invariant). The slug is cosmetic; the id is what makes it stable.
 */
export function deriveBranch(task: Pick<Task, 'id' | 'title'>): string {
  return `agent/${safeRef(task.id)}-${slugify(task.title)}`;
}

/** The isolated checkout path for a task within a pool. */
export function worktreePath(root: string, poolId: string, task: Pick<Task, 'id'>): string {
  return join(root, `${poolId}-${safeName(task.id)}`);
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return (nl >= 0 ? s.slice(0, nl) : s).slice(0, 80);
}
