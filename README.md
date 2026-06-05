# hyperpanes-mcp

[![CI](https://github.com/Eyalm321/hyperpanes-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Eyalm321/hyperpanes-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server for **hyperpanes** — the Electron
terminal-workspace app (one window of tiled, labeled, color-framed terminal panes). It lets
an agent **compose and launch** workspace layouts and **drive a running instance** — read,
spawn, and arrange panes, stream their output, and (guarded) type into live shells — from
Claude, Cursor, or any MCP client.

It works at two levels, and you can use either without the other:

| Level | Needs a running app? | What it does |
|---|---|---|
| **Compose & launch** | No | Generate/validate a workspace config and shell out to `hyperpanes` to open it. |
| **Live control** | Yes | Talk to the app's loopback control API to inspect/drive panes and stream output. |

> **Live control is off by default.** The app's control API is a loopback (`127.0.0.1`),
> token-authenticated server that only listens once you enable Preferences → **"Allow agent
> control"** in hyperpanes. Typing into shells (`send_input`) is gated further still — see the
> [send_input safety model](#send_input-safety-model).

## Tools

### Compose & launch (no running app needed)

| Tool | Description |
|---|---|
| `list_layouts` | List the tab layouts (`auto`, `single`, `columns`, `rows`, `grid`, `main-stack`) with descriptions. |
| `validate_workspace` | Validate a workspace spec against the schema. Returns `{ valid, errors?, summary }` (window/tab/pane counts). |
| `build_workspace` | Validate + return canonical workspace JSON; optionally write it to a `.json` file; include the equivalent `hyperpanes` CLI command when losslessly expressible. |
| `launch_workspace` | Launch `hyperpanes` with a workspace, from a `.json` path or an inline spec. Defaults to a lossless temp-file launch; `mode:"cli"` compiles to flags. Needs `HYPERPANES_BIN`. |

### Inspect a running instance

| Tool | Description |
|---|---|
| `control_status` | Is the control API reachable? Reports app pid/version, whether the app allows input, the bridge-side `send_input` gate, and the `control.json` path. **Call this first.** |
| `list_panes` | All panes across windows/tabs, with status, activity (busy/idle/exited), org metadata, tab/window context, and each pane's output-resource URI. |
| `read_pane` | A pane's terminal scrollback. `tail` = last N lines; `strip` = ANSI-stripped clean text. |
| `read_messages` | Drain a pane's durable message inbox past a cursor (`after` = highest seq seen). |
| `whoami` | Identify the pane this bridge is running inside (`HYPERPANES_PANE_ID`) and its org metadata — so a manager-agent-in-a-pane can learn who it is before driving sub-workers. |

### Drive panes

| Tool | Description |
|---|---|
| `open_pane` | Open a new pane in a window's active tab (defaults to the first window). Returns the new `paneId`; accepts `meta` (org metadata) and `env` (e.g. a scoped token) at spawn. |
| `set_layout` | Set a tab's tiling layout (defaults to the first window's active tab). |
| `focus_pane` | Focus a pane (and its tab/window). |
| `close_pane` | Close a pane, terminating its shell. |
| `restart_pane` | Kill and respawn a pane's shell. |
| `rename_pane` | Change a pane's label and (optionally) subtitle, live. |
| `recolor_pane` | Change a pane's frame color, live (any CSS color). |
| `set_meta` | Attach/update a pane's free-form metadata (merge; `null` deletes a key). How an orchestrator records the org chart as data. |

### Send input

| Tool | Description |
|---|---|
| `send_input` ⚠️ | **Type into a live shell** — runs whatever you send in a real terminal. Triple-gated and never on by default. See the [safety model](#send_input-safety-model). |

### Agent orchestration

Turn the control plane into a substrate for an LLM **agent org** — one orchestrator driving
worker panes, or a recursive manager→worker tree. Hierarchy is **data** (`meta.parent`), the
message bus is hierarchy-agnostic, and tokens scope what a child can reach.

| Tool | Description |
|---|---|
| `send_message` | Enqueue a structured message to a pane's durable inbox (at-least-once delivery). |
| `send_to_parent` | Message this pane's org parent (resolved from `meta.parent`). |
| `broadcast_subtree` | Message every pane in an org subtree (all panes whose `meta.parent` chain leads back to a root). |
| `mint_token` | Mint a subtree-scoped control token (no escalation) to hand a child via `open_pane` env — the child controls only its subtree and never sees the master token. |
| `lock_pane` | Take an advisory write lock so only the holder can `send_input` until it expires. |
| `unlock_pane` | Release an advisory write lock you hold. |

## Resources

Pane output and inboxes are exposed as **subscribable MCP resources** — read for a snapshot,
subscribe for a live stream (the bridge consumes the app's `/events` WebSocket and emits
`resources/updated` / `resources/list_changed` notifications):

| Resource URI | Content |
|---|---|
| `hyperpanes://pane/{paneId}/output` | Terminal output — scrollback on read, deltas on subscribe (`text/plain`). |
| `hyperpanes://pane/{paneId}/messages` | The pane's durable message inbox — JSON on read, live deliveries on subscribe. |

## Installation

The server runs over stdio and is launched by your MCP client.

### Claude Desktop / generic MCP config

```json
{
  "mcpServers": {
    "hyperpanes": {
      "command": "npx",
      "args": ["-y", "hyperpanes-mcp"],
      "env": {
        "HYPERPANES_BIN": "C:/path/to/hyperpanes.exe"
      }
    }
  }
}
```

`HYPERPANES_BIN` is only needed for `launch_workspace`; the live-control tools find the app
via its `control.json` (see [Configuration](#configuration)).

### Claude Code

```bash
claude mcp add hyperpanes -- npx -y hyperpanes-mcp
```

### Install globally

```bash
npm install -g hyperpanes-mcp
hyperpanes-mcp   # runs the stdio server
```

Also published to GitHub Packages as `@eyalm321/hyperpanes-mcp`.

## Configuration

All variables are optional. `launch_workspace` needs a launcher; the live-control tools need
the app running with **"Allow agent control"** enabled.

| Env var | Purpose |
|---|---|
| `HYPERPANES_BIN` | Path to the hyperpanes executable (for `launch_workspace`). No PATH fallback — it fails loudly rather than spawn the wrong process. |
| `HYPERPANES_LAUNCH_ARGS` | Whitespace-separated leading args for the launcher (e.g. a dev runner). |
| `HYPERPANES_CONTROL_FILE` | Override the path to the app's `control.json` (use if the app runs under a non-default data dir). |
| `HYPERPANES_USER_DATA` | Override just the userData dir; `<dir>/control.json` is used. |
| `HYPERPANES_CONTROL_TOKEN` / `HYPERPANES_CONTROL_PORT` | A scoped control token + port for a child pane (set automatically by `mint_token` / `open_pane` env). Used instead of reading `control.json`. |
| `HYPERPANES_PANE_ID` | The pane this bridge runs inside — enables `whoami` and the hierarchy helpers. |
| `HYPERPANES_ALLOW_INPUT` | `1`/`true` to permit `send_input` on this bridge (off by default). |
| `HYPERPANES_INPUT_ALLOWLIST` | Comma-separated pane ids or labels allowed to receive input. |

Default `control.json` locations:

- **Windows:** `%APPDATA%\hyperpanes\control.json`
- **macOS:** `~/Library/Application Support/hyperpanes/control.json`
- **Linux:** `$XDG_CONFIG_HOME/hyperpanes/control.json` (or `~/.config/hyperpanes/…`)

## send_input safety model

> `send_input` types into **live shells** — it runs whatever you send in a real terminal. It
> is the sharp edge of this server and is **never on by default**. Three independent gates,
> all required:

1. **App-side (enforced by hyperpanes):** the control server is loopback + token, **disabled
   by default**, and `send_input` returns **403 unless** "Allow agent control → input" is on.
   The bridge cannot bypass this.
2. **Bridge opt-in:** refused unless **`HYPERPANES_ALLOW_INPUT=1`** is set in this server's
   environment. Optionally **`HYPERPANES_INPUT_ALLOWLIST`** restricts which panes accept input.
3. **Per-call confirmation:** every call must pass **`confirm: true`**.

`control_status` surfaces all three (`appAllowsInput` + `inputGate`) so a refusal is always
explainable.

## Workspace schema

A faithful mirror of the app's `WorkspaceFile`. The canonical shape is nested; the legacy
single-window fields are kept for back-compat, and everything normalizes through one
`windowsOf` funnel (windows[] verbatim → groups[] as one window → panes[] as one window/tab).

```
WorkspaceFile { name?, layout?, panes?, groups?, active?, windows? }
WindowSpec    { title?, active?, bounds?, groups[] }
GroupSpec     { title?, layout?, panes[], sizes?, mainFraction?, focused?, zoomed? }   // a tab
PaneSpec      { label?, subtitle?, color?, command?, cwd?, shell?, fontSize? }
Layout        = auto | single | columns | rows | grid | main-stack
```

- **Launch modes.** `launch_workspace` defaults to writing a temp `.json` (**lossless**).
  `mode:"cli"` compiles to `--window`/`--tab`/`-c …` flags — convenient but **lossy**: window
  bounds, the active-tab index, pane subtitle, split sizes, and command-less panes are JSON-only
  and reported in `lossy`.
- **Relative `cwd`.** In a workspace *file*, relative `cwd` resolves against the file's dir.
  Inline specs are written to a temp file — prefer absolute `cwd` for inline specs.
- **Strict validation.** Unknown keys are rejected (typo guard), `layout` must be a known id,
  `fontSize` a positive integer, and a workspace must declare at least one pane.

See [`examples/dev.workspace.json`](examples/dev.workspace.json) for a full two-window spec.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (pure units; no running app needed)
npm run test:watch
npm run dev        # tsx src/index.ts
node scripts/smoke.mjs   # end-to-end stdio check (no app needed)
```

The unit tests mirror the app's own `workspace.test.ts` / control read-model cases, so a
contract drift in the app surfaces here as a test failure.

## Architecture

```
src/
  index.ts          # stdio entrypoint
  server.ts         # creates the MCP server; registers compose/launch tools + wires control tools
  schema.ts         # workspace schema (zod) + windowsOf/summarize — mirrors the app's workspace.ts
  compile-cli.ts    # WorkspaceFile -> hyperpanes CLI argv (inverse of the app's parseCli)
  launch.ts         # launcher resolution + launch planning/execution
  control-tools.ts  # live-control + orchestration tools, and the subscribable pane resources
  control/
    discovery.ts    # locate + parse control.json (and scoped-token env)
    client.ts       # HTTP client for the control API (state/output/input/command/messages/tokens/locks)
    model.ts        # read-model types + pure helpers (flatten, resolve, URIs, whoami, subtree)
    subscriptions.ts# /events WebSocket -> MCP resource notifications
    input-gate.ts   # send_input gating (opt-in + confirm + allowlist)
scripts/smoke.mjs   # end-to-end stdio check
examples/           # sample workspace files
```

## Releasing

CI runs the build + tests on every push and PR to `main` (Node 20 & 22). Publishing is
triggered by creating a **GitHub Release**, which publishes to **both** registries:

- **npm** as the unscoped package `hyperpanes-mcp`
- **GitHub Packages** as `@eyalm321/hyperpanes-mcp`

### One-time repo setup

1. Add an `NPM_TOKEN` repository secret (an npm **automation** token). `GITHUB_TOKEN` is
   provided automatically for GitHub Packages.
2. To release: `npm version <patch|minor|major>`, push with `--follow-tags`, then create a
   GitHub Release for the tag (e.g. `v0.1.1`). The `publish` workflow builds, tests, and
   publishes to both registries.

## License

MIT © Eyalm321
