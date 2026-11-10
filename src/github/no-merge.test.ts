/** Guard (design note §9 "Merge"): the code must never merge, auto-merge or approve. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN: Array<[string, RegExp]> = [
  ['merge API path', /['"`][^'"`\n]*\/merge(?![\w-])[^'"`\n]*['"`]/],
  ['merge_method', /merge_method/],
  ['auto_merge', /auto_merge/],
  ['enablePullRequestAutoMerge', /enablePullRequestAutoMerge/],
  ['mergePullRequest', /mergePullRequest/],
  ['APPROVE review event', /['"`]APPROVE['"`]/],
  ['gh pr merge', /gh\s+pr\s+merge/],
  ['pr,merge argv pair', /['"`]pr['"`]\s*,\s*['"`]merge['"`]/]
];

export function scan(text: string): string[] {
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function walk(dir: string, ok: (f: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, ok, out);
    else if (ok(p)) out.push(p);
  }
  return out;
}

describe('no merge / approve capability', () => {
  it('scanner flags planted samples and ignores prose', () => {
    for (const s of [
      "const u = '/repos/a/b/pulls/1/merge';",
      'body: { merge_method: "squash" }',
      'mutation { enablePullRequestAutoMerge }',
      'mergePullRequest(',
      "event: 'APPROVE'",
      'run("gh pr merge 5")',
      "execFile('gh', ['pr', 'merge', '5'])"
    ]) {
      expect(scan(s), s).not.toEqual([]);
    }
    expect(scan('// the merge gate blocks; use merge-base and `git merge-base`')).toEqual([]);
    expect(scan("const x = 'merge-base';")).toEqual([]);
  });

  it('src (non-test) has no merge/approve usage', () => {
    const files = walk('src', (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((f) => scan(readFileSync(f, 'utf8')).map((h) => `${f}: ${h}`));
    expect(hits).toEqual([]);
  });

  it('dist has no merge/approve usage (must exist in CI)', () => {
    if (process.env.CI) expect(existsSync('dist'), 'CI must build before tests').toBe(true);
    if (!existsSync('dist')) return;
    const files = walk('dist', (f) => f.endsWith('.js'));
    const hits = files.flatMap((f) => scan(readFileSync(f, 'utf8')).map((h) => `${f}: ${h}`));
    expect(hits).toEqual([]);
  });
});
