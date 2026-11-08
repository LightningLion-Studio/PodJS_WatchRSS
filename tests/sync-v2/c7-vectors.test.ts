/** Fixed rc7 vectors through the product codec, closure reader and sealer.
 * Fixture keys/nonces are public test data and never product inputs. */
import {test,expect} from 'bun:test';
import {createHash,createHmac,createCipheriv,createECDH,createPrivateKey,sign,hkdfSync} from 'node:crypto';
import {vector} from './fixture';
import {crypto as baseCrypto} from './p2-fixture';
import {canonical,jsonBytes,bytes} from '../../src/sync-v2/protocol';
import {b64} from '../../src/sync-v2/wire';
import {sealV2,openV2,objectOid,type EnvelopeCrypto} from '../../src/sync-v2/sealed';
import {signedMessage} from '../../src/sync-v2/signing';
import {SyncV2Error} from '../../src/sync-v2/http';
import {noteClosurePorts} from '../../src/sync-v2/cloud-index';
import {mergeNoteMarkdown} from '../../src/sync-v2/business';
import {encodeNote,parentState,refsBytes,readSegmentedNote,sealSegmentedNote,splitOrdinary,segmentState,SEALED_OVERHEAD,type NoteInput,type TextSource,type PriorSegments} from '../../src/sync-v2/note-segments';

const fixture=vector('note-segments-rc7'),{scope,entityKey,noteRevision}=fixture.context;
const ID=Buffer.from(fixture.context.idKeyHex,'hex'),KEY=Buffer.from(fixture.context.contentKeyHex,'hex'),keys={id:ID,content:KEY,version:1};
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const lp=(values:Uint8Array[])=>Buffer.concat(values.flatMap(v=>{const n=Buffer.alloc(4);n.writeUInt32BE(v.length);return [n,Buffer.from(v)];}));
const ecdh=createECDH('prime256v1');ecdh.setPrivateKey(Buffer.from('77'.repeat(32),'hex'));const point=ecdh.getPublicKey();
const signer=createPrivateKey({key:{kty:'EC',crv:'P-256',d:Buffer.from('77'.repeat(32),'hex').toString('base64url'),x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url')},format:'jwk'});
const N=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function signRaw(stateOid:string,segmentOids:string[]){const body={scope,stateOid,segmentOids:[...segmentOids]},sig=sign('sha256',signedMessage('wrss.sync.v2/state-refs-sign',body),{key:signer,dsaEncoding:'ieee-p1363'});const s=BigInt('0x'+sig.subarray(32).toString('hex'));if(s>N/2n)Buffer.from((N-s).toString(16).padStart(64,'0'),'hex').copy(sig,32);return {body,signature:sig.toString('base64url')};}
/** Deterministic randomness keyed by fixture tag; product sealV2 does the rest. */
const tagged=(tag:()=>string):EnvelopeCrypto=>({...baseCrypto,async random(n){const t=tag();return n===32?createHash('sha256').update('rc7/salt/'+t).digest():createHash('sha256').update('rc7/nonce/'+t).digest().subarray(0,12);}});
const tagOf=(seed:string,plain:Uint8Array)=>{const v=JSON.parse(new TextDecoder().decode(plain));return v.payload.segmentOf!==undefined?seed+'/segment/'+v.payload.index:seed+'/root';};
async function sealTagged(plain:Uint8Array,tag:string){return sealV2(tagged(()=>tag),ID,KEY,scope,'state',1,plain);}
/** Synchronous reference envelope for streaming the 2048-segment case. */
function sealSync(plain:Uint8Array,tag:string){
 const salt=createHash('sha256').update('rc7/salt/'+tag).digest(),nonce=createHash('sha256').update('rc7/nonce/'+tag).digest().subarray(0,12);
 const opaque=createHmac('sha256',ID).update(lp([bytes('wrss.sync.v2/content'),jsonBytes(scope),bytes('state'),createHash('sha256').update(plain).digest()])).digest('hex');
 const header={domain:'wrss.sync.v2/sealed',version:2,scope,keyVersion:1,type:'state',opaqueContentId:opaque,encoding:'identity',plainBytes:plain.length,encodedBytes:plain.length,salt:salt.toString('base64url'),nonce:nonce.toString('base64url')};
 const aad=jsonBytes(header),key=Buffer.from(hkdfSync('sha256',KEY,salt,lp([bytes('wrss.sync.v2/aead'),createHash('sha256').update(aad).digest()]),32)),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(aad);
 const size=Buffer.alloc(4);size.writeUInt32BE(aad.length);const wire=Buffer.concat([bytes('WRS2'),size,aad,c.update(plain),c.final(),c.getAuthTag()]);return {oid:'state:sha256:'+sha(wire),bytes:wire,opaque};
}
function* blocks(desc:any):Iterable<string>{if(typeof desc==='string'){yield desc;return;}for(const p of desc.parts){const stride=Math.max(1,Math.floor(8192/p.repeat.length));for(let left=p.count;left>0;){const n=Math.min(stride,left);yield p.repeat.repeat(n);left-=n;}}}
const materialize=(desc:any)=>[...blocks(desc)].join('');
function fieldSummary(fields:Record<string,TextSource>){const out:any={};for(const k of Object.keys(fields).sort()){const h=createHash('sha256');let n=0;for(const b of typeof fields[k]==='string'?[fields[k] as string]:(fields[k] as ()=>Iterable<string>)()){const x=bytes(b);h.update(x);n+=x.length;}out[k]={bytes:n,sha256:h.digest('hex')};}return out;}
function noteInput(input:any,stream:boolean):NoteInput{
 const fields:Record<string,TextSource>={};for(const [k,d]of Object.entries<any>(input.fields))fields[k]=stream?()=>blocks(d):materialize(d);
 const hashOf=(k:string)=>fields[k]===undefined?sha(new Uint8Array()):fieldSummary({[k]:fields[k]!})[k].sha256;
 const metadata={contentHash:hashOf('markdown'),baseContentHash:hashOf('baseMarkdown'),pinned:false,updatedAt:1,modifiedBy:'synthetic',deleted:false,deletedAt:0,...structuredClone(input.metadata??{})};
 return {entityKey,features:input.features??[],metadata,fields};
}
const stateOf=(input:NoteInput)=>({version:2,entityKey,requiredFeatures:[...input.features],payload:{...input.metadata,...input.fields},noteSegments:[]});
/** Streaming summary: product encodeNote + parentState; reference envelope. */
function summarize(input:NoteInput,seed='initial',rev=noteRevision,cache=new Map<string,{oid:string;bytes:Uint8Array;opaque:string}>()){
 const segments:any[]=[],reused:number[]=[];
 const enc=encodeNote(input,rev,(index,text)=>{const plain=jsonBytes(segmentState(entityKey,rev,index,text)),b=bytes(text),ps=sha(plain);let obj=cache.get(ps);if(obj)reused.push(index);else obj=sealSync(plain,seed+'/segment/'+index);segments.push({index,textBytes:b.length,statePlainBytes:plain.length,textSha256:sha(b),statePlainSha256:ps,oid:obj.oid,storedBytes:obj.bytes.length,opaqueContentId:obj.opaque,prefixHex:Buffer.from(b.subarray(0,8)).toString('hex'),suffixHex:Buffer.from(b.subarray(-8)).toString('hex')});});
 const fields=fieldSummary(input.fields);
 if(enc.form==='short'){const plain=jsonBytes({...stateOf(input),payload:{...input.metadata,...Object.fromEntries(Object.entries(input.fields).map(([k,v])=>[k,typeof v==='string'?v:[...v()].join('')]))}}),obj=sealSync(plain,seed+'/root');return {form:'short',shortPlainBytes:enc.shortBytes,rootPlainBytes:plain.length,rootOid:obj.oid,rootStoredBytes:obj.bytes.length,fields};}
 const refs=segments.map(s=>s.oid),root=parentState(input,rev,enc.segmentCount,enc.plaintextSha256,refs),plain=jsonBytes(root),obj=sealSync(plain,seed+'/root'),rootRefs=refsBytes(scope,obj.oid,refs);
 expect(plain.length).toBe(enc.parentPlainBytes);
 let closure=plain.length+SEALED_OVERHEAD+rootRefs,actual=obj.bytes.length+rootRefs;for(const s of segments){const r=refsBytes(scope,s.oid,[]);closure+=s.statePlainBytes+SEALED_OVERHEAD+r;actual+=s.storedBytes+r;}
 return {form:'segmented',shortPlainBytes:enc.shortBytes,rootPlainBytes:plain.length,rootOid:obj.oid,rootStoredBytes:obj.bytes.length,noteRevision:rev,streamBytes:enc.textBytes,plaintextSha256:enc.plaintextSha256,fields,metadataSha256:sha(jsonBytes(input.metadata)),segmentCount:enc.segmentCount,segments,rootRefsBytes:rootRefs,closureStoredBytesUpperBound:closure,uniqueStoredBytesWithRefs:actual,reusedIndices:reused};
}
const sealPorts=(seed:string)=>({seal:(plain:Uint8Array)=>sealTagged(plain,tagOf(seed,plain)),signRefs:async(oid:string,ids:string[])=>jsonBytes(signRaw(oid,ids)),open:(oid:string,raw:Uint8Array)=>openV2(baseCrypto,ID,KEY,scope,oid,raw)});
/** Product sealing path: segments sealed and the closure kept for reading. */
async function productClosure(input:NoteInput,seed='initial',rev=noteRevision,prior:PriorSegments|null=null){
 const out=await sealSegmentedNote(stateOf(input),rev,sealPorts(seed),prior),objects=new Map<string,{oid:string;wire:Uint8Array}>(),tables=new Map<string,any>();
 for(const s of out.segments.objects)objects.set(s.oid,{oid:s.oid,wire:s.sealed});
 for(const id of out.parent.noteSegments)tables.set(id,signRaw(id,[]));tables.set(out.stateOid,signRaw(out.stateOid,out.parent.noteSegments));
 return {out,closure:{root:out.parent,rootObject:{oid:out.stateOid,wire:out.objects.get(out.stateOid)!},objects,refs:[...out.parent.noteSegments] as string[]|null,tables,badRefsSignature:false}};
}
const http=(c:any)=>{const raws=new Map<string,Uint8Array>();return {http:{scope,async stateRefs(_w:string,oid:string){if(oid===c.rootObject.oid&&c.refs===null||!c.tables.has(oid))throw new SyncV2Error('object_missing');const raw=jsonBytes(c.tables.get(oid)),id=objectOid('state-refs',raw);raws.set(id,raw);return {version:2,scope,parentOid:oid,refsOid:id,authorDeviceId:'a'.repeat(32),keyId:'b'.repeat(32),totalBytes:raw.length};}} as any,read:async(id:string)=>{const v=c.objects.get(id)?.wire??raws.get(id);if(!v)throw new SyncV2Error('object_missing');return v;}};};
const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(point)});
async function productRead(c:any,supported=true){
 const {http:h,read}=http(c),ports=noteClosurePorts(h,read,baseCrypto,keys,approved,'1'.repeat(32));
 const out=await readSegmentedNote(c.rootObject.oid,c.root,ports,{entityKey,supported:supported?['note-conflicts.v1','note-segments.v1']:['note-conflicts.v1']});
 const {fields}=splitOrdinary(out.state),b=jsonBytes(fields);
 return {ok:true,streamBytes:b.length,plaintextSha256:sha(b),fields:fieldSummary(fields)};
}
async function open(obj:{oid:string;wire:Uint8Array}){return (await openV2(baseCrypto,ID,KEY,scope,obj.oid,obj.wire)).value;}
/** Port of the reference mutation table; resealed objects use product sealV2. */
async function mutate(original:any,kind:string){
 const c={root:structuredClone(original.root),refs:original.refs&&[...original.refs],rootObject:original.rootObject,tables:new Map([...original.tables].map(([k,v]:any)=>[k,structuredClone(v)])),objects:new Map([...original.objects].map(([k,v]:any)=>[k,{...v,wire:Buffer.from(v.wire)}])),badRefsSignature:false} as any,ids=c.root.noteSegments;
 const replace=async(i:number,value:any)=>{const obj=await sealTagged(jsonBytes(value),'mutate/'+kind+'/'+i);c.objects.set(obj.oid,{oid:obj.oid,wire:obj.bytes});ids[i]=obj.oid;c.refs=[...ids];};
 switch(kind){
  case 'swap-only':case 'swap-both':[ids[0],ids[1]]=[ids[1],ids[0]];if(kind==='swap-both')c.refs=[...ids];break;
  case 'missing-object':c.objects.delete(ids[1]);break;case 'duplicate':ids[1]=ids[0];break;case 'count':c.root.payload.segmentCount++;break;
  case 'parent-extra':c.root.payload.extra=1;break;case 'parent-feature-missing':c.root.requiredFeatures=[];break;case 'unknown-feature':c.root.requiredFeatures.push('unknown.v1');break;
  case 'metadata-text':c.root.payload.metadata.markdown='duplicate';break;case 'missing-refs':c.refs=null;break;case 'missing-child-refs':c.tables.delete(ids[1]);break;
  case 'bad-refs-signature':c.badRefsSignature=true;break;case 'total-hash':c.root.payload.plaintextSha256='00'.repeat(32);break;
  case 'wire-tamper':case 'aead-tamper':{const obj=c.objects.get(ids[0]);obj.wire[obj.wire.length-1]^=1;if(kind==='aead-tamper'){obj.oid='state:sha256:'+sha(obj.wire);c.objects.set(obj.oid,obj);ids[0]=obj.oid;c.refs=[...ids];}break;}
  case 'segmentOf':case 'index':case 'entityKey':case 'nested':case 'features':case 'empty':{const v=await open(c.objects.get(ids[0]));if(kind==='segmentOf')v.payload.segmentOf='99'.repeat(16);if(kind==='index')v.payload.index=1;if(kind==='entityKey')v.entityKey='99'.repeat(32);if(kind==='nested')v.noteSegments=[ids[1]];if(kind==='features')v.requiredFeatures=['note-segments.v1'];if(kind==='empty')v.payload.text='';await replace(0,v);break;}
  case 'old-authenticated-segment':{const v=await open(c.objects.get(ids[0]));v.payload.text=v.payload.text.replace('a','b');await replace(0,v);break;}
  case 'noncanonical-boundary':case 'trailing-data':case 'duplicate-text-key':case 'unknown-text-key':case 'malformed-json':{
   const values=[];for(const id of ids)values.push(await open(c.objects.get(id)));const texts=values.map((v:any)=>v.payload.text);
   if(kind==='noncanonical-boundary'){texts[2]=texts[1].slice(-1)+texts[2];texts[1]=texts[0].slice(-1)+texts[1].slice(0,-1);texts[0]=texts[0].slice(0,-1);}
   if(kind==='trailing-data')texts[texts.length-1]+=' ';if(kind==='duplicate-text-key')texts[0]=texts[0].replace('{','{"markdown":"duplicate",').slice(0,texts[0].length);
   if(kind==='unknown-text-key')texts[0]=texts[0].replace('markdown','unknownx');if(kind==='malformed-json')texts[0]='['+texts[0].slice(1);
   for(let i=0;i<values.length;i++){values[i].payload.text=texts[i];await replace(i,values[i]);}c.root.payload.plaintextSha256=sha(bytes(texts.join('')));break;}
 }
 const root=await sealTagged(jsonBytes(c.root),'mutate-root/'+kind);c.rootObject={oid:root.oid,wire:root.bytes};
 for(const id of ids)if(!c.tables.has(id)&&kind!=='missing-child-refs')c.tables.set(id,signRaw(id,[]));c.tables.set(root.oid,signRaw(root.oid,c.refs??[]));
 if(c.badRefsSignature)c.tables.get(root.oid).signature='A'.repeat(86);return c;
}

const cases=new Map<string,any>(fixture.cases.map((x:any)=>[x.id,x]));
for(const v of fixture.cases)test('C7 vector encoding '+v.id,async()=>{
 const raw=structuredClone(v.input);if(v.expandConflictText)for(const r of raw.metadata.noteConflicts.records)for(const k of ['baseMarkdown','localMarkdown','remoteMarkdown'])r[k]=materialize(r[k]);
 const large=v.id.startsWith('maximum-')||v.id.startsWith('reject-'),input=noteInput(raw,large),before=canonical(input.metadata)+canonical(input.features);
 let summary:any;try{summary=summarize(input);}catch(e){summary={error:(e as Error).message,preserved:canonical(input.metadata)+canonical(input.features)===before};}
 expect(summary).toEqual(v.expected);
 if(!large&&v.expected.form==='segmented'){
  // Product sealer yields the same OIDs; product reader restores exact field bytes.
  const {out,closure}=await productClosure(input);expect(out.stateOid).toBe(v.expected.rootOid);expect(out.parent.noteSegments).toEqual(v.expected.segments.map((s:any)=>s.oid));
  const restored=await productRead(closure);expect(restored.fields).toEqual(v.expected.fields);expect(restored.streamBytes).toBe(v.expected.streamBytes);expect(sha(jsonBytes(closure.root.payload.metadata))).toBe(v.expected.metadataSha256);
 }
},120000);

test('C7 vector closures: product reader returns every fixed error in order',async()=>{
 const {closure}=await productClosure(noteInput(cases.get(fixture.closureSource).input,false)),seen=new Set<string>();
 for(const v of fixture.closureCases){const c=await mutate(closure,v.mutation),before=canonical(c.root);let observed:any;
  try{observed=await productRead(c,v.supported??true);}catch(e){observed={error:(e as Error).message,preserved:true};}
  expect({id:v.id,...observed}).toEqual({id:v.id,...v.expected});expect(canonical(c.root)).toBe(before);seen.add(observed.error??'ok');}
 expect([...seen].sort()).toEqual(['aead_invalid','closure_incomplete','hash_mismatch','invalid_encoding','invalid_schema','ok','signature_invalid','unsupported_feature']);
},120000);

test('C7 vector reuse: authenticated original bytes and OIDs, no deterministic shortcut',async()=>{
 const base=noteInput(cases.get(fixture.closureSource).input,false),{out:first}=await productClosure(base),cache=new Map<string,any>();
 for(const s of first.segments.objects){const plain=(await openV2(baseCrypto,ID,KEY,scope,s.oid,s.sealed)).plain;cache.set(sha(plain),{oid:s.oid,bytes:s.sealed,opaque:''});}
 for(const v of fixture.reuseCases){
  const input=noteInput(v.after,false),{out,closure}=await productClosure(input,v.after.sealSeed??'initial',noteRevision,first.segments);
  expect(out.stateOid).toBe(v.expected.rootOid);expect(out.reusedSegments).toBe(v.expected.reusedIndices.length);expect(out.uploadedSegments).toBe(v.expected.segmentCount-v.expected.reusedIndices.length);
  for(const i of v.expected.reusedIndices){expect(out.parent.noteSegments[i]).toBe(first.parent.noteSegments[i]);expect(Buffer.from(out.segments.objects[i]!.sealed).equals(Buffer.from(first.segments.objects[i]!.sealed))).toBe(true);expect(out.objects.has(first.parent.noteSegments[i])).toBe(false);}
  expect(out.parent.noteSegments).toEqual(v.expected.segments.map((s:any)=>s.oid));expect((await productRead(closure)).fields).toEqual(v.expected.fields);
  // A tampered cache entry is never reused, even with the same OID.
  const forged={noteRevision,objects:first.segments.objects.map(o=>({oid:o.oid,sealed:Uint8Array.from(o.sealed,(b,i)=>i===o.sealed.length-1?b^1:b)}))},again=await sealSegmentedNote(stateOf(input),noteRevision,sealPorts('forged'),forged);expect(again.reusedSegments).toBe(0);
  // Another binding never cross-reuses segments.
  const other=await sealSegmentedNote(stateOf(input),'44'.repeat(16),sealPorts('other'),first.segments);expect(other.reusedSegments).toBe(0);
 }
});

test('C7 vector independent encapsulation: same plaintext, new random envelope, different OID',async()=>{
 const {out}=await productClosure(noteInput(cases.get(fixture.closureSource).input,false)),plain=(await openV2(baseCrypto,ID,KEY,scope,out.parent.noteSegments[0],out.segments.objects[0]!.sealed)).plain;
 const one=await sealTagged(plain,'fresh-a'),two=await sealTagged(plain,'fresh-b');
 expect({firstOid:one.oid,secondOid:two.oid,opaqueContentId:one.header.opaqueContentId,sameOpaque:one.header.opaqueContentId===two.header.opaqueContentId,sameOid:one.oid===two.oid}).toEqual(fixture.independentEncapsulation.expected);
 const random=await sealV2(baseCrypto,ID,KEY,scope,'state',1,plain);expect(random.oid).not.toBe(one.oid);
});

test('C7 vector merge: reassemble, frozen three-way merge, re-segment',async()=>{
 for(const v of fixture.mergeCases){
  const [base,local,remote]=[materialize(v.base),materialize(v.local),materialize(v.remote)],restored:string[]=[];
  for(const markdown of [base,local,remote]){const {closure}=await productClosure(noteInput({fields:{markdown,plainText:markdown,baseMarkdown:base}},false));const {http:h,read}=http(closure);const out=await readSegmentedNote(closure.rootObject.oid,closure.root,noteClosurePorts(h,read,baseCrypto,keys,approved,'1'.repeat(32)),{entityKey,supported:['note-segments.v1']});restored.push(out.state.payload.markdown);expect(out.state.payload.baseMarkdown).toBe(base);}
  const editBase=structuredClone(v.editBase),merged=mergeNoteMarkdown(restored[0]!,restored[1]!,restored[2]!)!;
  expect(sha(bytes(merged))).toBe(v.expectedMarkdownSha256);expect(merged.includes('\r')).toBe(false);
  const input=noteInput({fields:{markdown:merged,plainText:merged,baseMarkdown:base}},false);input.fields={markdown:merged,plainText:merged,baseMarkdown:base};input.metadata={...input.metadata,contentHash:sha(bytes(merged)),baseContentHash:sha(bytes(base))};
  expect(summarize(input,'merge')).toEqual(v.expected);const {out}=await productClosure(input,'merge');expect(out.stateOid).toBe(v.expected.rootOid);expect(v.editBase).toEqual(editBase);
 }
},120000);
