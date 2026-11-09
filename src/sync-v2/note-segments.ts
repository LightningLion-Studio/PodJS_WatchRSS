/** Sync v2-rc7 long-note business codec (sync-v2.md section 25). Pure codec,
 * ordered closure authentication and authenticated segment reuse. IO is ports. */
import {GreedyScalarSegmenter,isGreedyScalarSegmentation,jsonStringBodyBytes,type ScalarSegmentLimits} from '@podjs/framework/json-text-segments';
import {ContentSha256} from '@podjs/framework/content-sha256';
import {canonical,jsonBytes,bytes,exact,hexId,oid,uint,parseCanonicalJson} from './protocol';
import {features as checkFeatures} from './wire';
import {objectOid} from './sealed';

export const NOTE_SEGMENTS_FEATURE='note-segments.v1';
export const STATE_LIMIT=262144,SEGMENT_TEXT_LIMIT=245760,MAX_SEGMENTS=2048,SEALED_OVERHEAD=4120;
export const NOTE_TEXT_FIELDS:readonly string[]=Object.freeze(['baseMarkdown','markdown','plainText']);
/** Watch resource budget for B=U(J(T)). Larger notes return storage_pressure:
 * the read side decides the budget on the REASSEMBLED note with this very
 * meter (measureNote().textBytes, M1b), never on sealed bytes, so devices
 * sharing one budget always agree on publishable <=> readable. Downloading
 * stays memory-safe through the independent sealed-hold cap in
 * readSegmentedNote. The codec itself supports the 2048-segment limit. */
export const NOTE_TEXT_BUDGET=2*1024*1024;
const MAX_SEALED=266264,PLACEHOLDER='state:sha256:'+'0'.repeat(64);
export type TextSource=string|(()=>Iterable<string>);
export interface NoteInput {entityKey:string;features:readonly string[];metadata:Record<string,any>;fields:Record<string,TextSource>}
const fail=(code:string):never=>{throw Error(code);};
const add=(a:number,b:number)=>{const sum=a+b;if(!Number.isSafeInteger(sum))fail('object_too_large');return sum;};
const plain=(value:any)=>!!value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;

function* chunks(source:TextSource):Iterable<string> {
 if(typeof source!=='string'){yield* source();return;}
 for(let at=0;at<source.length;){let end=Math.min(source.length,at+8192);const c=source.charCodeAt(end-1);if(end<source.length&&c>=0xd800&&c<=0xdbff)end--;yield source.slice(at,end);at=end;}
}
/** Tokens of J(T): structure plus escaped string bodies, never one full copy. */
function* textTokens(fields:Record<string,TextSource>):Iterable<string> {
 yield '{';let n=0;
 for(const key of Object.keys(fields).sort()){yield (n++?',':'')+JSON.stringify(key)+':"';for(const chunk of chunks(fields[key]!))yield JSON.stringify(chunk).slice(1,-1);yield '"';}
 yield '}';
}
export function segmentState(entityKey:string,noteRevision:string,index:number,text:string){return {version:2,entityKey,requiredFeatures:[],payload:{segmentOf:noteRevision,index,text},noteSegments:[]};}
export function segmentLimits(entityKey:string,noteRevision:string):ScalarSegmentLimits{
 const base=jsonBytes(segmentState(entityKey,noteRevision,0,'')).length-1;
 return {maxRawBytes:SEGMENT_TEXT_LIMIT,maxEncodedBytes:STATE_LIMIT,overhead:index=>base+String(index).length,maxSegments:MAX_SEGMENTS};
}
export function parentState(input:NoteInput,noteRevision:string,count:number,plaintextSha256:string,segmentOids:readonly string[]){
 return {version:2,entityKey:input.entityKey,requiredFeatures:[...new Set([...input.features,NOTE_SEGMENTS_FEATURE])].sort(),payload:{segmentedNote:true,noteRevision,segmentCount:count,plaintextSha256,metadata:JSON.parse(canonical(input.metadata))},noteSegments:[...segmentOids]};
}
export const refsBytes=(scope:unknown,stateOid:string,segmentOids:readonly string[])=>jsonBytes({body:{scope,stateOid,segmentOids:[...segmentOids]},signature:'A'.repeat(86)}).length;

/** T sources and M of an ordinary note state. Absent fields stay absent. */
export function splitOrdinary(state:any):NoteInput {
 exact(state,['version','entityKey','requiredFeatures','payload','noteSegments']);hexId(state.entityKey,64);checkFeatures(state.requiredFeatures);
 if(state.version!==2||!Array.isArray(state.noteSegments)||state.noteSegments.length||state.requiredFeatures.includes(NOTE_SEGMENTS_FEATURE)||!plain(state.payload)||Object.hasOwn(state.payload,'segmentedNote'))fail('invalid_schema');
 const metadata={...state.payload},fields:Record<string,string>={};
 for(const key of NOTE_TEXT_FIELDS)if(Object.hasOwn(metadata,key)){if(typeof metadata[key]!=='string')fail('invalid_schema');fields[key]=metadata[key];delete metadata[key];}
 return {entityKey:state.entityKey,features:state.requiredFeatures,metadata,fields};
}
/** Exact len(U(J(S0))) and len(B) without serializing the text fields. */
export function measureNote(input:NoteInput){
 const empty:Record<string,string>={};let escaped=0;
 for(const key of Object.keys(input.fields)){if(!NOTE_TEXT_FIELDS.includes(key)||Object.hasOwn(input.metadata,key))fail('invalid_schema');empty[key]='';for(const chunk of chunks(input.fields[key]!))escaped=add(escaped,jsonStringBodyBytes(chunk).escaped);}
 return {shortBytes:add(jsonBytes({version:2,entityKey:input.entityKey,requiredFeatures:[...input.features],payload:{...input.metadata,...empty},noteSegments:[]}).length,escaped),textBytes:add(jsonBytes(empty).length,escaped)};
}
export type NoteEncoding={form:'short';shortBytes:number;textBytes:number}|{form:'segmented';shortBytes:number;textBytes:number;noteRevision:string;segmentCount:number;plaintextSha256:string;parentPlainBytes:number};
/** 25.1/25.4: ordinary iff len(U(J(S0)))<=L; otherwise greedy segments are
 * emitted in order. Every limit failure is object_too_large; budget failure is
 * storage_pressure. The input is never modified. */
export function encodeNote(input:NoteInput,noteRevision:string,emit:(index:number,text:string)=>void,budget=Number.MAX_SAFE_INTEGER):NoteEncoding {
 hexId(noteRevision,32);const measured=measureNote(input);
 if(measured.shortBytes<=STATE_LIMIT)return {form:'short',...measured};
 if(measured.textBytes>budget)fail('storage_pressure');
 if(jsonBytes(parentState(input,noteRevision,1,'0'.repeat(64),[PLACEHOLDER])).length>STATE_LIMIT)fail('object_too_large');
 const hash=new ContentSha256();let total=0;
 const segmenter=new GreedyScalarSegmenter(segmentLimits(input.entityKey,noteRevision),(index,text)=>{const b=bytes(text);hash.update(b);total=add(total,b.length);emit(index,text);});
 for(const token of textTokens(input.fields))segmenter.push(token);
 const count=segmenter.finish(),sha=hash.finish();if(total!==measured.textBytes)fail('invalid_encoding');
 const parentPlainBytes=jsonBytes(parentState(input,noteRevision,count,sha,Array(count).fill(PLACEHOLDER))).length;if(parentPlainBytes>STATE_LIMIT)fail('object_too_large');
 return {form:'segmented',...measured,noteRevision,segmentCount:count,plaintextSha256:sha,parentPlainBytes};
}

/** 25.5 step 2: structural parent guard (section 23.3). */
export function checkSegmentedParent(state:any,entityKey?:string){
 try{exact(state,['version','entityKey','requiredFeatures','payload','noteSegments']);hexId(state.entityKey,64);checkFeatures(state.requiredFeatures);}catch{fail('invalid_schema');}
 const p=state.payload;if(state.version!==2||entityKey!==undefined&&state.entityKey!==entityKey||!state.requiredFeatures.includes(NOTE_SEGMENTS_FEATURE)||!plain(p)||!Array.isArray(state.noteSegments))fail('invalid_schema');
 try{exact(p,['segmentedNote','noteRevision','segmentCount','plaintextSha256','metadata']);hexId(p.noteRevision,32);hexId(p.plaintextSha256,64);uint(p.segmentCount,MAX_SEGMENTS);for(const id of state.noteSegments)oid(id,'state');}catch{fail('invalid_schema');}
 if(p.segmentedNote!==true||p.segmentCount<1||p.segmentCount!==state.noteSegments.length||new Set(state.noteSegments).size!==state.noteSegments.length||!plain(p.metadata)||NOTE_TEXT_FIELDS.some(k=>Object.hasOwn(p.metadata,k))||Object.hasOwn(p.metadata,'segmentedNote'))fail('invalid_schema');
}
const parentInput=(parent:any,fields:Record<string,TextSource>={}):NoteInput=>({entityKey:parent.entityKey,features:parent.requiredFeatures.filter((f:string)=>f!==NOTE_SEGMENTS_FEATURE),metadata:parent.payload.metadata,fields});
/** 25.5 steps 9-11 on authenticated, ordered segment values. Returns S0. */
export function assembleSegments(parent:any,values:readonly any[]){
 const p=parent.payload,texts:string[]=[];
 values.forEach((v,i)=>{
  try{exact(v,['version','entityKey','requiredFeatures','payload','noteSegments']);exact(v.payload,['segmentOf','index','text']);}catch{fail('invalid_schema');}
  const q=v.payload;if(v.version!==2||v.entityKey!==parent.entityKey||q.segmentOf!==p.noteRevision||q.index!==i||!Array.isArray(v.noteSegments)||v.noteSegments.length||!Array.isArray(v.requiredFeatures)||v.requiredFeatures.length||typeof q.text!=='string'||!q.text)fail('invalid_schema');
  if(jsonBytes(v).length>STATE_LIMIT||jsonStringBodyBytes(q.text).raw>SEGMENT_TEXT_LIMIT)fail('object_too_large');texts.push(q.text);
 });
 if(texts.length!==p.segmentCount)fail('invalid_schema');
 const hash=new ContentSha256();let total=0;for(const text of texts){const b=bytes(text);hash.update(b);total=add(total,b.length);}
 if(hash.finish()!==p.plaintextSha256)fail('hash_mismatch');
 const joined=texts.join('');let decoded:any;try{decoded=JSON.parse(joined);}catch{fail('invalid_encoding');}
 if(!plain(decoded)||Object.entries(decoded).some(([k,v])=>!NOTE_TEXT_FIELDS.includes(k)||typeof v!=='string'))fail('invalid_schema');
 let encoded='';try{encoded=canonical(decoded);}catch{fail('invalid_encoding');}if(encoded!==joined||bytes(encoded).length!==total)fail('invalid_encoding');
 if(Object.keys(decoded).some(k=>Object.hasOwn(p.metadata,k)))fail('invalid_schema');
 const input=parentInput(parent,decoded);if(measureNote(input).shortBytes<=STATE_LIMIT||!isGreedyScalarSegmentation(texts,segmentLimits(parent.entityKey,p.noteRevision)))fail('invalid_schema');
 return {version:2,entityKey:parent.entityKey,requiredFeatures:[...input.features],payload:{...JSON.parse(canonical(p.metadata)),...decoded},noteSegments:[]};
}

export interface RefsRead {mapping:any;raw:Uint8Array|null}
export interface ClosurePorts {
 /** Sealed bytes, or null when the object is missing. */
 object(oid:string):Promise<Uint8Array|null>;
 /** Public refs mapping and raw table bytes; null when missing. */
 refs(stateOid:string):Promise<RefsRead|null>;
 /** Full section 2 authentication of one sealed state; returns its value. */
 open(oid:string,raw:Uint8Array):Promise<any>;
 /** Mapping, scope and signature authentication; returns segmentOids. */
 verifyRefs(stateOid:string,read:RefsRead):Promise<string[]>;
}
function peekPlainBytes(raw:Uint8Array){
 try{if(raw.length<8)return 0;const n=new DataView(raw.buffer,raw.byteOffset,raw.byteLength).getUint32(4,false);if(8+n>raw.length)return 0;const h=parseCanonicalJson(raw.subarray(8,8+n));return typeof h?.plainBytes==='number'?h.plainBytes:0;}catch{return 0;}
}
/** 25.5: authenticate the complete closure of an already-opened parent in the
 * frozen error order, then reassemble. Nothing is applied here. Returns S0 and
 * the authenticated segment objects for later reuse. */
export async function readSegmentedNote(parentOid:string,parent:any,ports:ClosurePorts,options:{entityKey?:string;supported:readonly string[];budget?:number}){
 checkSegmentedParent(parent,options.entityKey);
 if(parent.requiredFeatures.some((f:string)=>!options.supported.includes(f)))fail('unsupported_feature');
 if(jsonBytes(parent).length>STATE_LIMIT)fail('object_too_large');
 const ids:string[]=parent.noteSegments,budget=options.budget??Number.MAX_SAFE_INTEGER,parentRefs=await ports.refs(parentOid),items:{raw:Uint8Array|null;refs:RefsRead|null}[]=[];let held=0;
 // M1b: the budget is decided on the reassembled note below with the one
 // scan/publish meter. Downloading is guarded only by this independent memory
 // cap. Derivation of its worst legitimate value for textBytes<=budget (E):
 // one escaped byte of the J(T) body re-escapes into the segment-state JSON
 // at ratio <=2 (`"`/`\` cost 2 escaped and 4 state bytes; `\u00XX` 6 and 7),
 // so all segment states together hold <= 2E + ~70 + 160*n. A sealed state is
 // its plaintext + GCM tag + framing <= plaintext + ~430 <= plaintext +
 // SEALED_OVERHEAD. Public refs tables (also retained) are the n OIDs plus a
 // signature. Worst legitimate hold is therefore ~2*budget + n*590, and the
 // cap 3*budget + SEALED_OVERHEAD*n leaves one whole budget of slack. Only a
 // body whose escape inflation (or padded refs) passes that bound can be
 // adversarial: fail closed as storage_pressure, the quarantine code, before
 // any open or assembly. A default (unbounded) budget keeps the cap unbounded.
 const holdLimit=budget>Number.MAX_SAFE_INTEGER/4?Number.POSITIVE_INFINITY:add(add(budget,budget),add(budget,SEALED_OVERHEAD*ids.length));
 const charge=(raw:Uint8Array|null)=>{if(raw){held=add(held,raw.length);if(held>holdLimit)fail('storage_pressure');}};
 for(const id of ids){const raw=await ports.object(id);charge(raw);const refs=await ports.refs(id);charge(refs?.raw??null);items.push({raw,refs});}
 const tables=[parentRefs,...items.map(x=>x.refs)];
 // 4: sizes of every present object and table.
 for(const x of items)if(x.raw&&(x.raw.length>MAX_SEALED||peekPlainBytes(x.raw)>STATE_LIMIT))fail('object_too_large');
 for(const t of tables)if(t?.raw&&t.raw.length>STATE_LIMIT)fail('object_too_large');
 // 5: closure.
 if(tables.some(t=>!t||!t.raw)||items.some(x=>!x.raw))fail('closure_incomplete');
 // 6: content addresses.
 items.forEach((x,i)=>{if(objectOid('state',x.raw!)!==ids[i])fail('hash_mismatch');});
 for(const t of tables as RefsRead[]){const id=t.mapping?.refsOid;if(typeof id==='string'&&/^state-refs:sha256:[a-f0-9]{64}$/.test(id)&&(objectOid('state-refs',t.raw!)!==id||t.mapping.totalBytes!==t.raw!.length))fail('hash_mismatch');}
 // 7: envelopes and signatures.
 const values:any[]=[];for(let i=0;i<ids.length;i++)values.push(await ports.open(ids[i]!,items[i]!.raw!));
 const listed=await ports.verifyRefs(parentOid,parentRefs!),childLists:string[][]=[];for(let i=0;i<ids.length;i++)childLists.push(await ports.verifyRefs(ids[i]!,items[i]!.refs!));
 // 8: public order equals the encrypted order.
 if(canonical(listed)!==canonical(ids))fail('invalid_schema');
 // 9-11.
 if(childLists.some(list=>list.length))fail('invalid_schema');
 const state=assembleSegments(parent,values);
 // M1b: the budget decision, on the reassembled note and with the exact
 // scan/publish meter (business.candidates -> encodeNote -> measureNote): it
 // charges the JSON-escaped bytes of the three text fields against the same
 // budget, so a note that passed scan is readable on every device carrying
 // that budget; sealed bytes are no longer a budget criterion (control chars
 // and quotes re-escape once more per segment, so the old sealed line
 // quarantined legitimate notes whose escaped charge still fit).
 if(measureNote(splitOrdinary(state)).textBytes>budget)fail('storage_pressure');
 return {state,segments:{noteRevision:parent.payload.noteRevision as string,objects:ids.map((id,i)=>({oid:id,sealed:items[i]!.raw!}))}};
}

export interface PriorSegments {noteRevision:string;objects:readonly {oid:string;sealed:Uint8Array}[]}
export interface SealPorts {
 seal(plain:Uint8Array):Promise<{oid:string;bytes:Uint8Array}>;
 signRefs(stateOid:string,segmentOids:string[]):Promise<Uint8Array>;
 open(oid:string,raw:Uint8Array):Promise<{plain:Uint8Array}>;
}
const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
/** 25.3/25.4/25.7: seal one segmented note. Unchanged segments of the same
 * binding reuse their original sealed bytes only after full authentication. */
export async function sealSegmentedNote(state:any,noteRevision:string,ports:SealPorts,prior:PriorSegments|null,budget=NOTE_TEXT_BUDGET){
 const input=splitOrdinary(state),texts:string[]=[],encoding=encodeNote(input,noteRevision,(_i,t)=>{texts.push(t);},budget);
 if(encoding.form!=='segmented')return fail('invalid_schema');
 const objects=new Map<string,Uint8Array>(),oids:string[]=[],sealed:{oid:string;sealed:Uint8Array}[]=[];let reused=0,uploaded=0,closureBytes=0;
 for(let i=0;i<texts.length;i++){
  const value=jsonBytes(segmentState(input.entityKey,noteRevision,i,texts[i]!));texts[i]='';let hit:{oid:string;sealed:Uint8Array}|null=null;
  const old=prior?.noteRevision===noteRevision?prior.objects[i]:undefined;
  if(old){try{if(same((await ports.open(old.oid,old.sealed)).plain,value))hit=old;}catch{/* Cache miss: never reuse an unauthenticated OID. */}}
  if(hit){reused++;oids.push(hit.oid);sealed.push(hit);}
  else{const s=await ports.seal(value),refs=await ports.signRefs(s.oid,[]);objects.set(s.oid,s.bytes);objects.set(objectOid('state-refs',refs),refs);oids.push(s.oid);sealed.push({oid:s.oid,sealed:s.bytes});uploaded++;}
  closureBytes=add(closureBytes,value.length+SEALED_OVERHEAD);
 }
 const parent=parentState(input,noteRevision,encoding.segmentCount,encoding.plaintextSha256,oids),raw=jsonBytes(parent);if(raw.length>STATE_LIMIT)fail('object_too_large');
 const root=await ports.seal(raw),rootRefs=await ports.signRefs(root.oid,oids);if(rootRefs.length>STATE_LIMIT)fail('object_too_large');
 objects.set(root.oid,root.bytes);objects.set(objectOid('state-refs',rootRefs),rootRefs);
 return {stateOid:root.oid,parent,objects,segments:{noteRevision,objects:sealed} as PriorSegments,uploadedSegments:uploaded,reusedSegments:reused,closureBytes:add(closureBytes,raw.length+SEALED_OVERHEAD)};
}
/** Worst-case stored bytes of the complete closure before sealing: every
 * state at identity size plus envelope, plus every public refs table. */
export function segmentedClosureBudget(state:any,noteRevision:string,scope:unknown,budget=NOTE_TEXT_BUDGET){
 const input=splitOrdinary(state);let bytesTotal=0,count=0;const child=refsBytes(scope,PLACEHOLDER,[]);
 const encoding=encodeNote(input,noteRevision,(i,t)=>{bytesTotal=add(bytesTotal,jsonBytes(segmentState(input.entityKey,noteRevision,i,t)).length+SEALED_OVERHEAD+child);count++;},budget);
 if(encoding.form!=='segmented')return null;
 return {segments:count,bytes:add(bytesTotal,encoding.parentPlainBytes+SEALED_OVERHEAD+refsBytes(scope,PLACEHOLDER,Array(count).fill(PLACEHOLDER)))};
}
