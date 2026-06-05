import { z } from 'zod';

/**
 * Workspace schema — a faithful mirror of the hyperpanes contract shipped in
 * `C:\hyperpanes\src\main\workspace.ts` (M0). The nesting is:
 *
 *   WorkspaceFile.windows[] -> WindowSpec.groups[] -> GroupSpec.panes[] -> PaneSpec
 *
 * with back-compat single-window fields (`panes`/`groups`) at the top level.
 * `windowsOf` below is a line-for-line port of the app's normalizer so this
 * package and the app agree on exactly one canonical shape.
 *
 * Keep this in sync with workspace.ts if the app's schema changes.
 */

/** The five concrete layouts plus `auto`, from hyperpanes' `Layout` union. */
export const LAYOUTS = [
  {
    id: 'auto',
    label: 'Automatic',
    description:
      "Picks a layout by pane count: 1 -> single, 2-3 -> columns, more -> grid. 'rows' and 'main-stack' are never auto-selected."
  },
  { id: 'single', label: 'Single', description: 'One pane fills the tab.' },
  { id: 'columns', label: 'Columns', description: 'Panes side by side in vertical columns.' },
  { id: 'rows', label: 'Rows', description: 'Panes stacked in horizontal rows.' },
  { id: 'grid', label: 'Grid', description: 'Panes tiled in a roughly square grid.' },
  {
    id: 'main-stack',
    label: 'Main + Stack',
    description: 'One large main pane beside a vertical stack of the remaining panes.'
  }
] as const;

export const LAYOUT_IDS = LAYOUTS.map((l) => l.id) as [string, ...string[]];

export const LayoutSchema = z.enum(['auto', 'single', 'columns', 'rows', 'grid', 'main-stack']);
export type Layout = z.infer<typeof LayoutSchema>;

/** A single terminal pane. Mirrors `PaneSpec` in workspace.ts, plus `subtitle`. */
export const PaneSpecSchema = z
  .object({
    label: z.string().optional(),
    // `subtitle` exists on the renderer pane model and round-trips through the
    // JSON/file launch path, but the app's CLI grammar has no flag for it — so it
    // is dropped if a workspace is launched via compiled CLI flags (see compile-cli).
    subtitle: z.string().optional(),
    color: z.string().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    shell: z.string().optional(),
    fontSize: z.number().int().positive().optional(),
    // Free-form per-pane metadata (agent-orchestration C): reserved keys
    // `role`/`parent`/`agentType`/`task` give an agent org its shape, rest open.
    // JSON-only — the CLI grammar has no flag for it (see compile-cli's lossy list).
    //
    // Tolerance MUST match the app (#8): the app's loader never rejects a
    // malformed (non-string) meta value — so neither do we. We accept any record
    // and DROP non-string values, keeping the canonical string→string shape rather
    // than failing validation on a workspace the app would happily load.
    meta: z
      .record(z.unknown())
      .transform((m) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(m)) if (typeof v === 'string') out[k] = v;
        return Object.keys(out).length ? out : undefined;
      })
      .optional()
  })
  .strict();
export type PaneSpec = z.infer<typeof PaneSpecSchema>;

/** A tab: an ordered set of panes with a tiling layout. Mirrors `GroupSpec`. */
export const GroupSpecSchema = z
  .object({
    title: z.string().optional(),
    layout: LayoutSchema.optional(),
    panes: z.array(PaneSpecSchema),
    // Sizing / focus / zoom. JSON-only — the CLI grammar can't express them (see
    // compile-cli's dropped-field report). The app validates defensively and
    // falls back to defaults (equal split, first pane focused, none maximized) on
    // a bad/mismatched value, so these stay loosely typed here.
    sizes: z.array(z.number().positive()).optional(), // per-slot fractions (normalized on load)
    mainFraction: z.number().optional(), // main-stack split (app clamps to 0.05–0.95)
    focused: z.number().int().nonnegative().optional(), // focused pane index
    zoomed: z.number().int().nonnegative().optional() // maximized pane index
  })
  .strict();
export type GroupSpec = z.infer<typeof GroupSpecSchema>;

/** Window geometry. JSON-only — not expressible via the CLI grammar. */
export const WindowBoundsSchema = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    maximized: z.boolean().optional(),
    fullscreen: z.boolean().optional()
  })
  .strict();
export type WindowBounds = z.infer<typeof WindowBoundsSchema>;

/** One OS window: its tabs, the active tab index, optional bounds. */
export const WindowSpecSchema = z
  .object({
    title: z.string().optional(),
    active: z.number().int().nonnegative().optional(),
    bounds: WindowBoundsSchema.optional(),
    groups: z.array(GroupSpecSchema)
  })
  .strict();
export type WindowSpec = z.infer<typeof WindowSpecSchema>;

/** Base object (without the non-empty refinement) so callers can extend it. */
const WorkspaceFileObject = z
  .object({
    name: z.string().optional(),
    layout: LayoutSchema.optional(),
    panes: z.array(PaneSpecSchema).optional(),
    groups: z.array(GroupSpecSchema).optional(),
    active: z.number().int().nonnegative().optional(),
    windows: z.array(WindowSpecSchema).optional()
  })
  .strict();
export type WorkspaceFile = z.infer<typeof WorkspaceFileObject>;

/** Full validation: structurally valid AND it ultimately declares >= 1 pane. */
export const WorkspaceFileSchema = WorkspaceFileObject.refine(
  (file) => summarize(windowsOf(file)).panes > 0,
  { message: 'workspace declares no panes (need panes, groups, or windows with at least one pane)' }
);

/**
 * Normalize any workspace into a flat window list — the one shape the launcher
 * seeds from. Line-for-line port of `windowsOf` in workspace.ts (M0). Precedence
 * mirrors the schema nesting: windows[] verbatim (groupless dropped); else
 * groups[] as one window; else panes[] as one window with one tab.
 */
export function windowsOf(file: WorkspaceFile | null | undefined): WindowSpec[] {
  if (!file) return [];
  if (file.windows && file.windows.length > 0) {
    return file.windows.filter((w) => Array.isArray(w.groups) && w.groups.length > 0);
  }
  if (file.groups && file.groups.length > 0) {
    return [{ title: file.name, active: file.active, groups: file.groups }];
  }
  if (file.panes && file.panes.length > 0) {
    return [
      { title: file.name, groups: [{ title: file.name, layout: file.layout, panes: file.panes }] }
    ];
  }
  return [];
}

/** Window / tab / pane counts for a normalized window list. */
export function summarize(windows: WindowSpec[]): { windows: number; tabs: number; panes: number } {
  const tabs = windows.reduce((n, w) => n + w.groups.length, 0);
  const panes = windows.reduce(
    (n, w) => n + w.groups.reduce((m, g) => m + g.panes.length, 0),
    0
  );
  return { windows: windows.length, tabs, panes };
}

/** Flatten a Zod error into readable `path: message` lines. */
export function formatZodError(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `${path}: ${i.message}`;
  });
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  summary?: ReturnType<typeof summarize>;
}

/** Validate arbitrary input against the workspace schema. */
export function validateWorkspace(input: unknown): ValidationResult {
  const res = WorkspaceFileSchema.safeParse(input);
  if (!res.success) return { valid: false, errors: formatZodError(res.error) };
  return { valid: true, summary: summarize(windowsOf(res.data)) };
}
