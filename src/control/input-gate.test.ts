import { describe, it, expect } from 'vitest';
import { readInputGate, checkInputAllowed } from './input-gate.js';

const pane = { id: 'p1', label: 'server' };

describe('readInputGate', () => {
  it('opt-in only on explicit truthy flag', () => {
    expect(readInputGate({}).optIn).toBe(false);
    expect(readInputGate({ HYPERPANES_ALLOW_INPUT: '0' }).optIn).toBe(false);
    expect(readInputGate({ HYPERPANES_ALLOW_INPUT: '1' }).optIn).toBe(true);
    expect(readInputGate({ HYPERPANES_ALLOW_INPUT: 'true' }).optIn).toBe(true);
  });
  it('parses an allowlist', () => {
    expect(readInputGate({ HYPERPANES_INPUT_ALLOWLIST: 'p1, server , p9' }).allowlist).toEqual(['p1', 'server', 'p9']);
    expect(readInputGate({}).allowlist).toBeNull();
  });
});

describe('checkInputAllowed', () => {
  it('refuses without bridge opt-in', () => {
    const r = checkInputAllowed({ optIn: false, allowlist: null }, { confirm: true }, pane);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HYPERPANES_ALLOW_INPUT/);
  });
  it('refuses without per-call confirm', () => {
    const r = checkInputAllowed({ optIn: true, allowlist: null }, {}, pane);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/confirm=true/);
  });
  it('allows when opted-in and confirmed', () => {
    expect(checkInputAllowed({ optIn: true, allowlist: null }, { confirm: true }, pane)).toEqual({ ok: true });
  });
  it('enforces the allowlist by id or label', () => {
    const gate = { optIn: true, allowlist: ['server'] };
    expect(checkInputAllowed(gate, { confirm: true }, pane).ok).toBe(true); // by label
    expect(checkInputAllowed({ optIn: true, allowlist: ['p1'] }, { confirm: true }, pane).ok).toBe(true); // by id
    const blocked = checkInputAllowed({ optIn: true, allowlist: ['other'] }, { confirm: true }, pane);
    expect(blocked.ok).toBe(false);
  });
});
