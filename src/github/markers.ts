/** Hidden marker comments that make sync-back and ingest idempotent (design note §7). */

export type MarkerState = 'claimed' | 'done' | 'failed' | 'review-blocked' | 'pr';

export interface Marker {
  task: string;
  state: string;
  gen: string;
}

export function formatMarker(taskId: string, state: MarkerState, gen: number | string): string {
  return `<!-- hyperpanes:task=${taskId} state=${state} gen=${gen} -->`;
}

const MARKER_RE = /<!-- hyperpanes:task=(\S+) state=(\S+) gen=(\S+) -->/g;

export function parseMarkers(body: string): Marker[] {
  return [...body.matchAll(MARKER_RE)].map((m) => ({
    task: m[1] as string,
    state: m[2] as string,
    gen: m[3] as string
  }));
}
