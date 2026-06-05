import { windowsOf, type WorkspaceFile, type WindowSpec, type PaneSpec } from './schema.js';

/**
 * Compile a workspace into hyperpanes CLI argv — the inverse of the app's
 * `parseCli` (M1). Produces the same in-memory structure the app would build,
 * so `parseCli(['hyperpanes', ...argv])` round-trips back to this workspace.
 *
 * Fidelity gaps (the CLI grammar cannot express these — they are JSON-only):
 *   - window `bounds`            (x/y/width/height/maximized/fullscreen)
 *   - window/tab `active` index  (no `--active` flag in the shipped parser)
 *   - pane `subtitle`            (no `--subtitle` flag)
 *   - pane `meta`                (org metadata — no flag)
 *   - pane `args`                (direct-spawn argv — no flag; shell-wraps instead)
 *   - a pane with no `command`   (CLI panes only exist via `-c`)
 *   - tab `sizes`/`mainFraction` (split ratios — no flag)
 *   - tab `focused`/`zoomed`     (focused / maximized pane index — no flag)
 *
 * When any of these are present, prefer launching via a written `.json` file
 * (lossless). `lossy` lists what a CLI launch would drop.
 */
export interface CompileResult {
  argv: string[];
  lossy: string[];
  /** True when argv reproduces the workspace exactly (no lossy fields). */
  lossless: boolean;
}

function emitPane(argv: string[], pane: PaneSpec): void {
  if (!pane.command) return; // command-less panes are unrepresentable; flagged in lossy
  argv.push('-c', pane.command);
  if (pane.label) argv.push('-l', pane.label);
  if (pane.color) argv.push('--color', pane.color);
  if (pane.cwd) argv.push('--cwd', pane.cwd);
  if (pane.shell) argv.push('--shell', pane.shell);
  if (pane.fontSize != null) argv.push('--font', String(pane.fontSize));
}

function collectLossy(windows: WindowSpec[]): string[] {
  const lossy = new Set<string>();
  for (const w of windows) {
    if (w.bounds) lossy.add('window bounds');
    if (w.active != null) lossy.add('window active-tab index');
    for (const g of w.groups) {
      if (g.sizes) lossy.add('tab split sizes');
      if (g.mainFraction != null) lossy.add('main-stack fraction');
      if (g.focused != null) lossy.add('focused pane index');
      if (g.zoomed != null) lossy.add('maximized pane index');
      for (const p of g.panes) {
        if (p.subtitle) lossy.add('pane subtitle');
        if (p.meta && Object.keys(p.meta).length) lossy.add('pane metadata');
        // A direct-spawn argv can't be expressed as flags — a CLI launch would
        // shell-wrap `command` (re-parsing it), losing the verbatim-argv semantics.
        if (p.args && p.args.length) lossy.add('pane args (direct-spawn argv)');
        if (!p.command) lossy.add('pane without a command');
      }
    }
  }
  return [...lossy];
}

export function compileCli(workspace: WorkspaceFile): CompileResult {
  const windows = windowsOf(workspace);
  const lossy = collectLossy(windows);
  const argv: string[] = [];
  if (windows.length === 0) return { argv, lossy, lossless: lossy.length === 0 };

  // The legacy (separator-free) shape is only safe when there is exactly one
  // window with exactly one tab and no window-level title/bounds/active that
  // would diverge from the tab. windowsOf sets window.title === group.title for
  // the wrapped single-window cases, so comparing them detects an authored
  // multi-level spec that happens to have one window/tab.
  const single = windows[0]!;
  const firstTab = single.groups[0];
  const isLegacy =
    windows.length === 1 &&
    single.groups.length === 1 &&
    !single.bounds &&
    single.active == null &&
    single.title === firstTab?.title;

  if (isLegacy && firstTab) {
    if (workspace.name) argv.push('--name', workspace.name);
    if (firstTab.layout) argv.push('--layout', firstTab.layout);
    for (const pane of firstTab.panes) emitPane(argv, pane);
    return { argv, lossy, lossless: lossy.length === 0 };
  }

  for (const win of windows) {
    argv.push('--window');
    if (win.title) argv.push('--name', win.title);
    for (const group of win.groups) {
      argv.push('--tab');
      if (group.title) argv.push('--name', group.title);
      if (group.layout) argv.push('--layout', group.layout);
      for (const pane of group.panes) emitPane(argv, pane);
    }
  }
  return { argv, lossy, lossless: lossy.length === 0 };
}

/** Render argv as a copy-pasteable command line (quoting args with spaces). */
export function toCommandLine(launcher: string, argv: string[]): string {
  const quote = (s: string) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);
  return [launcher, ...argv].map(quote).join(' ');
}
