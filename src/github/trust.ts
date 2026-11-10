/** Trust checks (design note §4.2 + §4.3). */

import type { GitHubClient, IssueEvent, Permission } from './client.js';

export type TrustSkip = 'untrusted-labeler' | 'edited-after-label' | 'no-label-event';

export interface LabelEvent {
  /** The `labeled` event id — the generation `gen`. */
  id: number;
  actor: string;
  createdAt: string;
}

export type TrustResult = { ok: true; labelEvent: LabelEvent } | { ok: false; reason: TrustSkip };

const WRITERS: readonly Permission[] = ['admin', 'maintain', 'write'];

/** Per-run permission cache so one actor costs one API call. */
export function trustChecker(client: GitHubClient, repo: string, trustedActors: string[]) {
  const cache = new Map<string, Promise<boolean>>();
  const isTrusted = (login: string | undefined): Promise<boolean> => {
    if (!login) return Promise.resolve(false);
    const key = login.toLowerCase();
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        if (trustedActors.length > 0 && !trustedActors.some((a) => a.toLowerCase() === key)) return false;
        return WRITERS.includes(await client.getCollaboratorPermission(repo, login));
      })();
      cache.set(key, p);
    }
    return p;
  };

  return async function check(number: number, label: string): Promise<TrustResult> {
    const events = await client.listIssueEvents(repo, number);
    const labeled = events
      .filter((e) => e.event === 'labeled' && e.label?.toLowerCase() === label.toLowerCase())
      .sort((a, b) => a.id - b.id);
    const last = labeled[labeled.length - 1];
    if (!last) return { ok: false, reason: 'no-label-event' };
    if (!(await isTrusted(last.actor))) return { ok: false, reason: 'untrusted-labeler' };
    const labelEvent: LabelEvent = { id: last.id, actor: last.actor as string, createdAt: last.createdAt };

    const labelTime = Date.parse(last.createdAt);
    const info = await client.getIssueEditInfo(repo, number);
    if (info.lastEditedAt && Date.parse(info.lastEditedAt) >= labelTime && !(await isTrusted(info.editor))) {
      return { ok: false, reason: 'edited-after-label' };
    }
    const renames: IssueEvent[] = events.filter((e) => e.event === 'renamed' && e.id > last.id);
    for (const r of renames) {
      if (!(await isTrusted(r.actor))) return { ok: false, reason: 'edited-after-label' };
    }
    return { ok: true, labelEvent };
  };
}
