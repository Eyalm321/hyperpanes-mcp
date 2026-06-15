import { describe, it, expect } from 'vitest';
import { generateBacklog, enqueueBacklog } from './backlog.js';
import {
  todoSource,
  listSource,
  jsonFileSource,
  failingTestSource,
  parseGrepOutput,
  todoPrompt,
  type TodoHit,
  type TodoScanner
} from './sources.js';
import { decodeSpec, type TaskSpec } from '../worker-pool/kinds.js';
import type { QueueClient, EnqueueResult } from '../worker-pool/queue-client.js';
import { configFromArgs, buildSources } from './cli.js';

/** A scanner stub so the TODO source never shells out to git in a unit test. */
const stubScanner =
  (hits: TodoHit[]): TodoScanner =>
  () =>
    Promise.resolve(hits);

describe('parseGrepOutput', () => {
  it('parses path:line:content and extracts the marker + text', () => {
    const hits = parseGrepOutput('src/a.ts:12:  // TODO: wire this up\nsrc/b.ts:3:// FIXME broken');
    expect(hits).toEqual([
      { file: 'src/a.ts', line: 12, marker: 'TODO', text: 'wire this up' },
      { file: 'src/b.ts', line: 3, marker: 'FIXME', text: 'broken' }
    ]);
  });
  it('ignores lines without a TODO/FIXME marker', () => {
    expect(parseGrepOutput('src/a.ts:1:just a normal line')).toEqual([]);
  });
});

describe('todoSource → task shape', () => {
  it('emits one canonical lint task per hit, with provenance + dedupeKey', async () => {
    const src = todoSource({
      repo: '/repo',
      base: 'main',
      scanner: stubScanner([{ file: 'src/x.ts', line: 7, marker: 'TODO', text: 'handle nulls' }])
    });
    const inputs = await src.collect();
    expect(inputs).toHaveLength(1);
    const i = inputs[0]!;
    expect(i.kind).toBe('lint');
    expect(i.title).toBe('TODO src/x.ts:7');
    expect(i.prompt).toContain('src/x.ts:7');
    expect(i.base).toBe('main');
    expect(i.dedupeKey).toBe('todo:src/x.ts:7:TODO');
    expect(i.source).toMatchObject({ kind: 'todo', file: 'src/x.ts', line: 7, marker: 'TODO' });
  });
  it('honors the limit', async () => {
    const hits: TodoHit[] = Array.from({ length: 5 }, (_u, n) => ({
      file: `f${n}.ts`,
      line: n,
      marker: 'TODO',
      text: ''
    }));
    const src = todoSource({ repo: '/r', limit: 2, scanner: stubScanner(hits) });
    expect(await src.collect()).toHaveLength(2);
  });
});

describe('todoPrompt', () => {
  it('mentions the marker, location, and the comment text', () => {
    const p = todoPrompt({ file: 'a.ts', line: 9, marker: 'FIXME', text: 'leak here' });
    expect(p).toContain('FIXME');
    expect(p).toContain('a.ts:9');
    expect(p).toContain('leak here');
  });
});

describe('listSource / jsonFileSource', () => {
  it('passes explicit inputs through verbatim', async () => {
    const src = listSource([{ prompt: 'do x' }, { prompt: 'do y', kind: 'manual' }]);
    expect(await src.collect()).toEqual([{ prompt: 'do x' }, { prompt: 'do y', kind: 'manual' }]);
  });
  it('jsonFileSource accepts a bare array or a { tasks } wrapper', async () => {
    const a = await jsonFileSource([{ prompt: 'p' }]).collect();
    const b = await jsonFileSource({ tasks: [{ prompt: 'p' }] }).collect();
    expect(a).toEqual(b);
  });
  it('jsonFileSource rejects a non-array, non-wrapper shape', () => {
    expect(() => jsonFileSource({ nope: true })).toThrow();
  });
});

describe('failingTestSource (extension seam)', () => {
  it('turns failing tests into ci_failure tasks via an injected collector', async () => {
    const src = failingTestSource(
      () => Promise.resolve([{ name: 'session_expiry', file: 'a.test.ts', message: 'expected 1' }]),
      { base: 'main' }
    );
    const inputs = await src.collect();
    expect(inputs).toHaveLength(1);
    const i = inputs[0]!;
    expect(i.kind).toBe('ci_failure');
    expect(i.title).toContain('session_expiry');
    expect(i.prompt).toContain('session_expiry');
    expect(i.dedupeKey).toBe('failtest:a.test.ts:session_expiry');
  });
});

describe('generateBacklog', () => {
  it('normalizes every source input into a canonical EnqueueRequest (decodable payload)', async () => {
    const gen = await generateBacklog(
      [listSource([{ prompt: 'Summarize the README', kind: 'manual' }])],
      { base: 'HEAD' }
    );
    expect(gen.items).toHaveLength(1);
    const req = gen.items[0]!.request;
    expect(req.kind).toBe('manual');
    expect(req.title).toBe('Summarize the README');
    // payload is the queue-opaque encoded spec — round-trips through decodeSpec
    const spec = decodeSpec({ payload: req.payload }) as TaskSpec;
    expect(spec.prompt).toBe('Summarize the README');
    expect(spec.base).toBe('HEAD');
  });

  it('combines multiple sources and reports per-source counts', async () => {
    const gen = await generateBacklog([
      todoSource({ repo: '/r', scanner: stubScanner([{ file: 'a.ts', line: 1, marker: 'TODO', text: 'x' }]) }),
      listSource([{ prompt: 'manual one' }])
    ]);
    expect(gen.items).toHaveLength(2);
    expect(gen.bySource).toEqual({ 'todo-scan': 1, 'explicit-list': 1 });
  });

  it('de-duplicates within a batch by dedupeKey (default on)', async () => {
    const hit: TodoHit = { file: 'a.ts', line: 1, marker: 'TODO', text: 'x' };
    const gen = await generateBacklog([
      todoSource({ repo: '/r', scanner: stubScanner([hit]) }),
      todoSource({ repo: '/r', scanner: stubScanner([hit]) })
    ]);
    expect(gen.items).toHaveLength(1); // same dedupeKey collapsed
  });

  it('keeps duplicates when dedupe is disabled', async () => {
    const hit: TodoHit = { file: 'a.ts', line: 1, marker: 'TODO', text: 'x' };
    const gen = await generateBacklog(
      [todoSource({ repo: '/r', scanner: stubScanner([hit]) }), todoSource({ repo: '/r', scanner: stubScanner([hit]) })],
      { dedupe: false }
    );
    expect(gen.items).toHaveLength(2);
  });
});

describe('enqueueBacklog (with a FAKE queue client — never hits the network)', () => {
  function fakeClient(): { client: QueueClient; posted: Array<{ queue: string; title: string }> } {
    const posted: Array<{ queue: string; title: string }> = [];
    let seq = 0;
    const client = {
      enqueue(queue: string, req: { title: string }): Promise<EnqueueResult> {
        posted.push({ queue, title: req.title });
        seq++;
        return Promise.resolve({ ok: true, id: `id-${seq}`, seq });
      }
    } as unknown as QueueClient;
    return { client, posted };
  }

  it('POSTs each generated task and reports per-task outcomes', async () => {
    const { client, posted } = fakeClient();
    const gen = await generateBacklog([listSource([{ prompt: 'one' }, { prompt: 'two' }])]);
    const outcomes = await enqueueBacklog(client, 'build', gen);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => o.result?.id)).toEqual(['id-1', 'id-2']);
    expect(posted).toEqual([
      { queue: 'build', title: 'one' },
      { queue: 'build', title: 'two' }
    ]);
  });

  it('records a per-task failure without aborting the rest of the batch', async () => {
    let n = 0;
    const client = {
      enqueue(): Promise<EnqueueResult> {
        n++;
        if (n === 1) return Promise.reject(new Error('queue out of scope'));
        return Promise.resolve({ ok: true, id: `id-${n}`, seq: n });
      }
    } as unknown as QueueClient;
    const gen = await generateBacklog([listSource([{ prompt: 'a' }, { prompt: 'b' }])]);
    const outcomes = await enqueueBacklog(client, 'q', gen);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toContain('out of scope');
    expect(outcomes[1]!.ok).toBe(true);
  });
});

describe('cli wiring', () => {
  it('configFromArgs maps flags + applies defaults', () => {
    const cfg = configFromArgs({ 'dry-run': true, todos: true, queue: 'build', limit: '3', markers: 'TODO,XXX' });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.todos).toBe(true);
    expect(cfg.queue).toBe('build');
    expect(cfg.limit).toBe(3);
    expect(cfg.markers).toEqual(['TODO', 'XXX']);
    expect(cfg.dedupe).toBe(true);
  });
  it('--no-dedupe disables dedupe', () => {
    expect(configFromArgs({ 'no-dedupe': true }).dedupe).toBe(false);
  });
  it('buildSources adds a todo source when --todos is set', () => {
    const sources = buildSources(configFromArgs({ todos: true, repo: '/r' }));
    expect(sources.map((s) => s.name)).toContain('todo-scan');
  });
  it('buildSources yields no sources when none are selected', () => {
    expect(buildSources(configFromArgs({}))).toHaveLength(0);
  });
});
