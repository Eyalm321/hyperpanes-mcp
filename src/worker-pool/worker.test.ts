import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTask,
  classifyRun,
  resolveAgentCommand,
  renderResult,
  type AgentRunner,
  type AgentRunInput,
  type AgentRunResult
} from './worker.js';
import type { DispatchedTask } from './kinds.js';

/** A FAKE runner — records its input and returns a canned result, so a unit test
 *  drives the worker body WITHOUT ever spawning `claude`. */
function fakeRunner(result: AgentRunResult): { runner: AgentRunner; calls: AgentRunInput[] } {
  const calls: AgentRunInput[] = [];
  const runner: AgentRunner = {
    run(input: AgentRunInput): Promise<AgentRunResult> {
      calls.push(input);
      return Promise.resolve(result);
    }
  };
  return { runner, calls };
}

function dispatched(over: Partial<DispatchedTask> = {}): DispatchedTask {
  return {
    id: 'tsk_1',
    kind: 'manual',
    title: 'Do the thing',
    prompt: 'Make it so',
    base: 'HEAD',
    branch: 'agent/tsk_1-do-the-thing',
    worktree: '/wt/pool-tsk_1',
    ...over
  };
}

describe('resolveAgentCommand', () => {
  it('defaults to claude --permission-mode acceptEdits -p <prompt>', () => {
    const c = resolveAgentCommand('fix the bug', {});
    expect(c.command).toBe('claude');
    expect(c.args).toEqual(['--permission-mode', 'acceptEdits', '-p', 'fix the bug']);
  });
  it('honors HP_WORKER_AGENT_CMD, appending the prompt as the last arg', () => {
    const c = resolveAgentCommand('do x', { HP_WORKER_AGENT_CMD: 'my-agent --headless' });
    expect(c.command).toBe('my-agent');
    expect(c.args).toEqual(['--headless', 'do x']);
  });
  it('substitutes a {prompt} slot in the override instead of appending', () => {
    const c = resolveAgentCommand('do x', { HP_WORKER_AGENT_CMD: 'agent -p {prompt} --json' });
    expect(c.command).toBe('agent');
    expect(c.args).toEqual(['-p', 'do x', '--json']);
  });
});

describe('classifyRun', () => {
  it('exit 0 ⇒ success', () => {
    expect(classifyRun({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }).status).toBe('success');
  });
  it('non-zero exit ⇒ failed', () => {
    const o = classifyRun({ exitCode: 3, stdout: '', stderr: 'boom', timedOut: false });
    expect(o.status).toBe('failed');
    expect(o.exitCode).toBe(3);
  });
  it('timedOut ⇒ timeout regardless of code', () => {
    expect(classifyRun({ exitCode: null, stdout: '', stderr: '', timedOut: true }).status).toBe('timeout');
  });
  it('folds stderr into the captured output', () => {
    expect(classifyRun({ exitCode: 0, stdout: 'out', stderr: 'err', timedOut: false }).output).toContain('err');
  });
});

describe('runTask (with a FAKE runner — never spawns claude)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hp-worker-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('SUCCESS path: passes the prompt+cwd through and writes a success RESULT.md', async () => {
    const { runner, calls } = fakeRunner({ exitCode: 0, stdout: 'agent did the work', stderr: '', timedOut: false });
    const task = dispatched({ prompt: 'Make it so' });

    const outcome = await runTask(task, runner, { cwd, timeoutMs: 5_000 });

    expect(outcome.status).toBe('success');
    expect(outcome.exitCode).toBe(0);
    // the runner saw the real prompt + cwd + budget
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ prompt: 'Make it so', cwd, timeoutMs: 5_000 });

    const md = readFileSync(join(cwd, 'RESULT.md'), 'utf8');
    expect(md).toContain('# Result for tsk_1');
    expect(md).toContain('agent did the work');
    expect(md).toContain('status: success');
  });

  it('TIMEOUT path: a timed-out run ⇒ timeout outcome + TIMEOUT RESULT.md', async () => {
    const { runner } = fakeRunner({ exitCode: null, stdout: 'partial', stderr: '', timedOut: true });
    const task = dispatched();

    const outcome = await runTask(task, runner, { cwd, timeoutMs: 10 });

    expect(outcome.status).toBe('timeout');
    expect(outcome.timedOut).toBe(true);

    const md = readFileSync(join(cwd, 'RESULT.md'), 'utf8');
    expect(md).toContain('# TIMEOUT for tsk_1');
    expect(md).toContain('status: timeout');
  });

  it('FAILED path: a non-zero exit ⇒ failed outcome + FAILED RESULT.md', async () => {
    const { runner } = fakeRunner({ exitCode: 2, stdout: '', stderr: 'no api key', timedOut: false });
    const outcome = await runTask(dispatched(), runner, { cwd, timeoutMs: 5_000 });

    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(2);
    const md = readFileSync(join(cwd, 'RESULT.md'), 'utf8');
    expect(md).toContain('# FAILED for tsk_1');
    expect(md).toContain('no api key');
  });

  it('a throwing runner is caught and recorded as failed (RESULT.md still written)', async () => {
    const runner: AgentRunner = {
      run(): Promise<AgentRunResult> {
        return Promise.reject(new Error('spawn EACCES'));
      }
    };
    const outcome = await runTask(dispatched(), runner, { cwd, timeoutMs: 5_000 });
    expect(outcome.status).toBe('failed');
    expect(existsSync(join(cwd, 'RESULT.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'RESULT.md'), 'utf8')).toContain('spawn EACCES');
  });
});

describe('renderResult', () => {
  it('reflects the success outcome in the heading and footer', () => {
    const md = renderResult(dispatched(), { status: 'success', exitCode: 0, output: 'done', timedOut: false }, '/wt/x');
    expect(md).toContain('# Result for tsk_1');
    expect(md).toContain('worktree: /wt/x');
    expect(md).toContain('exitCode: 0');
  });
});
