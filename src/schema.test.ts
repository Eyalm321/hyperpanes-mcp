import { describe, it, expect } from 'vitest';
import { validateWorkspace, windowsOf, summarize, WorkspaceFileSchema } from './schema.js';

// windowsOf must match the app's normalizer exactly — these cases mirror
// hyperpanes' own workspace.test.ts `windowsOf` block.
describe('windowsOf (parity with hyperpanes)', () => {
  it('returns [] for null / contentless', () => {
    expect(windowsOf(null)).toEqual([]);
    expect(windowsOf({})).toEqual([]);
    expect(windowsOf({ panes: [] })).toEqual([]);
  });

  it('wraps top-level panes as one window with one tab', () => {
    expect(windowsOf({ name: 'x', layout: 'grid', panes: [{ label: 'a' }] })).toEqual([
      { title: 'x', groups: [{ title: 'x', layout: 'grid', panes: [{ label: 'a' }] }] }
    ]);
  });

  it('wraps groups as one window of tabs, carrying active', () => {
    const groups = [{ title: 't1', panes: [{ label: 'a' }] }];
    expect(windowsOf({ name: 'x', groups, active: 0 })).toEqual([{ title: 'x', active: 0, groups }]);
  });

  it('uses windows verbatim, dropping groupless windows', () => {
    const win = { title: 'w', groups: [{ panes: [{ label: 'a' }] }] };
    expect(windowsOf({ windows: [win, { title: 'empty', groups: [] }] })).toEqual([win]);
  });

  it('prefers windows over top-level groups/panes', () => {
    const win = { title: 'w', groups: [{ panes: [{ label: 'a' }] }] };
    expect(windowsOf({ windows: [win], groups: [{ panes: [{ label: 'z' }] }] })).toEqual([win]);
  });
});

describe('summarize', () => {
  it('counts windows, tabs, and panes', () => {
    const windows = windowsOf({
      windows: [
        { groups: [{ panes: [{ label: 'a' }, { label: 'b' }] }, { panes: [{ label: 'c' }] }] },
        { groups: [{ panes: [{ label: 'd' }] }] }
      ]
    });
    expect(summarize(windows)).toEqual({ windows: 2, tabs: 3, panes: 4 });
  });
});

describe('validateWorkspace', () => {
  it('accepts a minimal panes workspace', () => {
    const r = validateWorkspace({ panes: [{ command: 'bash' }] });
    expect(r).toEqual({ valid: true, summary: { windows: 1, tabs: 1, panes: 1 } });
  });

  it('accepts a full nested windows workspace', () => {
    const r = validateWorkspace({
      windows: [
        {
          title: 'dev',
          active: 0,
          bounds: { width: 1200, height: 800, maximized: true },
          groups: [{ title: 'app', layout: 'main-stack', panes: [{ command: 'npm run dev', subtitle: 'feature/x' }] }]
        }
      ]
    });
    expect(r.valid).toBe(true);
    expect(r.summary).toEqual({ windows: 1, tabs: 1, panes: 1 });
  });

  it('accepts a tab with sizes / mainFraction / focused / zoomed', () => {
    const r = validateWorkspace({
      groups: [
        {
          layout: 'main-stack',
          panes: [{ command: 'a' }, { command: 'b' }, { command: 'c' }],
          sizes: [0.5, 0.25, 0.25],
          mainFraction: 0.7,
          focused: 2,
          zoomed: 1
        }
      ]
    });
    expect(r.valid).toBe(true);
  });

  it('rejects a negative size or non-integer focus index', () => {
    expect(
      validateWorkspace({ groups: [{ panes: [{ command: 'a' }], sizes: [-1] }] }).valid
    ).toBe(false);
    expect(
      validateWorkspace({ groups: [{ panes: [{ command: 'a' }], focused: 1.5 }] }).valid
    ).toBe(false);
  });

  it('rejects an empty workspace (no panes anywhere)', () => {
    const r = validateWorkspace({ name: 'empty' });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toMatch(/no panes/i);
  });

  it('rejects unknown keys (typo guard)', () => {
    const r = validateWorkspace({ panes: [{ commnd: 'bash' }] });
    expect(r.valid).toBe(false);
    expect(r.errors?.join('\n')).toMatch(/commnd|Unrecognized/i);
  });

  it('rejects an unknown layout', () => {
    const r = validateWorkspace({ panes: [{ command: 'x' }], layout: 'spiral' });
    expect(r.valid).toBe(false);
  });

  it('rejects a non-integer / non-positive fontSize', () => {
    expect(validateWorkspace({ panes: [{ command: 'x', fontSize: 0 }] }).valid).toBe(false);
    expect(validateWorkspace({ panes: [{ command: 'x', fontSize: 12.5 }] }).valid).toBe(false);
  });

  it('accepts free-form pane meta (agent-orchestration C)', () => {
    const r = validateWorkspace({
      panes: [{ command: 'claude', meta: { role: 'worker', parent: 'p0', task: 'tests' } }]
    });
    expect(r.valid).toBe(true);
  });

  it('tolerates a non-string meta value by dropping it (app parity, #8)', () => {
    // The app's loader never rejects meta — it loads such a workspace — so the
    // validator mirrors that: accept it, dropping the non-string value to keep the
    // canonical string→string shape rather than failing on a file the app accepts.
    const input = { panes: [{ command: 'x', meta: { role: 'worker', bad: 5 } }] };
    expect(validateWorkspace(input).valid).toBe(true);
    const parsed = WorkspaceFileSchema.parse(input);
    expect(parsed.panes?.[0]?.meta).toEqual({ role: 'worker' });
  });

  it('round-trips through parse (no data mutation)', () => {
    const input = { name: 'dev', panes: [{ command: 'bash', label: 'shell' }] };
    expect(WorkspaceFileSchema.parse(input)).toEqual(input);
  });
});
