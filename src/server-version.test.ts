import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from './server.js';

describe('serverInfo version', () => {
  it('matches package.json, not a hard-coded constant', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe('0.1.0');
  });
});
