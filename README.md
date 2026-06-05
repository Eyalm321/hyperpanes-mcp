# hyperpanes-mcp

An [MCP](https://modelcontextprotocol.io) server for **[hyperpanes](https://github.com/)** —
the Electron terminal-workspace app (one window of tiled, labeled, color-framed terminal
panes). It lets an agent **compose, validate, and launch** terminal-workspace layouts.

This is a **separate project** from the hyperpanes app. It builds against the workspace
schema and CLI grammar shipped in the app's `src/main/workspace.ts`.

## Status — Phase 1 (stateless launch-config)

Phase 1 is **stateless**: it generates and validates workspace configs and shells out to
hyperpanes to launch them. It has **no dependency on a running app**.

| Tool | What it does |
| --- | --- |
| `list_layouts` | List the tab layouts (`auto`, `single`, `columns`, `rows`, `grid`, `main-stack`) with descriptions. |
| `validate_workspace` | Validate a workspace spec against the schema. Returns `{ valid, errors?, summary }`. |
| `build_workspace` | Validate + return canonical workspace JSON; optionally write to a `.json` file; include the equivalent CLI command when losslessly expressible. |
| `launch_workspace` | Launch hyperpanes with a workspace (from a `.json` path or an inline spec). |

**Phase 2 (live control)** is also built — a thin adapter over the app's loopback control
API (`control-server.ts`, M2/M2b). See [Phase 2 — live control](#phase-2--live-control) and
the [`send_input` safety model](#send_input-safety-model).

## Install & build

```bash
npm install
npm run build      # -> dist/
npm test           # unit tests (schema, CLI compiler, control client/model/gates)
node scripts/smoke.mjs   # end-to-end stdio smoke test, both phases (no app needed)
```

Requires Node ≥ 20 (developed on Node 24).

## Use as an MCP server

The server speaks MCP over stdio. Register it with your client, e.g. Claude Code:

```jsonc
{
  "mcpServers": {
    "hyperpanes": {
      "command": "node",
      "args": ["C:/hyperpanes-mcp/dist/index.js"],
      "env": {
        // Required only for launch_workspace — see "Launching" below.
        "HYPERPANES_BIN": "C:/path/to/hyperpanes.exe"
      }
    }
  }
}
```

During development you can point `command`/`args` at `npx tsx src/index.ts` instead of the
build.

## Workspace schema (the contract)

A faithful mirror of `WorkspaceFile` in the app's `src/main/workspace.ts`. The canonical
shape is nested; the legacy single-window fields are kept for back-compat.

```
WorkspaceFile {
  name?, layout?,                 // legacy single-window fields…
  panes?: PaneSpec[],             // …(absent `windows` ⇒ these describe one window)
  groups?: GroupSpec[],
  active?: number,
  windows?: WindowSpec[]          // canonical multi-window
}
WindowSpec { title?, active?: number, bounds?: WindowBounds, groups: GroupSpec[] }
GroupSpec  { title?, layout?: Layout, panes: PaneSpec[],     // a tab
             sizes?: number[], mainFraction?, focused?, zoomed? }  // split/focus/zoom (JSON-only)
PaneSpec   { label?, subtitle?, color?, command?, cwd?, shell?, fontSize? }
WindowBounds { x?, y?, width?, height?, maximized?, fullscreen? }
Layout = 'auto' | 'single' | 'columns' | 'rows' | 'grid' | 'main-stack'
```

A tab can fully reproduce its split and selection: `sizes` are per-pane fractions
(summed→1, length = pane count), `mainFraction` is the Main+Stack split, and `focused` /
`zoomed` are pane **indices** (which pane is focused / maximized). All four are JSON-only —
the CLI grammar can't express them, so a `cli` launch drops them (reported in `lossy`).

- **Normalization.** Everything funnels through `windowsOf` (a line-for-line port of the
  app's normalizer): `windows[]` is used verbatim (groupless windows dropped); else
  top-level `groups[]` become one window of tabs; else top-level `panes[]` become one
  window with one tab.
- **Relative `cwd`.** In a workspace **file**, relative `cwd` resolves against the file's
  own directory (done by the app on load). Inline specs passed to `launch_workspace` are
  written to a temp file, so relative `cwd` resolves against the temp dir — prefer absolute
  `cwd` for inline specs.
- **Validation is strict.** Unknown keys are rejected (typo guard), `layout` must be a known
  id, `fontSize` must be a positive integer, and a workspace must declare at least one pane.

See [`examples/dev.workspace.json`](examples/dev.workspace.json) for a full two-window spec.

## Launching

hyperpanes ships as an Electron **app**, not a CLI on `PATH` (its `package.json` has no
`bin`). So `launch_workspace` needs to be told how to start it:

1. the `launcher` tool argument, or
2. the **`HYPERPANES_BIN`** env var (path to the built/installed executable).

Optional leading args (e.g. for a dev runner) come from **`HYPERPANES_LAUNCH_ARGS`**
(whitespace-separated). There is **no** bare-`hyperpanes` PATH fallback — the tool fails
loudly rather than spawn the wrong process.

Two launch modes:

- **`file`** (default) — writes the workspace to a temp `.json` and launches
  `hyperpanes <file>`. **Lossless.**
- **`cli`** — compiles the workspace to `--window`/`--tab`/`-c …` flags. Convenient and
  copy-pasteable, but **lossy**: the CLI grammar cannot express window `bounds`, the
  `active` tab index, pane `subtitle`, or a pane with no `command`. `build_workspace` /
  `launch_workspace` report which fields a CLI launch would drop.

## Phase 2 — live control

A thin adapter over the app's **local control API** (`control-server.ts`, M2/M2b): a loopback
`127.0.0.1` HTTP server + `/events` WebSocket, **off by default**, with a per-instance bearer
token. It is enabled in the app via Preferences → "Allow agent control".

| Tool | What it does |
| --- | --- |
| `control_status` | Is control reachable? Reports app pid/version, whether the app allows input, the bridge-side `send_input` gate, and the `control.json` path. **Call this first.** |
| `list_panes` | All panes across windows/tabs, with status, **activity** (`busy`/`idle`/`exited` liveness heuristic), any **org metadata** (`role`/`parent`/`agentType`/`task`), and each pane's output-resource URI. |
| `read_pane` | A pane's scrollback (`tail` = last N lines; `strip` = ANSI-stripped clean text). |
| `open_pane` | New pane in a window's active tab (defaults to the first window). Returns the **new paneId**; accepts `meta` (org metadata) and `env` (e.g. a scoped control token) at spawn. |
| `set_meta` | Attach/update a pane's free-form `meta` (shallow-merged). How an orchestrator records the org chart as data. |
| `set_layout` | Set a tab's layout (defaults to the first window's active tab). |
| `focus_pane` / `close_pane` / `restart_pane` | Focus, close, or restart a pane. |
| `rename_pane` / `recolor_pane` | Change a pane's label + subtitle, or its frame color — live. |
| `send_input` | **Guarded** — type into a live shell. See [safety model](#send_input-safety-model). Pass `owner` to write a pane you've `lock_pane`-d. |
| `whoami` | Identify the pane this bridge runs inside (`HYPERPANES_PANE_ID`) + its org metadata. The recursion enabler. |
| `send_message` / `read_messages` | Durable per-pane message bus (at-least-once, cursor reads). |
| `send_to_parent` / `broadcast_subtree` | Hierarchy helpers — message your org `meta.parent`, or every pane in your subtree. |
| `mint_token` | Mint a narrower (subtree-scoped) control token to hand a child via `open_pane` env. |
| `lock_pane` / `unlock_pane` | Advisory write lock so only the holder can `send_input` until it expires. |

### Agent orchestration (Phases A–C)

These tools turn the control plane into a substrate for an LLM **agent org** — one external
orchestrator driving worker panes, or a recursive CEO→manager→worker tree. Hierarchy is **data**
(per-pane `meta` + the window→tab→pane tree), never baked into the API, so the same primitives
serve both shapes. See `docs/agent-orchestration-plan.md` in the app repo.

- **Self-awareness.** Each pane's pty gets `HYPERPANES_PANE_ID` + `HYPERPANES_CONTROL_FILE`, so
  an MCP bridge running *inside* a pane learns who it is via `whoami`.
- **Liveness.** `list_panes` reports `activity` (`busy`/`idle`/`exited` — a quiescence
  **heuristic**, not a "done" guarantee) and a `state`/`activity` event stream.
- **Messaging.** `send_message`/`read_messages` (+ the subscribable
  `hyperpanes://pane/{id}/messages` resource) are a durable, at-least-once inbox per pane;
  `send_to_parent`/`broadcast_subtree` resolve targets from `meta`.
- **Scoping (opt-in).** The master token (in `control.json`) is unscoped. `mint_token` issues a
  subtree-scoped, optionally-TTL'd token that can only reach its windows/tabs/panes and can only
  mint *narrower* children. Hand it to a child via `open_pane({ env: { HYPERPANES_CONTROL_TOKEN,
  HYPERPANES_CONTROL_PORT } })` — the child then controls only its subtree and is **never given
  the master `control.json`**. A scoped token's `/state` and event stream are filtered to its panes.
- **Concurrency.** `lock_pane` takes an advisory write lock; a locked pane refuses `send_input`
  from anyone but the holder (pass `owner`). Unlocked panes are writable by anyone.

> **Activity is a heuristic.** `idle` means a pane produced no output for the app's idle
> threshold — the agent is *likely* waiting at its prompt or done, **not** a guarantee work is
> complete. An agent that streams/thinks silently can read as idle; a chatty one may never idle.

**Pane self-awareness.** Each pane's pty is launched with `HYPERPANES_PANE_ID` (its own paneId)
and `HYPERPANES_CONTROL_FILE` (the path to `control.json`), so an MCP-capable agent running
*inside* a pane can discover which pane it is and how to reach this control plane.

**Discovery.** The bridge reads the app's `userData/control.json`
(`{ port, token, pid, version, events }`). Path precedence: `HYPERPANES_CONTROL_FILE` →
`HYPERPANES_USER_DATA`/`control.json` → platform default
(`%APPDATA%/hyperpanes/control.json` on Windows, `~/Library/Application Support/hyperpanes/…`
on macOS, `$XDG_CONFIG_HOME/hyperpanes/…` on Linux). In dev the app may run under a different
Electron name — set `HYPERPANES_CONTROL_FILE` if `control_status` reports the wrong path.

**Streaming.** Each pane's output is an MCP **resource** at `hyperpanes://pane/{paneId}/output`.
Reading it returns the scrollback; **subscribing** streams updates: the bridge opens the app's
`/events` WebSocket and turns `output`/`exit` frames into `resources/updated` notifications and
`state` frames into `resources/list_changed`. (No WebSocket is exposed by the bridge — it
*consumes* the app's; clients get plain MCP notifications over stdio.) Pane **activity** flips
also coalesce into a `state` frame, so a subscriber gets a `list_changed` nudge and can re-read
the new `activity` via `list_panes`.

## `send_input` safety model

> `send_input` lets an agent **type into live shells** — it runs whatever you send in a real
> terminal. It is the sharp edge of this project and is **never on by default**. Three gates,
> all required, do not weaken:

1. **App-side (enforced by hyperpanes):** the control server is loopback-only + token, is
   **disabled by default**, and `send_input` returns **403 unless** "Allow agent control →
   input" (`allowInput`) is toggled on in the app. The bridge cannot bypass this.
2. **Bridge opt-in (allowlist):** the MCP server refuses `send_input` unless
   **`HYPERPANES_ALLOW_INPUT=1`** is set in its environment. Optionally
   **`HYPERPANES_INPUT_ALLOWLIST`** (comma-separated pane ids or labels) restricts which panes
   accept input.
3. **Per-call confirmation:** every `send_input` call must pass **`confirm: true`**.

`control_status` surfaces all three (`appAllowsInput` + `inputGate`) so you can see exactly
why a call would be refused.

## Project layout

```
src/
  schema.ts          # zod schema + types + windowsOf/summarize (mirrors workspace.ts)
  compile-cli.ts     # WorkspaceFile -> hyperpanes CLI argv (inverse of the app's parseCli)
  launch.ts          # launcher resolution + launch planning/execution
  server.ts          # MCP server: registers Phase 1 tools + Phase 2 (control) tools
  control-tools.ts   # Phase 2 tools + the subscribable pane-output resource
  control/
    discovery.ts     # locate + parse userData/control.json
    client.ts        # HTTP client for the control API (state/output/input/command)
    model.ts         # read-model types + pure helpers (flatten, resolve, URIs)
    subscriptions.ts # /events WebSocket -> MCP resource notifications
    input-gate.ts    # send_input gating (opt-in + confirm + allowlist)
  index.ts           # stdio entrypoint
scripts/smoke.mjs    # end-to-end stdio check (both phases; no app needed)
examples/            # sample workspace files
```

## Keeping in sync with the app

`src/schema.ts` and `src/compile-cli.ts` mirror the app's `src/main/workspace.ts`
(`WorkspaceFile`/`windowsOf`/`parseCli`); `src/control/*` mirrors `control-server.ts`
(routes, `/events` frames, `control.json`). The test suites intentionally reuse the app's own
test cases so drift surfaces as a failure. If the app's schema, CLI grammar, or control API
changes, update the corresponding files and their tests.
