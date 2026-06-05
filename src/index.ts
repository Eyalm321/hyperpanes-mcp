#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; nothing else to do here.
}

main().catch((err) => {
  // Never write to stdout — it is the MCP transport. Diagnostics go to stderr.
  console.error('hyperpanes-mcp failed to start:', err);
  process.exit(1);
});
