// Builds the MCPB bundle (one-click install in Claude Desktop) from the
// committed dist file: build/mcpb/ → build/meshmend-mcp-<version>.mcpb.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8'));
if (manifest.version !== version) throw new Error(`manifest.json version ${manifest.version} != package.json ${version}`);
const stage = root + 'build/mcpb/';
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage + 'server', { recursive: true });
cpSync(root + 'manifest.json', stage + 'manifest.json');
cpSync(root + 'assets/icon.png', stage + 'icon.png');
cpSync(root + 'dist/meshmend-mcp.js', stage + 'server/meshmend-mcp.js');
for (const f of ['LICENSE', 'NOTICE']) cpSync(root + f, stage + f);
const out = root + `build/meshmend-mcp-${version}.mcpb`;
const mcpb = ['-y', '@anthropic-ai/mcpb@2.1.2'];
execFileSync('npx', [...mcpb, 'validate', stage + 'manifest.json'], { stdio: 'inherit' });
execFileSync('npx', [...mcpb, 'pack', stage, out], { stdio: 'inherit' });
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
console.log(`${out.slice(root.length)}\nsha256 ${sha}`);
