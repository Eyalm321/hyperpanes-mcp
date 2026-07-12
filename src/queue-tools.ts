/**
 * MCP tools for the hyperpanes **work-queue** (the durable job queue exposed by the control
 * server's `/queues` + `/tasks` routes). These wrap {@link QueueClient} so an MCP client can
 * enqueue, claim (competing consumers), complete (ack/nack), heartbeat (extend), and inspect
 * tasks — the same surface the worker-pool controller uses, but driven one call at a time.
 *
 * Lease model: a `claim` hands back each task's `fencingToken` + `visibilityDeadline`. Every
 * completion (`ack`/`nack`/`extend`) MUST carry that `fencingToken` (optimistic lease fencing —
 * a stale worker whose lease was reaped can't clobber a task another worker now owns).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readDiscovery, controlFilePath } from './control/discovery.js';
import { QueueClient } from './worker-pool/queue-client.js';

function json(data: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Open a queue client from the current control.json (throws ControlUnavailable). */
function openQueue(): QueueClient {
  return new QueueClient(readDiscovery());
}

/** Wrap a queue operation, turning unavailability/errors into tool error results. */
async function run(fn: (q: QueueClient) => Promise<unknown>) {
  let q: QueueClient;
  try {
    q = openQueue();
  } catch (err) {
    return json({ ok: false, error: errMessage(err), controlFile: controlFilePath() }, true);
  }
  try {
    return json(await fn(q));
  } catch (err) {
    return json({ ok: false, error: errMessage(err) }, true);
  }
}

/** Register the work-queue tools on an McpServer (call after registerControlTools). */
export function registerQueueTools(server: McpServer): void {
  // ---- list_queues -----------------------------------------------------
  server.registerTool(
    'list_queues',
    {
      title: 'List work queues',
      description:
        'List every work queue and its depth (pending/claimed/etc. counts). Scope-filtered to the token. The work queue is the durable job queue behind the control server; use it to fan work out to competing workers.'
    },
    async () => run(async (q) => ({ ok: true, queues: await q.queues() }))
  );

  // ---- enqueue_task ----------------------------------------------------
  server.registerTool(
    'enqueue_task',
    {
      title: 'Enqueue a task',
      description:
        'Append a task to a work queue (created on first use). `payload` is the opaque task body (often JSON) a worker reads after claiming. Optional: `kind`/`title` for triage, `priority` (higher runs sooner), `maxAttempts` (auto re-queue up to N on nack/lease-expiry), `visibilityTimeoutMs` (default lease), `delayMs` (schedule into the future), `dedupeKey` (collapse duplicate enqueues), and — for the goals system — `goalId` (tag the task to a goal) and `dependsOn` (task ids that must all reach `done` before this task becomes claimable; a DAG gate). Returns the new task `id` + `seq`.',
      inputSchema: {
        queue: z.string().describe('queue name (created on first enqueue)'),
        payload: z.string().describe('opaque task body the worker reads after claiming (often JSON)'),
        kind: z.string().optional().describe('free-form category for triage'),
        title: z.string().optional(),
        priority: z.number().int().optional().describe('higher = claimed sooner (default 0)'),
        maxAttempts: z.number().int().positive().optional().describe('re-queue up to N times (default 5)'),
        visibilityTimeoutMs: z.number().int().positive().optional().describe('default lease length per claim'),
        delayMs: z.number().int().positive().optional().describe('delay before the task becomes claimable'),
        dedupeKey: z.string().optional().describe('collapse duplicate enqueues sharing this key'),
        goalId: z.string().optional().describe('goals system: tag this task to a goal'),
        dependsOn: z
          .array(z.string())
          .optional()
          .describe('goals system: task ids that must all be `done` before this task is claimable (DAG gate)')
      }
    },
    async ({ queue, payload, kind, title, priority, maxAttempts, visibilityTimeoutMs, delayMs, dedupeKey, goalId, dependsOn }) =>
      run(async (q) =>
        ({
          ...(await q.enqueueRaw(queue, {
            payload,
            ...(kind !== undefined ? { kind } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(maxAttempts !== undefined ? { maxAttempts } : {}),
            ...(visibilityTimeoutMs !== undefined ? { visibilityTimeoutMs } : {}),
            ...(delayMs !== undefined ? { delayMs } : {}),
            ...(dedupeKey !== undefined ? { dedupeKey } : {}),
            ...(goalId !== undefined ? { goalId } : {}),
            ...(dependsOn !== undefined ? { dependsOn } : {})
          }))
        }))
  );

  // ---- claim_task ------------------------------------------------------
  server.registerTool(
    'claim_task',
    {
      title: 'Claim task(s)',
      description:
        'Claim the next task(s) off a queue for `worker` (competing consumers — each task goes to exactly one claimer). An empty queue returns `{tasks:[]}` (not an error). Each returned task carries a `fencingToken` and `visibilityDeadline` — keep them: ack/nack/extend need the token, and the task returns to the queue if you do not ack/extend before the deadline. `count` prefetches several; `leaseMs` overrides the task default lease.',
      inputSchema: {
        queue: z.string(),
        worker: z.string().describe('a stable id for this worker (appears in the task as claimedBy)'),
        leaseMs: z.number().int().positive().optional().describe('lease length; omit to use the task default'),
        count: z.number().int().positive().optional().describe('prefetch up to N tasks (default 1)')
      }
    },
    async ({ queue, worker, leaseMs, count }) =>
      run(async (q) => ({ ok: true, tasks: await q.claim(queue, worker, { leaseMs, count }) }))
  );

  // ---- ack_task --------------------------------------------------------
  server.registerTool(
    'ack_task',
    {
      title: 'Ack (complete) a task',
      description:
        'Mark a claimed task done. Must carry the `fencingToken` from the claim (lease fencing). `result` is an optional stored outcome string.',
      inputSchema: {
        taskId: z.string(),
        fencingToken: z.number().int().describe('the token from the claim (lease fencing)'),
        result: z.string().optional()
      }
    },
    async ({ taskId, fencingToken, result }) =>
      run(async (q) => ({ ...(await q.ack(taskId, fencingToken, result)) }))
  );

  // ---- nack_task -------------------------------------------------------
  server.registerTool(
    'nack_task',
    {
      title: 'Nack (fail/retry) a task',
      description:
        'Report a claimed task as failed. By default it is re-queued until maxAttempts is exhausted (then it lands in `dead`). Must carry the claim `fencingToken`. `delayMs` backs off the retry; `requeue:false` fails it immediately without retrying.',
      inputSchema: {
        taskId: z.string(),
        fencingToken: z.number().int(),
        error: z.string().optional().describe('failure reason to store'),
        requeue: z.boolean().optional().describe('false = fail now without retrying (default true)'),
        delayMs: z.number().int().nonnegative().optional().describe('back off this long before the retry')
      }
    },
    async ({ taskId, fencingToken, error, requeue, delayMs }) =>
      run(async (q) => ({ ...(await q.nack(taskId, fencingToken, { error, requeue, delayMs })) }))
  );

  // ---- extend_task -----------------------------------------------------
  server.registerTool(
    'extend_task',
    {
      title: 'Extend a task lease',
      description:
        'Heartbeat a long-running task: extend its lease by `extraMs` so it is not reaped and handed to another worker. Must carry the claim `fencingToken`.',
      inputSchema: {
        taskId: z.string(),
        fencingToken: z.number().int(),
        extraMs: z.number().int().positive().describe('extend the lease by this many ms')
      }
    },
    async ({ taskId, fencingToken, extraMs }) =>
      run(async (q) => ({ ...(await q.extend(taskId, fencingToken, extraMs)) }))
  );

  // ---- get_task --------------------------------------------------------
  server.registerTool(
    'get_task',
    {
      title: 'Get a task',
      description: 'Fetch one task by id (state, payload, attempts, lease, timestamps). Returns task:null if it does not exist.',
      inputSchema: { taskId: z.string() }
    },
    async ({ taskId }) => run(async (q) => ({ ok: true, task: await q.get(taskId) }))
  );

  // ---- list_tasks ------------------------------------------------------
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks in a queue',
      description:
        'List/inspect tasks in a queue. Optional `state` filter (queued/claimed/done/failed/dead), `after` (seq cursor — pass a prior result\'s latest seq to page) and `limit` (default 100, max 1000). Returns the tasks plus per-state counts.',
      inputSchema: {
        queue: z.string(),
        state: z.enum(['queued', 'claimed', 'done', 'failed', 'dead']).optional(),
        after: z.number().int().nonnegative().optional().describe('seq cursor for paging'),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ queue, state, after, limit }) =>
      run(async (q) => ({ ok: true, ...(await q.list(queue, { state, after, limit })) }))
  );

  // ---- purge_queue -----------------------------------------------------
  server.registerTool(
    'purge_queue',
    {
      title: 'Purge terminal tasks',
      description:
        'Drop TERMINAL tasks (done/failed/dead) from a queue for retention/cleanup. In-flight (queued/claimed) tasks are kept. Returns how many were removed.',
      inputSchema: { queue: z.string() }
    },
    async ({ queue }) => run(async (q) => ({ ok: true, ...(await q.purge(queue)) }))
  );
}
