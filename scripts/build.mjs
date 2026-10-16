// Bundles src/index.ts and every dependency into one file, dist/meshmend-mcp.js,
// so `npx github:Keith-CY/meshmend-mcp` and the MCPB bundle run without installing anything.
import { build } from 'esbuild';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const out = new URL('../dist/meshmend-mcp.js', import.meta.url).pathname;
const result = await build({
  metafile: true,
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
  banner: {
    js: `#!/usr/bin/env node\n// meshmend-mcp ${pkg.version} (MIT): https://github.com/Keith-CY/meshmend-mcp — bundled build of src/; see the repository for the readable source.\nimport { createRequire as __mmCreateRequire } from 'node:module'; const require = __mmCreateRequire(import.meta.url);`,
  },
});
await chmod(out, 0o755);

// NOTICE: every package that ended up in the bundle, with its licence text.
const root = new URL('..', import.meta.url).pathname;
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) packages.set(m[1], root + 'node_modules/' + m[1] + '/');
}
const parts = [];
for (const [name, dir] of [...packages].sort()) {
  const meta = JSON.parse(await readFile(dir + 'package.json', 'utf8'));
  const files = (await readdir(dir)).filter((f) => /^(licen[cs]e|copying)/i.test(f));
  const text = files.length ? (await readFile(dir + files[0], 'utf8')).trim() : `The package ships no licence file. Its package.json declares the ${meta.license} licence; author: ${typeof meta.author === 'string' ? meta.author : meta.author?.name ?? 'not given'}; repository: ${typeof meta.repository === 'string' ? meta.repository : meta.repository?.url ?? 'not given'}.`;
  parts.push(`## ${name} ${meta.version} (${meta.license})\n\n${text}\n`);
}
await writeFile(
  root + 'NOTICE',
  `MeshMend MCP server\nCopyright (c) 2026 CHEN (MeshMend). MIT licence: see LICENSE.\n\n` +
    `src/core/ is MeshMend's own mesh code, also used by https://mesh-mend.pages.dev/.\n` +
    `tests/fixtures/trimesh/ holds three STL files from the trimesh project (MIT; see that folder's LICENSE.md).\n\n` +
    `dist/meshmend-mcp.js bundles the following packages. Their licences follow.\n\n` +
    parts.join('\n'),
);
console.log(`built ${out.split('/').slice(-2).join('/')}`);
