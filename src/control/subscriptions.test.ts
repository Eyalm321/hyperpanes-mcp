import { describe, it, expect, vi } from 'vitest';
import { PaneSubscriptions, type EventConnection, type SubscriptionDeps } from './subscriptions.js';
import { paneOutputUri, paneMessagesUri, type ControlEvent, type ControlState } from './model.js';

const emptyState: ControlState = { windows: [] };

function makeSubs(overrides: Partial<SubscriptionDeps> = {}) {
  const updated: string[] = [];
  let listChanged = 0;
  let opened = 0;
  let closed = 0;
  const conn: EventConnection = { close: () => { closed++; } };
  const subs = new PaneSubscriptions({
    eventsUrl: () => 'ws://127.0.0.1:1/events?token=t',
    fetchState: async () => emptyState,
    onUpdated: (uri) => updated.push(uri),
    onListChanged: () => { listChanged++; },
    connect: () => { opened++; return conn; },
    ...overrides
  });
  return { subs, updated, get listChanged() { return listChanged; }, get opened() { return opened; }, get closed() { return closed; } };
}

describe('PaneSubscriptions.handleEvent', () => {
  it('emits updated for a subscribed pane on output (by paneId)', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneOutputUri('p1'));
    h.subs.handleEvent({ type: 'output', sessionUid: 's1', paneId: 'p1', data: 'x' });
    expect(h.updated).toEqual([paneOutputUri('p1')]);
  });

  it('ignores output for an unsubscribed pane', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneOutputUri('p1'));
    h.subs.handleEvent({ type: 'output', sessionUid: 's2', paneId: 'p2', data: 'x' });
    expect(h.updated).toEqual([]);
  });

  it('resolves a null paneId via the sessionUid map', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneOutputUri('p9'));
    h.subs.setSessionMap(new Map([['s9', 'p9']]));
    h.subs.handleEvent({ type: 'exit', sessionUid: 's9', paneId: null, code: 0 } as ControlEvent);
    expect(h.updated).toEqual([paneOutputUri('p9')]);
  });

  it('emits list_changed on a state event', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneOutputUri('p1'));
    h.subs.handleEvent({ type: 'state' });
    expect(h.listChanged).toBe(1);
  });

  it('emits list_changed on an activity event — the headline orchestration signal (#1)', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneOutputUri('p1'));
    // An activity flip is no longer dropped: it nudges the client to re-enumerate
    // (re-reading the pane's new liveness from list_panes) instead of polling.
    h.subs.handleEvent({ type: 'activity', paneId: 'p1', activity: 'idle' });
    expect(h.listChanged).toBe(1);
  });

  it('emits updated for a subscribed messages resource on a message event (E)', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneMessagesUri('p1'));
    h.subs.handleEvent({ type: 'message', to: 'p1', from: 'mgr', seq: 3, body: 'go' });
    expect(h.updated).toEqual([paneMessagesUri('p1')]);
  });

  it('ignores a message for an unsubscribed pane / wrong resource', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneOutputUri('p1')); // output, not messages
    h.subs.handleEvent({ type: 'message', to: 'p1', from: 'mgr', seq: 1, body: 'x' });
    h.subs.handleEvent({ type: 'message', to: 'p2', from: 'mgr', seq: 2, body: 'y' });
    expect(h.updated).toEqual([]);
  });
});

describe('PaneSubscriptions lifecycle', () => {
  it('opens one connection on first subscribe and closes after last unsubscribe', async () => {
    const h = makeSubs();
    await h.subs.subscribe(paneOutputUri('p1'));
    await h.subs.subscribe(paneOutputUri('p2'));
    expect(h.opened).toBe(1); // single shared connection
    expect(h.subs.size).toBe(2);
    h.subs.unsubscribe(paneOutputUri('p1'));
    expect(h.closed).toBe(0); // still one sub left
    h.subs.unsubscribe(paneOutputUri('p2'));
    expect(h.closed).toBe(1);
    expect(h.subs.size).toBe(0);
  });

  it('does not open a connection when the app is unavailable', async () => {
    const h = makeSubs({ eventsUrl: () => null });
    await h.subs.subscribe(paneOutputUri('p1'));
    expect(h.opened).toBe(0);
  });
});
