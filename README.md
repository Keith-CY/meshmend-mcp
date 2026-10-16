<p align="center"><img src="assets/icon.png" width="96" alt="MeshMend"></p>

<h1 align="center">MeshMend — MCP server</h1>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">中文</a></p>

Check and repair 3D-printing meshes (STL and 3MF) from an AI assistant that can run tools on your computer: Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI or any other MCP client that starts local servers.

Ask *“is `~/prints/bracket.stl` watertight?”*, *“why does my slicer say this model has holes?”* or *“把这个 3MF 转成 STL”*: the assistant reads the file on your machine, tells you exactly what is wrong (holes, flipped faces, inside-out shells, non-manifold edges, duplicate triangles), says honestly whether an automatic repair will fix it, and writes a repaired copy next to the original.

**Your files never leave your computer.** The server runs locally, reads and writes only the files you name, makes no network requests and has no telemetry. The original file is never overwritten. It is the same mesh code as the free in-browser tool at [mesh-mend.pages.dev](https://mesh-mend.pages.dev/).

```sh
npx -y github:Keith-CY/meshmend-mcp
```

> **Status:** version 0.1.0. Publishing to npm is pending; until then `npx -y github:Keith-CY/meshmend-mcp` (needs Node.js 18+ and git) runs the same build, and Claude Desktop users can install the one-click bundle from [Releases](https://github.com/Keith-CY/meshmend-mcp/releases).

## Tools

| Tool | Input | What it does |
|---|---|---|
| `check_mesh` | `path`, `unit?` (`mm`/`cm`/`in`, STL only), `item?` (3MF build item) | Reports size in mm, triangles, shells and every problem with its count, plus a verdict from a trial repair in memory: `ok`, `repairable`, `partly_repairable` or `needs_manual_review`. Read-only. |
| `repair_mesh` | `path`, `fill_holes?` (default false), `max_hole_span_mm?` (default 20), `output_path?`, `unit?`, `item?`, `overwrite?` | Removes duplicate and zero-area faces, makes face winding consistent, turns inside-out shells outward and, if asked, caps flat holes. Writes a binary STL in millimetres and reports before and after. |
| `convert_3mf_to_stl` | `path`, `item?`, `output_path?`, `overwrite?` | 3MF to binary STL in millimetres, with build transforms and units applied and the geometry unchanged. |

Every result comes as readable text and as structured JSON (`structuredContent`, with an `outputSchema`). `check_mesh` is marked read-only; the other two only create new files (`destructiveHint: false`).

**Where results go:** next to the input, as `<name>.repaired.stl` (or `<name>.stl` for a conversion), then `-2`, `-3`, … rather than replacing anything. With `output_path`, an existing file is replaced only with `overwrite: true`, and the input file can never be the output.

## Connect it

### Claude Desktop

**One click:** download `meshmend-mcp-0.1.0.mcpb` from [Releases](https://github.com/Keith-CY/meshmend-mcp/releases) and open it (or **Settings → Extensions → Advanced settings → Install extension…**). Claude Desktop runs it with its built-in Node.js.

**Or by hand:** **Settings → Developer → Edit config** and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meshmend": {
      "command": "npx",
      "args": ["-y", "github:Keith-CY/meshmend-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add meshmend -- npx -y github:Keith-CY/meshmend-mcp
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "meshmend": { "command": "npx", "args": ["-y", "github:Keith-CY/meshmend-mcp"] }
  }
}
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "meshmend": { "type": "stdio", "command": "npx", "args": ["-y", "github:Keith-CY/meshmend-mcp"] }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`: the same `mcpServers` block as Cursor.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.meshmend]
command = "npx"
args = ["-y", "github:Keith-CY/meshmend-mcp"]
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{ "mcpServers": { "meshmend": { "command": "npx", "args": ["-y", "github:Keith-CY/meshmend-mcp"] } } }
```

### Any other client

Any MCP client that starts local (stdio) servers can run `npx -y github:Keith-CY/meshmend-mcp`, or `node /path/to/meshmend-mcp/dist/meshmend-mcp.js` from a checkout (the file has no dependencies). Ready-made files are in [`examples/clients/`](examples/clients/).

Give the assistant **absolute paths** (`~` is expanded). Relative paths are resolved from the server’s working directory, which in desktop apps is often not your project folder.

## Real files, before and after

From this repository’s tests and a local run (`npm test` repeats all but the bunny and the sphere):

| File | What `check_mesh` found | Verdict | After `repair_mesh` |
|---|---|---|---|
| MeshMend’s sample block, 30 × 24 × 24 mm, 19 triangles ([`missing-patch.stl`](tests/fixtures/missing-patch.stl)) | 1 hole (4 open edges), 3 winding conflicts, 1 duplicate face | repairable (with `fill_holes`) | Closed: duplicate removed, orientation fixed, the 10 × 8 mm hole capped with 2 triangles; 20 triangles |
| [`multibody.stl`](tests/fixtures/trimesh/) from trimesh, 32 triangles | 2 inside-out shells, 12 winding conflicts | repairable | Closed and outward |
| The Utah teapot ([`teapot.stl`](tests/fixtures/trimesh/)), 894 triangles | 6 open boundaries (64 open edges), 1 non-manifold vertex | needs manual review | Unchanged, and it says why: the holes are curved and the non-manifold vertex needs a decision |
| A CAD export ([`featuretype.STL`](tests/fixtures/trimesh/)), 3,476 triangles | 16 open seams (576 open edges) | needs manual review | Unchanged: surfaces whose vertices don’t match exactly, and MeshMend never welds nearby vertices |
| The Stanford bunny (`bun_zipper.ply` as STL, scaled to 156 mm; not included) | 5 open boundaries (223 open edges) in its base, 69,451 triangles | needs manual review | Unchanged even with a 200 mm span: the scan holes aren’t flat |
| A generated 100 mm sphere, 247,499 triangles, 3 holes and 249 flipped faces | 3 open boundaries (13 open edges), 744 winding conflicts | partly repairable | Orientation fixed and 1 flat hole capped; 2 curved holes left for review. About 10 s |

## What it fixes, and what it doesn’t

It fixes:

- duplicate faces and zero-area (degenerate) faces;
- inconsistent face winding (flipped normals) across ordinary shared edges;
- closed shells that are inside out, when they don’t overlap other shells;
- with `fill_holes: true`: simple flat holes (3–128 boundary vertices) whose bounding-box diagonal is within `max_hole_span_mm`.

It does **not**:

- weld nearby vertices (only exactly equal coordinates are joined), so it can’t close seams between surfaces;
- split non-manifold edges or vertices, remesh, or rebuild a solid;
- repair self-intersections, union overlapping parts, or check wall thickness, overhangs or supports;
- cap curved holes, nested openings or holes wider than the span;
- guarantee that a model prints. Open the result in your slicer.

Because some openings are intentional, hole filling is off unless asked for. `check_mesh` runs the repair in memory first, so its verdict says whether `repair_mesh` will actually help before anything is written.

**Limits:** 30 MiB per file and 250,000 triangles (the same as the website). 3MF: the primary build, components, transforms, production-extension part references and units; ZIP64, unsupported required extensions, mixed units across parts and G-code-only packages are refused with an explanation. Colours, materials and print settings are not carried into STL.

## Privacy

MeshMend’s MCP server works only on your computer. It reads the files you or your assistant name and writes new STL files; it sends nothing anywhere, has no analytics or telemetry, and keeps no logs. Your AI assistant sees the tool results (counts, sizes, file paths and messages) like any other tool output, under that assistant’s own privacy terms.

## Development

```sh
npm install
npm test            # builds dist/ and runs the core, file and end-to-end tests (needs Bun)
npm run pack:mcpb   # builds the Claude Desktop bundle into build/
node scripts/call.mjs check_mesh '{"path":"tests/fixtures/missing-patch.stl"}'
```

`src/core/` is MeshMend’s mesh code, copied unchanged from the website so both give the same answers. `dist/meshmend-mcp.js` is a single bundled file (committed, so `npx github:` needs no build step); [`NOTICE`](NOTICE) lists the bundled packages and their licences.

## Licence

[MIT](LICENSE). The three trimesh test files are MIT-licensed by their authors ([details](tests/fixtures/trimesh/README.md)).

The in-browser version, with a 3D preview and before/after comparison: **[mesh-mend.pages.dev](https://mesh-mend.pages.dev/)**.
