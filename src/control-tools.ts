import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LayoutSchema, GroupSpecSchema } from './schema.js';
import { ControlUnavailableError, readDiscovery, controlFilePath } from './control/discovery.js';
import { ControlClient } from './control/client.js';
import {
  flattenPanes,
  firstWindowId,
  firstWindowActiveTabId,
  paneOutputUri,
  paneMessagesUri,
  resolveWindowIdForTab,
  resolveWhoami,
  subtreePaneIds,
  type ControlState
} from './control/model.js';
import { checkInputAllowed, readInputGate } from './control/input-gate.js';
import { PaneSubscriptions } from './control/subscriptions.js';

function json(data: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError };
}

/** Open a fresh client from the current control.json (throws ControlUnavailable). */
function openClient(): ControlClient {
  return new ControlClient(readDiscovery());
}

/** Wrap a control operation, turning unavailability/errors into tool error results. */
async function run(fn: (c: ControlClient) => Promise<unknown>) {
  let client: ControlClient;
  try {
    client = openClient();
  } catch (err) {
    return json({ ok: false, error: errMessage(err), controlFile: controlFilePath() }, true);
  }
  try {
    return json(await fn(client));
  } catch (err) {
    return json({ ok: false, error: errMessage(err) }, true);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Heuristic: did a `prompt_pane` submit fail to register? A freshly-launched TUI
 * can drop the trailing bare CR that submits a line — its input loop isn't armed
 * yet, so the text lands in the input box but is never sent (cold-start race; see
 * the app's control-input.ts "live finding, 2026-06-05"). The turn-aware wait is
 * no help on its own: the paste ECHO advances output past the cursor, so the read
 * still reports `settled:true` exactly as a real turn would. The tell is the
 * CONTENT — only our own keystrokes came back, with no reply after them.
 *
 * We compare the raw output delta (everything the pane emitted since just before
 * the send) against the text we typed, both reduced to alphanumerics. After
 * removing the echo, a genuine reply leaves a substantial residual; a dropped
 * submit leaves only input-box / status-line redraw noise.
 *
 * Tuned to err toward retrying: a false positive costs one extra bare Enter,
 * which is a no-op in an already-empty input box, whereas a false negative leaves
 * the prompt stuck unsent. A `timedOut` turn means the agent is still working
 * (output never went quiet) — NOT a dropped submit — so those never qualify.
 */
export function submitLikelyDropped(
  rawDelta: string,
  text: string,
  settled: boolean,
  timedOut: boolean
): boolean {
  if (!settled || timedOut) return false;
  const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const deltaNorm = norm(rawDelta);
  const textNorm = norm(text);
  const echoIdx = textNorm.length > 0 ? deltaNorm.indexOf(textNorm) : -1;
  // Strip one occurrence of the echoed text; what's left should be a real reply
  // (large) or just redraw chrome (small). When the echo wrapped oddly and isn't
  // a clean substring, fall back to a length subtraction.
  const residualLen =
    echoIdx >= 0 ? deltaNorm.length - textNorm.length : Math.max(0, deltaNorm.length - textNorm.length);
  // Below this many alphanumerics beyond the echo, nothing but input-box / status
  // redraw came back — no reply. A genuine reply dwarfs it.
  const ECHO_NOISE_CEILING = 64;
  return residualLen <= ECHO_NOISE_CEILING;
}

/**
 * Register Phase 2 (M4) live-control tools and the subscribable pane-output
 * resource on an McpServer. The server must declare the
 * `resources: { subscribe, listChanged }` capability (see server.ts).
 */
export function registerControlTools(server: McpServer): void {
  // ---- control_status (read-only diagnostics) --------------------------
  server.registerTool(
    'control_status',
    {
      title: 'Control status',
      description:
        'Check whether the hyperpanes control API is reachable and whether input is allowed. Reports the app pid/version, the bridge-side send_input gate, and the control.json path. Call this first if other control tools fail.'
    },
    async () => {
      let client: ControlClient;
      try {
        client = openClient();
      } catch (err) {
        return json({
          available: false,
          reason: errMessage(err),
          controlFile: controlFilePath(),
          inputGate: readInputGate()
        });
      }
      try {
        const health = await client.health();
        const state = await client.state();
        return json({
          available: true,
          port: client.discovery.port,
          pid: health.pid,
          version: health.version,
          appAllowsInput: health.allowInput,
          windows: state.windows.length,
          panes: flattenPanes(state).length,
          inputGate: readInputGate()
        });
      } catch (err) {
        return json({ available: false, reason: errMessage(err), inputGate: readInputGate() });
      }
    }
  );

  // ---- list_panes ------------------------------------------------------
  server.registerTool(
    'list_panes',
    {
      title: 'List panes',
      description:
        'List all panes across all windows/tabs of the running hyperpanes instance, with status, activity (busy/idle/exited liveness heuristic), any org metadata (role/parent/agentType/task), tab/window context, and the resource URI for streaming each pane\'s output.'
    },
    async () =>
      run(async (c) => {
        const state = await c.state();
        return {
          ok: true,
          panes: flattenPanes(state).map(({ pane, windowId, tabId, tabTitle, layout, activeTab }) => ({
            paneId: pane.id,
            label: pane.label,
            // Secondary header line, omitted when unset (set via rename_pane).
            ...(pane.subtitle ? { subtitle: pane.subtitle } : {}),
            status: pane.status,
            // Liveness heuristic: 'idle' ≈ waiting at its prompt / done, 'busy' =
            // recently emitting output, 'exited' = gone. Not a "task complete" guarantee.
            activity: pane.activity,
            exitCode: pane.exitCode,
            command: pane.command,
            // Direct-spawn argv (P4a), omitted when the pane uses the shell path.
            ...(pane.args && pane.args.length ? { args: pane.args } : {}),
            cwd: pane.cwd,
            shell: pane.shell,
            color: pane.color,
            // Free-form org metadata (role/parent/agentType/task), omitted when unset.
            ...(pane.meta ? { meta: pane.meta } : {}),
            windowId,
            tabId,
            tabTitle,
            layout,
            activeTab,
            outputResource: paneOutputUri(pane.id)
          }))
        };
      })
  );

  // ---- read_pane -------------------------------------------------------
  server.registerTool(
    'read_pane',
    {
      title: 'Read pane output',
      description:
        'Read a pane\'s terminal output. `mode:"screen"` returns the RENDERED cell grid (what\'s actually on screen — no overdraw, spinner spam, or mangled spacing) instead of the raw pty stream; use it to read a TUI agent\'s transcript cleanly (default "raw"). `tail` limits to the last N lines; `strip` removes ANSI escape codes from a raw read. `waitForIdle` BLOCKS until the pane has been output-quiet for `settleMs` (default 600ms) or `timeoutMs` (default 30000ms) elapses — the way to read a reply without polling/sleeping. `since` is a byte cursor (use the `cursor` from a prior read) that returns only NEW output (raw mode), so you don\'t re-scrape the whole scrollback each turn. Every read returns the current `cursor`. For continuous streaming, subscribe to the pane\'s output resource instead.',
      inputSchema: {
        paneId: z.string(),
        mode: z
          .enum(['raw', 'screen'])
          .optional()
          .describe('"screen" = rendered cell grid (clean TUI transcript); "raw" (default) = pty byte stream'),
        tail: z.number().int().positive().optional(),
        strip: z.boolean().optional(),
        since: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('byte cursor from a prior read\'s `cursor`; returns only output produced since'),
        waitForIdle: z
          .boolean()
          .optional()
          .describe('block until the pane is output-quiet for settleMs (or timeoutMs)'),
        settleMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('quiet window that ends a waitForIdle read (default 600ms; raise for slow models)'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('max time to block on waitForIdle before returning what is there (default 30000ms)')
      }
    },
    async ({ paneId, mode, tail, strip, since, waitForIdle, settleMs, timeoutMs }) =>
      run(async (c) => ({
        ok: true,
        ...(await c.readPane(paneId, { mode, tail, strip, since, waitForIdle, settleMs, timeoutMs }))
      }))
  );

  // ---- open_pane -------------------------------------------------------
  server.registerTool(
    'open_pane',
    {
      title: 'Open pane',
      description:
        'Open a new pane in the active tab of a window (defaults to the first window). Returns the new paneId. `command` alone runs through the shell. Pass `args` (a string array) to run `command` DIRECTLY as the executable with that exact argv — no shell, no re-parse — which is the reliable way to pass arguments containing spaces or quotes (e.g. command:"claude", args:["--append-system-prompt","…long persona…"]); a single `command` string with such args gets mangled by the shell. `meta` attaches free-form org metadata (reserved keys: role/parent/agentType/task) so the new worker is self-describing.',
      inputSchema: {
        command: z.string().optional(),
        args: z
          .array(z.string())
          .optional()
          .describe(
            'With `command`: run it directly with this verbatim argv (no shell re-parse). Each element is one argument — do NOT pre-quote.'
          ),
        label: z.string().optional(),
        cwd: z.string().optional(),
        shell: z.string().optional(),
        color: z.string().optional(),
        meta: z.record(z.string(), z.string()).optional(),
        // Extra pty env (agent-orchestration F). To staff a subtree-scoped worker,
        // mint_token a scoped token and pass { HYPERPANES_CONTROL_TOKEN: <token>,
        // HYPERPANES_CONTROL_PORT: <port> } here — the child then reaches only its
        // subtree, and is NOT given the master control.json.
        env: z.record(z.string(), z.string()).optional(),
        windowId: z.number().int().optional()
      }
    },
    async ({ command, args, label, cwd, shell, color, meta, env, windowId }) =>
      run(async (c) => {
        const state = await c.state();
        const target = windowId ?? firstWindowId(state);
        if (target == null) throw new Error('no windows open to add a pane to');
        const res = await c.command({
          type: 'newPane',
          windowId: target,
          pane: { label, command, args, cwd, shell, color, meta, env }
        });
        // The app returns the new pane id via the command round-trip (D). A
        // missing id means the round-trip failed (a timed-out/wedged renderer now
        // surfaces as a 5xx that c.command throws, but guard the resultless case
        // too) — surface it as an error rather than a phantom success (#2).
        const paneId = typeof res.result === 'string' ? res.result : undefined;
        if (!paneId) throw new Error('app accepted newPane but returned no pane id (renderer reply lost?)');
        // Wait for the pane to land in the read-model so an immediate read_pane /
        // prompt_pane doesn't 404 — the structure publish is debounced (see
        // waitForPane). `ready:false` means it didn't appear in time (rare); the
        // pane still exists, the read-model just lagged unusually.
        const ready = await c.waitForPane(paneId);
        return { ok: true, windowId: target, paneId, ready };
      })
  );

  // ---- open_tab --------------------------------------------------------
  server.registerTool(
    'open_tab',
    {
      title: 'Open tab(s)',
      description:
        'Attach one or more new tabs to an existing window (defaults to the first window), each with fresh shells — the programmatic equivalent of `hyperpanes --attach`. Returns the new tab ids. Use this (not open_pane) to add a whole tab, or several tabs, in one call. Pass `as:"panes"` to instead merge ALL the given panes into the window\'s ACTIVE tab (returns the new pane ids). Each group is one tab: { title?, layout?, panes:[{ command?, args?, label?, cwd?, shell?, color?, meta? }] }.',
      inputSchema: {
        groups: z.array(GroupSpecSchema).min(1),
        as: z.enum(['tab', 'panes']).optional(),
        windowId: z.number().int().optional()
      }
    },
    async ({ groups, as, windowId }) =>
      run(async (c) => {
        const state = await c.state();
        const target = windowId ?? firstWindowId(state);
        if (target == null) throw new Error('no windows open to attach to');
        const unit = as ?? 'tab';
        // The app returns the new tab ids (unit:'tab') or pane ids (unit:'panes')
        // via the command round-trip (D), mirroring newPane → id.
        const res = await c.command({ type: 'attach', windowId: target, groups, as: unit });
        const ids = Array.isArray(res.result) ? (res.result as string[]) : [];
        return { ok: true, windowId: target, as: unit, ids };
      })
  );

  // ---- set_meta --------------------------------------------------------
  server.registerTool(
    'set_meta',
    {
      title: 'Set pane metadata',
      description:
        'Attach or update free-form metadata on a pane (merged: a string value sets/overwrites a key, an explicit null DELETES that key, untouched keys are kept). Reserved keys role/parent/agentType/task describe an agent org; the rest is open. Returns the TRUE merged metadata read back from the app (not your raw input). This is how an orchestrator records the org chart as data.',
      inputSchema: {
        paneId: z.string(),
        meta: z
          .record(z.string(), z.union([z.string(), z.null()]))
          .describe('key→string sets/overwrites it; key→null deletes it')
      }
    },
    async ({ paneId, meta }) =>
      run(async (c) => {
        // The app echoes the TRUE merged meta (deletes applied, prior keys retained)
        // as the command result, mirroring newPane → id. Use it directly instead of
        // re-reading /state: that read races the renderer's debounced control-publish
        // and returns a pre-merge snapshot, so just-set keys appear hundreds of ms
        // late (the #7 echo race). This also drops an extra HTTP round-trip.
        const res = await c.command({ type: 'setMeta', paneId, meta });
        const merged = (res.result ?? {}) as Record<string, string>;
        return { ok: true, paneId, meta: merged };
      })
  );

  // ---- set_layout ------------------------------------------------------
  server.registerTool(
    'set_layout',
    {
      title: 'Set tab layout',
      description:
        'Set the tiling layout of a tab. `tabId` defaults to the active tab of the first window. Use list_layouts for valid ids.',
      inputSchema: {
        layout: LayoutSchema,
        tabId: z.string().optional()
      }
    },
    async ({ layout, tabId }) =>
      run(async (c) => {
        const state = await c.state();
        const targetTab = tabId ?? firstWindowActiveTabId(state);
        if (!targetTab) throw new Error('no tab to set a layout on');
        const windowId = resolveWindowIdForTab(state, targetTab);
        if (windowId == null) throw new Error(`unknown tabId: ${targetTab}`);
        await c.command({ type: 'setLayout', layout, tabId: targetTab, windowId });
        return { ok: true, tabId: targetTab, layout };
      })
  );

  // ---- focus_pane / close_pane / restart_pane --------------------------
  const paneCommand = (
    name: string,
    title: string,
    type: 'focusPane' | 'closePane' | 'restartPane',
    description: string
  ) =>
    server.registerTool(name, { title, description, inputSchema: { paneId: z.string() } }, async ({ paneId }) =>
      run(async (c) => {
        await c.command({ type, paneId });
        return { ok: true, paneId, action: type };
      })
    );

  paneCommand('focus_pane', 'Focus pane', 'focusPane', 'Focus a pane (and its tab/window).');
  paneCommand('close_pane', 'Close pane', 'closePane', 'Close a pane, terminating its shell.');
  paneCommand('restart_pane', 'Restart pane', 'restartPane', 'Kill and respawn a pane\'s shell.');

  // ---- rename_pane / recolor_pane (live header edits) ------------------
  server.registerTool(
    'rename_pane',
    {
      title: 'Rename pane',
      description:
        'Change a pane\'s label (title) and, optionally, its subtitle — applied live to the pane header. Pass subtitle:"" to clear it; omit subtitle to leave it unchanged.',
      inputSchema: {
        paneId: z.string(),
        label: z.string(),
        subtitle: z.string().optional().describe('"" clears it; omit to leave as-is')
      }
    },
    async ({ paneId, label, subtitle }) =>
      run(async (c) => {
        await c.command({
          type: 'renamePane',
          paneId,
          label,
          ...(subtitle !== undefined ? { subtitle } : {})
        });
        return { ok: true, paneId, label, ...(subtitle !== undefined ? { subtitle } : {}) };
      })
  );

  server.registerTool(
    'recolor_pane',
    {
      title: 'Recolor pane',
      description:
        'Change a pane\'s frame color, applied live. Accepts any CSS color string (e.g. "#e5484d").',
      inputSchema: { paneId: z.string(), color: z.string() }
    },
    async ({ paneId, color }) =>
      run(async (c) => {
        await c.command({ type: 'recolorPane', paneId, color });
        return { ok: true, paneId, color };
      })
  );

  // ---- send_input (GUARDED — the sharp edge) ---------------------------
  server.registerTool(
    'send_input',
    {
      title: 'Send input to a pane',
      description:
        'Type text into a live shell. With `submit:true` the app writes your text, then a SEPARATE bare Enter a beat later — the reliable way to submit a line to a TUI agent (a trailing "\\n" in one write is read as a bracketed paste, not Enter). Without submit, include a trailing newline yourself to run a shell command. DANGEROUS: this executes whatever you send in a real terminal. Triple-gated and never on by default — requires (1) the app\'s "Allow agent control → input" toggle, (2) HYPERPANES_ALLOW_INPUT=1 on this bridge, and (3) confirm=true on every call. See README "send_input safety model".',
      inputSchema: {
        paneId: z.string(),
        data: z.string().describe('Exact bytes to write. With submit:true, pass the line WITHOUT a trailing newline.'),
        submit: z
          .boolean()
          .optional()
          .describe('Write a bare Enter as a separate keystroke after the text (submits a TUI line cleanly).'),
        submitDelayMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Beat between the text and the Enter when submit:true (default ~40ms; raise for slow TUIs).'),
        confirm: z.boolean().optional().describe('Must be true — explicit per-call confirmation.'),
        owner: z
          .string()
          .optional()
          .describe('Lock owner, if the pane was locked via lock_pane — required to write a locked pane.')
      }
    },
    async ({ paneId, data, submit, submitDelayMs, confirm, owner }) =>
      run(async (c) => {
        const state = await c.state();
        const found = flattenPanes(state).find((p) => p.pane.id === paneId);
        if (!found) throw new Error(`no such pane: ${paneId}`);
        const decision = checkInputAllowed(readInputGate(), { confirm }, found.pane);
        if (!decision.ok) return { ok: false, refused: true, reason: decision.reason };
        await c.sendInput(paneId, data, owner, submit, submitDelayMs);
        return { ok: true, paneId, bytes: data.length, submitted: submit === true };
      })
  );

  // ---- send_keys (GUARDED — also input) --------------------------------
  server.registerTool(
    'send_keys',
    {
      title: 'Send named keys to a pane',
      description:
        'Send a sequence of named keys to a live pane as the right terminal bytes: enter, escape, tab, shift+tab, up/down/left/right, home/end, pageup/pagedown, backspace, delete, space, and ctrl+<letter> (e.g. ctrl+c). For menus, y/n and trust prompts, and cancelling — things a text string can\'t express. Same triple gate as send_input (it IS input): app toggle + HYPERPANES_ALLOW_INPUT=1 + confirm=true.',
      inputSchema: {
        paneId: z.string(),
        keys: z.array(z.string()).describe('Ordered key names, e.g. ["enter"] or ["ctrl+c"] or ["down","down","enter"].'),
        confirm: z.boolean().optional().describe('Must be true — explicit per-call confirmation.'),
        owner: z.string().optional().describe('Lock owner, if the pane was locked via lock_pane.')
      }
    },
    async ({ paneId, keys, confirm, owner }) =>
      run(async (c) => {
        const state = await c.state();
        const found = flattenPanes(state).find((p) => p.pane.id === paneId);
        if (!found) throw new Error(`no such pane: ${paneId}`);
        const decision = checkInputAllowed(readInputGate(), { confirm }, found.pane);
        if (!decision.ok) return { ok: false, refused: true, reason: decision.reason };
        await c.sendKeys(paneId, keys, owner);
        return { ok: true, paneId, keys };
      })
  );

  // ---- prompt_pane (GUARDED — the one-call TUI turn) -------------------
  server.registerTool(
    'prompt_pane',
    {
      title: 'Prompt a pane and read the reply',
      description:
        'Drive one full turn of a TUI agent (e.g. a live `claude`) in a pane with ONE call: type `text`, submit it cleanly (a separate Enter), wait for the pane to go output-quiet, then return the RENDERED screen transcript and whether it is now awaiting input. The wait is turn-aware — it won\'t return on the pre-prompt screen, only once the reply has begun and settled. Composes send_input(submit) + read_pane(waitForIdle, mode:"screen"). Same triple gate as send_input (it IS input): app toggle + HYPERPANES_ALLOW_INPUT=1 + confirm=true.',
      inputSchema: {
        paneId: z.string(),
        text: z.string().describe('The message to type. No trailing newline needed — it is submitted for you.'),
        confirm: z.boolean().optional().describe('Must be true — explicit per-call confirmation.'),
        owner: z.string().optional().describe('Lock owner, if the pane was locked via lock_pane.'),
        settleMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Quiet window that ends the wait (default 600ms; raise for slow models).'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max time to wait for the reply (default 30000ms).'),
        tail: z.number().int().positive().optional().describe('Limit the returned transcript to its last N lines.')
      }
    },
    async ({ paneId, text, confirm, owner, settleMs, timeoutMs, tail }) =>
      run(async (c) => {
        const state = await c.state();
        const found = flattenPanes(state).find((p) => p.pane.id === paneId);
        if (!found) throw new Error(`no such pane: ${paneId}`);
        const decision = checkInputAllowed(readInputGate(), { confirm }, found.pane);
        if (!decision.ok) return { ok: false, refused: true, reason: decision.reason };
        // Snapshot the byte cursor BEFORE sending so the wait is turn-aware: it
        // won't settle until output advances past here (the reply has begun).
        const before = await c.readPane(paneId);
        const readReply = () =>
          c.readPane(paneId, { since: before.cursor, waitForIdle: true, settleMs, timeoutMs, mode: 'screen', tail });
        await c.sendInput(paneId, text, owner, true);
        let reply = await readReply();
        // Cold-start self-heal: a just-launched TUI can swallow the first submit's
        // bare CR, leaving the text typed but unsent (see submitLikelyDropped).
        // If the turn came back as echo-with-no-reply AND this pane is still early
        // in its life (small byte cursor ⇒ the only window the drop happens in),
        // fire one corrective Enter and re-read. The extra CR is a no-op if the
        // box turned out to be empty, so a misfire is harmless. Capped at one try.
        const COLD_START_BYTES = 16_000;
        let recovered = false;
        if ((before.cursor ?? 0) < COLD_START_BYTES) {
          const delta = await c.readPane(paneId, { since: before.cursor, strip: true });
          if (submitLikelyDropped(delta.output ?? '', text, reply.settled ?? false, reply.timedOut ?? false)) {
            await c.sendInput(paneId, '', owner, true); // bare Enter — submit what's sitting in the box
            reply = await readReply();
            recovered = true;
          }
        }
        return {
          ok: true,
          paneId,
          settled: reply.settled ?? false,
          timedOut: reply.timedOut ?? false,
          awaitingInput: reply.awaitingInput ?? false,
          cursor: reply.cursor,
          ...(recovered ? { recovered: true } : {}),
          reply: reply.output
        };
      })
  );

  registerMessagingTools(server);
  registerScopeAndLockTools(server);

  // ---- pane output + messages as subscribable resources ----------------
  registerPaneResources(server);
}

// ---- agent-orchestration E (message bus) + whoami --------------------
function registerMessagingTools(server: McpServer): void {
  // whoami — pane self-awareness. Reads HYPERPANES_PANE_ID from this bridge's env
  // (set when the bridge runs inside a hyperpanes pane) and enriches it from /state.
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Identify the pane this MCP bridge is running inside (from HYPERPANES_PANE_ID) and report its org metadata (role/parent/agentType/task) + window/tab context. The recursion enabler: a manager-agent-in-a-pane calls this to learn who it is before driving its sub-workers. Optionally pass paneId to describe a specific pane instead.',
      inputSchema: { paneId: z.string().optional() }
    },
    async ({ paneId }) =>
      run(async (c) => {
        const self = paneId ?? process.env.HYPERPANES_PANE_ID;
        if (!self) {
          return {
            ok: false,
            error:
              'HYPERPANES_PANE_ID is not set — this bridge is not running inside a hyperpanes pane. Pass paneId explicitly.'
          };
        }
        const who = resolveWhoami(await c.state(), self);
        if (!who) return { ok: false, error: `pane ${self} not found in /state (out of scope?)` };
        return { ok: true, ...who };
      })
  );

  // read_messages — drain a pane's durable inbox past a cursor.
  server.registerTool(
    'read_messages',
    {
      title: 'Read pane messages',
      description:
        'Read a pane\'s durable message inbox (agent-orchestration E). `after` is a cursor — pass the highest seq you have seen to get only newer messages. `dropped` reports how many were evicted by the per-pane cap. For live delivery, subscribe to the pane\'s messages resource instead of polling.',
      inputSchema: {
        paneId: z.string(),
        after: z.number().int().nonnegative().optional()
      }
    },
    async ({ paneId, after }) => run(async (c) => ({ ok: true, ...(await c.readMessages(paneId, after)) }))
  );

  // send_message — enqueue a message to any pane (bus is hierarchy-agnostic).
  server.registerTool(
    'send_message',
    {
      title: 'Send a message to a pane',
      description:
        'Enqueue a structured message to a pane\'s durable inbox (agent-orchestration E). Delivered at-least-once; the target reads it via read_messages or its messages resource. `from` should identify the sender (your paneId, or an orchestrator label).',
      inputSchema: {
        to: z.string().describe('target paneId'),
        body: z.string(),
        from: z.string().optional().describe('sender id; defaults to this bridge\'s HYPERPANES_PANE_ID or "orchestrator"')
      }
    },
    async ({ to, body, from }) =>
      run(async (c) => {
        const sender = from ?? process.env.HYPERPANES_PANE_ID ?? 'orchestrator';
        const sent = await c.sendMessage(to, sender, body);
        return { ok: true, to, from: sender, seq: sent.seq };
      })
  );

  // send_to_parent — message this pane's org parent (meta.parent). Hierarchy
  // helper built on meta; the bus itself stays hierarchy-agnostic.
  server.registerTool(
    'send_to_parent',
    {
      title: 'Send a message to my parent',
      description:
        'Message this pane\'s org parent — resolved from its meta.parent (agent-orchestration E). Requires HYPERPANES_PANE_ID (this bridge runs inside a pane), or pass `from` explicitly. Errors if the pane has no parent set.',
      inputSchema: {
        body: z.string(),
        from: z.string().optional().describe('this pane\'s id; defaults to HYPERPANES_PANE_ID')
      }
    },
    async ({ body, from }) =>
      run(async (c) => {
        const self = from ?? process.env.HYPERPANES_PANE_ID;
        if (!self) return { ok: false, error: 'HYPERPANES_PANE_ID not set; pass `from`' };
        const who = resolveWhoami(await c.state(), self);
        if (!who) return { ok: false, error: `pane ${self} not found (out of scope?)` };
        if (!who.parent) return { ok: false, error: `pane ${self} has no meta.parent` };
        const sent = await c.sendMessage(who.parent, self, body);
        return { ok: true, to: who.parent, from: self, seq: sent.seq };
      })
  );

  // broadcast_subtree — message every pane whose meta.parent chain passes through
  // a root pane (the manager's own subtree).
  server.registerTool(
    'broadcast_subtree',
    {
      title: 'Broadcast to my subtree',
      description:
        'Send a message to every pane in an org subtree — all panes whose meta.parent chain leads back to `root` (agent-orchestration E). `root` defaults to HYPERPANES_PANE_ID. Returns the list of recipients.',
      inputSchema: {
        body: z.string(),
        root: z.string().optional().describe('subtree root paneId; defaults to HYPERPANES_PANE_ID'),
        from: z.string().optional()
      }
    },
    async ({ body, root, from }) =>
      run(async (c) => {
        const rootId = root ?? process.env.HYPERPANES_PANE_ID;
        if (!rootId) return { ok: false, error: 'HYPERPANES_PANE_ID not set; pass `root`' };
        const targets = subtreePaneIds(await c.state(), rootId);
        const sender = from ?? rootId;
        const sent: string[] = [];
        for (const t of targets) {
          await c.sendMessage(t, sender, body);
          sent.push(t);
        }
        return { ok: true, root: rootId, recipients: sent, count: sent.length };
      })
  );
}

// ---- agent-orchestration F (scoping) + H (locking) -------------------
function registerScopeAndLockTools(server: McpServer): void {
  // mint_token — a parent mints a NARROWER token to hand a child via env.
  server.registerTool(
    'mint_token',
    {
      title: 'Mint a scoped token',
      description:
        'Mint a subtree-scoped control token (agent-orchestration F). The new token can only reach the named windows/tabs/panes, and only within the minting token\'s own authority (no escalation). Hand it to a child via open_pane env: { HYPERPANES_CONTROL_TOKEN: token, HYPERPANES_CONTROL_PORT: port } — the child then controls only its subtree and never sees the master token. Optional ttlMs expires it.',
      inputSchema: {
        windowIds: z.array(z.number().int()).optional(),
        tabIds: z.array(z.string()).optional(),
        paneIds: z.array(z.string()).optional(),
        ttlMs: z.number().int().positive().optional()
      }
    },
    async ({ windowIds, tabIds, paneIds, ttlMs }) =>
      run(async (c) => {
        const scope = { windowIds, tabIds, paneIds };
        const minted = await c.mintToken(scope, ttlMs);
        return {
          ok: true,
          token: minted.token,
          scope: minted.scope,
          expiresAt: minted.expiresAt,
          port: minted.port,
          events: minted.events,
          hint: 'pass { HYPERPANES_CONTROL_TOKEN: token, HYPERPANES_CONTROL_PORT: port } as open_pane env'
        };
      })
  );

  // lock_pane / unlock_pane — advisory write serialization.
  server.registerTool(
    'lock_pane',
    {
      title: 'Lock a pane for writing',
      description:
        'Take an advisory write lock on a pane (agent-orchestration H) so only this owner can send_input until it expires or is released. Advisory: an unlocked pane is writable by anyone. Renew by acquiring again as the same owner. Pass the same `owner` to send_input while holding it.',
      inputSchema: {
        paneId: z.string(),
        owner: z.string().describe('your lock identity (e.g. your paneId)'),
        ttlMs: z.number().int().positive().optional().describe('lock lifetime (default 30000ms)')
      }
    },
    async ({ paneId, owner, ttlMs }) => run(async (c) => await c.lock(paneId, owner, ttlMs))
  );

  server.registerTool(
    'unlock_pane',
    {
      title: 'Release a pane lock',
      description: 'Release an advisory write lock you hold on a pane (agent-orchestration H).',
      inputSchema: { paneId: z.string(), owner: z.string() }
    },
    async ({ paneId, owner }) => run(async (c) => await c.unlock(paneId, owner))
  );
}

function registerPaneResources(server: McpServer): void {
  const listOutputs = async () => {
    try {
      const state: ControlState = await openClient().state();
      return {
        resources: flattenPanes(state).map(({ pane, tabTitle }) => ({
          uri: paneOutputUri(pane.id),
          name: `${pane.label} output`,
          description: `Output of pane "${pane.label}" (tab ${tabTitle}, ${pane.status})`,
          mimeType: 'text/plain'
        }))
      };
    } catch {
      return { resources: [] };
    }
  };

  server.registerResource(
    'pane-output',
    new ResourceTemplate('hyperpanes://pane/{paneId}/output', { list: listOutputs }),
    {
      title: 'Pane output',
      description: 'Terminal output of a hyperpanes pane (scrollback on read; streams on subscribe).',
      mimeType: 'text/plain'
    },
    async (uri, variables) => {
      const raw = variables.paneId;
      const paneId = Array.isArray(raw) ? raw[0] : raw;
      if (!paneId) throw new Error('missing paneId in resource URI');
      const out = await openClient().readPane(String(paneId));
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: out.output }] };
    }
  );

  // Per-pane message inbox as a subscribable resource (agent-orchestration E):
  // reading returns the inbox as JSON; subscribing streams live deliveries.
  server.registerResource(
    'pane-messages',
    new ResourceTemplate('hyperpanes://pane/{paneId}/messages', { list: undefined }),
    {
      title: 'Pane messages',
      description: 'Durable message inbox of a hyperpanes pane (JSON on read; live on subscribe).',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const raw = variables.paneId;
      const paneId = Array.isArray(raw) ? raw[0] : raw;
      if (!paneId) throw new Error('missing paneId in resource URI');
      const inbox = await openClient().readMessages(String(paneId));
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(inbox, null, 2) }]
      };
    }
  );

  // Bridge control `/events` → MCP resource notifications (output/exit/message →
  // resources/updated for that pane; state → list_changed).
  const subs = new PaneSubscriptions({
    eventsUrl: () => {
      try {
        return readDiscovery().events;
      } catch {
        return null;
      }
    },
    fetchState: () => openClient().state(),
    onUpdated: (uri) => void server.server.sendResourceUpdated({ uri }),
    onListChanged: () => void server.server.sendResourceListChanged()
  });

  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    await subs.subscribe(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subs.unsubscribe(req.params.uri);
    return {};
  });
}
