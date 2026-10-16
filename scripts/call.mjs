// Calls one tool on the built server over stdio, the way an MCP client does:
//   node scripts/call.mjs check_mesh '{"path":"tests/fixtures/missing-patch.stl"}'
// Prints the text result; --json prints the structured result instead.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [tool, raw = '{}', flag] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node scripts/call.mjs <tool> \'<json arguments>\' [--json]');
  process.exit(2);
}
const client = new Client({ name: 'meshmend-call', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../dist/meshmend-mcp.js', import.meta.url).pathname], cwd: process.cwd(), stderr: 'inherit' }));
try {
  const r = await client.callTool({ name: tool, arguments: JSON.parse(raw) });
  if (flag === '--json') console.log(JSON.stringify(r.structuredContent ?? r, null, 2));
  else console.log((r.isError ? 'ERROR: ' : '') + r.content.map((c) => c.text).join('\n'));
} finally {
  await client.close();
}
