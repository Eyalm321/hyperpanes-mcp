import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  controlFilePath,
  normalizeDiscovery,
  readDiscovery,
  discoveryFromEnv,
  ControlUnavailableError
} from './discovery.js';

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

describe('controlFilePath precedence', () => {
  it('prefers the explicit arg, then env, then default', () => {
    expect(controlFilePath('/explicit/control.json')).toBe('/explicit/control.json');
    process.env.HYPERPANES_CONTROL_FILE = '/env/control.json';
    expect(controlFilePath()).toBe('/env/control.json');
    delete process.env.HYPERPANES_CONTROL_FILE;
    process.env.HYPERPANES_USER_DATA = join('/data', 'hp');
    expect(controlFilePath()).toBe(join('/data', 'hp', 'control.json'));
  });
});

describe('normalizeDiscovery', () => {
  it('uses a provided events URL', () => {
    const d = normalizeDiscovery({ port: 1234, token: 'abc', pid: 9, version: '0.1.0', events: 'ws://x/events?token=abc' }, 'src');
    expect(d).toEqual({ port: 1234, token: 'abc', pid: 9, version: '0.1.0', events: 'ws://x/events?token=abc' });
  });
  it('synthesizes events when absent (older app)', () => {
    const d = normalizeDiscovery({ port: 5555, token: 'tok' }, 'src');
    expect(d.events).toBe('ws://127.0.0.1:5555/events?token=tok');
  });
  it('rejects missing port/token', () => {
    expect(() => normalizeDiscovery({ token: 'x' }, 'src')).toThrow(ControlUnavailableError);
    expect(() => normalizeDiscovery({ port: 1 }, 'src')).toThrow(/port\/token/);
  });
});

describe('discoveryFromEnv (scoped token via pane env, F)', () => {
  it('builds discovery from token + port env', () => {
    const d = discoveryFromEnv({ HYPERPANES_CONTROL_TOKEN: 'scoped', HYPERPANES_CONTROL_PORT: '7788' } as NodeJS.ProcessEnv);
    expect(d).toEqual({ port: 7788, token: 'scoped', events: 'ws://127.0.0.1:7788/events?token=scoped' });
  });
  it('returns null when no token env is set', () => {
    expect(discoveryFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
  it('throws when the token is set but the port is missing/invalid', () => {
    expect(() => discoveryFromEnv({ HYPERPANES_CONTROL_TOKEN: 't' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });
});

describe('readDiscovery prefers the env token over control.json', () => {
  it('uses env token+port when no explicit path is given', () => {
    process.env.HYPERPANES_CONTROL_TOKEN = 'envtok';
    process.env.HYPERPANES_CONTROL_PORT = '9999';
    const d = readDiscovery();
    expect(d).toMatchObject({ token: 'envtok', port: 9999 });
  });
});

describe('readDiscovery', () => {
  it('reads a real control.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-disc-'));
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ port: 4321, token: 'zzz', pid: 1, version: '0.1.0', events: 'ws://127.0.0.1:4321/events?token=zzz' }));
    try {
      const d = readDiscovery(file);
      expect(d.port).toBe(4321);
      expect(d.events).toMatch(/4321/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('throws a helpful error when missing', () => {
    expect(() => readDiscovery(join(tmpdir(), 'definitely-not-here-control.json'))).toThrow(/control API not found/);
  });
});
