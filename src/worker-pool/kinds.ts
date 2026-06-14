/**
 * Canonical `Task` schema — the one record that flows across all worker-pool
 * layers (backlog → queue → controller → worker → CI). Mirrors doc 05
 * (`05-task-schema.md`): opaque at storage, typed at the edges.
 *
 * PHASE-3 INTEGRATION — the CANONICAL wire format is the Rust work queue's
 * serialized JSON (`rs/crates/core/src/control/work.rs`): **camelCase** keys,
 * **epoch-ms number** timestamps, and a **FLATTENED lease** (`claimedBy` /
 * `fencingToken` / `visibilityDeadline` at the top level — never a nested `lease`
 * object), with unset optionals **omitted** entirely. {@link Task} below mirrors
 * that byte-for-byte so the controller's queue client can pass it through verbatim.
 *
 * The queue is GENERIC: it owns only lifecycle + lease + retry columns and treats
 * `payload` as an opaque string it never parses. The typed instruction the two
 * edges agree on (prompt/base/repo/source/…) rides INSIDE that `payload` string as
 * JSON — see {@link TaskSpec} / {@link encodeSpec} / {@link decodeSpec}.
 */

import { join } from 'node:path';
import { z } from 'zod';

/** Discriminator at the producer edge. The wire `Task.kind` is a free-form string
 *  (the queue stores it opaquely); these are the kinds this controller emits. */
export type TaskKind = 'ci_failure' | 'lint' | 'issue' | 'review' | 'manual';

/** Lifecycle state — OWNED by the L2 queue; the controller never writes it. */
export type TaskState = 'queued' | 'claimed' | 'done' | 'failed' | 'dead';

/**
 * The canonical queue record — EXACTLY the Rust `WorkQueue`'s serialized JSON
 * (camelCase, epoch-ms numbers, flattened lease, optionals omitted). Every field
 * here is queue-owned; the controller reads a claimed Task and reports terminal
 * state via `ack`/`nack` carrying the task's own `fencingToken`. `payload` is the
 * queue-opaque body (a JSON string) — decode it with {@link decodeSpec}.
 */
export interface Task {
  // ---- identity / columns (the queue owns + assigns) ----
  id: string; // uuid, queue-assigned, stable across retries — THE join key
  queue: string; // logical queue / namespace, e.g. "build"
  seq: number; // global monotonic id; doubles as the list cursor
  kind: string; // free-form discriminator (ci_failure | lint | issue | review | manual | …)
  title: string; // short; seeds pane label + PR title
  state: TaskState;
  payload: string; // OPAQUE body — JSON string the queue never parses (see TaskSpec)
  priority: number; // higher first
  attempts: number; // incremented on each claim
  maxAttempts: number; // dead-letter once attempts >= maxAttempts

  // ---- scheduling ----
  availableAt: number; // epoch ms; claimable only when availableAt <= now

  // ---- lease (FLATTENED, present only while claimed) ----
  claimedBy?: string; // worker identity
  fencingToken?: number; // monotonic fencing token for the current claim
  visibilityDeadline?: number; // epoch ms; reaped back to queued past this

  // ---- result / bookkeeping ----
  result?: string; // recorded on ack
  error?: string; // recorded on nack / dead-letter
  dedupeKey?: string; // optional idempotent-enqueue key

  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/**
 * The typed instruction the two edges agree on, carried INSIDE the queue-opaque
 * `Task.payload` string (doc 05: "typed at the edges"). The controller decodes it
 * after a claim to know what to run; the queue never sees these fields.
 */
export interface TaskSpec {
  prompt: string; // full agent instruction
  base: string; // branch/ref the worktree forks from
  repo?: string;
  source?: unknown; // provenance, queue-opaque, discriminated by kind
  payload?: unknown; // kind-specific structured data
}

/** A backlog item at the producer edge. Only `prompt` is required. */
export interface TaskInput {
  kind?: TaskKind;
  title?: string;
  priority?: number;
  repo?: string;
  base?: string;
  prompt: string;
  source?: unknown;
  payload?: unknown;
  dedupeKey?: string;
}

/** A normalized enqueue request: the queue columns + the encoded opaque payload.
 *  This is the body the queue client POSTs to `/queues/{queue}/tasks`. */
export interface EnqueueRequest {
  kind: TaskKind;
  title: string;
  priority: number;
  payload: string; // encodeSpec(TaskSpec)
  dedupeKey?: string;
}

/** The task frame the controller hands a worker (via the handshake file, not the bus). */
export interface DispatchedTask {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  base: string;
  branch: string;
  worktree: string;
}

export const TASK_KINDS: readonly TaskKind[] = ['ci_failure', 'lint', 'issue', 'review', 'manual'];

/** Producer-edge loader. Only `prompt` is strictly required; everything else defaults. */
const TaskInputSchema = z
  .object({
    kind: z.enum(TASK_KINDS).optional(),
    title: z.string().optional(),
    priority: z.number().optional(),
    repo: z.string().optional(),
    base: z.string().optional(),
    prompt: z.string().min(1),
    source: z.unknown().optional(),
    payload: z.unknown().optional(),
    dedupeKey: z.string().optional()
  })
  .passthrough();

/** The opaque-payload spec, parsed leniently (a foreign producer may omit fields). */
const TaskSpecSchema = z
  .object({
    prompt: z.string().optional(),
    base: z.string().optional(),
    repo: z.string().optional(),
    source: z.unknown().optional(),
    payload: z.unknown().optional()
  })
  .passthrough();

/** Serialize a {@link TaskSpec} into the queue-opaque `payload` string. */
export function encodeSpec(spec: TaskSpec): string {
  return JSON.stringify(spec);
}

/**
 * Decode the typed instruction from a claimed Task's opaque `payload`. A payload
 * that isn't a JSON object is treated as raw prompt text (a lenient edge), so the
 * worker always gets a usable `{ prompt, base }`.
 */
export function decodeSpec(task: Pick<Task, 'payload'>, fallbackBase = 'HEAD'): TaskSpec {
  const text = task.payload ?? '';
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return { prompt: text, base: fallbackBase };
  }
  const r = TaskSpecSchema.parse(parsed);
  return {
    prompt: r.prompt ?? '',
    base: r.base || fallbackBase,
    ...(r.repo !== undefined ? { repo: r.repo } : {}),
    ...(r.source !== undefined ? { source: r.source } : {}),
    ...(r.payload !== undefined ? { payload: r.payload } : {})
  };
}

/** Normalize a backlog item into an {@link EnqueueRequest} (columns + encoded payload). */
export function toEnqueueRequest(input: unknown, fallbackBase = 'HEAD'): EnqueueRequest {
  const r = TaskInputSchema.parse(input);
  const title = (r.title ?? firstLine(r.prompt)).trim() || firstLine(r.prompt).trim() || 'task';
  const spec: TaskSpec = {
    prompt: r.prompt,
    base: r.base ?? fallbackBase,
    ...(r.repo !== undefined ? { repo: r.repo } : {}),
    ...(r.source !== undefined ? { source: r.source } : {}),
    ...(r.payload !== undefined ? { payload: r.payload } : {})
  };
  return {
    kind: r.kind ?? 'manual',
    title,
    priority: r.priority ?? 50,
    payload: encodeSpec(spec),
    ...(r.dedupeKey !== undefined ? { dedupeKey: r.dedupeKey } : {})
  };
}

/** Parse a `--tasks` JSON file body (a bare array or `{ tasks: [...] }`) into requests. */
export function toEnqueueRequests(raw: unknown, fallbackBase = 'HEAD'): EnqueueRequest[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : null;
  if (!arr) throw new Error('tasks file must be a JSON array or { "tasks": [...] }');
  return arr.map((t) => toEnqueueRequest(t, fallbackBase));
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
