import {canonical,jsonBytes,parseCanonicalJson,type Scope} from './protocol';
import {sameScope,indexRow} from './wire';
import {objectOid} from './sealed';
/** Canonical wire tree. The P1 local radix cache is not a wire tree. */
export function buildTree(scope:Scope,rows:any[],prefix=''): {oid:string;bytes:Uint8Array;nodes:Map<string,Uint8Array>} {
 if(rows.length>1000000)throw Error('object_too_large');const sorted=[...rows].sort((a,b)=>a.entityKey<b.entityKey?-1:a.entityKey>b.entityKey?1:0);let prior='';for(const row of sorted){indexRow(row);if(row.entityKey<=prior||!row.entityKey.startsWith(prefix))throw Error('invalid_schema');prior=row.entityKey;}
 const leaf={version:2,scope,form:'leaf',prefix,rows:sorted};let raw=sorted.length<=256?jsonBytes(leaf):new Uint8Array();const nodes=new Map<string,Uint8Array>();
 if(sorted.length>256||raw.length>262144){if(prefix.length>=64)throw Error('object_too_large');const children=[];for(const digit of '0123456789abcdef'){const group=sorted.filter(r=>r.entityKey[prefix.length]===digit);if(group.length){const child=buildTree(scope,group,prefix+digit);for(const [id,b]of child.nodes)nodes.set(id,b);children.push({digit,oid:child.oid,count:group.length});}}raw=jsonBytes({version:2,scope,form:'node',prefix,children});}
 const id=objectOid('tree',raw);nodes.set(id,raw);return {oid:id,bytes:raw,nodes};
}
/** Verify the complete signed-root closure, including canonical split decisions. */
export async function readTree(scope:Scope,root:string,get:(oid:string)=>Promise<Uint8Array>){
 const seen=new Set<string>();let total=0;const walk=async(id:string,prefix:string):Promise<any[]>=>{
  if(seen.has(id)||seen.size>=1000000)throw Error('invalid_schema');seen.add(id);const raw=await get(id);if(objectOid('tree',raw)!==id)throw Error('hash_mismatch');const node=parseCanonicalJson(raw);sameScope(node.scope,scope);if(node.version!==2||node.prefix!==prefix)throw Error('invalid_schema');
  if(node.form==='leaf'){if(canonical(Object.keys(node).sort())!==canonical(['form','prefix','rows','scope','version']))throw Error('invalid_schema');if(!Array.isArray(node.rows)||node.rows.length>256)throw Error('invalid_schema');total+=node.rows.length;if(total>1000000)throw Error('object_too_large');if(raw.length>262144)throw Error('object_too_large');for(const row of node.rows)indexRow(row);if(node.rows.some((r:any,i:number)=>!r.entityKey.startsWith(prefix)||i>0&&node.rows[i-1].entityKey>=r.entityKey))throw Error('invalid_schema');return node.rows;}
  if(node.form!=='node'||prefix.length>=64||canonical(Object.keys(node).sort())!==canonical(['children','form','prefix','scope','version'])||!Array.isArray(node.children)||node.children.length===0||node.children.length>16)throw Error('invalid_schema');const rows:any[]=[];let prior='';for(const child of node.children){if(canonical(Object.keys(child).sort())!==canonical(['count','digit','oid'])||!/[0-9a-f]/.test(child.digit)||child.digit.length!==1||child.digit<=prior)throw Error('invalid_schema');prior=child.digit;const part=await walk(child.oid,prefix+child.digit);if(child.count!==part.length)throw Error('invalid_schema');rows.push(...part);}if(rows.length<=256&&jsonBytes({version:2,scope,form:'leaf',prefix,rows}).length<=262144)throw Error('invalid_schema');return rows;
 };return walk(root,'');
}

/** Rewrite affected paths only. Canonical leaf collapse reads at most 256 rows. */
export async function updateTree(scope:Scope,root:string,get:(oid:string)=>Promise<Uint8Array>,changes:any[]){
 const nodes=new Map<string,Uint8Array>();for(const row of changes)indexRow(row);const cache=new Map<string,any>();
 const load=async(id:string)=>{if(cache.has(id))return cache.get(id);const raw=await get(id);if(objectOid('tree',raw)!==id)throw Error('hash_mismatch');const node=parseCanonicalJson(raw);sameScope(node.scope,scope);cache.set(id,node);return node;};
 const all=async(id:string):Promise<any[]>=>{const node=await load(id);if(node.form==='leaf')return node.rows;const rows=[];for(const child of node.children)rows.push(...await all(child.oid));return rows;};
 const visit=async(id:string,prefix:string,updates:any[]):Promise<{oid:string;count:number}>=>{
  const old=await load(id);if(old.version!==2||old.prefix!==prefix)throw Error('invalid_schema');
  if(old.form==='leaf'){const rows=new Map(old.rows.map((r:any)=>[r.entityKey,r]));for(const row of updates)rows.set(row.entityKey,row);const tree=buildTree(scope,[...rows.values()],prefix);for(const [key,raw]of tree.nodes)nodes.set(key,raw);return {oid:tree.oid,count:rows.size};}
  if(old.form!=='node')throw Error('invalid_schema');const children=[];for(const digit of '0123456789abcdef'){
   const child=old.children.find((c:any)=>c.digit===digit),group=updates.filter(r=>r.entityKey[prefix.length]===digit);if(!group.length){if(child)children.push(child);continue;}
   let next;if(child)next=await visit(child.oid,prefix+digit,group);else{const tree=buildTree(scope,group,prefix+digit);for(const [key,raw]of tree.nodes)nodes.set(key,raw);next={oid:tree.oid,count:group.length};}children.push({digit,...next});
  }
  const count=children.reduce((n,c)=>n+c.count,0);let raw:Uint8Array;
  if(count<=256){const rows:any[]=[];for(const child of children){if(nodes.has(child.oid)){const treeRows=await readSubtree(child.oid);rows.push(...treeRows);}else rows.push(...await all(child.oid));}raw=jsonBytes({version:2,scope,form:'leaf',prefix,rows:rows.sort((a,b)=>a.entityKey<b.entityKey?-1:1)});if(raw.length>262144)raw=jsonBytes({version:2,scope,form:'node',prefix,children});}
  else raw=jsonBytes({version:2,scope,form:'node',prefix,children});
  const next=objectOid('tree',raw);nodes.set(next,raw);return {oid:next,count};
 };
 const readSubtree=async(id:string):Promise<any[]>=>{const node=nodes.has(id)?parseCanonicalJson(nodes.get(id)!):await load(id);if(node.form==='leaf')return node.rows;const rows=[];for(const child of node.children)rows.push(...await readSubtree(child.oid));return rows;};
 if(!changes.length)return {oid:root,nodes};const next=await visit(root,'',changes);return {...next,nodes};
}
