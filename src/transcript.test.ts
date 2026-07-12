import { describe, expect, it } from 'vitest';
import { encodeProjectDir, parseTranscript, transcriptPathFor } from './transcript.js';

describe('encodeProjectDir', () => {
  it('maps every non-alphanumeric character to a dash, no run-collapsing', () => {
    expect(encodeProjectDir('/home/me/dev/x')).toBe('-home-me-dev-x');
    // Dots and underscores encode too (verified against Claude Code's on-disk layout).
    expect(encodeProjectDir('/a/b.c_d')).toBe('-a-b-c-d');
    expect(encodeProjectDir('C:\\hyperpanes')).toBe('C--hyperpanes');
  });
});

describe('transcriptPathFor', () => {
  it('builds the ~/.claude/projects path from cwd + session id', () => {
    expect(transcriptPathFor('/w/p', 'abc-123', '/home/u')).toBe(
      '/home/u/.claude/projects/-w-p/abc-123.jsonl'
    );
  });
});

describe('parseTranscript', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('keeps user/assistant text turns in order and skips plumbing records', () => {
    const jsonl = [
      line({ type: 'summary', summary: 'ignored' }),
      line({ type: 'user', message: { role: 'user', content: 'hello' } }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }
      }),
      'not json at all',
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'running a tool' },
            { type: 'tool_use', name: 'Bash', input: {} }
          ]
        }
      })
    ].join('\n');
    const msgs = parseTranscript(jsonl);
    // The pure tool-result user record is plumbing and drops out entirely;
    // tool_use blocks are summarized inline next to the visible text.
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(msgs[0].text).toBe('hello');
    expect(msgs[1].text).toBe('hi there');
    expect(msgs[2].text).toBe('running a tool\n[tool: Bash]');
  });

  it('returns empty for an empty or garbage transcript', () => {
    expect(parseTranscript('')).toEqual([]);
    expect(parseTranscript('garbage\n{"type":"other"}')).toEqual([]);
  });
});
