import {BOOK_KINDS,LIMIT_KEYS,capability,selection,exact,row,bool,fail,type Binding,type Capability,type Selection,type Direction,type KindVersion,type Row} from './wire';
import {capability as resumeCapability} from '../library-resume/wire';
import {capabilityDigest} from './digests';

export const RELEASE_B2_ENABLED=false;
export interface Ready {identityVerified:boolean;accountConfirmed:boolean;legacyAcksDrained:boolean}
function isReady(ready:Ready):boolean {exact(ready,['identityVerified','accountConfirmed','legacyAcksDrained']);return Object.values(ready).every(v=>bool(v)===true);}
export type PeerRoute='B2'|'PODJS_V1'|'COMPOSE_V14'|'WAIT_READY'|'CAPABILITY_MISMATCH'|'PEER_IMPLEMENTATION_UNKNOWN';
const BITS=['supportsManifestBatches','supportsReaderPresets','supportsReaderAssets','supportsResourceChunkAck','supportsReaderPresetPreview','supportsPersistentSession','supportsTransferByteProgress'];
const EXT=['supportsAutomaticAccountSync','supportsDomainFastPathV2','supportsBookSyncV1','supportsBookReadingDeltaV1','supportsNoteManifestV2','supportsNoteAssetInventory','supportsRssCanonicalIds','supportsFullMetadataOnlyArticles','supportsMetadataOnlyArticles','supportsTokenUsageCursor','persistentSessionAccepted'];
const ALLOWED=new Set(['success','version','action','phase','deviceId','sentAt','account','accountMatchesRequest','ipUpgradeAccepted','watchCapabilities',...BITS,...EXT,'supportsAccountDataSpaces','libraryPeer','libraryBinary','libraryResume','supportedLibraryResumeVersions','supportedLibraryBinaryVersions']);
/** Classification chooses a compatibility policy. It never authenticates a peer. */
export function classifyPeer(probe:unknown,ready:Ready):PeerRoute {
 try{
  const p=row(probe);exact(ready,['identityVerified','accountConfirmed','legacyAcksDrained']);Object.values(ready).forEach(bool);
  if(p.success!==true||p.version!==14||p.action!=='syncLibrary'||p.phase!=='probe')return 'CAPABILITY_MISMATCH';
  for(const k of [...BITS,...EXT,'supportsAccountDataSpaces'])if(Object.hasOwn(p,k))bool(p[k]);
  if(Object.hasOwn(p,'libraryResume'))resumeCapability(p.libraryResume);
  for(const k of ['supportedLibraryResumeVersions','supportedLibraryBinaryVersions'])if(Object.hasOwn(p,k)){
   const vs=p[k];if(!Array.isArray(vs)||vs.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(vs).size!==vs.length)return 'CAPABILITY_MISMATCH';
  }
  const wait=(route:PeerRoute):PeerRoute=>Object.values(ready).every(x=>x===true)?route:'WAIT_READY';
  if(Object.hasOwn(p,'libraryPeer')){
   const peer=exact(p.libraryPeer,['implementation','appVersion']);
   if(typeof peer.implementation!=='string'||typeof peer.appVersion!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[1-9]\d*)?$/.test(peer.appVersion))return 'CAPABILITY_MISMATCH';
   if(peer.implementation==='podjs'&&(/^2\.0\.[01](-[1-9]\d*)?$/.test(peer.appVersion)))return Object.hasOwn(p,'libraryBinary')||Object.hasOwn(p,'supportsAccountDataSpaces')?'CAPABILITY_MISMATCH':wait('PODJS_V1');
   if(peer.implementation==='podjs'&&Object.hasOwn(p,'supportsAccountDataSpaces'))return 'CAPABILITY_MISMATCH';
  }
  if(Object.keys(p).some(k=>!ALLOWED.has(k)))return 'PEER_IMPLEMENTATION_UNKNOWN';
  if(Object.hasOwn(p,'libraryPeer')){
   if((p.libraryPeer as Row).implementation!=='podjs')return 'PEER_IMPLEMENTATION_UNKNOWN';
   if(!Object.hasOwn(p,'libraryBinary'))return wait('PODJS_V1');capability(p.libraryBinary);return wait('B2');
  }
  if(Object.hasOwn(p,'libraryBinary'))return 'PEER_IMPLEMENTATION_UNKNOWN';
  if(BITS.some(k=>!Object.hasOwn(p,k)))return 'PEER_IMPLEMENTATION_UNKNOWN';
  if(!Object.hasOwn(p,'supportsAccountDataSpaces'))return ['supportsManifestBatches','supportsPersistentSession','supportsTransferByteProgress'].every(k=>p[k]===true)&&p.supportsReaderPresets===p.supportsReaderAssets&&p.supportsReaderAssets===p.supportsResourceChunkAck?wait('PODJS_V1'):'PEER_IMPLEMENTATION_UNKNOWN';
  return p.supportsAccountDataSpaces===true&&BITS.every(k=>p[k]===true)?wait('COMPOSE_V14'):'PEER_IMPLEMENTATION_UNKNOWN';
 }catch{return 'CAPABILITY_MISMATCH';}
}
/** Advertise only adapters whose contracts are ready. */
export function binaryCapability(readyKinds:Capability['kinds'],limits:Capability['limits']):Capability {
 return capability({version:2,profile:'merge-b2',kinds:readyKinds,chunkSizes:[65536],limits});
}
export function s2Capability(readyKinds:Capability['kinds'],limits:Capability['limits']):Capability {
 if(readyKinds.some(k=>k.kind.startsWith('book')))fail('UNSUPPORTED_KIND');
 return binaryCapability(readyKinds,{...limits,maxInFlightChunks:1,maxInFlightBytes:65536});
}
export function negotiate(source:Capability,receiver:Capability):Selection|null {
 capability(source);capability(receiver);
 const kinds:KindVersion[]=source.kinds.filter(k=>k.send&&receiver.kinds.some(r=>r.kind===k.kind&&r.schemaVersion===k.schemaVersion&&r.receive)).map(({kind,schemaVersion})=>({kind,schemaVersion}));
 // A body/resource without its metadata adapter stays on its existing v1 domain.
 // The legacy books domain has one completion. Both directions must support
 // the whole domain before either direction can replace syncBooks.
 const booksReady=BOOK_KINDS.every(kind=>[source,receiver].every(c=>c.kinds.some(k=>k.kind===kind&&k.send&&k.receive)));
 const usable=kinds.filter(k=>booksReady||!k.kind.startsWith('book')).filter(k=>k.kind!=='articleBody'||kinds.some(m=>m.kind==='articleMetadata')).filter(k=>k.kind!=='readerResource'||kinds.some(m=>m.kind==='readerMetadata'));
 if(!usable.length)return null;
 const limits=Object.fromEntries(Object.keys(source.limits).map(k=>[k,Math.min(source.limits[k as keyof Capability['limits']],receiver.limits[k as keyof Capability['limits']])]));
 return selection({profile:'merge-b2',kinds:usable,chunkBytes:65536,limits});
}
/** New jobs select the intersection. Resumes keep the frozen limits; callers
 * bind them to the persisted selection digest before granting write authority. */
export function checkSelectedLimits(binding:Binding,source:Capability,receiver:Capability):void{
 for(const key of LIMIT_KEYS){
  const maximum=Math.min(source.limits[key],receiver.limits[key]),chosen=binding.selection.limits[key];
  if(binding.intent==='resume'?chosen>maximum:chosen!==maximum)fail('CAPABILITY_MISMATCH');
 }
}
export interface Scope {domain:string;kind?:string;direction:Direction;v1Available:boolean}
export interface ScopeRoute extends Scope {protocol:'b2'|'v1'}
export function routeScopes(b2Enabled:boolean,peer:PeerRoute,scopes:readonly Scope[],phone?:Capability,watch?:Capability):ScopeRoute[] {
 if(peer==='WAIT_READY')fail('AUTH_REVOKED');if(peer==='CAPABILITY_MISMATCH'||peer==='PEER_IMPLEMENTATION_UNKNOWN')fail(peer);
 if(phone)capability(phone);if(watch)capability(watch);
 const selected=new Map<Direction,Selection|null>();
 if(b2Enabled&&peer==='B2'){
  if(!phone||!watch)fail('CAPABILITY_MISMATCH');
  selected.set('phoneToWatch',negotiate(phone,watch));selected.set('watchToPhone',negotiate(watch,phone));
 }
 return scopes.map(scope=>{
  const b2=selected.get(scope.direction)?.kinds.some(k=>k.kind===scope.kind)===true;
  if(!b2&&!scope.v1Available)fail('UNSUPPORTED_SCOPE');return {...scope,protocol:b2?'b2':'v1'};
 });
}
/** Separate connections and fresh Ready are required for each protocol group. */
export class ConnectionRoute {
 private protocol:'b2'|'v1'|null=null;
 select(protocol:'b2'|'v1',ready:Ready):void {
  if(!isReady(ready))fail('AUTH_REVOKED');
  if(this.protocol!==null&&this.protocol!==protocol)fail('CAPABILITY_MISMATCH');this.protocol=protocol;
 }
}
export function selectionComplete(routes:readonly ScopeRoute[],businessReceipts:ReadonlySet<string>):boolean {
 return routes.every(r=>businessReceipts.has(r.direction+':'+r.domain+':'+r.protocol));
}
/** Off delegates the exact original object/bytes; no B2 parsing or I/O occurs. */
export function gated<T>(b2Enabled:boolean,legacy:()=>T,binary:()=>T):T {return b2Enabled?binary():legacy();}

export class SwitchGate {
 private state:'legacy'|'replyPending'|'binary'|'closed'='legacy';
 private readonly watch:Capability;
 constructor(private readonly b2Enabled:boolean,watch:Capability){this.watch=JSON.parse(JSON.stringify(capability(watch)));}
 accept(value:unknown,ready:Ready):Row {
  if(!this.b2Enabled||this.state!=='legacy'||!isReady(ready))fail('AUTH_REVOKED');
  const r=exact(value,['action','version','phase','type','requestId','payload']);
  if(r.action!=='syncLibraryBinary'||r.version!==2||r.phase!=='switch'||r.type!=='request'||typeof r.requestId!=='string'||!/^[0-9a-f]{32}$/.test(r.requestId))fail();
  const p=exact(r.payload,['codec','watchCapabilityDigest']);if(p.codec!=='lb2'||p.watchCapabilityDigest!==capabilityDigest(this.watch))fail('CAPABILITY_MISMATCH');
  this.state='replyPending';return {action:r.action,version:2,phase:'switch',type:'response',requestId:r.requestId,success:true,result:p};
 }
 responseFullyWritten():void {if(this.state!=='replyPending')fail();this.state='binary';}
 requireBinary():void {if(!this.b2Enabled||this.state!=='binary')fail('CAPABILITY_MISMATCH');}
 close():void {this.state='closed';}
}
