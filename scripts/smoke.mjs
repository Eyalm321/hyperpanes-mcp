// End-to-end smoke test: spawn the built MCP server over stdio, run the MCP
// handshake, and exercise Phase 1 (stateless) + Phase 2 (live-control) tools.
// Phase 2 runs WITHOUT a running app, so it asserts graceful degradation
// (control unavailable) rather than real control. Run: node scripts/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const text = (r) => JSON.parse(r.content[0].text);

// ---- tool surface ----
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('tools:', tools.join(', '));
for (const t of [
  'build_workspace', 'launch_workspace', 'list_layouts', 'validate_workspace',
  'control_status', 'list_panes', 'read_pane', 'open_pane', 'set_layout',
  'focus_pane', 'close_pane', 'restart_pane', 'send_input'
]) {
  assert(tools.includes(t), `missing tool: ${t}`);
}

// ---- Phase 1 (stateless) ----
const layouts = await client.callTool({ name: 'list_layouts', arguments: {} });
assert(/main-stack/.test(layouts.content[0].text), 'list_layouts');

const built = text(await client.callTool({
  name: 'build_workspace',
  arguments: {
    spec: {
      name: 'dev',
      windows: [
        { title: 'main', groups: [{ layout: 'main-stack', panes: [{ command: 'npm run dev', label: 'server' }] }] },
        { title: 'db', groups: [{ panes: [{ command: 'psql', label: 'db' }] }] }
      ]
    }
  }
}));
assert(built.ok && built.summary.windows === 2 && built.cli.lossless, 'build_workspace');
console.log('phase 1 ok:', JSON.stringify(built.summary));

// ---- Phase 2 (no app running -> graceful) ----
const status = text(await client.callTool({ name: 'control_status', arguments: {} }));
assert(status.available === false && status.controlFile, 'control_status should report unavailable + path');
assert(status.inputGate && status.inputGate.optIn === false, 'inputGate default off');
console.log('control_status (no app):', status.available, '| controlFile:', status.controlFile);

const panes = await client.callTool({ name: 'list_panes', arguments: {} });
assert(panes.isError === true && text(panes).ok === false, 'list_panes should error gracefully w/o app');

const input = text(await client.callTool({ name: 'send_input', arguments: { paneId: 'x', data: 'rm -rf /\n' } }));
assert(input.ok === false, 'send_input must refuse without app/opt-in');
console.log('send_input refused as expected:', input.error || input.reason || '(error result)');

// ---- resources: the pane-output template should be advertised ----
const templates = await client.listResourceTemplates();
const tmpl = templates.resourceTemplates.map((t) => t.uriTemplate);
assert(tmpl.some((u) => u.includes('hyperpanes://pane/')), 'pane-output resource template missing');
console.log('resource templates:', tmpl.join(', '));

await client.close();
console.log('SMOKE OK');
