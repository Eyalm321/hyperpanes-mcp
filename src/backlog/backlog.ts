/**
 * Backlog GENERATOR (worker-pool phase 7) — the producer edge of the pipeline.
 *
 * It fans out a set of {@link BacklogSource}s, normalizes every emitted {@link TaskInput}
 * into a canonical {@link EnqueueRequest} (the same shape the controller produces), and
 * either PRINTS them (`--dry-run`, no I/O) or POSTs each one through the existing
 * {@link QueueClient.enqueue} route. Sources are opaque to the generator, so adding a
 * new signal (failing tests, GitHub issues, …) never touches this orchestration.
 */

import { toEnqueueRequest, type EnqueueRequest } from '../worker-pool/kinds.js';
import type { QueueClient, EnqueueResult } from '../worker-pool/queue-client.js';
import type { BacklogSource } from './sources.js';

export interface GenerateOptions {
  /** Default base ref baked into each task whose input omits one. */
  base?: string;
  /** Drop inputs whose `dedupeKey` (or encoded payload) collides within this batch. */
  dedupe?: boolean;
}

/** A normalized request paired with the source that produced it (for logging). */
export interface BacklogItem {
  source: string;
  request: EnqueueRequest;
}

export interface GenerateResult {
  items: BacklogItem[];
  /** Per-source counts, for human-readable summaries. */
  bySource: Record<string, number>;
}

/**
 * Collect every source, normalize, and (optionally) de-duplicate within the batch.
 * Pure — no queue, no network — so `--dry-run` and the live path share it.
 */
export async function generateBacklog(
  sources: BacklogSource[],
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const base = opts.base ?? 'HEAD';
  const dedupe = opts.dedupe ?? true;
  const items: BacklogItem[] = [];
  const bySource: Record<string, number> = {};
  const seen = new Set<string>();

  for (const source of sources) {
    const inputs = await source.collect();
    let count = 0;
    for (const input of inputs) {
      const request = toEnqueueRequest(input, base);
      if (dedupe) {
        const key = request.dedupeKey ?? `payload:${request.payload}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      items.push({ source: source.name, request });
      count++;
    }
    bySource[source.name] = (bySource[source.name] ?? 0) + count;
  }

  return { items, bySource };
}

export interface EnqueueOutcome {
  ok: boolean;
  source: string;
  request: EnqueueRequest;
  result?: EnqueueResult;
  error?: string;
}

/**
 * POST a generated backlog onto `queue` via the queue client. Each enqueue is
 * independent: one failure doesn't abort the rest, it's recorded and the batch
 * continues, so a transient error can't strand the remaining tasks.
 */
export async function enqueueBacklog(
  client: Pick<QueueClient, 'enqueue'>,
  queue: string,
  result: GenerateResult
): Promise<EnqueueOutcome[]> {
  const out: EnqueueOutcome[] = [];
  for (const { source, request } of result.items) {
    try {
      const res = await client.enqueue(queue, request);
      out.push({ ok: true, source, request, result: res });
    } catch (err) {
      out.push({ ok: false, source, request, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
