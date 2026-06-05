import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  LAYOUTS,
  WorkspaceFileSchema,
  formatZodError,
  summarize,
  windowsOf,
  type WorkspaceFile
} from './schema.js';
import { compileCli, toCommandLine } from './compile-cli.js';
import {
  executeLaunch,
  planLaunch,
  resolveLauncher,
  resolveLauncherArgs,
  type LaunchMode
} from './launch.js';
import { registerControlTools } from './control-tools.js';
import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const VERSION = '0.1.0';

/** JSON tool result (machine-readable) with an optional error flag. */
function json(data: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError };
}

/** Parse arbitrary input into a WorkspaceFile or a list of error strings. */
function parseWorkspace(input: unknown): { ok: true; workspace: WorkspaceFile } | { ok: false; errors: string[] } {
  const res = WorkspaceFileSchema.safeParse(input);
  if (!res.success) return { ok: false, errors: formatZodError(res.error) };
  return { ok: true, workspace: res.data };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'hyperpanes-mcp', version: VERSION },
    { capabilities: { resources: { subscribe: true, listChanged: true } } }
  );

  // ---- list_layouts ----------------------------------------------------
  server.registerTool(
    'list_layouts',
    {
      title: 'List layouts',
      description:
        'List the tab layouts hyperpanes supports (auto, single, columns, rows, grid, main-stack) with descriptions. Use these ids for a group/tab `layout`.'
    },
    async () => json({ layouts: LAYOUTS })
  );

  // ---- validate_workspace ---------------------------------------------
  server.registerTool(
    'validate_workspace',
    {
      title: 'Validate workspace',
      description:
        'Validate a workspace spec against the hyperpanes schema without launching anything. Returns { valid, errors?, summary } where summary counts windows/tabs/panes. Accepts the nested windows[]->groups[]->panes[] shape or the legacy single-window panes[]/groups[] shape.',
      inputSchema: { spec: z.unknown() }
    },
    async ({ spec }) => {
      const parsed = parseWorkspace(spec);
      if (!parsed.ok) return json({ valid: false, errors: parsed.errors });
      return json({ valid: true, summary: summarize(windowsOf(parsed.workspace)) });
    }
  );

  // ---- build_workspace -------------------------------------------------
  server.registerTool(
    'build_workspace',
    {
      title: 'Build workspace',
      description:
        'Validate a workspace spec and return canonical workspace JSON. Optionally write it to `path` (a .json file). Also returns the equivalent hyperpanes CLI command when the spec is losslessly expressible as flags (otherwise notes which fields are JSON-only).',
      inputSchema: {
        spec: z.unknown(),
        path: z
          .string()
          .optional()
          .describe('Optional .json path to write the workspace to (absolute or relative to cwd).')
      }
    },
    async ({ spec, path }) => {
      const parsed = parseWorkspace(spec);
      if (!parsed.ok) return json({ ok: false, errors: parsed.errors }, true);

      const workspace = parsed.workspace;
      const pretty = JSON.stringify(workspace, null, 2);
      const compiled = compileCli(workspace);

      let written: string | undefined;
      if (path) {
        const target = isAbsolute(path) ? path : resolve(process.cwd(), path);
        try {
          writeFileSync(target, pretty, 'utf8');
          written = target;
        } catch (err) {
          return json({ ok: false, errors: [`failed to write ${target}: ${String(err)}`] }, true);
        }
      }

      return json({
        ok: true,
        workspace,
        summary: summarize(windowsOf(workspace)),
        writtenTo: written,
        cli: compiled.lossless
          ? { command: toCommandLine('hyperpanes', compiled.argv), lossless: true }
          : { lossless: false, jsonOnlyFields: compiled.lossy }
      });
    }
  );

  // ---- launch_workspace ------------------------------------------------
  server.registerTool(
    'launch_workspace',
    {
      title: 'Launch workspace',
      description:
        'Launch hyperpanes with a workspace. Provide either `path` (an existing .json) or `spec` (a workspace object). Requires a launcher: pass `launcher` or set the HYPERPANES_BIN env var (hyperpanes has no PATH binary). `mode` defaults to "file" (writes a temp .json — lossless); "cli" compiles to flags (drops JSON-only fields like bounds/active/subtitle).',
      inputSchema: {
        spec: z.unknown().optional(),
        path: z.string().optional().describe('Path to an existing workspace .json to launch.'),
        launcher: z
          .string()
          .optional()
          .describe('Path to the hyperpanes executable. Overrides HYPERPANES_BIN.'),
        mode: z.enum(['file', 'cli']).optional().describe('Launch via temp file (default) or compiled CLI flags.')
      }
    },
    async ({ spec, path, launcher, mode }) => {
      const launcherCmd = resolveLauncher(launcher);
      if (!launcherCmd) {
        return json(
          {
            ok: false,
            errors: [
              'No hyperpanes launcher configured. Pass `launcher` or set HYPERPANES_BIN to the hyperpanes executable path.'
            ]
          },
          true
        );
      }
      if (!path && spec == null) {
        return json({ ok: false, errors: ['Provide either `path` or `spec`.'] }, true);
      }

      let workspace: WorkspaceFile | undefined;
      if (!path) {
        const parsed = parseWorkspace(spec);
        if (!parsed.ok) return json({ ok: false, errors: parsed.errors }, true);
        workspace = parsed.workspace;
      }

      try {
        const plan = planLaunch({
          launcher: launcherCmd,
          launcherArgs: resolveLauncherArgs(),
          path,
          workspace,
          mode: (mode as LaunchMode | undefined) ?? 'file'
        });
        const { pid } = executeLaunch(plan);
        return json({
          ok: true,
          launched: true,
          pid,
          mode: plan.mode,
          command: toCommandLine(plan.command, plan.args),
          tempFile: plan.tempFile,
          droppedFields: plan.lossy.length ? plan.lossy : undefined
        });
      } catch (err) {
        return json({ ok: false, errors: [`launch failed: ${String(err)}`] }, true);
      }
    }
  );

  // ---- Phase 2 (M4): live control over the running app's control API ----
  registerControlTools(server);

  return server;
}
