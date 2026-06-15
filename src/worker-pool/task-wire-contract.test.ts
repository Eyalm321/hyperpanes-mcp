/**
 * Cross-language wire contract for the queue `Task` record.
 *
 * The Rust work queue (`rs/crates/core/src/control/work.rs`) and this controller
 * hand-mirror the SAME wire shape: camelCase keys, epoch-ms NUMBER timestamps, and
 * a FLATTENED lease (`claimedBy` / `fencingToken` / `visibilityDeadline` at the top
 * level — never a nested `lease` object).
 *
 * `test/fixtures/task-wire.golden.json` is the canonical golden, derived from the
 * Rust `serde_json::to_string_pretty` of a fully-populated `Task`. The Rust
 * serialization is AUTHORITATIVE. This file is byte-identical to its twin in the
 * Rust repo (`rs/crates/core/tests/fixtures/task-wire.golden.json`). If this test
 * fails, the controller's {@link Task} / {@link RawTaskSchema} has drifted from the
 * queue's wire format.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { RawTaskSchema, type Task } from './kinds.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/worker-pool -> repo root -> test/fixtures
const GOLDEN_PATH = join(here, '..', '..', 'test', 'fixtures', 'task-wire.golden.json');

describe('Task wire contract (cross-language golden)', () => {
  const raw = readFileSync(GOLDEN_PATH, 'utf8');
  const parsedJson = JSON.parse(raw) as Record<string, unknown>;

  it('parses the Rust golden with the controller Task schema', () => {
    // The full golden must satisfy RawTaskSchema (which is .strict(): an unexpected
    // key — e.g. a snake_case variant or a nested `lease` — is a hard failure).
    const task: Task = RawTaskSchema.parse(parsedJson);

    // Load-bearing values survived (proves the camelCase keys mapped to real fields).
    expect(task.state).toBe('claimed');
    expect(task.claimedBy).toBe('wkr-A');
    expect(task.fencingToken).toBe(7);
    expect(task.visibilityDeadline).toBe(1_700_000_030_000);
    expect(task.maxAttempts).toBe(5);
    expect(task.availableAt).toBe(1_700_000_000_000);
    expect(task.result).toBe('artifact://built/ok');
  });

  it('uses the exact camelCase keys and no snake_case variants', () => {
    for (const key of [
      'claimedBy',
      'fencingToken',
      'visibilityDeadline',
      'maxAttempts',
      'availableAt',
      'createdAt',
      'updatedAt',
      'dedupeKey'
    ]) {
      expect(parsedJson, `golden must contain camelCase key \`${key}\``).toHaveProperty(key);
    }
    for (const bad of [
      'claimed_by',
      'fencing_token',
      'visibility_deadline',
      'max_attempts',
      'available_at',
      'created_at',
      'updated_at',
      'dedupe_key'
    ]) {
      expect(parsedJson, `golden must NOT contain snake_case key \`${bad}\``).not.toHaveProperty(bad);
    }
  });

  it('encodes timestamps as numbers (epoch ms), not strings', () => {
    for (const ts of ['availableAt', 'visibilityDeadline', 'createdAt', 'updatedAt']) {
      expect(typeof parsedJson[ts], `\`${ts}\` must be a number`).toBe('number');
    }
  });
});
