// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HeoPressClient, configFromEnv } from './client.js';
import { registerAllTools } from './tools/index.js';

async function main() {
  const config = configFromEnv();
  const client = new HeoPressClient(config);

  const server = new McpServer({
    name: 'heopress',
    version: '0.9.0',
  });

  registerAllTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[heopress-mcp] Fatal:', err);
  process.exit(1);
});
