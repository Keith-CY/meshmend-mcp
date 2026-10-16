// Copied unchanged from MeshMend's site source (src/mesh.ts in the mesh-mend
// repository at commit 6b17aec, the code behind https://mesh-mend.pages.dev/),
// so the MCP server checks and repairs meshes exactly as the website does.
// Keep it in step with the site rather than editing it here.
import earcut from 'earcut';

export const MAX_TRIANGLES = 250_000;
export const MAX_BYTES = 30 * 1024 * 1024;
export type Mesh = Float64Array;
type Face = [number, number, number];
type Vec = [number, number, number];
type Edge = { a: number; b: number; face: number };
type Indexed = { vertices: Vec[]; faces: Face[]; duplicates: number; degenerates: number };
export type Report = {
  triangles: number; vertices: number; duplicateFaces: number; degenerateFaces: number;
  boundaryEdges: number; nonManifoldEdges: number; nonManifoldVertices: number;
  windingConflicts: number; components: number; inwardShells: number;
  dimensions: Vec; bounds: [Vec, Vec]; closedTopology: boolean;
};
export type RepairResult = { mesh: Mesh; report: Report; changes: { duplicateFacesRemoved: number; degenerateFacesRemoved: number; trianglesFlipped: number; holesFilled: number; trianglesAdded: number }; warnings: string[] };
const key = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
const sub = (a: Vec, b: Vec): Vec => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a: Vec, b: Vec) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm = (a: Vec) => Math.hypot(...a);
const edgesOf = (f: Face): [number, number][] => [[f[0],f[1]],[f[1],f[2]],[f[2],f[0]]];

export function validateMesh(mesh: Mesh) {
  if (!mesh.length || mesh.length % 9 || mesh.length / 9 > MAX_TRIANGLES) throw new Error(`Use a non-empty model with at most ${MAX_TRIANGLES.toLocaleString('en-US')} triangles.`);
  for (const n of mesh) if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new Error('The mesh contains invalid or excessively large coordinates. Re-export it from your model editor.');
}

function index(mesh: Mesh): Indexed {
  validateMesh(mesh);
  const vertices: Vec[] = [], faces: Face[] = [], ids = new Map<string,number>(), seen = new Set<string>();
  let duplicates=0, degenerates=0;
  for (let i=0;i<mesh.length;i+=9) {
    const f: Face = [0,0,0];
    for(let j=0;j<3;j++) {
      const p: Vec = [mesh[i+j*3],mesh[i+j*3+1],mesh[i+j*3+2]];
      const k=p.join(','); let id=ids.get(k);
      if(id===undefined){id=vertices.length;ids.set(k,id);vertices.push(p);} f[j]=id;
    }
    if(new Set(f).size<3 || norm(cross(sub(vertices[f[1]],vertices[f[0]]),sub(vertices[f[2]],vertices[f[0]])))===0) {degenerates++;continue;}
    const signature=[...f].sort((a,b)=>a-b).join(':');
    if(seen.has(signature)){duplicates++;continue;}seen.add(signature);faces.push(f);
  }
  return {vertices,faces,duplicates,degenerates};
}
function edgeMap(faces: Face[]) {
  const map=new Map<string,Edge[]>();
  faces.forEach((f,face)=>{for(const [a,b] of edgesOf(f)){const k=key(a,b);const items=map.get(k);const e={a,b,face};if(items)items.push(e);else map.set(k,[e]);}});
  return map;
}
function shells(faces:Face[], edges:Map<string,Edge[]>) {
  const neighbors: number[][]=Array.from({length:faces.length},()=>[]);
  for(const es of edges.values()) if(es.length===2){neighbors[es[0].face].push(es[1].face);neighbors[es[1].face].push(es[0].face);}
  const seen=new Uint8Array(faces.length), result:number[][]=[];
  for(let start=0;start<faces.length;start++)if(!seen[start]){
    const queue=[start];seen[start]=1;
    for(let q=0;q<queue.length;q++)for(const n of neighbors[queue[q]])if(!seen[n]){seen[n]=1;queue.push(n);}
    result.push(queue);
  }
  return result;
}
function signedVolume(vertices:Vec[],faces:Face[],indices:number[]) {
  const origin=vertices[faces[indices[0]][0]];let v=0;
  for(const i of indices){const [a,b,c]=faces[i];v+=dot(sub(vertices[a],origin),cross(sub(vertices[b],origin),sub(vertices[c],origin)))/6;}return v;
}
function isClosed(indices:number[],faces:Face[],edges:Map<string,Edge[]>) {
  return indices.every(i=>edgesOf(faces[i]).every(([a,b])=>edges.get(key(a,b))?.length===2));
}
function boundsOf(points:Vec[]): [Vec,Vec] {
  const lo:Vec=[Infinity,Infinity,Infinity],hi:Vec=[-Infinity,-Infinity,-Infinity];
  for(const p of points)for(let j=0;j<3;j++){lo[j]=Math.min(lo[j],p[j]);hi[j]=Math.max(hi[j],p[j]);}
  return points.length?[lo,hi]:[[0,0,0],[0,0,0]];
}
function nonManifoldVertices(vertices:Vec[],faces:Face[],edges:Map<string,Edge[]>) {
  const incident:number[][]=Array.from({length:vertices.length},()=>[]);
  faces.forEach((f,i)=>f.forEach(v=>incident[v].push(i)));
  let bad=0;
  for(let v=0;v<incident.length;v++){
    const list=incident[v];if(!list.length)continue;
    const visited=new Set<number>([list[0]]),queue=[list[0]],boundaries=new Set<string>();let branch=false;
    for(let q=0;q<queue.length;q++)for(const [a,b] of edgesOf(faces[queue[q]]))if(a===v||b===v){
      const k=key(a,b),es=edges.get(k)!;
      if(es.length===1)boundaries.add(k);
      if(es.length>2)branch=true;
      if(es.length===2)for(const e of es)if(!visited.has(e.face)){visited.add(e.face);queue.push(e.face);}
    }
    if(branch||visited.size!==list.length||(boundaries.size!==0&&boundaries.size!==2))bad++;
  }
  return bad;
}

export function analyze(mesh:Mesh): Report {
  const m=index(mesh), edges=edgeMap(m.faces);let boundaryEdges=0,nonManifoldEdges=0,windingConflicts=0;
  for(const es of edges.values()){
    if(es.length===1)boundaryEdges++;
    if(es.length>2)nonManifoldEdges++;
    if(es.length===2&&es[0].a===es[1].a)windingConflicts++;
  }
  const components=shells(m.faces,edges), used=new Set(m.faces.flat());
  const bounds=boundsOf(m.vertices.filter((_,i)=>used.has(i)));
  const badVertices=nonManifoldVertices(m.vertices,m.faces,edges);
  const inwardShells=components.filter(c=>isClosed(c,m.faces,edges)&&signedVolume(m.vertices,m.faces,c)<0).length;
  return {triangles:mesh.length/9,vertices:used.size,duplicateFaces:m.duplicates,degenerateFaces:m.degenerates,boundaryEdges,nonManifoldEdges,nonManifoldVertices:badVertices,windingConflicts,components:components.length,inwardShells,dimensions:bounds[0].map((v,i)=>bounds[1][i]-v) as Vec,bounds,closedTopology:!!m.faces.length&&!boundaryEdges&&!nonManifoldEdges&&!badVertices&&!windingConflicts&&!m.duplicates&&!m.degenerates};
}

function orient(m:Indexed) {
  const edges=edgeMap(m.faces), visited=new Uint8Array(m.faces.length), flips=new Uint8Array(m.faces.length);
  let conflict=false;
  for(let start=0;start<m.faces.length;start++)if(!visited[start]){
    visited[start]=1;const queue=[start];
    for(let q=0;q<queue.length;q++){
      const i=queue[q];
      for(const [a,b] of edgesOf(m.faces[i])){
        const es=edges.get(key(a,b))!;if(es.length!==2)continue;
        const own=es.find(e=>e.face===i)!,other=es.find(e=>e.face!==i)!;
        const flip=flips[i]^(own.a===other.a?1:0);
        if(visited[other.face]){if(flips[other.face]!==flip)conflict=true;}
        else{visited[other.face]=1;flips[other.face]=flip;queue.push(other.face);}
      }
    }
  }
  let count=0;
  m.faces.forEach((f,i)=>{if(flips[i]){[f[1],f[2]]=[f[2],f[1]];count++;}});
  const currentEdges=edgeMap(m.faces), groups=shells(m.faces,currentEdges);
  const boxes=groups.map(g=>boundsOf(g.flatMap(i=>m.faces[i].map(v=>m.vertices[v]))));
  let ambiguous=false;
  groups.forEach((g,i)=>{
    if(!isClosed(g,m.faces,currentEdges)||signedVolume(m.vertices,m.faces,g)>=0)return;
    const overlaps=boxes.some((b,j)=>j!==i&&b[0].every((v,k)=>v<=boxes[i][1][k]&&b[1][k]>=boxes[i][0][k]));
    if(overlaps){ambiguous=true;return;}
    for(const n of g){[m.faces[n][1],m.faces[n][2]]=[m.faces[n][2],m.faces[n][1]];count++;}
  });
  return {count,conflict,ambiguous};
}
function boundaryLoops(faces:Face[],edges:Map<string,Edge[]>) {
  const remaining=new Map<string,Edge>(),adj=new Map<number,Edge[]>();
  for(const [k,es] of edges)if(es.length===1){const e=es[0];remaining.set(k,e);for(const v of [e.a,e.b]){const list=adj.get(v)||[];list.push(e);adj.set(v,list);}}
  const loops:number[][]=[];
  while(remaining.size){
    const first=remaining.values().next().value!;let a=first.a,b=first.b;const path=[a];remaining.delete(key(a,b));let ok=true;
    while(b!==path[0]){
      if(path.includes(b)||path.length>128){ok=false;break;}path.push(b);
      const es=adj.get(b)||[];if(es.length!==2){ok=false;break;}
      const next=es.find(e=>key(e.a,e.b)!==key(a,b));if(!next){ok=false;break;}
      const nextV=next.a===b?next.b:next.a;
      if(!remaining.delete(key(b,nextV))){ok=false;break;}a=b;b=nextV;
    }
    if(ok&&path.length>=3&&path.every(v=>adj.get(v)?.length===2))loops.push(path);
  }
  return loops;
}
function triangulatePlanarLoop(ids:number[],vertices:Vec[],maxSpan:number) {
  const points=ids.map(i=>vertices[i]), origin=points[0], normal:Vec=[0,0,0];
  for(let i=0;i<points.length;i++){const p=sub(points[i],origin),q=sub(points[(i+1)%points.length],origin);const c=cross(p,q);for(let j=0;j<3;j++)normal[j]+=c[j];}
  const length=norm(normal);if(!length)return null;
  const n=normal.map(v=>v/length) as Vec;
  const bounds=boundsOf(points),span=norm(sub(bounds[1],bounds[0]));
  if(span>maxSpan||points.some(p=>Math.abs(dot(sub(p,origin),n))>Math.max(span*1e-6,1e-9)))return null;
  const drop=Math.abs(n[0])>Math.abs(n[1])?(Math.abs(n[0])>Math.abs(n[2])?0:2):(Math.abs(n[1])>Math.abs(n[2])?1:2);
  const flat=points.flatMap(p=>p.filter((_,i)=>i!==drop));
  const xy=points.map((_,i)=>[flat[i*2],flat[i*2+1]]);
  const turn=(a:number[],b:number[],c:number[]) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on=(a:number[],b:number[],p:number[])=>Math.abs(turn(a,b,p))<1e-12&&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])&&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1]);
  for(let i=0;i<xy.length;i++)for(let j=i+1;j<xy.length;j++){
    if(j===i+1||(i===0&&j===xy.length-1))continue;
    const a=xy[i],b=xy[(i+1)%xy.length],c=xy[j],d=xy[(j+1)%xy.length];
    if((turn(a,b,c)*turn(a,b,d)<0&&turn(c,d,a)*turn(c,d,b)<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))return null;
  }
  const result=earcut(flat);if(result.length!==(ids.length-2)*3)return null;
  const faces:Face[]=[];for(let i=0;i<result.length;i+=3)faces.push([ids[result[i]],ids[result[i+1]],ids[result[i+2]]]);return faces;
}
const soup=(m:Indexed):Mesh=>new Float64Array(m.faces.flatMap(f=>f.flatMap(i=>m.vertices[i])));

export function repair(mesh:Mesh,fillHoles=false,maxHoleSpan=10):RepairResult {
  if(!Number.isFinite(maxHoleSpan)||maxHoleSpan<=0||maxHoleSpan>1000)throw new Error('Choose a maximum hole span between 0 and 1,000 mm.');
  const m=index(mesh),warnings:string[]=[];
  if(!m.faces.length)throw new Error('No usable triangles remain after cleanup. Export a surface mesh from your model editor.');
  const changes={duplicateFacesRemoved:m.duplicates,degenerateFacesRemoved:m.degenerates,trianglesFlipped:0,holesFilled:0,trianglesAdded:0};
  let oriented=orient(m);changes.trianglesFlipped+=oriented.count;
  if(fillHoles){
    const edges=edgeMap(m.faces),before=analyze(soup(m));
    if(before.nonManifoldEdges||before.nonManifoldVertices||oriented.conflict)warnings.push('Hole filling was skipped because the mesh has ambiguous topology.');
    else{
      const loops=boundaryLoops(m.faces,edges);
      // Coplanar nested loops can bound intentional annular openings. Never cap them independently.
      const loopBoxes=loops.map(l=>boundsOf(l.map(i=>m.vertices[i])));
      for(let i=0;i<loops.length;i++){
        const overlaps=loopBoxes.some((b,j)=>j!==i&&b[0].every((v,k)=>v<=loopBoxes[i][1][k]+1e-8&&b[1][k]>=loopBoxes[i][0][k]-1e-8));
        if(overlaps)continue;
        const additions=triangulatePlanarLoop(loops[i],m.vertices,maxHoleSpan);if(!additions)continue;
        if(m.faces.length+additions.length>MAX_TRIANGLES){warnings.push('Some holes were left open to keep the result within the triangle limit.');break;}
        const current=edgeMap(m.faces);let duplicate=false;const signatures=new Set(m.faces.map(f=>[...f].sort((a,b)=>a-b).join(':')));
        for(const f of additions)if(signatures.has([...f].sort((a,b)=>a-b).join(':'))||edgesOf(f).some(([a,b])=>(current.get(key(a,b))?.length||0)>=2))duplicate=true;
        if(duplicate)continue;
        m.faces.push(...additions);changes.holesFilled++;changes.trianglesAdded+=additions.length;
      }
      oriented=orient(m);changes.trianglesFlipped+=oriented.count;
    }
  }
  if(oriented.conflict)warnings.push('This surface cannot be consistently oriented. Some winding conflicts remain.');
  if(oriented.ambiguous)warnings.push('Potentially nested or overlapping shells keep their global orientation. Inspect them in a slicer.');
  const result=soup(m),report=analyze(result);
  if(report.boundaryEdges)warnings.push('Open edges remain. Intentional openings, large gaps and non-planar holes need manual review.');
  if(report.nonManifoldEdges||report.nonManifoldVertices)warnings.push('Non-manifold geometry remains. Automatic splitting could change the intended solid.');
  warnings.push('Self-intersections, wall thickness and print supports are not checked. Inspect the downloaded file in your slicer.');
  return {mesh:result,report,changes,warnings};
}

export function issueLines(mesh:Mesh):Float32Array {
  const m=index(mesh),edges=edgeMap(m.faces),lines:number[]=[];
  for(const es of edges.values())if(es.length!==2||es[0].a===es[1].a){lines.push(...m.vertices[es[0].a],...m.vertices[es[0].b]);if(lines.length>=120_000)break;}
  return new Float32Array(lines);
}

export function parseSTL(buffer:ArrayBuffer,scale=1):Mesh {
  if(buffer.byteLength>MAX_BYTES)throw new Error('This file exceeds the 30 MiB limit. Reduce or split the model first.');
  if(![1,25.4,10].includes(scale))throw new Error('Unsupported STL unit.');
  const view=new DataView(buffer);let values:number[]|Float64Array;
  const count=buffer.byteLength>=84?view.getUint32(80,true):0;
  if(count>0&&84+count*50===buffer.byteLength){
    if(count>MAX_TRIANGLES)throw new Error('The file exceeds the 250,000 triangle limit.');
    values=new Float64Array(count*9);
    for(let i=0;i<count;i++)for(let j=0;j<9;j++)values[i*9+j]=view.getFloat32(84+i*50+12+j*4,true)*scale;
  }else{
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).trim();}catch{throw new Error('The binary STL is truncated or its triangle count is invalid. Re-export the file.');}
    if(!/^solid(?:\s|$)/i.test(text)||!/^endsolid\b.*$/im.test(text))throw new Error('This is not a complete ASCII or binary STL file.');
    const number='[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const vertex=`vertex\\s+(${number})\\s+(${number})\\s+(${number})`;
    const facet=new RegExp(`facet\\s+normal\\s+${number}\\s+${number}\\s+${number}\\s+outer\\s+loop\\s+${vertex}\\s+${vertex}\\s+${vertex}\\s+endloop\\s+endfacet`,'gi');
    values=[];
    text=text.replace(facet,(...args:unknown[])=>{for(let j=1;j<=9;j++)(values as number[]).push(Number(args[j])*scale);if(values.length/9>MAX_TRIANGLES)throw new Error('The file exceeds the 250,000 triangle limit.');return '';});
    if(text.replace(/^\s*(?:endsolid|solid)\b[^\r\n]*/gim,'').trim())throw new Error('The ASCII STL contains malformed or incomplete triangles.');
  }
  const mesh=new Float64Array(values);validateMesh(mesh);return mesh;
}

export function exportSTL(mesh:Mesh):ArrayBuffer {
  validateMesh(mesh);const buffer=new ArrayBuffer(84+mesh.length/9*50),view=new DataView(buffer);
  new Uint8Array(buffer).set(new TextEncoder().encode('MeshMend binary STL; coordinates in millimeters; review in slicer.'));
  view.setUint32(80,mesh.length/9,true);
  for(let i=0;i<mesh.length;i+=9){
    const a=Array.from(mesh.slice(i,i+3)) as Vec,b=Array.from(mesh.slice(i+3,i+6)) as Vec,c=Array.from(mesh.slice(i+6,i+9)) as Vec;
    const n=cross(sub(b,a),sub(c,a)),length=norm(n),offset=84+i/9*50;
    for(let j=0;j<3;j++)view.setFloat32(offset+j*4,length?n[j]/length:0,true);
    for(let j=0;j<9;j++)view.setFloat32(offset+12+j*4,mesh[i+j],true);
  }return buffer;
}

export function checkedExportSTL(mesh:Mesh):ArrayBuffer {
  const buffer=exportSTL(mesh),quantized=parseSTL(buffer),before=analyze(mesh),after=analyze(quantized);
  const fields:(keyof Report)[]=['vertices','duplicateFaces','degenerateFaces','boundaryEdges','nonManifoldEdges','nonManifoldVertices','windingConflicts','components','inwardShells'];
  if(fields.some(key=>before[key]!==after[key]))throw new Error('Binary STL precision would change this mesh topology. Move the model closer to the origin or adjust its scale in your editor, then export again.');
  return buffer;
}

export function demoMesh():Mesh {
  const vertices:Vec[]=[[0,0,0],[30,0,0],[30,24,0],[0,24,0],[0,0,24],[30,0,24],[30,24,24],[0,24,24],[10,8,24],[20,8,24],[20,16,24],[10,16,24]];
  const faces:Face[]=[[0,2,1],[0,3,2],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7],[4,5,9],[4,9,8],[5,6,10],[5,10,9],[6,7,11],[6,11,10],[7,4,8],[7,8,11]];
  // The 10 x 8 mm missing lid patch is intentional fixture damage, plus one flipped and one duplicate face.
  [faces[2][1],faces[2][2]]=[faces[2][2],faces[2][1]];faces.push([...faces[0]]);
  return new Float64Array(faces.flatMap(f=>f.flatMap(i=>vertices[i])));
}
