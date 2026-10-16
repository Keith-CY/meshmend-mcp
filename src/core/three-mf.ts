// Copied unchanged from MeshMend's site source (src/three-mf.ts in the mesh-mend
// repository at commit 6b17aec, the code behind https://mesh-mend.pages.dev/),
// so the MCP server checks and repairs meshes exactly as the website does.
// Keep it in step with the site rather than editing it here.
import { Unzip, UnzipInflate, zipSync, strToU8 } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MAX_BYTES, MAX_TRIANGLES, validateMesh, type Mesh } from './mesh';

const CORE='http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION='http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const REL='http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const UNITS:Record<string,number>={micron:0.001,millimeter:1,centimeter:10,inch:25.4,foot:304.8,meter:1000};
type Xml = Record<string,any>;
type Model={xml:Xml;prefix:string;unit:string;objects:Map<string,Xml>;productionPrefixes:string[]};
export type Item={name:string;mesh:Mesh};
export type ThreeMF={items:Item[];unit:string;warnings:string[]};
const array=(v:any):any[]=>v===undefined?[]:Array.isArray(v)?v:[v];
const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',parseTagValue:false,parseAttributeValue:false,processEntities:false});
function xml(data:Uint8Array|undefined):Xml {
  if(!data)throw new Error('A required part is missing from this 3MF package.');
  if(data.length>32*1024*1024)throw new Error('A model part exceeds the 32 MiB XML limit.');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw new Error('This 3MF uses an unsupported text encoding. Re-export it as UTF-8.');}
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('XML document types and custom entities are not supported.');
  const result=XMLValidator.validate(text);if(result!==true)throw new Error('A 3MF XML part is malformed. Re-export the model.');
  return parser.parse(text);
}
function partPath(path:string,base=''):string {
  if(typeof path!=='string'||/[\\?#\u0000]/.test(path)||/^[a-z][a-z0-9+.-]*:/i.test(path))throw new Error('External or invalid package references are not supported.');
  let decoded:string;try{decoded=decodeURIComponent(path);}catch{throw new Error('The package contains an invalid part path.');}
  if(/[\\?#\u0000]/.test(decoded)||/^[a-z][a-z0-9+.-]*:/i.test(decoded))throw new Error('The package contains an invalid part path.');
  const segments=(decoded.startsWith('/')?decoded:base+decoded).split('/'),resolved:string[]=[];
  for(const segment of segments){if(!segment||segment==='.')continue;if(segment==='..'){if(!resolved.length)throw new Error('A package reference escapes the archive.');resolved.pop();}else resolved.push(segment);}
  return resolved.join('/');
}
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function archiveMetadata(buffer:ArrayBuffer){
  const v=new DataView(buffer);let end=-1;
  for(let i=buffer.byteLength-22;i>=Math.max(0,buffer.byteLength-65557);i--)if(v.getUint32(i,true)===0x06054b50&&i+22+v.getUint16(i+20,true)===buffer.byteLength){end=i;break;}
  if(end<0)throw new Error('The 3MF archive is truncated or its directory is missing.');
  if(v.getUint16(end+4,true)||v.getUint16(end+6,true))throw new Error('Multi-disk ZIP archives are not supported.');
  const count=v.getUint16(end+10,true),size=v.getUint32(end+12,true),start=v.getUint32(end+16,true);
  if(count===65535||size===0xffffffff||start===0xffffffff)throw new Error('ZIP64 3MF packages are not supported in this version. Re-export as a standard ZIP-based 3MF.');
  if(count>2048||count!==v.getUint16(end+8,true)||start+size!==end)throw new Error('The 3MF archive directory is invalid or too large.');
  const parts=new Map<string,{crc:number;size:number}>();let offset=start;
  for(let i=0;i<count;i++){
    if(offset+46>end||v.getUint32(offset,true)!==0x02014b50)throw new Error('The 3MF archive directory is damaged.');
    const flags=v.getUint16(offset+8,true),method=v.getUint16(offset+10,true),length=v.getUint16(offset+28,true),extra=v.getUint16(offset+30,true),comment=v.getUint16(offset+32,true),localOffset=v.getUint32(offset+42,true);
    if((flags&1)||![0,8].includes(method))throw new Error('Encrypted or unsupported compressed 3MF entries cannot be converted.');
    if(offset+46+length+extra+comment>end||localOffset>=start)throw new Error('The 3MF archive directory is damaged.');
    const name=partPath(new TextDecoder().decode(new Uint8Array(buffer,offset+46,length)));
    if(parts.has(name))throw new Error('The 3MF archive contains duplicate part names.');
    parts.set(name,{crc:v.getUint32(offset+16,true),size:v.getUint32(offset+24,true)});offset+=46+length+extra+comment;
  }
  if(offset!==end)throw new Error('The 3MF archive directory has an unexpected length.');return parts;
}
function unpack(buffer:ArrayBuffer) {
  if(buffer.byteLength>MAX_BYTES)throw new Error('This file exceeds the 30 MiB limit.');
  const bytes=new Uint8Array(buffer);
  if(bytes[0]!==80||bytes[1]!==75)throw new Error('This is not a ZIP-based 3MF file.');
  const expected=archiveMetadata(buffer);
  const files=new Map<string,Uint8Array>(),names=new Set<string>();let entries=0,total=0,started=0,finished=0;
  const unzip=new Unzip(file=>{
    if(++entries>2048)throw new Error('The 3MF archive contains too many entries.');
    const name=partPath(file.name);if(names.has(name)||!expected.has(name))throw new Error('The 3MF archive contains duplicate or inconsistent part names.');names.add(name);
    if(!/\.(model|rels)$/i.test(name)&&name!=='[Content_Types].xml')return;
    if((file.originalSize||0)>32*1024*1024)throw new Error('An expanded 3MF part is too large.');
    const chunks:Uint8Array[]=[];let size=0;started++;
    file.ondata=(error,data,final)=>{
      if(error)throw new Error(error.message||'The 3MF archive could not be decompressed.');
      size+=data.length;total+=data.length;
      if(size>32*1024*1024||total>64*1024*1024)throw new Error('Expanded model data exceeds the browser safety limit.');
      chunks.push(data);if(final){const merged=new Uint8Array(size);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.length;}const meta=expected.get(name)!;if(size!==meta.size||crc32(merged)!==meta.crc)throw new Error('A 3MF part failed its checksum. The archive may be damaged.');files.set(name,merged);finished++;}
    };file.start();
  });unzip.register(UnzipInflate);
  try{for(let offset=0;offset<bytes.length;offset+=16384)unzip.push(bytes.subarray(offset,offset+16384),offset+16384>=bytes.length);}catch(e){if(e instanceof Error)throw e;throw new Error('The 3MF archive is damaged.');}
  if(started!==finished||entries!==expected.size)throw new Error('The 3MF archive is truncated.');return files;
}
const numeric=(value:unknown,label:string)=>{
  if(typeof value!=='string'||!/^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(value))throw new Error(`Invalid ${label} in the 3MF model.`);
  const n=Number(value);if(!Number.isFinite(n)||Math.abs(n)>1e9)throw new Error(`Invalid ${label} in the 3MF model.`);return n;
};
const IDENTITY=[1,0,0,0,1,0,0,0,1,0,0,0];
function matrix(value:unknown):number[] {
  if(value===undefined)return IDENTITY;
  if(typeof value!=='string')throw new Error('Invalid 3MF transform.');const fields=value.trim().split(/\s+/);
  if(fields.length!==12)throw new Error('A 3MF transform must contain 12 numbers.');
  const m=fields.map(v=>numeric(v,'transform'));if(Math.abs(determinant(m))<1e-15)throw new Error('A 3MF transform collapses the model. Re-export it.');return m;
}
function determinant(m:number[]) {return m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);}
function point(p:number[],transforms:number[][],scale:number) {
  let [x,y,z]=p;
  for(let i=transforms.length-1;i>=0;i--){const m=transforms[i];[x,y,z]=[x*m[0]+y*m[3]+z*m[6]+m[9],x*m[1]+y*m[4]+z*m[7]+m[10],x*m[2]+y*m[5]+z*m[8]+m[11]];}
  return [x*scale,y*scale,z*scale];
}

export function parse3MF(buffer:ArrayBuffer):ThreeMF {
  const files=unpack(buffer),rels=xml(files.get('_rels/.rels'));
  const relRoot=Object.keys(rels).find(k=>k==='Relationships'||k.endsWith(':Relationships'));
  if(!relRoot)throw new Error('The 3MF has no package relationships.');
  const prefix=relRoot.includes(':')?relRoot.split(':')[0]+':':'';
  const roots=array(rels[relRoot][prefix+'Relationship']).filter(r=>r['@Type']===REL);
  if(roots.length!==1||roots[0]['@TargetMode']==='External')throw new Error('The 3MF must have one internal primary model relationship.');
  const rootPath=partPath(roots[0]['@Target']),models=new Map<string,Model>();
  function load(path:string):Model {
    const cached=models.get(path);if(cached)return cached;
    const data=xml(files.get(path));const root=Object.keys(data).find(k=>k==='model'||k.endsWith(':model'));
    if(!root||Array.isArray(data[root]))throw new Error('The 3MF model part is invalid.');
    const model=data[root],prefix=root.includes(':')?root.split(':')[0]+':':'';
    const namespace=model[prefix?'@xmlns:'+prefix.slice(0,-1):'@xmlns'];
    if(namespace!==CORE)throw new Error('This 3MF core namespace is not supported.');
    const unit=model['@unit']||'millimeter';if(!UNITS[unit])throw new Error('Unsupported 3MF unit.');
    const productionPrefixes=Object.keys(model).filter(k=>k.startsWith('@xmlns:')&&model[k]===PRODUCTION).map(k=>k.slice(7));
    const required=String(model['@requiredextensions']||'').trim().split(/\s+/).filter(Boolean);
    for(const ext of required)if(model['@xmlns:'+ext]!==PRODUCTION)throw new Error(`Required 3MF extension “${ext}” is not supported. Export a standard mesh-only 3MF or STL from your slicer.`);
    const objects=new Map<string,Xml>();
    for(const obj of array(model[prefix+'resources']?.[prefix+'object'])){
      const id=obj['@id'];if(typeof id!=='string'||!/^\d+$/.test(id)||Number(id)<1||objects.has(id))throw new Error('Invalid or repeated 3MF object identifier.');objects.set(id,obj);
    }
    const loaded={xml:model,prefix,unit,objects,productionPrefixes};models.set(path,loaded);return loaded;
  }
  const root=load(rootPath),build=array(root.xml[root.prefix+'build']?.[root.prefix+'item']);
  if(!build.length)throw new Error('This 3MF contains no build geometry. A sliced G-code-only 3MF cannot be converted to an STL mesh.');
  if(build.length>256)throw new Error('This 3MF has more than 256 build items. Split the project in your slicer.');
  let totalTriangles=0,visits=0,skipped=0;const items:Item[]=[];
  function reference(node:Xml,model:Model,path:string){
    const attrs=model.productionPrefixes.map(p=>node['@'+p+':path']).filter(v=>v!==undefined);
    if(attrs.length>1)throw new Error('Ambiguous 3MF part reference.');
    if(!attrs.length)return path;
    if(path!==rootPath)throw new Error('Nested cross-file 3MF references are not supported.');
    if(typeof attrs[0]!=='string'||!attrs[0].startsWith('/'))throw new Error('A production part reference must be an absolute package path.');
    return partPath(attrs[0]);
  }
  function visit(path:string,id:string,transforms:number[][],stack:Set<string>,output:number[]) {
    if(++visits>10_000||stack.size>32)throw new Error('The 3MF component graph is too complex.');
    const stamp=path+'#'+id;if(stack.has(stamp))throw new Error('The 3MF contains a circular component reference.');
    const model=load(path);if(model.unit!==root.unit)throw new Error('Mixed units across 3MF model parts are not supported. Re-export using one unit.');
    const obj=model.objects.get(String(id));if(!obj)throw new Error('A referenced 3MF object is missing.');
    const next=new Set(stack);next.add(stamp);const p=model.prefix,mesh=obj[p+'mesh'],components=obj[p+'components'];
    if(!!mesh===!!components)throw new Error('A 3MF object must contain either a mesh or components.');
    if(components){const cs=array(components[p+'component']);if(!cs.length)throw new Error('An empty 3MF component object cannot be converted.');for(const c of cs)visit(reference(c,model,path),c['@objectid'],[...transforms,matrix(c['@transform'])],next,output);return;}
    const vertices=array(mesh[p+'vertices']?.[p+'vertex']).map(v=>['x','y','z'].map(a=>numeric(v['@'+a],'vertex coordinate')));
    const triangles=array(mesh[p+'triangles']?.[p+'triangle']);
    if(!triangles.length)throw new Error('A 3MF mesh contains no triangles.');
    totalTriangles+=triangles.length;if(totalTriangles>MAX_TRIANGLES)throw new Error('The expanded build exceeds the 250,000 triangle limit.');
    const mirrored=transforms.reduce((sign,m)=>sign*Math.sign(determinant(m)),1)<0;
    for(const t of triangles){
      const ids=['v1','v2','v3'].map(k=>numeric(t['@'+k],'triangle index'));
      if(ids.some(v=>!Number.isSafeInteger(v)||v<0||v>=vertices.length))throw new Error('A 3MF triangle references an invalid vertex.');
      if(mirrored)[ids[1],ids[2]]=[ids[2],ids[1]];
      for(const i of ids)output.push(...point(vertices[i],transforms,UNITS[root.unit]));
    }
  }
  for(let i=0;i<build.length;i++){
    const item=build[i];if(item['@printable']==='0'||item['@printable']==='false'){skipped++;continue;}
    const path=reference(item,root,rootPath),object=load(path).objects.get(String(item['@objectid'])),output:number[]=[];
    visit(path,item['@objectid'],[matrix(item['@transform'])],new Set(),output);
    const mesh=new Float64Array(output);validateMesh(mesh);
    const label=object?.['@name']||`Build item ${i+1}`;items.push({name:String(label).slice(0,120),mesh});
  }
  if(!items.length)throw new Error('No printable build items were found in this 3MF.');
  const warnings=['STL keeps triangle geometry only. Colors, textures, materials, printer profiles and plate metadata are not exported.','Build-item positions are preserved. Combining items does not boolean-union overlapping solids.'];
  if(skipped)warnings.push(`${skipped} non-printable build item(s) were excluded.`);
  return {items,unit:root.unit,warnings};
}
export function combineItems(items:Item[]):Mesh {
  const total=items.reduce((sum,i)=>sum+i.mesh.length,0);if(total/9>MAX_TRIANGLES)throw new Error('Too many triangles.');
  const result=new Float64Array(total);let offset=0;for(const i of items){result.set(i.mesh,offset);offset+=i.mesh.length;}validateMesh(result);return result;
}
export function demo3MF():ArrayBuffer {
  const model=`<model xmlns="${CORE}" unit="inch"><resources><object id="1" name="Calibration tetrahedron"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const bytes=zipSync({'[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),'_rels/.rels':strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r0" Type="${REL}" Target="/3D/3dmodel.model"/></Relationships>`),'3D/3dmodel.model':strToU8(model)});
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
}
