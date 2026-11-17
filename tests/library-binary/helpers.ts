import fixed from '../fixtures/library-binary/fixed-vectors.json';
import {type Capability,type Selection,type Envelope,type Phase,type Row,type ObjectDescriptor,hash} from '../../src/sync/library-binary/wire';
import {requestDigest,objectId,selectionDigest,objectsRoot,planDigest} from '../../src/sync/library-binary/digests';
import type {DataFrame} from '../../src/sync/library-binary/codec';
export {fixed};
export const cap=fixed.s2Capability as Capability;
export const selection:Selection={profile:'merge-b2',kinds:cap.kinds.map(({kind,schemaVersion})=>({kind,schemaVersion})),chunkBytes:65536,limits:{...cap.limits}};
export const binding={streamId:1 as const,jobId:'01'.repeat(16),planDigest:'02'.repeat(32),selectionDigest:selectionDigest(selection)};
let counter=1;
export function request(phase:Phase,payload:Row,opts:Partial<Envelope>={}):Envelope {
 const jobId=phase==='prepare'?null:binding.jobId,plan=phase==='prepare'?null:binding.planDigest;
 const e:Envelope={action:'syncLibraryBinary',version:2,type:'request',phase,payload,jobId,planDigest:plan,epoch:phase==='prepare'||phase==='begin'?null:1,requestId:(counter++).toString(16).padStart(32,'0'),requestDigest:'',...opts};
 e.requestDigest=requestDigest(e.jobId,e.planDigest,e.phase,e.payload!);return e;
}
export const reply=(r:Envelope,result:Row):Envelope=>({action:r.action,version:r.version,type:'response',phase:r.phase,jobId:r.jobId,planDigest:r.planDigest,epoch:r.epoch,requestId:r.requestId,requestDigest:r.requestDigest,success:true,result});
export function data():DataFrame {return {kind:'data',streamId:1,objectSlot:0,epoch:1,txSeq:1,chunkIndex:0,requestId:'00112233445566778899aabbccddeeff',requestDigest:fixed.requestDigest,payload:new Uint8Array([97,98,99])};}
export function object(kind:'rssSource'|'noteAsset'='noteAsset'):ObjectDescriptor {
 const o={objectId:'',kind,schemaVersion:1 as const,businessId:'fixture',contentVersion:'1',encoding:kind==='rssSource'?'none' as const:'raw' as const,size:kind==='rssSource'?0:3,sha256:hash(kind==='rssSource'?new Uint8Array():data().payload),chunkHashes:kind==='rssSource'?[]:[hash(data().payload)],metadataUtf8:'{ "x": 1 }',metadataSha256:hash(new TextEncoder().encode('{ "x": 1 }')),chunkBytes:65536 as const,dependsOn:[]};o.objectId=objectId(o);return o;
}
export function begin(objects:readonly ObjectDescriptor[]){
 const s={...selection,kinds:[...new Set(objects.map(o=>o.kind))].sort().map(kind=>({kind,schemaVersion:1 as const}))};
 if(!s.kinds.length)s.kinds=selection.kinds;
 const snapshot={snapshotId:'snapshot',manifestDigest:'04'.repeat(32),fromExclusive:0,toInclusive:0};
 const p={intent:'create' as const,accountScope:'03'.repeat(32),phoneDeviceId:'phone',watchDeviceId:'watch',direction:'phoneToWatch' as const,phoneSnapshot:snapshot,watchSnapshot:snapshot,selection:s,selectionDigest:selectionDigest(s),objectCount:objects.length,objectsRoot:objectsRoot(objects.map(o=>o.objectId)),pageObjectCounts:objects.length?[objects.length]:[]};
 return {payload:p,plan:planDigest(p)};
}
