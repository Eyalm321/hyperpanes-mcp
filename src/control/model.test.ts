import { describe, it, expect } from 'vitest';
import {
  flattenPanes,
  tabStatusOf,
  resolveWindowIdForTab,
  firstWindowId,
  firstWindowActiveTabId,
  sessionPaneMap,
  paneOutputUri,
  paneIdFromUri,
  paneMessagesUri,
  paneIdFromMessagesUri,
  resolveWhoami,
  subtreePaneIds,
  type ControlState
} from './model.js';

const state: ControlState = {
  windows: [
    {
      windowId: 1,
      activeTabId: 'tab-a',
      tabs: [
        {
          id: 'tab-a',
          title: 'app',
          layout: 'main-stack',
          panes: [
            { id: 'p1', sessionUid: 's1', label: 'server', color: '#e5484d', status: 'running', activity: 'busy' },
            { id: 'p2', sessionUid: 's2', label: 'logs', color: '#000', status: 'exited', exitCode: 0, activity: 'exited' }
          ]
        },
        { id: 'tab-b', title: 'scratch', layout: 'columns', panes: [{ id: 'p3', sessionUid: 's3', label: 'sh', color: '#fff', status: 'running', activity: 'idle', meta: { role: 'worker' } }] }
      ]
    },
    { windowId: 2, activeTabId: 'tab-c', tabs: [{ id: 'tab-c', title: 'db', layout: 'single', panes: [{ id: 'p4', sessionUid: 's4', label: 'psql', color: '#abc', status: 'running', activity: 'busy' }] }] }
  ]
};

describe('flattenPanes', () => {
  it('flattens with window/tab context and active flag', () => {
    const flat = flattenPanes(state);
    expect(flat).toHaveLength(4);
    expect(flat[0]).toMatchObject({ windowId: 1, tabId: 'tab-a', tabTitle: 'app', layout: 'main-stack', activeTab: true });
    expect(flat[2]).toMatchObject({ tabId: 'tab-b', activeTab: false }); // p3 in non-active tab
    expect(flat[3]).toMatchObject({ windowId: 2, tabId: 'tab-c', activeTab: true });
  });

  it('carries the tab colour as tabColor, null when unset or absent (older apps)', () => {
    const colored: ControlState = {
      windows: [
        {
          windowId: 1,
          activeTabId: 't1',
          tabs: [
            { id: 't1', title: 'a', color: '#aabbcc', layout: 'auto', panes: [{ id: 'p1', sessionUid: 's1', label: 'x', color: '#fff', status: 'running', activity: 'idle' }] },
            { id: 't2', title: 'b', color: null, layout: 'auto', panes: [{ id: 'p2', sessionUid: 's2', label: 'y', color: '#fff', status: 'running', activity: 'idle' }] }
          ]
        }
      ]
    };
    const flat = flattenPanes(colored);
    expect(flat[0]?.tabColor).toBe('#aabbcc');
    expect(flat[1]?.tabColor).toBeNull();
    // A tab without the key at all (an app that predates tab colours) reads as null too.
    expect(flattenPanes(state)[0]?.tabColor).toBeNull();
  });

  it('carries pane activity + meta through to the flattened pane', () => {
    const flat = flattenPanes(state);
    expect(flat[0]).toMatchObject({ pane: { activity: 'busy' } });
    expect(flat[1]).toMatchObject({ pane: { activity: 'exited' } });
    expect(flat[2]).toMatchObject({ pane: { activity: 'idle', meta: { role: 'worker' } } });
  });
});

describe('window/tab resolution', () => {
  it('resolveWindowIdForTab finds the owning window', () => {
    expect(resolveWindowIdForTab(state, 'tab-b')).toBe(1);
    expect(resolveWindowIdForTab(state, 'tab-c')).toBe(2);
    expect(resolveWindowIdForTab(state, 'nope')).toBeUndefined();
  });
  it('firstWindowId / firstWindowActiveTabId', () => {
    expect(firstWindowId(state)).toBe(1);
    expect(firstWindowActiveTabId(state)).toBe('tab-a');
    expect(firstWindowId({ windows: [] })).toBeUndefined();
  });
});

describe('sessionPaneMap', () => {
  it('maps sessionUid -> paneId for every pane', () => {
    const m = sessionPaneMap(state);
    expect(m.get('s1')).toBe('p1');
    expect(m.get('s4')).toBe('p4');
    expect(m.size).toBe(4);
  });
});

describe('pane output URI', () => {
  it('round-trips, encoding odd ids', () => {
    expect(paneOutputUri('p1')).toBe('hyperpanes://pane/p1/output');
    expect(paneIdFromUri('hyperpanes://pane/p1/output')).toBe('p1');
    const odd = 'a/b c';
    expect(paneIdFromUri(paneOutputUri(odd))).toBe(odd);
  });
  it('rejects non-pane URIs', () => {
    expect(paneIdFromUri('hyperpanes://pane//output')).toBeUndefined();
    expect(paneIdFromUri('file:///x')).toBeUndefined();
  });
});

describe('pane messages URI', () => {
  it('round-trips and is distinct from the output URI', () => {
    expect(paneMessagesUri('p1')).toBe('hyperpanes://pane/p1/output'.replace('/output', '/messages'));
    expect(paneIdFromMessagesUri(paneMessagesUri('p1'))).toBe('p1');
    // The output decoder rejects a messages URI and vice-versa.
    expect(paneIdFromUri(paneMessagesUri('p1'))).toBeUndefined();
    expect(paneIdFromMessagesUri(paneOutputUri('p1'))).toBeUndefined();
  });
});

describe('resolveWhoami', () => {
  const withMeta: ControlState = {
    windows: [
      {
        windowId: 1,
        activeTabId: 't',
        tabs: [
          {
            id: 't',
            title: 'team',
            layout: 'columns',
            panes: [
              {
                id: 'mgr',
                sessionUid: 's',
                label: 'manager',
                color: '#fff',
                status: 'running',
                activity: 'busy',
                meta: { role: 'manager:frontend', parent: 'ceo', agentType: 'claude', task: 'ship' }
              }
            ]
          }
        ]
      }
    ]
  };

  it('returns identity + reserved meta keys + context', () => {
    expect(resolveWhoami(withMeta, 'mgr')).toEqual({
      paneId: 'mgr',
      role: 'manager:frontend',
      parent: 'ceo',
      agentType: 'claude',
      task: 'ship',
      meta: { role: 'manager:frontend', parent: 'ceo', agentType: 'claude', task: 'ship' },
      windowId: 1,
      tabId: 't',
      tabTitle: 'team',
      tabStatus: 'working'
    });
  });

  it('is null for an unknown pane', () => {
    expect(resolveWhoami(withMeta, 'ghost')).toBeNull();
  });
});

describe('subtreePaneIds (org tree via meta.parent)', () => {
  // ceo → mgr → {w1, w2}; lone has no parent.
  const tree: ControlState = {
    windows: [
      {
        windowId: 1,
        activeTabId: 't',
        tabs: [
          {
            id: 't',
            title: 'org',
            layout: 'grid',
            panes: [
              { id: 'ceo', sessionUid: 's0', label: 'ceo', color: '#000', status: 'running', activity: 'idle' },
              { id: 'mgr', sessionUid: 's1', label: 'mgr', color: '#111', status: 'running', activity: 'idle', meta: { parent: 'ceo' } },
              { id: 'w1', sessionUid: 's2', label: 'w1', color: '#222', status: 'running', activity: 'busy', meta: { parent: 'mgr' } },
              { id: 'w2', sessionUid: 's3', label: 'w2', color: '#333', status: 'running', activity: 'busy', meta: { parent: 'mgr' } },
              { id: 'lone', sessionUid: 's4', label: 'lone', color: '#444', status: 'running', activity: 'busy' }
            ]
          }
        ]
      }
    ]
  };

  it('collects descendants through the parent chain, excluding the root', () => {
    expect(subtreePaneIds(tree, 'ceo').sort()).toEqual(['mgr', 'w1', 'w2']);
    expect(subtreePaneIds(tree, 'mgr').sort()).toEqual(['w1', 'w2']);
    expect(subtreePaneIds(tree, 'w1')).toEqual([]); // leaf
    expect(subtreePaneIds(tree, 'lone')).toEqual([]); // no children
  });
});

describe('tab status', () => {
  const mk = (activity: 'busy' | 'idle' | 'exited', i = 0) => ({
    id: `p${i}`,
    sessionUid: `s${i}`,
    label: 'x',
    color: '#fff',
    status: activity === 'exited' ? ('exited' as const) : ('running' as const),
    activity
  });
  it('passes the app-sent status through', () => {
    expect(tabStatusOf({ id: 't', title: 't', layout: 'auto', status: 'working', panes: [mk('idle')] })).toBe('working');
    expect(tabStatusOf({ id: 't', title: 't', layout: 'auto', status: 'idle', panes: [mk('busy')] })).toBe('idle');
  });
  it('derives working when any pane is busy', () => {
    expect(tabStatusOf({ id: 't', title: 't', layout: 'auto', panes: [mk('busy', 1), mk('idle', 2), mk('exited', 3)] })).toBe('working');
  });
  it('derives idle for idle + exited panes and for an empty tab', () => {
    expect(tabStatusOf({ id: 't', title: 't', layout: 'auto', panes: [mk('idle', 1), mk('exited', 2)] })).toBe('idle');
    expect(tabStatusOf({ id: 't', title: 't', layout: 'auto', panes: [] })).toBe('idle');
  });
  it('flattenPanes carries tabStatus', () => {
    const flat = flattenPanes(state);
    expect(flat[0]?.tabStatus).toBe('working'); // tab-a has a busy pane
    expect(flat[2]?.tabStatus).toBe('idle'); // tab-b only idle
  });
});
