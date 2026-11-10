import type { Task } from '../worker-pool/kinds.js';
import type { TasksListResult } from '../worker-pool/queue-client.js';

export interface TaskLister {
  list(queue: string, opts?: { after?: number }): Promise<Pick<TasksListResult, 'tasks'>>;
}

/** Every task in `queue`, any state, paged by the `seq` cursor. */
export async function listAllTasks(q: TaskLister, queue: string): Promise<Task[]> {
  const out: Task[] = [];
  let after = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await q.list(queue, after > 0 ? { after } : {});
    if (r.tasks.length === 0) break;
    out.push(...r.tasks);
    const next = Math.max(...r.tasks.map((t) => t.seq));
    if (next <= after) break;
    after = next;
  }
  return out;
}
