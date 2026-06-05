import { describe, it, expect } from 'vitest';
import { compileCli, toCommandLine } from './compile-cli.js';
import { planLaunch } from './launch.js';

// The expected argv mirror the grammar in hyperpanes' parseCli — each case here
// is the inverse of an input the app's workspace.test.ts parses.
describe('compileCli', () => {
  it('emits the legacy flat shape for one window / one tab', () => {
    const { argv, lossless } = compileCli({
      name: 'dev',
      layout: 'main-stack',
      panes: [{ command: 'bash', label: 'bash', cwd: '/work' }]
    });
    expect(argv).toEqual([
      '--name', 'dev',
      '--layout', 'main-stack',
      '-c', 'bash', '-l', 'bash', '--cwd', '/work'
    ]);
    expect(lossless).toBe(true);
  });

  it('emits repeated -c with per-pane color/label, no separators', () => {
    const { argv } = compileCli({
      panes: [
        { command: 'npm run dev', label: 'server', color: '#e5484d' },
        { command: 'psql', label: 'db' }
      ]
    });
    expect(argv).toEqual([
      '-c', 'npm run dev', '-l', 'server', '--color', '#e5484d',
      '-c', 'psql', '-l', 'db'
    ]);
  });

  it('emits --tab separators for multiple tabs in one window', () => {
    const { argv } = compileCli({
      windows: [
        {
          groups: [
            { title: 'app', panes: [{ command: 'a', label: 'a' }] },
            { title: 'logs', panes: [{ command: 'b', label: 'b' }] }
          ]
        }
      ]
    });
    expect(argv).toEqual([
      '--window',
      '--tab', '--name', 'app', '-c', 'a', '-l', 'a',
      '--tab', '--name', 'logs', '-c', 'b', '-l', 'b'
    ]);
  });

  it('emits --window separators with titles and layout', () => {
    const { argv } = compileCli({
      windows: [
        { title: 'one', groups: [{ layout: 'grid', panes: [{ command: 'a', label: 'a' }] }] },
        { title: 'two', groups: [{ panes: [{ command: 'b', label: 'b' }] }] }
      ]
    });
    expect(argv).toEqual([
      '--window', '--name', 'one', '--tab', '--layout', 'grid', '-c', 'a', '-l', 'a',
      '--window', '--name', 'two', '--tab', '-c', 'b', '-l', 'b'
    ]);
  });

  it('emits --font for an integer fontSize', () => {
    const { argv } = compileCli({ panes: [{ command: 'top', label: 'top', fontSize: 14 }] });
    expect(argv).toEqual(['-c', 'top', '-l', 'top', '--font', '14']);
  });

  it('flags JSON-only fields as lossy (bounds, active, subtitle, meta, command-less pane)', () => {
    const { lossy, lossless } = compileCli({
      windows: [
        {
          active: 1,
          bounds: { width: 800, height: 600 },
          groups: [
            {
              panes: [
                { command: 'a', subtitle: 'feature/x', meta: { role: 'worker' } },
                { label: 'placeholder' }
              ]
            }
          ]
        }
      ]
    });
    expect(lossless).toBe(false);
    expect(lossy).toEqual(
      expect.arrayContaining([
        'window bounds',
        'window active-tab index',
        'pane subtitle',
        'pane metadata',
        'pane without a command'
      ])
    );
  });

  it('flags tab sizing / focus / zoom as JSON-only lossy fields', () => {
    const { lossy, lossless } = compileCli({
      windows: [
        {
          groups: [
            {
              layout: 'main-stack',
              panes: [{ command: 'a' }, { command: 'b' }],
              sizes: [0.7, 0.3],
              mainFraction: 0.7,
              focused: 1,
              zoomed: 0
            }
          ]
        }
      ]
    });
    expect(lossless).toBe(false);
    expect(lossy).toEqual(
      expect.arrayContaining([
        'tab split sizes',
        'main-stack fraction',
        'focused pane index',
        'maximized pane index'
      ])
    );
  });

  it('toCommandLine quotes args containing spaces', () => {
    expect(toCommandLine('hyperpanes', ['-c', 'npm run dev'])).toBe('hyperpanes -c "npm run dev"');
  });
});

describe('planLaunch', () => {
  it('file mode writes a temp workspace and passes its path', () => {
    let written = '';
    const plan = planLaunch({
      launcher: 'hp.exe',
      workspace: { panes: [{ command: 'bash' }] },
      writeTemp: (json) => {
        written = json;
        return '/tmp/ws.json';
      }
    });
    expect(plan.mode).toBe('file');
    expect(plan.args).toEqual(['/tmp/ws.json']);
    expect(plan.lossy).toEqual([]);
    expect(JSON.parse(written)).toEqual({ panes: [{ command: 'bash' }] });
  });

  it('cli mode compiles flags and surfaces lossy fields', () => {
    const plan = planLaunch({
      launcher: 'hp.exe',
      mode: 'cli',
      workspace: { windows: [{ bounds: { width: 800 }, groups: [{ panes: [{ command: 'a' }] }] }] }
    });
    expect(plan.mode).toBe('cli');
    expect(plan.args).toEqual(['--window', '--tab', '-c', 'a']);
    expect(plan.lossy).toContain('window bounds');
  });

  it('an existing path launches verbatim with prepended launcher args', () => {
    const plan = planLaunch({ launcher: 'hp.exe', launcherArgs: ['.'], path: '/abs/dev.json' });
    expect(plan.args).toEqual(['.', '/abs/dev.json']);
    expect(plan.mode).toBe('file');
  });

  it('throws without path or workspace', () => {
    expect(() => planLaunch({ launcher: 'hp.exe' })).toThrow(/path.*workspace/i);
  });
});
