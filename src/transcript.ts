// read_pane mode:"transcript" — the deterministic way to read a Claude pane's
// conversation. TUI-scraping a claude pane is lossy (fullscreen redraws, scroll
// regions, spinner overdraw); but every claude in a hyperpanes pane leaves a
// session marker (written by the hp-claude-session-hook), and Claude Code keeps
// the authoritative transcript on disk — so we join pane → marker → transcript
// and return the actual last messages instead of a screen approximation.
//
//   marker:     <state dir>/claude-sessions/<paneId>.json  = { sessionId, cwd }
//   transcript: ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
//
// The cwd encoding matches Claude Code's project-dir naming: every character
// that is not ASCII alphanumeric becomes '-' (no run-collapsing).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  /** Concatenated text blocks; tool activity summarized inline as [tool: name]. */
  text: string;
}

export interface TranscriptResult {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  /** Last `count` conversation messages, oldest first. */
  messages: TranscriptMessage[];
  /** Total conversation messages in the transcript (before tailing). */
  totalMessages: number;
}

/** hyperpanes state dir (Linux XDG / macOS Application Support), overridable for tests. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'hyperpanes');
  }
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== ''
    ? env.XDG_STATE_HOME
    : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'hyperpanes');
}

/** Claude Code's project-dir encoding: keep [A-Za-z0-9], everything else → '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptPathFor(cwd: string, sessionId: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** Extract the displayable text of one transcript record's message content. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use' && typeof b.name === 'string') parts.push(`[tool: ${b.name}]`);
    // tool_result blocks are plumbing (one per tool call) — they'd drown the tail.
  }
  return parts.join('\n');
}

/** Parse a transcript's JSONL text into conversation messages (user/assistant only). */
export function parseTranscript(jsonl: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const text = contentText(msg.content).trim();
    if (!text) continue; // pure tool-result plumbing records stay out of the tail
    out.push({ role: rec.type, text });
  }
  return out;
}

/** Cap each message's text so one giant paste can't blow the tool result. */
function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… [+${text.length - maxChars} chars]`;
}

/**
 * Read the conversation tail for a pane. Returns null when the pane has no live
 * Claude marker (not a claude pane — callers fall back to a screen read).
 */
export async function readPaneTranscript(
  paneId: string,
  opts: { messages?: number; maxCharsPerMessage?: number } = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<TranscriptResult | null> {
  const markerPath = path.join(stateDir(env), 'claude-sessions', `${paneId}.json`);
  let marker: { sessionId?: string; cwd?: string };
  try {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch {
    return null;
  }
  if (!marker.sessionId || !marker.cwd) return null;
  const transcriptPath = transcriptPathFor(marker.cwd, marker.sessionId);
  let jsonl: string;
  try {
    jsonl = await fs.readFile(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const all = parseTranscript(jsonl);
  const n = Math.max(1, opts.messages ?? 10);
  const maxChars = Math.max(200, opts.maxCharsPerMessage ?? 2000);
  return {
    sessionId: marker.sessionId,
    cwd: marker.cwd,
    transcriptPath,
    messages: all.slice(-n).map((m) => ({ role: m.role, text: clip(m.text, maxChars) })),
    totalMessages: all.length
  };
}
