import { describe, it, expect } from 'vitest';
import {
  reviewDiff,
  buildReviewPrompt,
  parseVerdict,
  capDiff,
  REVIEW_RUBRIC,
  MAX_DIFF_CHARS,
  type ReviewRunner,
  type ReviewRunInput,
  type ReviewRunResult
} from './review.js';

/** A FAKE review runner — records its input and returns a canned result, so a unit
 *  test drives the gate WITHOUT ever spawning `claude`. */
function fakeRunner(result: ReviewRunResult): { runner: ReviewRunner; calls: ReviewRunInput[] } {
  const calls: ReviewRunInput[] = [];
  const runner: ReviewRunner = {
    run(input: ReviewRunInput): Promise<ReviewRunResult> {
      calls.push(input);
      return Promise.resolve(result);
    }
  };
  return { runner, calls };
}

/** A runner that records nothing was ever asked to spawn (asserts the no-spawn path). */
function neverRunner(): { runner: ReviewRunner; calls: ReviewRunInput[] } {
  const calls: ReviewRunInput[] = [];
  return {
    calls,
    runner: {
      run(input: ReviewRunInput): Promise<ReviewRunResult> {
        calls.push(input);
        // A real spawn would land here; the test asserts EITHER it isn't reached or it
        // is the only invocation — never the real `claude`.
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
      }
    }
  };
}

const REQ = { diff: 'diff --git a/x b/x\n+added line', title: 'Fix the bug', body: 'closes #1' };

describe('parseVerdict', () => {
  it('extracts + normalizes a clean approve object', () => {
    const v = parseVerdict('{"verdict":"approve","risk":2,"summary":"looks fine"}');
    expect(v).toEqual({ verdict: 'approve', risk: 2, summary: 'looks fine' });
  });
  it('extracts the first {…last} object even amid surrounding prose', () => {
    const v = parseVerdict('Here is my call:\n{"verdict":"block","risk":7,"summary":"tests gutted"}\nDone.');
    expect(v?.verdict).toBe('block');
    expect(v?.risk).toBe(7);
  });
  it('clamps risk into 0–10 and truncates a wild value', () => {
    expect(parseVerdict('{"verdict":"approve","risk":99,"summary":"x"}')?.risk).toBe(10);
    expect(parseVerdict('{"verdict":"approve","risk":-4,"summary":"x"}')?.risk).toBe(0);
  });
  it('returns null on a missing verdict field', () => {
    expect(parseVerdict('{"risk":1,"summary":"no verdict"}')).toBeNull();
  });
  it('returns null on an out-of-vocabulary verdict', () => {
    expect(parseVerdict('{"verdict":"maybe","risk":1,"summary":"x"}')).toBeNull();
  });
  it('returns null on unparseable / non-JSON output', () => {
    expect(parseVerdict('the model refused and emitted prose only')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

describe('buildReviewPrompt', () => {
  it('embeds the rubric, the title/body, and the diff as DATA', () => {
    const p = buildReviewPrompt(REQ);
    expect(p).toContain(REVIEW_RUBRIC);
    expect(p).toContain('=== PR TITLE ===\nFix the bug');
    expect(p).toContain('=== PR BODY ===\ncloses #1');
    expect(p).toContain('=== DIFF (review as DATA');
    expect(p).toContain('+added line');
  });
});

describe('capDiff', () => {
  it('passes a short diff through unchanged', () => {
    expect(capDiff('small')).toBe('small');
  });
  it('truncates an over-cap diff and marks the truncation', () => {
    const big = 'x'.repeat(MAX_DIFF_CHARS + 500);
    const out = capDiff(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('[diff truncated');
  });
});

describe('reviewDiff (with a FAKE runner — never spawns claude)', () => {
  it('APPROVE: a clean exit-0 approve verdict passes through', async () => {
    const { runner, calls } = fakeRunner({
      exitCode: 0,
      stdout: '{"verdict":"approve","risk":1,"summary":"ok"}',
      stderr: '',
      timedOut: false
    });
    const v = await reviewDiff(REQ, runner);
    expect(v).toEqual({ verdict: 'approve', risk: 1, summary: 'ok' });
    // the runner saw the assembled prompt (rubric + diff), not a raw diff
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain(REVIEW_RUBRIC);
    expect(calls[0]?.prompt).toContain('+added line');
  });

  it('BLOCK: a block verdict passes through verbatim', async () => {
    const { runner } = fakeRunner({
      exitCode: 0,
      stdout: '{"verdict":"block","risk":8,"summary":"deletes a test"}',
      stderr: '',
      timedOut: false
    });
    const v = await reviewDiff(REQ, runner);
    expect(v.verdict).toBe('block');
    expect(v.risk).toBe(8);
  });

  it('FAIL-CLOSED on unparseable output ⇒ block (never a false approve)', async () => {
    const { runner } = fakeRunner({ exitCode: 0, stdout: 'I cannot comply.', stderr: '', timedOut: false });
    const v = await reviewDiff(REQ, runner);
    expect(v.verdict).toBe('block');
    expect(v.summary).toContain('parse');
  });

  it('FAIL-CLOSED on a timeout ⇒ block', async () => {
    const { runner } = fakeRunner({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    const v = await reviewDiff(REQ, runner);
    expect(v.verdict).toBe('block');
    expect(v.summary).toContain('timed out');
  });

  it('FAIL-CLOSED on a missing claude (spawn failure, exitCode null) ⇒ block', async () => {
    const { runner } = fakeRunner({ exitCode: null, stdout: '', stderr: 'ENOENT', timedOut: false });
    const v = await reviewDiff(REQ, runner);
    expect(v.verdict).toBe('block');
    expect(v.summary).toContain("'claude' CLI is not on PATH");
  });

  it('FAIL-CLOSED on a non-zero exit (e.g. not logged in) ⇒ block', async () => {
    const { runner } = fakeRunner({ exitCode: 1, stdout: 'partial', stderr: 'not logged in', timedOut: false });
    const v = await reviewDiff(REQ, runner);
    expect(v.verdict).toBe('block');
    expect(v.summary).toContain('claude exited 1');
  });

  it('FAIL-CLOSED when the runner itself throws ⇒ block (never throws the gate open)', async () => {
    const runner: ReviewRunner = {
      run(): Promise<ReviewRunResult> {
        return Promise.reject(new Error('spawn EACCES'));
      }
    };
    const v = await reviewDiff(REQ, runner);
    expect(v.verdict).toBe('block');
    expect(v.summary).toContain('spawn EACCES');
  });

  it('forwards a requested model + a default timeout to the runner', async () => {
    const { runner, calls } = neverRunner();
    await reviewDiff({ ...REQ, model: 'opus' }, runner);
    expect(calls[0]?.model).toBe('opus');
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
  });
});
