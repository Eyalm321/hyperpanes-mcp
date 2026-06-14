/**
 * HTTP client for the hyperpanes control server's **work-queue** routes
 * (`/queues` + `/tasks`, worker-pool phase-3). It is the queue analogue of
 * {@link ControlClient}: one instance wraps one discovered `{ port, token }` and
 * speaks the CANONICAL wire format — the Rust `WorkQueue`'s serialized JSON
 * (camelCase, epoch-ms numbers, FLATTENED lease `claimedBy`/`fencingToken`/
 * `visibilityDeadline`). Every {@link Task} it returns is passed through verbatim.
 *
 * The controller uses this (with the master token) to enqueue a backlog, claim
 * tasks (competing consumers), heartbeat long leases (`extend`), and report
 * terminal state (`ack`/`nack`) carrying the task's own `fencingToken` — the
 * optimistic-concurrency guard that fences out a stale worker (HTTP 409).
 */

import { ControlUnavailableError, type Discovery } from '../control/discovery.js';
import type { EnqueueRequest, Task, TaskState } from './kinds.js';

/** Queue depth by state (mirrors the Rust `Counts`). */
export interface QueueCounts {
  queued: number;
  claimed: number;
  done: number;
  failed: number;
  dead: number;
}

export interface QueueSummary {
  queue: string;
  counts: QueueCounts;
}

export interface EnqueueResult {
  ok: boolean;
  id: string;
  seq: number;
}

/** Result of a lease-guarded op (`ack`/`nack`/`extend`). */
export interface LeaseResult {
  ok: boolean;
  state?: TaskState;
  visibilityDeadline?: number;
}

export interface TasksListResult {
  queue: string;
  tasks: Task[];
  counts: QueueCounts;
  latestSeq: number;
}

export interface ClaimOpts {
  /** Lease length for this claim; omit (or <= 0) to use the task's own visibility timeout. */
  leaseMs?: number;
  /** Prefetch up to N tasks in one call (default 1). */
  count?: number;
}

export interface NackOpts {
  /** `true` (default) ⇒ retry with backoff; `false` ⇒ give up now (→ failed). */
  requeue?: boolean;
  error?: string;
  /** Override the computed backoff for this requeue (ms). */
  delayMs?: number;
}

export interface ListOpts {
  after?: number;
  state?: TaskState;
  limit?: number;
}

export class QueueClient {
  private readonly base: string;
  private readonly auth: Record<string, string>;

  constructor(public readonly discovery: Discovery) {
    this.base = `http://127.0.0.1:${discovery.port}`;
    this.auth = { authorization: `Bearer ${discovery.token}` };
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(this.base + path, {
        ...init,
        headers: { ...this.auth, ...(init?.headers ?? {}) }
      });
    } catch (err) {
      throw new ControlUnavailableError(
        `cannot reach hyperpanes control API at ${this.base} (${String(err)}). Is the app still running with control enabled?`
      );
    }
  }

  private async postJson(path: string, body: unknown): Promise<Response> {
    return this.req(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  // ---- producer edge ----
  async enqueue(queue: string, req: EnqueueRequest): Promise<EnqueueResult> {
    const r = await this.postJson(`/queues/${encodeURIComponent(queue)}/tasks`, req);
    if (r.status === 403) throw new Error(`queue out of scope: ${queue}`);
    if (!r.ok) throw new Error(`enqueue ${queue} -> ${r.status}`);
    return (await r.json()) as EnqueueResult;
  }

  // ---- competing consumers ----
  /** Claim the next task(s) off `queue` for `worker`; an empty queue yields `[]` (not an error). */
  async claim(queue: string, worker: string, opts: ClaimOpts = {}): Promise<Task[]> {
    const body = {
      worker,
      ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {})
    };
    const r = await this.postJson(`/queues/${encodeURIComponent(queue)}/claim`, body);
    if (r.status === 403) throw new Error(`queue out of scope: ${queue}`);
    if (!r.ok) throw new Error(`claim ${queue} -> ${r.status}`);
    const out = (await r.json()) as { ok: boolean; tasks?: Task[] };
    return out.tasks ?? [];
  }

  // ---- lease-guarded completion (carry the task's fencingToken) ----
  async ack(taskId: string, fencingToken: number, result?: string): Promise<LeaseResult> {
    const r = await this.postJson(`/tasks/${encodeURIComponent(taskId)}/ack`, {
      fencingToken,
      ...(result !== undefined ? { result } : {})
    });
    return this.leaseResult(r, 'ack', taskId);
  }

  async nack(taskId: string, fencingToken: number, opts: NackOpts = {}): Promise<LeaseResult> {
    const r = await this.postJson(`/tasks/${encodeURIComponent(taskId)}/nack`, {
      fencingToken,
      ...(opts.requeue !== undefined ? { requeue: opts.requeue } : {}),
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {})
    });
    return this.leaseResult(r, 'nack', taskId);
  }

  /** Heartbeat: extend the current lease by `extraMs` so a long task isn't reaped. */
  async extend(taskId: string, fencingToken: number, extraMs: number): Promise<LeaseResult> {
    const r = await this.postJson(`/tasks/${encodeURIComponent(taskId)}/extend`, {
      fencingToken,
      extraMs
    });
    return this.leaseResult(r, 'extend', taskId);
  }

  // ---- reads ----
  async get(taskId: string): Promise<Task | null> {
    const r = await this.req(`/tasks/${encodeURIComponent(taskId)}`);
    if (r.status === 404) return null;
    if (r.status === 403) throw new Error(`queue out of scope for task ${taskId}`);
    if (!r.ok) throw new Error(`get task ${taskId} -> ${r.status}`);
    return (await r.json()) as Task;
  }

  async list(queue: string, opts: ListOpts = {}): Promise<TasksListResult> {
    const params = new URLSearchParams();
    if (opts.after && opts.after > 0) params.set('after', String(Math.floor(opts.after)));
    if (opts.state) params.set('state', opts.state);
    if (opts.limit && opts.limit > 0) params.set('limit', String(Math.floor(opts.limit)));
    const q = params.toString();
    const r = await this.req(`/queues/${encodeURIComponent(queue)}/tasks${q ? `?${q}` : ''}`);
    if (r.status === 403) throw new Error(`queue out of scope: ${queue}`);
    if (!r.ok) throw new Error(`list ${queue} -> ${r.status}`);
    return (await r.json()) as TasksListResult;
  }

  async queues(): Promise<QueueSummary[]> {
    const r = await this.req('/queues');
    if (!r.ok) throw new Error(`queues -> ${r.status}`);
    const out = (await r.json()) as { queues?: QueueSummary[] };
    return out.queues ?? [];
  }

  private async leaseResult(r: Response, op: string, taskId: string): Promise<LeaseResult> {
    if (r.status === 404) throw new Error(`no such task: ${taskId}`);
    // 409 = the optimistic-concurrency guard: this fencing token was superseded
    // (the lease was reaped + re-claimed). The caller must NOT treat the work as
    // completed — another worker now owns the task.
    if (r.status === 409) throw new Error(`stale lease for task ${taskId} (fencing token superseded)`);
    if (r.status === 403) throw new Error(`queue out of scope for task ${taskId}`);
    if (!r.ok) throw new Error(`${op} ${taskId} -> ${r.status}`);
    return (await r.json()) as LeaseResult;
  }
}
