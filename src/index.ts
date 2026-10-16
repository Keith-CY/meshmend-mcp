// MeshMend MCP server (stdio). Checks and repairs STL and 3MF files on the
// user's own computer with the same code as https://mesh-mend.pages.dev/.
// No network access, no telemetry; stdout carries only the MCP protocol.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkMesh, repairMesh, convert3mf, UserError } from './meshtools';

export const VERSION = '0.1.0';

const INSTRUCTIONS =
  'MeshMend checks and repairs 3D-printing meshes (STL and 3MF) that are on the user’s own computer. ' +
  'Use check_mesh first when someone asks whether a model is printable, watertight or manifold, or why a slicer complains (holes, open edges, flipped normals, inside-out parts, non-manifold edges). ' +
  'Then use repair_mesh to write a fixed copy (fill_holes: true to close flat holes), or convert_3mf_to_stl to get an STL out of a 3MF. ' +
  'Files are read and written locally and never uploaded; the original is never overwritten. ' +
  'Give absolute paths. Results are binary STL in millimetres. ' +
  'It does not repair self-intersections or check wall thickness, overhangs or supports: say so when it matters, and suggest opening the result in a slicer.';

const pathArg = z.string().min(1).max(4096).describe('Path of the file on this computer. Absolute paths are safest; ~ is expanded, and relative paths are resolved from the server’s working directory.');
const unitArg = z.enum(['mm', 'cm', 'in']).optional().describe('STL only: the unit the STL coordinates are in (STL files do not say). Default mm. Results are always in millimetres.');
const itemArg = z.number().int().min(0).max(255).optional().describe('3MF only: the index of one build item (from check_mesh’s item list). Omit to use all build items together.');
const outputArg = z.string().min(1).max(4096).optional().describe('Where to save the result; must end in .stl and its folder must exist. Default: next to the input, with a new name that never replaces an existing file.');
const overwriteArg = z.boolean().optional().describe('Replace output_path if it already exists. Default false. The input file is never replaced.');

const vec = z.array(z.number());
const stats = {
  triangles: z.number(),
  vertices: z.number(),
  sizeMm: vec.describe('Bounding-box size x, y, z in millimetres'),
  boundsMm: z.object({ min: vec, max: vec }),
  watertight: z.boolean().describe('Closed, manifold, consistently oriented, with no duplicate or zero-area faces'),
  openBoundaryEdges: z.number(),
  openBoundaries: z.number().describe('Separate holes or gaps'),
  nonManifoldEdges: z.number(),
  nonManifoldVertices: z.number(),
  windingConflicts: z.number().describe('Edges where neighbouring faces disagree on orientation (flipped faces)'),
  insideOutShells: z.number(),
  duplicateFaces: z.number(),
  zeroAreaFaces: z.number(),
  shells: z.number(),
};
const report = z.object({
  ...stats,
  verdict: z
    .enum(['ok', 'repairable', 'partly_repairable', 'needs_manual_review'])
    .describe('ok: closed and outward; repairable: repair_mesh is expected to fix everything (from a trial repair in memory); partly_repairable: some problems would remain; needs_manual_review: repair_mesh cannot change the problems'),
});
const file = z.object({
  path: z.string(),
  format: z.enum(['stl', '3mf']),
  bytes: z.number(),
  sourceUnit: z.string(),
  items: z.array(z.object({ index: z.number(), name: z.string(), triangles: z.number() })),
  selectedItem: z.number().nullable(),
});
const output = z.object({ path: z.string(), bytes: z.number(), replaced: z.boolean() });

type Result = { text: string; structured: Record<string, unknown> };
async function run(fn: () => Promise<Result>) {
  try {
    const r = await fn();
    return { content: [{ type: 'text' as const, text: r.text }], structuredContent: r.structured };
  } catch (e) {
    const known = e instanceof UserError || (e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError) && !(e instanceof ReferenceError));
    const message = known ? (e as Error).message : `MeshMend could not process this file (${e instanceof Error ? e.message : 'unknown error'}).`;
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}

export function createServer() {
  const server = new McpServer(
    { name: 'meshmend', title: 'MeshMend', version: VERSION, websiteUrl: 'https://mesh-mend.pages.dev/' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'check_mesh',
    {
      title: 'Check an STL or 3MF mesh',
      description:
        'Use this when the user has an STL or 3MF file on their computer and asks whether it is printable, watertight or manifold, or why a slicer or printer complains about it: holes, open edges, gaps, flipped normals, inside-out faces, non-manifold edges or vertices, duplicate or zero-area triangles. ' +
        'Reads the file locally (it is never uploaded) and reports size in mm, triangle and shell counts, each problem with its count, and a verdict (ok / repairable / partly_repairable / needs_manual_review) based on a trial repair in memory, so it can say whether repair_mesh will actually fix the file. Read-only: nothing is written. ' +
        'Does not check self-intersections, wall thickness, overhangs or supports. Limits: 30 MiB and 250,000 triangles; 3MF build items and units are read from the file.',
      inputSchema: { path: pathArg, unit: unitArg, item: itemArg },
      outputSchema: {
        file,
        report,
        repairOutlook: z.object({ fillHoles: z.boolean().describe('Whether the trial repair needed fill_holes: true'), remainingAfterRepair: z.array(z.string()) }),
        nextStep: z.string(),
        warnings: z.array(z.string()),
      },
      annotations: { title: 'Check an STL or 3MF mesh', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => checkMesh(args)),
  );

  server.registerTool(
    'repair_mesh',
    {
      title: 'Repair an STL or 3MF mesh',
      description:
        'Use this when the user wants a broken STL or 3MF fixed for 3D printing (after check_mesh, or when they ask to repair, fix, make watertight or close holes). ' +
        'Writes a repaired binary STL (millimetres) next to the input or at output_path and never overwrites the original. ' +
        'It removes duplicate and zero-area faces, makes face winding consistent, turns inside-out shells outward and, with fill_holes: true, caps flat (planar) holes no wider than max_hole_span_mm. ' +
        'It is deliberately conservative: it never welds nearby vertices, never splits non-manifold geometry, leaves curved or larger holes open, and does not fix self-intersections, wall thickness or supports; those are reported for manual review. ' +
        'Runs locally; nothing is uploaded.',
      inputSchema: {
        path: pathArg,
        output_path: outputArg,
        fill_holes: z.boolean().optional().describe('Cap flat (planar) holes. Default false, because some openings are intentional.'),
        max_hole_span_mm: z.number().gt(0).max(1000).optional().describe('Largest hole to cap, as the diagonal of its bounding box in mm. Default 20, as on the website.'),
        unit: unitArg,
        item: itemArg,
        overwrite: overwriteArg,
      },
      outputSchema: {
        file,
        output,
        settings: z.object({ fillHoles: z.boolean(), maxHoleSpanMm: z.number() }),
        changes: z.object({ duplicateFacesRemoved: z.number(), degenerateFacesRemoved: z.number(), trianglesFlipped: z.number(), holesFilled: z.number(), trianglesAdded: z.number() }),
        before: z.object(stats),
        after: report,
        nextStep: z.string(),
        warnings: z.array(z.string()),
      },
      annotations: { title: 'Repair an STL or 3MF mesh', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => repairMesh(args)),
  );

  server.registerTool(
    'convert_3mf_to_stl',
    {
      title: 'Convert 3MF to STL',
      description:
        'Use this when the user has a 3MF file (from a slicer such as Bambu Studio, PrusaSlicer or Cura, or a CAD export) and needs an STL, for all build items together or one item. ' +
        'Applies the 3MF’s build transforms and unit, and writes a binary STL in millimetres without changing the geometry; colours, materials and print settings are not carried over. Also reports whether the result is watertight. ' +
        'Never overwrites the 3MF. Runs locally; nothing is uploaded.',
      inputSchema: { path: pathArg.describe('Path of the .3mf file on this computer (absolute is safest).'), output_path: outputArg, item: itemArg, overwrite: overwriteArg },
      outputSchema: { file, output, report, nextStep: z.string(), warnings: z.array(z.string()) },
      annotations: { title: 'Convert 3MF to STL', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => convert3mf(args)),
  );

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`meshmend-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
