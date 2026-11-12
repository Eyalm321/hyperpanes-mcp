import { describe, it, expect } from 'vitest';
import {
  submitLikelyDropped,
  whoamiResult,
  listPanesResult,
  pickBuild,
  renameTabResult,
  movePaneResult,
  projectTabField,
  recolorTabResult,
  openTabResult,
  TAB_COLOR_RE,
  TAB_TITLE_MAX
} from './control-tools.js';
import { GroupSpecSchema } from './schema.js';
import type { ControlState, ControlPane } from './control/model.js';

// Cold-start submit-drop detector (prompt_pane self-heal). The signature of a
// dropped submit is: the turn settled, but the only thing that came back was our
// own keystrokes echoed into the input box — no reply followed.
describe('submitLikelyDropped', () => {
  const TEXT = 'hey there, what are you working on?';

  it('flags a dropped submit: delta is just the echo + a little status chrome', () => {
    // What the pane emits when the CR is swallowed: the text redrawn in the input
    // box, plus the status line repainting. No assistant reply.
    const delta = `❯ ${TEXT}\n  [Sonnet 4.6 high] Admin | ctx 0%  ⏵⏵ auto mode on`;
    expect(submitLikelyDropped(delta, TEXT, true, false)).toBe(true);
  });

  it('does NOT flag a real turn: the reply dwarfs the echo', () => {
    const reply =
      'I am refactoring the auth middleware to pull the token verification into a ' +
      'shared helper so the three route handlers stop duplicating it. About halfway.';
    const delta = `❯ ${TEXT}\n● ${reply}`;
    expect(submitLikelyDropped(delta, TEXT, true, false)).toBe(false);
  });

  it('never flags a still-working agent (timedOut ⇒ output never went quiet)', () => {
    const delta = `❯ ${TEXT}\n● `; // reply has begun but not settled
    expect(submitLikelyDropped(delta, TEXT, false, true)).toBe(false);
  });

  it('never flags an unsettled read', () => {
    const delta = `❯ ${TEXT}`;
    expect(submitLikelyDropped(delta, TEXT, false, false)).toBe(false);
  });

  it('is robust to the echo wrapping / box-drawing noise inside the typed text', () => {
    // The TUI can interleave border glyphs and newlines as it wraps a long line;
    // normalizing to alphanumerics still recognizes the echo as our own text.
    const wrapped = '❯ hey there, what are\n  │ working on?'; // mangled echo, no reply
    expect(submitLikelyDropped(wrapped, TEXT, true, false)).toBe(true);
  });
});

describe('running app version', () => {
  const pane = { id: 'p1', label: 'one', status: 'running' } as unknown as ControlPane;
  const base = (app?: { version: string; build?: string }) =>
    ({
      ...(app ? { app } : {}),
      windows: [{ id: 1, activeTabId: 't1', tabs: [{ id: 't1', title: 'T', layout: 'single', panes: [pane] }] }]
    }) as unknown as ControlState;
  const client = (state: ControlState, health: () => Promise<unknown>) =>
    ({ state: async () => state, health }) as never;

  it('whoami reports app from /state without calling /health', async () => {
    let called = false;
    const c = client(base({ version: '1.2.3', build: 'private build, abc1234' }), async () => {
      called = true;
      return {};
    });
    const r = (await whoamiResult(c, 'p1')) as { ok: boolean; app?: unknown };
    expect(r.ok).toBe(true);
    expect(r.app).toEqual({ version: '1.2.3', build: 'private build, abc1234' });
    expect(called).toBe(false);
  });

  it('whoami falls back to /health when /state has no app (older app)', async () => {
    const c = client(base(), async () => ({ version: '1.0.0', build: 'b1' }));
    const r = (await whoamiResult(c, 'p1')) as { app?: unknown };
    expect(r.app).toEqual({ version: '1.0.0', build: 'b1' });
  });

  it('whoami omits the build key on public builds', async () => {
    const r = (await whoamiResult(client(base({ version: '1.2.3' }), async () => ({})), 'p1')) as {
      app: object;
    };
    expect(r.app).toEqual({ version: '1.2.3' });
    expect('build' in r.app).toBe(false);
    const r2 = (await whoamiResult(client(base(), async () => ({ version: '1.0.0' })), 'p1')) as {
      app: object;
    };
    expect('build' in r2.app).toBe(false);
  });

  it('whoami never fails when both sources fail', async () => {
    const r = (await whoamiResult(
      client(base(), async () => {
        throw new Error('down');
      }),
      'p1'
    )) as { ok: boolean; app?: unknown };
    expect(r.ok).toBe(true);
    expect('app' in r).toBe(false);
  });

  it('list_panes includes top-level app when present, omits otherwise', () => {
    expect(listPanesResult(base({ version: '1.2.3', build: 'x' })).app).toEqual({ version: '1.2.3', build: 'x' });
    expect('app' in listPanesResult(base())).toBe(false);
  });

  it('control_status build: health wins, falls back to state.app, undefined when neither', () => {
    expect(pickBuild({ build: 'h' }, base({ version: '1', build: 's' }))).toBe('h');
    expect(pickBuild({}, base({ version: '1', build: 's' }))).toBe('s');
    expect(pickBuild({}, base({ version: '1' }))).toBeUndefined();
  });
});

describe('rename_tab / recolor_tab', () => {
  // A fake client that records every POST /command body.
  const recorder = () => {
    const sent: unknown[] = [];
    const c = {
      command: async (cmd: unknown) => {
        sent.push(cmd);
        return { ok: true };
      }
    } as never;
    return { c, sent };
  };

  it('rename_tab sends exactly renameTab {tabId, title}', async () => {
    const { c, sent } = recorder();
    const r = await renameTabResult(c, '0:1', 'build');
    expect(sent).toEqual([{ type: 'renameTab', tabId: '0:1', title: 'build' }]);
    expect(r).toEqual({ ok: true, tabId: '0:1', title: 'build' });
  });

  it('recolor_tab sends recolorTab {tabId, color}', async () => {
    const { c, sent } = recorder();
    const r = await recolorTabResult(c, 'abc-123', '#e5484d');
    expect(sent).toEqual([{ type: 'recolorTab', tabId: 'abc-123', color: '#e5484d' }]);
    expect(r).toEqual({ ok: true, tabId: 'abc-123', color: '#e5484d' });
  });

  it('recolor_tab with null sends an explicit color:null (clears the manual colour)', async () => {
    const { c, sent } = recorder();
    await recolorTabResult(c, '0:0', null);
    expect(sent).toEqual([{ type: 'recolorTab', tabId: '0:0', color: null }]);
    expect('color' in (sent[0] as object)).toBe(true);
  });

  it('surfaces the app error (e.g. unknown tab) instead of reporting ok', async () => {
    const c = {
      command: async () => {
        throw new Error('no such tab: 9:9');
      }
    } as never;
    await expect(renameTabResult(c, '9:9', 'x')).rejects.toThrow('no such tab: 9:9');
    await expect(recolorTabResult(c, '9:9', null)).rejects.toThrow('no such tab: 9:9');
  });

  it('accepts the colours the app accepts and rejects the rest', () => {
    for (const ok of ['#aabbcc', '#AABBCC', '#abc', '#E54']) expect(TAB_COLOR_RE.test(ok)).toBe(true);
    for (const bad of ['red', 'aabbcc', '#12345', '#abcd', '#gggggg', '', '#aabbccdd']) {
      expect(TAB_COLOR_RE.test(bad)).toBe(false);
    }
    expect(TAB_TITLE_MAX).toBe(80);
  });

  it('list_panes reports each pane\'s tabColor next to tabTitle', () => {
    const pane = { id: 'p1', label: 'one', status: 'running' } as unknown as ControlPane;
    const state = {
      windows: [
        { windowId: 1, activeTabId: 't1', tabs: [{ id: 't1', title: 'T', color: '#aabbcc', layout: 'single', panes: [pane] }] }
      ]
    } as unknown as ControlState;
    const [p] = listPanesResult(state).panes;
    expect(p?.tabTitle).toBe('T');
    expect(p?.tabColor).toBe('#aabbcc');
    const plain = { windows: [{ windowId: 1, activeTabId: 't1', tabs: [{ id: 't1', title: 'T', layout: 'single', panes: [pane] }] }] } as unknown as ControlState;
    expect(listPanesResult(plain).panes[0]?.tabColor).toBeNull();
  });
});

describe('open_tab group colour', () => {
  it('passes a group color through to attach as the new tab\'s colour', async () => {
    const sent: unknown[] = [];
    const c = {
      state: async () => ({ windows: [{ windowId: 3, activeTabId: null, tabs: [] }] }),
      command: async (cmd: unknown) => {
        sent.push(cmd);
        return { ok: true, result: ['tab-1'] };
      }
    } as never;
    const groups = [{ title: 'build', color: '#e5484d', panes: [{ command: 'npm test', color: '#3b82f6' }] }];
    const r = await openTabResult(c, groups);
    expect(sent).toEqual([{ type: 'attach', windowId: 3, groups, as: 'tab' }]);
    expect(r).toEqual({ ok: true, windowId: 3, as: 'tab', ids: ['tab-1'] });
  });

  it('the open_tab group schema takes color next to title (hex or null) and rejects bad ones', () => {
    expect(GroupSpecSchema.safeParse({ title: 'a', color: '#abc', panes: [] }).success).toBe(true);
    expect(GroupSpecSchema.safeParse({ title: 'a', color: null, panes: [] }).success).toBe(true);
    expect(GroupSpecSchema.safeParse({ title: 'a', panes: [] }).success).toBe(true);
    expect(GroupSpecSchema.safeParse({ title: 'a', color: 'red', panes: [] }).success).toBe(false);
  });
});

describe('move_pane / projectTab', () => {
  const recorder = (result: unknown) => {
    const sent: unknown[] = [];
    const c = {
      command: async (cmd: unknown) => {
        sent.push(cmd);
        return { ok: true, result };
      }
    } as never;
    return { c, sent };
  };

  it('sends movePane with exactly the given target and returns the tabId', async () => {
    const { c, sent } = recorder({ tabId: 'tab-1' });
    const r = await movePaneResult(c, { paneId: 'p1', tabId: '1:0' });
    expect(sent).toEqual([{ type: 'movePane', paneId: 'p1', tabId: '1:0' }]);
    expect(r).toEqual({ ok: true, paneId: 'p1', tabId: 'tab-1' });
  });

  it('passes newTab / project with an optional windowId', async () => {
    const { c, sent } = recorder({ tabId: 'new' });
    await movePaneResult(c, { paneId: 'p1', newTab: { title: 'proj-a', color: '#a855f7' }, windowId: 2 });
    await movePaneResult(c, { paneId: 'p1', project: 'proj-a' });
    expect(sent).toEqual([
      { type: 'movePane', paneId: 'p1', newTab: { title: 'proj-a', color: '#a855f7' }, windowId: 2 },
      { type: 'movePane', paneId: 'p1', project: 'proj-a' }
    ]);
  });

  it('needs exactly one target, and sends nothing otherwise', async () => {
    const { c, sent } = recorder({ tabId: 'x' });
    await expect(movePaneResult(c, { paneId: 'p1' })).rejects.toThrow('exactly one');
    await expect(movePaneResult(c, { paneId: 'p1', tabId: 't', project: 'p' })).rejects.toThrow('exactly one');
    expect(sent).toEqual([]);
  });

  it('surfaces the app error and a missing tabId', async () => {
    const failing = {
      command: async () => {
        throw new Error('command movePane -> 409 (pane p1 is the only pane in its window)');
      }
    } as never;
    await expect(movePaneResult(failing, { paneId: 'p1', newTab: {} })).rejects.toThrow('409');
    const { c } = recorder(undefined);
    await expect(movePaneResult(c, { paneId: 'p1', newTab: {} })).rejects.toThrow('no tabId');
  });

  it('projectTab is only sent when set and needs project', () => {
    expect(projectTabField(undefined, undefined)).toEqual({});
    expect(projectTabField('proj-a', undefined)).toEqual({});
    expect(projectTabField('proj-a', true)).toEqual({ projectTab: true });
    expect(projectTabField(undefined, false)).toEqual({ projectTab: false });
    expect(() => projectTabField(undefined, true)).toThrow('projectTab needs project');
  });
});
