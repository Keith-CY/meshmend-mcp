// End-to-end: the BUILT server (dist/meshmend-mcp.js) is started with node and
// driven by the official MCP client over stdio, as Claude Desktop, Cursor and
// other clients do: initialize, tools/list, then tools/call on broken meshes.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync, closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { demoMesh, exportSTL, parseSTL, analyze } from '../src/core/mesh';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist', 'meshmend-mcp.js');
const fixtures = join(root, 'tests', 'fixtures');
let dir = '';
let client: Client;

type Call = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Call;
const text = (r: Call) => r.content.map((c) => c.text).join('\n');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const put = (name: string, data: ArrayBuffer | string) => {
  const p = join(dir, name);
  writeFileSync(p, typeof data === 'string' ? data : new Uint8Array(data));
  return p;
};
const copy = (from: string, name: string) => {
  const p = join(dir, name);
  copyFileSync(from, p);
  return p;
};

function asciiSTL(mesh: Float64Array, name = 'part') {
  const lines = [`solid ${name}`];
  for (let i = 0; i < mesh.length; i += 9) {
    lines.push('facet normal 0 0 0', ' outer loop');
    for (let j = 0; j < 3; j++) lines.push(`  vertex ${mesh[i + j * 3]} ${mesh[i + j * 3 + 1]} ${mesh[i + j * 3 + 2]}`);
    lines.push(' endloop', 'endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}
// A 20 mm cube as 12 triangles, outward winding.
function cube(size = 20): Float64Array {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((x) => x * size));
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float64Array(f.flatMap((t) => t.flatMap((i) => v[i])));
}
const flipAll = (m: Float64Array) => {
  const out = m.slice();
  for (let i = 0; i < out.length; i += 9) for (let j = 0; j < 3; j++) [out[i + 3 + j], out[i + 6 + j]] = [out[i + 6 + j], out[i + 3 + j]];
  return out;
};

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'meshmend-e2e-')));
  client = new Client({ name: 'meshmend-e2e', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [dist], cwd: dir, stderr: 'pipe' }));
});
afterAll(async () => {
  await client?.close();
  if (dir && dir.includes('meshmend-e2e-')) rmSync(dir, { recursive: true, force: true });
});

describe('protocol', () => {
  test('initialize reports the server and its instructions', () => {
    expect(client.getServerVersion()?.name).toBe('meshmend');
    expect(client.getServerVersion()?.version).toBe('0.1.0');
    expect(client.getInstructions()).toContain('never uploaded');
  });
  test('tools/list: three tools with titles, annotations and schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_mesh', 'convert_3mf_to_stl', 'repair_mesh']);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(t.outputSchema).toBeTruthy();
      expect(t.description!.length).toBeGreaterThan(200);
    }
    expect(tools.find((t) => t.name === 'check_mesh')!.annotations!.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'repair_mesh')!.annotations!.readOnlyHint).toBe(false);
  });
});

describe('check_mesh', () => {
  test('the site fixture: missing lid patch, flipped face, duplicate face', async () => {
    const r = await call('check_mesh', { path: copy(join(fixtures, 'missing-patch.stl'), 'missing-patch.stl') });
    expect(r.isError).toBeFalsy();
    const rep = r.structuredContent.report;
    expect(rep).toMatchObject({ triangles: 19, openBoundaryEdges: 4, openBoundaries: 1, duplicateFaces: 1, windingConflicts: 3, watertight: false, verdict: 'repairable' });
    expect(rep.sizeMm).toEqual([30, 24, 24]);
    expect(r.structuredContent.repairOutlook.fillHoles).toBe(true);
    expect(text(r)).toContain('fill_holes: true');
  });
  test('the demo mesh as ASCII STL gives the same numbers as the website guide', async () => {
    const r = await call('check_mesh', { path: put('demo-ascii.stl', asciiSTL(demoMesh())) });
    expect(r.structuredContent.report).toMatchObject({ triangles: 19, openBoundaryEdges: 4, duplicateFaces: 1, windingConflicts: 3, verdict: 'repairable' });
  });
  test('an inside-out closed shell is found and called repairable', async () => {
    const r = await call('check_mesh', { path: put('inside-out.stl', exportSTL(flipAll(cube()))) });
    expect(r.structuredContent.report).toMatchObject({ insideOutShells: 1, openBoundaryEdges: 0, windingConflicts: 0, verdict: 'repairable' });
    expect(r.structuredContent.repairOutlook.fillHoles).toBe(false);
  });
  test('a clean cube is ok; units scale STL coordinates', async () => {
    const p = put('cube.stl', exportSTL(cube(1)));
    const mm = await call('check_mesh', { path: p });
    expect(mm.structuredContent.report).toMatchObject({ watertight: true, verdict: 'ok', sizeMm: [1, 1, 1] });
    const inch = await call('check_mesh', { path: p, unit: 'in' });
    expect(inch.structuredContent.report.sizeMm).toEqual([25.4, 25.4, 25.4]);
    expect(inch.structuredContent.warnings.join(' ')).toContain('inches');
  });
  test('relative paths resolve from the working directory; item on an STL is ignored with a note', async () => {
    put('rel.stl', exportSTL(cube()));
    const r = await call('check_mesh', { path: 'rel.stl', item: 0 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.file.path).toBe(join(dir, 'rel.stl'));
    expect(r.structuredContent.warnings.join(' ')).toContain('3MF files only');
  });
  test('3MF: build items, declared unit and inch scaling', async () => {
    const r = await call('check_mesh', { path: copy(join(fixtures, 'inch-calibration.3mf'), 'inch-calibration.3mf') });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.file).toMatchObject({ format: '3mf', sourceUnit: 'inch', selectedItem: null });
    expect(r.structuredContent.file.items.length).toBe(1);
    expect(r.structuredContent.report).toMatchObject({ sizeMm: [25.4, 25.4, 25.4], verdict: 'ok' });
    const bad = await call('check_mesh', { path: join(dir, 'inch-calibration.3mf'), item: 3 });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('item must be one of 0–0');
  });
  test('real-world files from trimesh: honest verdicts', async () => {
    const multibody = await call('check_mesh', { path: join(fixtures, 'trimesh', 'multibody.stl') });
    expect(multibody.structuredContent.report).toMatchObject({ windingConflicts: 12, insideOutShells: 2, verdict: 'repairable' });
    const teapot = await call('check_mesh', { path: join(fixtures, 'trimesh', 'teapot.stl') });
    expect(teapot.structuredContent.report).toMatchObject({ openBoundaries: 6, openBoundaryEdges: 64, nonManifoldVertices: 1, verdict: 'needs_manual_review' });
    expect(text(teapot)).toContain('never split automatically');
    const seams = await call('check_mesh', { path: join(fixtures, 'trimesh', 'featuretype.STL') });
    expect(seams.structuredContent.report).toMatchObject({ openBoundaries: 16, openBoundaryEdges: 576, verdict: 'needs_manual_review' });
    expect(text(seams)).toContain('never welds nearby vertices');
  });
  test('bad inputs come back as tool errors, and the server keeps running', async () => {
    const invalid = await call('check_mesh', { path: copy(join(fixtures, 'invalid.stl'), 'invalid.stl') });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toContain('not a complete ASCII or binary STL');
    const obj = await call('check_mesh', { path: put('model.obj', 'v 0 0 0') });
    expect(obj.isError).toBe(true);
    expect(text(obj)).toContain('Only .stl and .3mf');
    const missing = await call('check_mesh', { path: join(dir, 'nope.stl') });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('No file at');
    const big = join(dir, 'huge.stl');
    closeSync(openSync(big, 'w'));
    truncateSync(big, 31 * 1024 * 1024); // sparse: refused from its size alone
    const huge = await call('check_mesh', { path: big });
    expect(huge.isError).toBe(true);
    expect(text(huge)).toContain('30 MiB');
    const empty = await call('check_mesh', { path: put('empty.stl', '') });
    expect(empty.isError).toBe(true);
    const badArgs = await client.callTool({ name: 'check_mesh', arguments: { path: 42 } });
    expect(badArgs.isError).toBe(true);
    const still = await call('check_mesh', { path: join(dir, 'cube.stl') });
    expect(still.isError).toBeFalsy();
  });
});

describe('repair_mesh', () => {
  test('fixes the site fixture with hole filling; output re-imports closed; original untouched', async () => {
    const input = join(dir, 'missing-patch.stl');
    const before = sha(input);
    const r = await call('repair_mesh', { path: input, fill_holes: true });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent;
    expect(s.output.path).toBe(join(dir, 'missing-patch.repaired.stl'));
    expect(s.changes).toMatchObject({ duplicateFacesRemoved: 1, holesFilled: 1, trianglesAdded: 2 });
    expect(s.after).toMatchObject({ triangles: 20, watertight: true, openBoundaryEdges: 0, verdict: 'ok' });
    expect(s.before).toMatchObject({ triangles: 19, openBoundaryEdges: 4 });
    const out = readFileSync(s.output.path);
    expect(out.byteLength).toBe(84 + 20 * 50);
    expect(analyze(parseSTL(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer)).closedTopology).toBe(true);
    expect(sha(input)).toBe(before);
  });
  test('without fill_holes the hole stays open and the next step says how to close it', async () => {
    const r = await call('repair_mesh', { path: join(dir, 'missing-patch.stl') });
    expect(r.structuredContent.output.path).toBe(join(dir, 'missing-patch.repaired-2.stl'));
    expect(r.structuredContent.after).toMatchObject({ openBoundaryEdges: 4, windingConflicts: 0, duplicateFaces: 0, verdict: 'repairable' });
    expect(r.structuredContent.nextStep).toContain('fill_holes: true');
  });
  test('inside-out shell turned outward', async () => {
    const r = await call('repair_mesh', { path: join(dir, 'inside-out.stl') });
    expect(r.structuredContent.after).toMatchObject({ insideOutShells: 0, watertight: true, verdict: 'ok' });
    expect(r.structuredContent.changes.trianglesFlipped).toBe(12);
  });
  test('binary STL with a square hole: closed within the span, left open below it', async () => {
    const m = cube(10);
    const withoutSide = new Float64Array([...m.slice(0, 4 * 9), ...m.slice(6 * 9)]); // the y = 0 face removed: a 10 x 10 mm hole, 14.1 mm across
    const p = put('holed.stl', exportSTL(withoutSide));
    const check = await call('check_mesh', { path: p });
    expect(check.structuredContent.report).toMatchObject({ openBoundaries: 1, openBoundaryEdges: 4, verdict: 'repairable' });
    const small = await call('repair_mesh', { path: p, fill_holes: true, max_hole_span_mm: 5, output_path: join(dir, 'holed-small.stl') });
    expect(small.structuredContent.changes.holesFilled).toBe(0);
    expect(small.structuredContent.after.verdict).toBe('needs_manual_review');
    const ok = await call('repair_mesh', { path: p, fill_holes: true, max_hole_span_mm: 30, output_path: join(dir, 'holed-fixed.stl') });
    expect(ok.structuredContent.changes).toMatchObject({ holesFilled: 1, trianglesAdded: 2 });
    expect(ok.structuredContent.after.watertight).toBe(true);
  });
  test('real-world multibody.stl (trimesh) comes out closed and outward', async () => {
    const r = await call('repair_mesh', { path: join(fixtures, 'trimesh', 'multibody.stl'), output_path: join(dir, 'multibody.fixed.stl') });
    expect(r.structuredContent.after).toMatchObject({ windingConflicts: 0, insideOutShells: 0, watertight: true, verdict: 'ok' });
  });
  test('teapot: nothing can be changed, said plainly', async () => {
    const r = await call('repair_mesh', { path: join(fixtures, 'trimesh', 'teapot.stl'), fill_holes: true, output_path: join(dir, 'teapot.out.stl') });
    expect(text(r)).toContain('none could be made automatically');
    expect(r.structuredContent.after.verdict).toBe('needs_manual_review');
  });
  test('output rules: never the input, no silent replacing, .stl only, existing folder', async () => {
    const input = join(dir, 'missing-patch.stl');
    const before = sha(input);
    const same = await call('repair_mesh', { path: input, output_path: input, overwrite: true });
    expect(same.isError).toBe(true);
    expect(text(same)).toContain('never overwritten');
    const target = join(dir, 'missing-patch.repaired.stl');
    const exists = await call('repair_mesh', { path: input, output_path: target });
    expect(exists.isError).toBe(true);
    expect(text(exists)).toContain('already exists');
    const replaced = await call('repair_mesh', { path: input, output_path: target, overwrite: true });
    expect(replaced.isError).toBeFalsy();
    expect(replaced.structuredContent.output.replaced).toBe(true);
    const obj = await call('repair_mesh', { path: input, output_path: join(dir, 'x.obj') });
    expect(text(obj)).toContain('must end in .stl');
    const nodir = await call('repair_mesh', { path: input, output_path: join(dir, 'no-such-folder', 'x.stl') });
    expect(text(nodir)).toContain('does not exist');
    const span = await client.callTool({ name: 'repair_mesh', arguments: { path: input, max_hole_span_mm: 5000 } });
    expect(span.isError).toBe(true);
    expect(sha(input)).toBe(before);
    expect(existsSync(join(dir, 'x.obj'))).toBe(false);
  });
});

describe('convert_3mf_to_stl', () => {
  test('writes <name>.stl in millimetres, then -2 rather than replacing', async () => {
    const input = join(dir, 'inch-calibration.3mf');
    const before = sha(input);
    const r = await call('convert_3mf_to_stl', { path: input });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.output.path).toBe(join(dir, 'inch-calibration.stl'));
    expect(r.structuredContent.report.sizeMm).toEqual([25.4, 25.4, 25.4]);
    const back = await call('check_mesh', { path: r.structuredContent.output.path });
    expect(back.structuredContent.report).toMatchObject({ sizeMm: [25.4, 25.4, 25.4], watertight: true });
    const again = await call('convert_3mf_to_stl', { path: input, item: 0 });
    expect(again.structuredContent.output.path).toBe(join(dir, 'inch-calibration-2.stl'));
    expect(again.structuredContent.file.selectedItem).toBe(0);
    expect(sha(input)).toBe(before);
    expect(statSync(r.structuredContent.output.path).size).toBe(84 + 4 * 50);
  });
  test('an STL is refused with a pointer to the right tool', async () => {
    const r = await call('convert_3mf_to_stl', { path: join(dir, 'cube.stl') });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('check_mesh or repair_mesh');
  });
});

