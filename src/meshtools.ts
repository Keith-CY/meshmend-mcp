// The three tools, as plain async functions (src/index.ts registers them with
// the MCP server). The geometry work is MeshMend's own code in src/core/.

import { basename } from 'node:path';
import { analyze, repair, parseSTL, exportSTL, type Mesh, type Report } from './core/mesh';
import { parse3MF, combineItems } from './core/three-mf';
import { readInput, chooseOutput, writeOutput, UserError, type InputFile } from './files';

export type Unit = 'mm' | 'cm' | 'in';
const SCALE: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };
const LIMITS = 'Not checked: self-intersections, wall thickness, overhangs and supports. Open the result in your slicer before printing.';

type Loaded = {
  input: InputFile;
  mesh: Mesh;
  sourceUnit: string;
  items: { index: number; name: string; triangles: number }[];
  selectedItem: number | null;
  warnings: string[];
};

export type Verdict = 'ok' | 'repairable' | 'partly_repairable' | 'needs_manual_review';
export type MeshStats = {
  triangles: number;
  vertices: number;
  sizeMm: number[];
  boundsMm: { min: number[]; max: number[] };
  watertight: boolean;
  openBoundaryEdges: number;
  openBoundaries: number;
  nonManifoldEdges: number;
  nonManifoldVertices: number;
  windingConflicts: number;
  insideOutShells: number;
  duplicateFaces: number;
  zeroAreaFaces: number;
  shells: number;
};
export type MeshReport = MeshStats & { verdict: Verdict };
export type Outlook = { verdict: Verdict; fillHoles: boolean; remainingAfterRepair: string[] };

const round = (n: number) => Math.round(n * 1000) / 1000;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const kib = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

/**
 * Separate open boundaries (each hole or gap is one), counted the way the
 * core indexes the mesh: exact coordinates, zero-area and duplicate faces
 * dropped, then edges used by exactly one face joined into groups.
 */
export function countOpenBoundaries(mesh: Mesh): number {
  const ids = new Map<string, number>();
  const id = (i: number) => {
    const k = `${mesh[i]},${mesh[i + 1]},${mesh[i + 2]}`;
    let v = ids.get(k);
    if (v === undefined) ids.set(k, (v = ids.size));
    return v;
  };
  const seen = new Set<string>();
  const edges = new Map<string, number>();
  for (let i = 0; i < mesh.length; i += 9) {
    const f = [id(i), id(i + 3), id(i + 6)];
    if (new Set(f).size < 3) continue;
    const ax = mesh[i + 3] - mesh[i], ay = mesh[i + 4] - mesh[i + 1], az = mesh[i + 5] - mesh[i + 2];
    const bx = mesh[i + 6] - mesh[i], by = mesh[i + 7] - mesh[i + 1], bz = mesh[i + 8] - mesh[i + 2];
    if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) === 0) continue;
    const sig = [...f].sort((a, b) => a - b).join(':');
    if (seen.has(sig)) continue;
    seen.add(sig);
    for (const [a, b] of [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]]) {
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const [k, n] of edges) {
    if (n !== 1) continue;
    const [a, b] = k.split(':').map(Number);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  let groups = 0;
  for (const [v] of parent) if (find(v) === v) groups++;
  return groups;
}

export function toStats(r: Report, mesh: Mesh): MeshStats {
  return {
    triangles: r.triangles,
    vertices: r.vertices,
    sizeMm: r.dimensions.map(round),
    boundsMm: { min: r.bounds[0].map(round), max: r.bounds[1].map(round) },
    watertight: r.closedTopology,
    openBoundaryEdges: r.boundaryEdges,
    openBoundaries: r.boundaryEdges ? countOpenBoundaries(mesh) : 0,
    nonManifoldEdges: r.nonManifoldEdges,
    nonManifoldVertices: r.nonManifoldVertices,
    windingConflicts: r.windingConflicts,
    insideOutShells: r.inwardShells,
    duplicateFaces: r.duplicateFaces,
    zeroAreaFaces: r.degenerateFaces,
    shells: r.components,
  };
}

/** The problems in a report, in words. Empty when there are none. */
export function problems(r: MeshStats): string[] {
  const out: string[] = [];
  if (r.openBoundaryEdges) out.push(`${plural(r.openBoundaries, 'open boundary', 'open boundaries')} (holes or gaps; ${plural(r.openBoundaryEdges, 'open edge')})`);
  if (r.nonManifoldEdges) out.push(`${plural(r.nonManifoldEdges, 'non-manifold edge')} (shared by 3+ faces)`);
  if (r.nonManifoldVertices) out.push(`${plural(r.nonManifoldVertices, 'non-manifold vertex', 'non-manifold vertices')}`);
  if (r.windingConflicts) out.push(`${plural(r.windingConflicts, 'winding conflict')} (flipped faces)`);
  if (r.insideOutShells) out.push(`${plural(r.insideOutShells, 'inside-out shell')}`);
  if (r.duplicateFaces) out.push(`${plural(r.duplicateFaces, 'duplicate face')}`);
  if (r.zeroAreaFaces) out.push(`${plural(r.zeroAreaFaces, 'zero-area face')}`);
  return out;
}

/**
 * What repair_mesh would achieve, found by a trial repair in memory (nothing
 * is written): with hole filling when there are open edges, at the given span.
 */
export function outlook(mesh: Mesh, stats: MeshStats, span = 20, settled = false): Outlook {
  if (stats.watertight && !stats.insideOutShells) return { verdict: 'ok', fillHoles: false, remainingAfterRepair: [] };
  // A mesh that repair() already produced with these settings would not change again (repair is idempotent).
  if (settled) return { verdict: 'needs_manual_review', fillHoles: false, remainingAfterRepair: problems(stats) };
  const fill = stats.openBoundaryEdges > 0;
  let trial;
  try {
    trial = repair(mesh, fill, span);
  } catch {
    return { verdict: 'needs_manual_review', fillHoles: false, remainingAfterRepair: problems(stats) };
  }
  const left = problems(toStats(trial.report, trial.mesh));
  const c = trial.changes;
  const changed = c.duplicateFacesRemoved + c.degenerateFacesRemoved + c.trianglesFlipped + c.holesFilled > 0;
  const verdict: Verdict = !left.length ? 'repairable' : changed ? 'partly_repairable' : 'needs_manual_review';
  return { verdict, fillHoles: c.holesFilled > 0, remainingAfterRepair: left };
}

const withVerdict = (s: MeshStats, o: Outlook): MeshReport => ({ ...s, verdict: o.verdict });

function whyLeft(s: MeshStats, o: Outlook): string {
  const why: string[] = [];
  const text = o.remainingAfterRepair.join(' ');
  if (/open boundar/.test(text))
    why.push('Holes that stay open are curved, wider than max_hole_span_mm, nested, or gaps between surfaces whose vertices do not match exactly (MeshMend never welds nearby vertices, so it cannot close seams).');
  if (/non-manifold/.test(text)) why.push('Non-manifold geometry needs a decision about the intended solid, so it is never split automatically.');
  if (/inside-out/.test(text)) why.push('Inside-out shells that overlap other shells keep their orientation, because they may be intended cavities.');
  if (/winding/.test(text)) why.push('Some faces cannot be oriented consistently, which usually means non-manifold or self-overlapping geometry.');
  return why.join(' ');
}

function nextStep(s: MeshStats, o: Outlook): string {
  const call = `repair_mesh${o.fillHoles ? ' with fill_holes: true' : ''}`;
  if (o.verdict === 'ok') return 'The surface is closed and consistently oriented. Slice it as usual.';
  if (o.verdict === 'repairable') return `${call} is expected to fix all of this (checked with a trial repair in memory). It writes a new STL and leaves the original untouched.`;
  const fix = `Fix ${o.verdict === 'partly_repairable' ? 'the rest' : 'them'} in the model editor (or re-export from the source CAD), or use a fuller repair tool such as your slicer’s own repair, then check again.`;
  if (o.verdict === 'partly_repairable') return `${call} would fix part of it; ${o.remainingAfterRepair.join(', ')} would remain. ${whyLeft(s, o)} ${fix}`;
  return `MeshMend’s conservative repair cannot change these: ${o.remainingAfterRepair.join(', ')}. ${whyLeft(s, o)} ${fix}`;
}

function sizeLine(r: MeshStats) {
  return `${r.sizeMm.map((v) => v.toLocaleString('en-US')).join(' × ')} mm · ${plural(r.triangles, 'triangle')} · ${plural(r.vertices, 'vertex', 'vertices')} · ${plural(r.shells, 'shell')}`;
}

const LABEL: Record<Verdict, string> = { ok: 'ok', repairable: 'repairable', partly_repairable: 'partly repairable', needs_manual_review: 'needs manual review' };
export function reportText(r: MeshReport): string {
  const issues = problems(r);
  const head = issues.length ? `${LABEL[r.verdict]}: ${issues.join(', ')}` : 'ok: closed (watertight) and consistently oriented';
  return `${head}\nSize: ${sizeLine(r)}`;
}

async function load(path: string, unit: Unit | undefined, item: number | undefined, only3mf = false): Promise<Loaded> {
  const input = await readInput(path);
  const warnings: string[] = [];
  if (only3mf && input.format !== '3mf') throw new UserError('convert_3mf_to_stl takes a .3mf file. For an STL, use check_mesh or repair_mesh.');
  if (input.format === 'stl') {
    if (item !== undefined) warnings.push('item applies to 3MF files only; it was ignored.');
    const u = unit ?? 'mm';
    const mesh = parseSTL(input.buffer, SCALE[u]);
    if (u !== 'mm') warnings.push(`STL coordinates were read as ${u === 'in' ? 'inches' : 'centimetres'} and converted to millimetres.`);
    return { input, mesh, sourceUnit: u, items: [], selectedItem: null, warnings };
  }
  if (unit !== undefined) warnings.push('unit applies to STL files only; a 3MF file declares its own unit, which was used.');
  const pkg = parse3MF(input.buffer);
  warnings.push(...pkg.warnings);
  const items = pkg.items.map((x, index) => ({ index, name: x.name, triangles: x.mesh.length / 9 }));
  let mesh: Mesh;
  let selectedItem: number | null = null;
  if (item === undefined) mesh = combineItems(pkg.items);
  else {
    if (!Number.isInteger(item) || item < 0 || item >= pkg.items.length) throw new UserError(`item must be one of 0–${pkg.items.length - 1} (this 3MF has ${plural(pkg.items.length, 'build item')}); omit it to use all items together.`);
    mesh = pkg.items[item].mesh;
    selectedItem = item;
  }
  return { input, mesh, sourceUnit: pkg.unit, items, selectedItem, warnings };
}

const fileInfo = (l: Loaded) => ({ path: l.input.path, format: l.input.format, bytes: l.input.bytes, sourceUnit: l.sourceUnit, items: l.items, selectedItem: l.selectedItem });

function itemsText(l: Loaded) {
  if (!l.items.length) return '';
  const shown = l.items.slice(0, 20).map((x) => `${x.index}: ${x.name} (${plural(x.triangles, 'triangle')})`).join('; ');
  const more = l.items.length > 20 ? `; … ${l.items.length - 20} more` : '';
  return `\nBuild items (${l.selectedItem === null ? 'all combined' : `item ${l.selectedItem} selected`}): ${shown}${more}. Unit in the file: ${l.sourceUnit}.`;
}

/**
 * Binary STL export with the core's precision guard (checkedExportSTL in
 * src/core/mesh.ts), reusing the report already computed for this mesh
 * instead of analysing it a second time.
 */
function exportGuarded(mesh: Mesh, known: Report): ArrayBuffer {
  const buffer = exportSTL(mesh);
  const after = analyze(parseSTL(buffer));
  const fields: (keyof Report)[] = ['vertices', 'duplicateFaces', 'degenerateFaces', 'boundaryEdges', 'nonManifoldEdges', 'nonManifoldVertices', 'windingConflicts', 'components', 'inwardShells'];
  if (fields.some((k) => known[k] !== after[k]))
    throw new UserError('Binary STL precision would change this mesh topology. Move the model closer to the origin or adjust its scale in your editor, then export again.');
  return buffer;
}

function assess(mesh: Mesh, r: Report, span = 20, settled = false) {
  const stats = toStats(r, mesh);
  const o = outlook(mesh, stats, span, settled);
  return { report: withVerdict(stats, o), outlook: o, step: nextStep(stats, o) };
}

export async function checkMesh(args: { path: string; unit?: Unit; item?: number }) {
  const l = await load(args.path, args.unit, args.item);
  const { report, outlook: o, step } = assess(l.mesh, analyze(l.mesh));
  const text =
    `MeshMend check of ${basename(l.input.path)} (${l.input.format.toUpperCase()}, ${kib(l.input.bytes)})\n` +
    `Verdict: ${reportText(report)}` +
    itemsText(l) +
    `\nNext step: ${step}` +
    (l.warnings.length ? `\nNotes: ${l.warnings.join(' ')}` : '') +
    `\n${LIMITS}\nChecked on this computer; the file was not uploaded.`;
  return {
    text,
    structured: {
      file: fileInfo(l),
      report,
      repairOutlook: { fillHoles: o.fillHoles, remainingAfterRepair: o.remainingAfterRepair },
      nextStep: step,
      warnings: [...l.warnings, LIMITS],
    },
  };
}

export async function repairMesh(args: { path: string; output_path?: string; fill_holes?: boolean; max_hole_span_mm?: number; unit?: Unit; item?: number; overwrite?: boolean }) {
  const fillHoles = args.fill_holes ?? false;
  const span = args.max_hole_span_mm ?? 20;
  if (!Number.isFinite(span) || span <= 0 || span > 1000) throw new UserError('max_hole_span_mm must be more than 0 and at most 1,000.');
  const l = await load(args.path, args.unit, args.item);
  const beforeStats = toStats(analyze(l.mesh), l.mesh);
  const result = repair(l.mesh, fillHoles, span);
  const after = assess(result.mesh, result.report, span, fillHoles || result.report.boundaryEdges === 0);
  const stl = exportGuarded(result.mesh, result.report);
  const target = await chooseOutput(l.input, args.output_path, '.repaired', args.overwrite ?? false);
  const bytes = await writeOutput(target, stl);
  const c = result.changes;
  const changed = [
    c.duplicateFacesRemoved && `removed ${plural(c.duplicateFacesRemoved, 'duplicate face')}`,
    c.degenerateFacesRemoved && `removed ${plural(c.degenerateFacesRemoved, 'zero-area face')}`,
    c.trianglesFlipped && `corrected face orientation (${plural(c.trianglesFlipped, 'triangle flip')})`,
    c.holesFilled && `filled ${plural(c.holesFilled, 'hole')} with ${plural(c.trianglesAdded, 'new triangle')}`,
  ].filter(Boolean) as string[];
  const notes = [...l.warnings, ...result.warnings.filter((w) => !w.startsWith('Self-intersections'))];
  const beforeText = problems(beforeStats);
  const text =
    `MeshMend repair of ${basename(l.input.path)}\n` +
    `Changes: ${changed.length ? changed.join('; ') : beforeText.length ? 'none could be made automatically' : 'none needed'}.\n` +
    `Before: ${beforeText.length ? beforeText.join(', ') : 'closed (watertight) and consistently oriented'}\n` +
    `After: ${reportText(after.report)}\n` +
    (after.report.verdict === 'ok' ? '' : `Next step: ${after.step}\n`) +
    `Saved: ${target.path} (binary STL in millimetres, ${kib(bytes)}${target.replaces ? ', replaced the earlier file' : ''}). The original file was not changed.` +
    itemsText(l) +
    (notes.length ? `\nNotes: ${notes.join(' ')}` : '') +
    `\n${LIMITS}\nRepaired on this computer; nothing was uploaded.`;
  return {
    text,
    structured: {
      file: fileInfo(l),
      output: { path: target.path, bytes, replaced: target.replaces },
      settings: { fillHoles, maxHoleSpanMm: span },
      changes: c,
      before: beforeStats,
      after: after.report,
      nextStep: after.step,
      warnings: [...notes, LIMITS],
    },
  };
}

export async function convert3mf(args: { path: string; output_path?: string; item?: number; overwrite?: boolean }) {
  const l = await load(args.path, undefined, args.item, true);
  const analysed = analyze(l.mesh);
  const { report, step } = assess(l.mesh, analysed);
  const stl = exportGuarded(l.mesh, analysed);
  const target = await chooseOutput(l.input, args.output_path, '', args.overwrite ?? false);
  const bytes = await writeOutput(target, stl);
  const NOTE = 'Colours, materials and print settings in the 3MF are not carried into STL.';
  const text =
    `MeshMend converted ${basename(l.input.path)} to STL without changing the geometry.\n` +
    `Saved: ${target.path} (binary STL in millimetres, ${kib(bytes)}${target.replaces ? ', replaced the earlier file' : ''}). The 3MF was not changed.` +
    itemsText(l) +
    `\nMesh: ${reportText(report)}\nNext step: ${step}` +
    (l.warnings.length ? `\nNotes: ${l.warnings.join(' ')}` : '') +
    `\n${NOTE}`;
  return { text, structured: { file: fileInfo(l), output: { path: target.path, bytes, replaced: target.replaces }, report, nextStep: step, warnings: [...l.warnings, NOTE] } };
}

export { UserError };
