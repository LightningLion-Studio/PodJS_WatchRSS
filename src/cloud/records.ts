import {cpuWork,cpuWorkAsync,cpuJsonParse,cpuJsonStringify,cpuSort} from '@podjs/framework/cpu-work';
import {ARTICLE_REGISTER_FEATURE,hasArticleRegisters,readArticleRegisters,normalizeArticleRegisters,mergeArticleRegisters,articleKnownCanonical} from './article-register';
import {bindCloudRaw,markCloudReadOnly,isolateCloudRaw,releaseKnownCloudRaw,cloudRaw,cloudCompatibility,recordRawSchema,recordFields,knownRecordValue,rawRecordText,parseRawJson,rawJsonValue,emptyCompatibilityStatus,type CloudFeatures} from './compatibility';
import {validateBookShape,validateBook,validateBookReading} from '../books/protocol';
import {CLOUD_HOST_CAPABILITY_UNAVAILABLE,CLOUD_SYNC_SUSPENDED} from './execution';
import {isImportedContentUrl} from '../core/imported-content';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {rssSourceKey,tryRssArticleId,isLocalOnlyRssSource} from './rss-identity';
import type {SnapshotCrypto} from './codec';
import {sha256Hex,hmacSha256Bytes,hex} from '@podjs/framework/crypto';
import {WorkReceipts} from '@podjs/framework/work-receipts';
import {utf8Encode,utf8Decode,type CloudTrust,type RssInventory} from './types';
export type RecordKind='article'|'source'|'rss-state'|'book'|'book-reading';
export interface RecordDocument {kind:string;value:Record<string,any>;features?:CloudFeatures;/** Local intent only; never serialized. */pendingEdit?:boolean;/** Physical-row export suppression only, never wire identity. */projectionAliases?:readonly string[]}
export interface RecordEnvelope {algorithm:'A256GCM';keyVersion:number;nonceBase64:string;ciphertextBase64:string}
export interface RecordRow {recordId:string;revision:string;envelope:RecordEnvelope;tombstone:boolean}
export interface RecordPage extends CloudTrust {formatVersion:0|1;items:RecordRow[];cursor:string;headRevision:string;hasMore:boolean}
export interface RecordWrite {recordId:string;expectedRevision:string;envelope:RecordEnvelope;tombstone:boolean}
export interface RecordPullMetrics {projectionDecryptions?:number;decryptions:number;retired:number;elapsedMillis:number;outcome:'complete'|'paused'|'failed'}
export interface RecordReplayProgress {event:'records-replay';stage:'decoding'|'merging'|'applied';batchRows:number;documents:number;keyMillis:number;decodeMillis:number;hashMillis:number;applyMillis:number;elapsedMillis:number}
export interface RecordWorkProgress {event:'records-work';lane:'interactions'|'flush'|'pull';stage:'export'|'identity'|'projection'|'canonicalJSON'|'hash'|'ack-diff'|'encode'|'push'|'checkpoint'|'retire'|'apply-metadata'|'apply-books'|'reading-candidates'|'reading-index'|'reading-merge'|'state-read'|'state-validate'|'projection-load'|'original-load'|'replay-unit'|'checkpoint-skip';durationMillis:number;units:number;cached?:boolean;outcome:'complete'|'failed'|'started';decryptions?:number;projectionDecryptions?:number}
export interface RecordPorts {
 userId:string;epoch:string;anchorVersion:number;version:number;
 key(version:number):Promise<Uint8Array|undefined>;
 crypto:SnapshotCrypto&{hmac(key:Uint8Array,bytes:Uint8Array):Promise<string>};
 readState():Promise<string|undefined>;writeState(value:string):Promise<void>;
 /** Production object/delta path; legacy test/host ports remain compatible. */
 now?():number;remainingMillis?():number;readStateObject?():Promise<unknown>;writeStateObject?(value:Record<string,any>):Promise<unknown>;lazyProjections?:boolean;
 /** Persist completed replay batches on foreground suspension, rechecking the
  * account independently of foreground eligibility. Never used after revocation. */
 checkpoint?(value:string):Promise<void>;
 /** Numeric work counters only; never include record IDs, keys or plaintext. */
 report?(metrics:RecordPullMetrics):void;
 progress?(metrics:RecordReplayProgress):void;
 work?(metrics:RecordWorkProgress):void;
 /** Fraction of the server revision range replayed so far; numbers only. */
 pageProgress?(done:number,total:number):void;
 get(after:string):Promise<RecordPage>;push(items:RecordWrite[]):Promise<{formatVersion:1;items:{recordId:string;revision:string}[]}>;
 readPreparation?():Promise<string|undefined>;writePreparation?(value:string):Promise<void>;
 refreshKeys?():Promise<void>;check?():void;current():Promise<void>;assertUpload():Promise<void>;
 bookReplacement?(legacy:RecordDocument):Promise<{book:RecordDocument;reading?:RecordDocument}|undefined>;
 project?(local:RecordDocument,basis:RecordDocument):Promise<RecordDocument>|RecordDocument;
 inventoryLookups?(inventory:RssInventory):Promise<RecordDocument[]>;
 /** Restore previously committed in-memory RSS/source projections without SQL writes. */
 hydrate?(documents:RecordDocument[]):Promise<void>;
 reapply?():Promise<number>;
 apply(documents:RecordDocument[],work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>|T)=>Promise<T>):Promise<number>;export(work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>|T)=>Promise<T>):Promise<RecordDocument[]>;
}
const check=(ok:unknown)=>{if(!ok)throw Error('cloud_record_invalid');};
const ID=/^[a-f0-9]{64}$/;
export function revision(v:string){check(typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&(v.length<19||v<='9223372036854775807'));return v;}
const cmp=(a:string,b:string)=>a.length-b.length||(a===b?0:a<b?-1:1);
export function canonical(value:any):string {return cpuWork('canonical-json','items',Array.isArray(value)?value.length:value&&typeof value==='object'?Object.keys(value).length:0,()=>canonicalValue(value));}
function canonicalValue(value:any):string {if(Array.isArray(value))return '['+value.map(canonicalValue).join(',')+']';if(value&&typeof value==='object')return '{'+cpuSort(Object.keys(value).filter(k=>value[k]!==undefined)).map(k=>cpuJsonStringify(k)+':'+canonicalValue(value[k])).join(',')+'}';return cpuJsonStringify(value);}
export function validateRecord(doc:RecordDocument){
 check(doc&&typeof doc.kind==='string'&&!!doc.kind&&doc.value&&typeof doc.value==='object'&&!Array.isArray(doc.value));const v=knownRecordValue(doc.kind,doc.value);if(hasArticleRegisters(doc)){normalizeArticleRegisters(doc);return;}
 if(['article','source','rss-state','book','book-reading'].includes(doc.kind))check(!['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'].some(k=>k in doc.value));
 if(doc.kind==='book'){validateBookShape(v);return;}if(doc.kind==='book-reading'){validateBookReading(v);return;}
 if(!['article','source','rss-state','book','book-reading'].includes(doc.kind))return;
 check(!['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'].some(k=>k in doc.value));
 if(doc.kind==='rss-state'){check(!['title','url','excerpt','siteName','imageUrl','rssSourceUrl','rssSourceTitle','contentHash'].some(k=>k in doc.value));check(Object.keys(v).every(k=>['sourceId','articleIdHash','sourceDeviceId','isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt'].includes(k)));check(typeof v.sourceId==='string'&&v.sourceId.length>0&&ID.test(v.articleIdHash));}else check(typeof v[doc.kind==='article'?'articleId':'url']==='string'&&!!v[doc.kind==='article'?'articleId':'url'].trim());
 for(const [k,value]of Object.entries(v)){if(/(?:At|Bytes|SortOrder)$/.test(k))check(Number.isSafeInteger(value));if(/(?:At|Bytes)$/.test(k))check(Number(value)>=0);if(['isRead','deleted','favoriteSaved','watchLaterSaved','independentSaved','isPinned'].includes(k))check(typeof value==='boolean');}
 if('readingProgress'in v)check(typeof v.readingProgress==='number'&&Number.isFinite(v.readingProgress)&&v.readingProgress>=0&&v.readingProgress<=1);
}
const publicArticleIndex=(v:Record<string,any>)=>/^https?:\/\//.test(v.rssSourceUrl??'')&&!isImportedContentUrl(v.rssSourceUrl)&&!isImportedContentUrl(v.url);
export class CloudRecordCodec {
 constructor(private c:RecordPorts['crypto']){}
 async id(key:Uint8Array,user:string,doc:RecordDocument){validateRecord(doc);const v=doc.value,identity=doc.kind==='book'?v.bookId:doc.kind==='book-reading'?v.bookId+':'+v.chapterIndex:doc.kind==='rss-state'?v.sourceId+':'+v.articleIdHash:doc.kind==='article'?v.articleId:v.url;const derived=await this.c.hkdf(key,utf8Encode(user),utf8Encode('watchrss/cloud/record-id/v1'));try{return await this.c.hmac(derived,utf8Encode(doc.kind+':'+identity));}finally{derived.fill(0);}}
 mergeArticles(left:RecordDocument,right:RecordDocument){return mergeArticleRegisters(left,right);}
 readPlaintext(text:string):RecordDocument {return cpuWork('records-parse','chars',text.length,()=>{const node=parseRawJson(text,{maxBytes:65520}),raw=rawJsonValue<any>(node);check(raw&&raw.format==='watchrss-rss-record'&&raw.version===1);let doc:RecordDocument=bindCloudRaw({kind:raw.kind,value:raw.value,...(raw.features===undefined?{}:{features:raw.features})},node,recordRawSchema(raw.kind),16384);if(doc.kind==='article'&&doc.value&&hasArticleRegisters(doc)){if(doc.features?.roCompat?.includes(ARTICLE_REGISTER_FEATURE)&&cloudCompatibility(doc).opaque&&cloudCompatibility(doc).reason!=='invalid_features')return doc;doc=readArticleRegisters(text);if(!cloudCompatibility(doc).readOnly)markCloudReadOnly(doc,'article_provenance_write_disabled');}if(!Object.prototype.hasOwnProperty.call(recordFields,doc.kind))isolateCloudRaw(doc,'unknown_kind');if(!cloudCompatibility(doc).opaque)validateRecord(doc);return doc;});}
 hashText(doc:RecordDocument){if(hasArticleRegisters(doc)&&!cloudCompatibility(doc).opaque)return articleKnownCanonical(normalizeArticleRegisters(doc));if(cloudCompatibility(doc).opaque)return cloudRaw(doc)?.source??canonical(doc);doc={...doc,value:knownRecordValue(doc.kind,doc.value)};if(doc.kind==='book'||doc.kind==='book-reading'){validateRecord(doc);const v={...doc.value};if('readingProgress'in v)v.readingProgress=Math.floor(v.readingProgress*1e6+.5)/1e6;return doc.kind+':'+canonical(v);}const value={...doc.value};delete value.sourceDeviceId;if(doc.kind==='source')delete value.createdAt;if('readingProgress'in value)value.readingProgress=Math.floor(value.readingProgress*1e6+.5)/1e6;return canonical({kind:doc.kind,value});}
 async hash(doc:RecordDocument){return this.c.sha256(utf8Encode(this.hashText(doc)));}
 async encode(key:Uint8Array,user:string,id:string,version:number,doc:RecordDocument,basis:RecordDocument=doc):Promise<RecordEnvelope>{
  validateRecord(doc);if(hasArticleRegisters(doc)||hasArticleRegisters(basis))throw Error('cloud_format_read_only');if(doc.kind==='book')await validateBook(doc.value,this.c.sha256);check(ID.test(id)&&Number.isInteger(version)&&version>0);if(cloudCompatibility(basis).readOnly)throw Error('cloud_format_read_only');const text=cloudRaw(basis)?rawRecordText(doc,basis):canonical({format:'watchrss-rss-record',version:1,kind:doc.kind,features:doc.features,value:doc.value});const node=parseRawJson(text);const bound=bindCloudRaw({...doc},node,recordRawSchema(doc.kind),16384);if(cloudCompatibility(bound).readOnly)throw Error('cloud_format_read_only');const bytes=utf8Encode(text);check(bytes.length+16<=65536);const derived=await this.c.hkdf(key,utf8Encode(user),utf8Encode('watchrss/cloud/record/v1'));
  try{const out=await this.c.encrypt(derived,utf8Encode(`watchrss-cloud-record-v1:${user}:${id}:${version}`),bytes);return {algorithm:'A256GCM',keyVersion:version,nonceBase64:bytesToBase64(out.nonce),ciphertextBase64:bytesToBase64(out.ciphertext)};}finally{derived.fill(0);bytes.fill(0);}
 }
 async decode(key:Uint8Array,anchor:Uint8Array,user:string,row:RecordRow){
  const e=row.envelope;check(ID.test(row.recordId)&&e?.algorithm==='A256GCM'&&Number.isInteger(e.keyVersion)&&e.keyVersion>0);check(typeof e.ciphertextBase64==='string'&&e.ciphertextBase64.length<=87384&&typeof e.nonceBase64==='string'&&e.nonceBase64.length===16);
  const nonce=base64ToBytes(e.nonceBase64),bytes=base64ToBytes(e.ciphertextBase64);check(nonce.length===12&&bytes.length>=16&&bytes.length<=65536&&bytesToBase64(bytes)===e.ciphertextBase64);
  const derived=await this.c.hkdf(key,utf8Encode(user),utf8Encode('watchrss/cloud/record/v1'));let plain:Uint8Array|undefined;
  try{plain=await this.c.decrypt(derived,utf8Encode(`watchrss-cloud-record-v1:${user}:${row.recordId}:${e.keyVersion}`),nonce,bytes);const text=utf8Decode(plain),round= utf8Encode(text);check(round.length===plain.length&&round.every((b,i)=>b===plain![i]));const doc=this.readPlaintext(text);if(cloudCompatibility(doc).opaque)return {doc,legacy:false};validateRecord(doc);if(doc.kind==='book')await validateBook(doc.value,this.c.sha256);let legacy=false;
   if(['article','source','rss-state','book','book-reading'].includes(doc.kind)&&await this.id(anchor,user,doc)!==row.recordId){check(await this.id(key,user,doc)===row.recordId);legacy=true;}releaseKnownCloudRaw(doc);return {doc,legacy};
  }catch(error){if(error instanceof Error&&[CLOUD_HOST_CAPABILITY_UNAVAILABLE,CLOUD_SYNC_SUSPENDED,'cloud_sync_deadline_exceeded','cloud_operation_superseded'].includes(error.message))throw error;throw Error(error instanceof Error&&error.message==='raw_json_depth'?'cloud_record_format_depth':'cloud_record_invalid');}finally{derived.fill(0);plain?.fill(0);}
 }
}
interface RecordProjection {plaintext?:string;checksum?:string;ids:string[];keyVersion:number;binding:string;nonceBase64:string;ciphertextBase64:string}
interface RecordState {replayScope?:string;replayDone?:Record<string,{end:number;proof:string}>;prepared?:{scope:string;entries:[string,{id:string;hash:string;proof:string}][]};projections?:RecordProjection[];protectedVersions?:Record<string,RecordRow[]>;quarantinedRows?:Record<string,boolean>;protectedRows?:Record<string,boolean>;pendingEdits?:Record<string,boolean>;epoch:string;cursor:string;records:Record<string,{revision:string;hash:string}>;rows:Record<string,RecordRow>}
/** Local projection, account/epoch scoped by the cache. Production stores plaintext; legacy encrypted projections remain readable during migration. */
export class WatchCloudRecords {
 private state!:RecordState;private codec:CloudRecordCodec;private decoded=new Map<string,{row:RecordRow;doc:RecordDocument;legacy:boolean}>();
 private progressCommit?:((unit:string)=>Promise<void>);private savedCursor='0';private savedProjection='';
 trackProgress(commit:(unit:string)=>Promise<void>){this.progressCommit=commit;}
 private replayReady=false;private rowMillis=1000;private replayBatch=1;private applyWarmupMillis=0;
 private now(){return this.p.now?.()??Date.now();}
 private decryptions=0;private projectionDecryptions=0;private retired=0;
 private runKeys=new Map<number,Uint8Array|undefined>();
 private derivedKeys=new Map<string,Uint8Array>();
 private async key(version:number){let key=this.runKeys.get(version);if(!this.runKeys.has(version)){key=await this.p.key(version);this.runKeys.set(version,key);}return key?.slice();}
 private async projectionBinding(ids:string[]){return this.p.crypto.sha256(utf8Encode(cpuJsonStringify(ids.map(id=>[this.state.rows[id],this.state.records[id]]))));}
 private projectionAad(group:Pick<RecordProjection,'keyVersion'|'binding'>){return utf8Encode(cpuJsonStringify(['watchrss/local-record-projection/v1',this.p.userId,this.p.epoch,group.keyVersion,group.binding]));}
 private async projectionChecksum(group:Pick<RecordProjection,'keyVersion'|'binding'>,text:string){return this.p.crypto.sha256(utf8Encode(utf8Decode(this.projectionAad(group))+'\0'+text));}
 private async openProjection(group:RecordProjection){
  if(group.plaintext!==undefined){check(typeof group.plaintext==='string'&&group.plaintext.length<=8*1024*1024&&group.checksum===await this.projectionChecksum(group,group.plaintext));return utf8Encode(group.plaintext);}
  const key=await this.key(group.keyVersion);if(!key)throw Error('missing_key_version');let derived:Uint8Array|undefined;
  try{derived=await this.projectionKey(key);this.projectionDecryptions++;const bytes=await this.p.crypto.decrypt(derived,this.projectionAad(group),base64ToBytes(group.nonceBase64),base64ToBytes(group.ciphertextBase64));check(bytes.length<=8*1024*1024);
   if(this.p.crypto.localPlaintext){const text=utf8Decode(bytes);group.checksum=await this.projectionChecksum(group,text);group.plaintext=text;group.nonceBase64='';group.ciphertextBase64='';}return bytes;
  }finally{key.fill(0);derived?.fill(0);}
 }
 private async projectionKey(key:Uint8Array){return this.derive(key,utf8Encode(this.p.userId),utf8Encode('watchrss/local-record-projection/v1'));}
 private async derive(key:Uint8Array,salt:Uint8Array,info:Uint8Array){
  const id=bytesToBase64(key)+':'+bytesToBase64(salt)+':'+bytesToBase64(info);let derived=this.derivedKeys.get(id);
  if(!derived){derived=await this.p.crypto.hkdf(key,salt,info);this.derivedKeys.set(id,derived);}return derived.slice();
 }
 private clearRunKeys(){for(const key of [...this.runKeys.values(),...this.derivedKeys.values()])key?.fill(0);this.runKeys.clear();this.derivedKeys.clear();}

 get compatibility(){const out=emptyCompatibilityStatus();for(const item of this.decoded.values()){const p=cloudCompatibility(item.doc);if(p.opaque)out.opaque++;else if(p.readOnly)out.readOnly++;}for(const id of Object.keys(this.state?.protectedRows??{}))if(!this.decoded.has(id))out.readOnly++;out.opaque+=Object.keys(this.state?.quarantinedRows??{}).length;out.editPending=Object.keys(this.state?.pendingEdits??{}).length;out.upgradeRequired=!!(out.opaque||out.readOnly||out.editPending);return out;}
 constructor(private p:RecordPorts){this.codec=new CloudRecordCodec({...p.crypto,hkdf:(...args)=>this.derive(...args),decrypt:async(...args)=>{this.decryptions++;return p.crypto.decrypt(...args);}});}
 private empty():RecordState{return {epoch:this.p.epoch,cursor:'0',records:{},rows:{}};}
 private async measured<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>):Promise<T>{const at=this.now(),originals=this.decryptions,projections=this.projectionDecryptions;try{this.p.work?.({event:'records-work',lane:'pull',stage,units,durationMillis:0,outcome:'started'});}catch{}let ok=false;try{const v=await run();ok=true;return v;}finally{try{this.p.work?.({event:'records-work',lane:'pull',stage,units,durationMillis:Math.max(0,this.now()-at),outcome:ok?'complete':'failed',...(['projection-load','original-load'].includes(stage)?{decryptions:this.decryptions-originals,projectionDecryptions:this.projectionDecryptions-projections}:{})});}catch{}}}
 private async save(){return this.measured('checkpoint',1,async()=>{if(this.p.writeStateObject)await this.p.writeStateObject(this.state);else{await this.p.current();await this.p.writeState(cpuJsonStringify(this.state));}const projection=this.state.projections?.at(-1)?.binding??'';if(this.state.cursor!==this.savedCursor){await this.progressCommit?.('pull:'+this.state.cursor);this.savedCursor=this.state.cursor;}if(projection&&projection!==this.savedProjection){await this.progressCommit?.('projection:'+projection);this.savedProjection=projection;}});}
 private async ensureDecoded(ids:readonly string[]){
  const needed=new Set(ids.filter(id=>!this.decoded.has(id)&&this.state.rows[id]&&!this.state.quarantinedRows?.[id]));
  for(const group of this.state.projections??[]){if(!group.ids.some(id=>needed.has(id)))continue;await this.p.current();
   await this.measured('projection-load',group.ids.length,async()=>{let key:Uint8Array|undefined,derived:Uint8Array|undefined,bytes:Uint8Array|undefined;try{
    if(group.ids.some(id=>!this.state.rows[id]||this.state.quarantinedRows?.[id])||await this.projectionBinding(group.ids)!==group.binding)return;
    bytes=await this.openProjection(group);
    const data=cpuJsonParse(utf8Decode(bytes));check(data.version===1&&Array.isArray(data.entries)&&data.entries.length===group.ids.length);
    const items=cpuWork('projection-rebuild','items',data.entries.length,()=>data.entries.map((entry:any,i:number)=>{check(entry.id===group.ids[i]&&typeof entry.text==='string'&&typeof entry.legacy==='boolean');const doc=this.codec.readPlaintext(entry.text);releaseKnownCloudRaw(doc);return {row:this.state.rows[entry.id]!,doc,legacy:entry.legacy};}));
    for(const item of items){this.decoded.set(item.row.recordId,item);needed.delete(item.row.recordId);}
   }catch(error){await this.p.current();if(/cloud_host_capability_unavailable|missing_key_version/.test(String(error)))throw error;/* Disposable projection: authenticate the original below. */}finally{key?.fill(0);derived?.fill(0);bytes?.fill(0);}});
  }
  for(const id of needed)await this.measured('original-load',1,async()=>{await this.p.current();const row=this.state.rows[id],key=await this.key(row.envelope.keyVersion),anchor=await this.key(this.p.anchorVersion);if(!key||!anchor)throw Error('missing_key_version');try{this.decoded.set(id,{row,...await this.codec.decode(key,anchor,this.p.userId,row)});}catch(error){await this.p.current();if(/cloud_host_capability_unavailable|missing_key_version|library_epoch_mismatch/.test(String(error)))throw error;(this.state.quarantinedRows??={})[id]=true;}finally{key.fill(0);anchor.fill(0);}});
 }

 async pull(){
  this.decryptions=0;this.projectionDecryptions=0;this.retired=0;const began=this.now();let outcome:RecordPullMetrics['outcome']='complete';
  try{return await this.pullRecords();}catch(error){outcome=String(error).includes('cloud_sync_suspended')?'paused':'failed';throw error;}
  finally{this.clearRunKeys();try{this.p.report?.({...(this.projectionDecryptions?{projectionDecryptions:this.projectionDecryptions}:{}),decryptions:this.decryptions,retired:this.retired,elapsedMillis:Math.max(0,this.now()-began),outcome});}catch{/* Diagnostics cannot change sync behavior. */}}
 }
 private async pullRecords(){
  const p=this.p;this.replayReady=false;await p.current();this.state=this.empty();const raw=await this.measured('state-read',1,()=>p.readStateObject?p.readStateObject():p.readState());const validatedAt=this.now();if(raw)try{const s=typeof raw==='string'?cpuJsonParse(raw):raw as RecordState;cpuWork('records-validate','items',Object.keys(s.rows??{}).length,()=>{revision(s.cursor);check(s.records&&s.rows&&typeof s.records==='object'&&typeof s.rows==='object'&&!Array.isArray(s.records)&&!Array.isArray(s.rows)&&Object.keys(s.records).length<=50000&&Object.keys(s.rows).length<=50000);
   for(const name of ['protectedRows','pendingEdits','quarantinedRows'])if(s[name]!==undefined)check(s[name]&&typeof s[name]==='object'&&!Array.isArray(s[name])&&Object.keys(s[name]).length<=50000&&Object.entries(s[name]).every(([id,v])=>ID.test(id)&&v===true));
   if(s.protectedVersions!==undefined){check(s.protectedVersions&&typeof s.protectedVersions==='object'&&!Array.isArray(s.protectedVersions));let count=Object.keys(s.rows).length;for(const [id,versions]of Object.entries(s.protectedVersions) as [string,RecordRow[]][]){check(ID.test(id)&&Array.isArray(versions));for(const row of versions){check(row.recordId===id&&row.envelope&&typeof row.tombstone==='boolean');revision(row.revision);}count+=versions.length;}check(count<=50000);}
   for(const [id,v]of Object.entries(s.records) as [string,{revision:string;hash:string}][]){check(ID.test(id)&&v&&ID.test(v.hash));revision(v.revision);}
   for(const [id,v]of Object.entries(s.rows) as [string,RecordRow][]){check(ID.test(id)&&v&&v.recordId===id&&v.envelope&&typeof v.tombstone==='boolean');revision(v.revision);}
   // Projection corruption is not loss of the underlying encrypted row cache.
   if(s.projections!==undefined){let count=0;s.projections=Array.isArray(s.projections)?s.projections.filter((g:RecordProjection)=>{const valid=g&&Array.isArray(g.ids)&&g.ids.length>0&&g.ids.length<=50&&g.ids.every(id=>ID.test(id))&&Number.isSafeInteger(g.keyVersion)&&g.keyVersion>0&&ID.test(g.binding)&&(typeof g.plaintext==='string'&&g.plaintext.length<=8*1024*1024&&typeof g.checksum==='string'&&ID.test(g.checksum)||typeof g.nonceBase64==='string'&&g.nonceBase64.length===16&&typeof g.ciphertextBase64==='string'&&g.ciphertextBase64.length<=12*1024*1024);count+=valid?g.ids.length:0;return valid&&count<=50000;}):[];}
   if(s.replayDone!==undefined&&(!s.replayDone||typeof s.replayDone!=='object'||Array.isArray(s.replayDone)||Object.keys(s.replayDone).length>50000))s.replayDone={};if(s.replayScope!==undefined&&(typeof s.replayScope!=='string'||s.replayScope.length>256)){delete s.replayScope;s.replayDone={};}if(s.epoch===p.epoch)this.state=s;});
  }catch{/* Cache loss requires cursor zero, never a library reset. */}
  try{p.work?.({event:'records-work',lane:'pull',stage:'state-validate',units:Object.keys(this.state.rows).length,durationMillis:Math.max(0,this.now()-validatedAt),outcome:'complete'});}catch{}
  this.savedCursor=this.state.cursor;this.savedProjection=this.state.projections?.at(-1)?.binding??'';let cursor=this.state.cursor,restarted=false,changed=0;const refreshed=new Set<number>();const anchor=await this.key(p.anchorVersion);if(!anchor)throw Error('missing_key_version');
  this.decoded.clear();
  const projectionEntries=new Map<string,{id:string;text:string;legacy:boolean}>();
  const cachedInteractions:RecordDocument[]=[];
  const storeProjection=async(rows:RecordRow[])=>{
   const entries=rows.flatMap(row=>{const entry=projectionEntries.get(row.recordId);return entry&&this.state.rows[row.recordId]&&this.state.records[row.recordId]?.revision===row.revision?[entry]:[];});if(!entries.length)return;
   const ids=entries.map(e=>e.id),version=p.version,key=await this.key(version);if(!key)throw Error('missing_key_version');let derived:Uint8Array|undefined,bytes:Uint8Array|undefined;
   try{const group={ids,keyVersion:version,binding:await this.projectionBinding(ids)};bytes=utf8Encode(cpuJsonStringify({version:1,entries}));check(bytes.length<=8*1024*1024);if(p.crypto.localPlaintext){const plaintext=utf8Decode(bytes);(this.state.projections??=[]).push({...group,plaintext,checksum:await this.projectionChecksum(group,plaintext),nonceBase64:'',ciphertextBase64:''});return;}derived=await this.projectionKey(key);const encrypted=await p.crypto.encrypt(derived,this.projectionAad(group),bytes);(this.state.projections??=[]).push({...group,nonceBase64:bytesToBase64(encrypted.nonce),ciphertextBase64:bytesToBase64(encrypted.ciphertext)});}finally{key.fill(0);derived?.fill(0);bytes?.fill(0);}
  };
  const hydrateProjections=async()=>{
   const covered=new Set<string>(),valid:RecordProjection[]=[];
   for(const group of this.state.projections??[]){await p.current();let key:Uint8Array|undefined,derived:Uint8Array|undefined,bytes:Uint8Array|undefined;
    try{if(group.ids.some(id=>covered.has(id)||!this.state.rows[id]||this.state.quarantinedRows?.[id])||await this.projectionBinding(group.ids)!==group.binding)continue;
     bytes=await this.openProjection(group);
     const data=cpuJsonParse(utf8Decode(bytes));check(data.version===1&&Array.isArray(data.entries)&&data.entries.length===group.ids.length);
     const items=cpuWork('projection-rebuild','items',data.entries.length,()=>data.entries.map((entry:any,i:number)=>{check(entry.id===group.ids[i]&&typeof entry.text==='string'&&typeof entry.legacy==='boolean');const doc=this.codec.readPlaintext(entry.text);releaseKnownCloudRaw(doc);return {row:this.state.rows[entry.id]!,doc,legacy:entry.legacy};}));
     const docs=items.filter((item:any)=>!cloudCompatibility(item.doc).opaque&&item.doc.value.bookIndexRetired!==true&&!(item.row.tombstone&&!item.doc.value.deleted)&&['article','source','rss-state','book','book-reading'].includes(item.doc.kind)).map((item:any)=>item.doc);
     if(p.hydrate)await p.hydrate(docs);else cachedInteractions.push(...docs);
     await p.current();for(const item of items){covered.add(item.row.recordId);this.decoded.set(item.row.recordId,item);}valid.push(group);
    }catch(error){if(/cloud_sync_deadline_exceeded|cloud_sync_suspended|cloud_operation_superseded|library_epoch_mismatch|账号|cloud_host_capability_unavailable/.test(String(error)))throw error;/* Invalid disposable projection falls back to authenticated original rows. */}
    finally{key?.fill(0);derived?.fill(0);bytes?.fill(0);}
   }
   this.state.projections=valid;return covered;
  };
  const applyCachedInteractions=async(final=false)=>{
   while(cachedInteractions.length>=500||final&&cachedInteractions.length){
    await p.current();const docs=cachedInteractions.splice(0,500),started=this.now();
    const report=(stage:'merging'|'applied')=>{try{p.progress?.({event:'records-replay',stage,batchRows:docs.length,documents:docs.length,keyMillis:0,decodeMillis:0,hashMillis:0,applyMillis:stage==='applied'?Math.max(0,this.now()-started):0,elapsedMillis:Math.max(0,this.now()-started)});}catch{}};
    report('merging');if(p.hydrate)await p.hydrate(docs);else changed+=await this.apply(docs);await p.current();report('applied');
   }
  };
  const process=async(rows:RecordRow[],retained=false)=>{await p.current();const started=this.now(),times={keyMillis:0,decodeMillis:0,hashMillis:0,applyMillis:0};const timed=async<T>(name:keyof typeof times,run:()=>Promise<T>)=>{const at=this.now();try{return await run();}finally{times[name]+=Math.max(0,this.now()-at);}};const progress=(stage:RecordReplayProgress['stage'],documents:number)=>{try{p.progress?.({event:'records-replay',stage,batchRows:rows.length,documents,...times,elapsedMillis:Math.max(0,this.now()-started)});}catch{}};progress('decoding',0);const docs:RecordDocument[]=[],acks:Record<string,{revision:string;hash:string}>={},retiredIds=new Set<string>();
   for(const row of rows){const old=this.state.records[row.recordId];if(old&&cmp(old.revision,row.revision)>0)continue;
    // This exact tombstone revision was authenticated and acknowledged earlier.
    // Compact old-version caches too: they retained every retired ciphertext.
    // Never produce a deletion/value from this hint; new revisions and failed
    // ciphertext (no acknowledgement) must still authenticate below.
    if(row.tombstone&&old?.revision===row.revision&&!this.state.protectedRows?.[row.recordId]){delete this.state.rows[row.recordId];this.decoded.delete(row.recordId);this.retired++;continue;}
    await p.current();let key:Uint8Array|undefined;
    try{key=await timed('keyMillis',()=>this.key(row.envelope.keyVersion));if(!key&&p.refreshKeys&&!refreshed.has(row.envelope.keyVersion)){refreshed.add(row.envelope.keyVersion);await p.refreshKeys();await p.current();this.runKeys.delete(row.envelope.keyVersion);key=await timed('keyMillis',()=>this.key(row.envelope.keyVersion));}if(!key)throw Error('missing_key_version');const value=await timed('decodeMillis',()=>this.codec.decode(key!,anchor,p.userId,row));check(cloudCompatibility(value.doc).opaque||!value.doc.value.deleted||row.tombstone);if(p.lazyProjections&&this.state.rows[row.recordId]?.revision!==row.revision)await this.ensureDecoded([row.recordId]);const previous=this.decoded.get(row.recordId);if(previous&&previous.row.revision!==row.revision&&(hasArticleRegisters(previous.doc)||hasArticleRegisters(value.doc))){const versions=(this.state.protectedVersions??={})[row.recordId]??=[];const unique=[...versions];for(const original of [previous.row,row])if(!unique.some(r=>r.revision===original.revision&&r.envelope.ciphertextBase64===original.envelope.ciphertextBase64))unique.push(original);if(Object.keys(this.state.rows).length+Object.values(this.state.protectedVersions??{}).reduce((n,v)=>n+v.length,0)+unique.length-versions.length>50000)throw Error('cloud_record_count_limit');this.state.protectedVersions[row.recordId]=unique;}this.decoded.set(row.recordId,{row,...value});projectionEntries.set(row.recordId,{id:row.recordId,text:cloudRaw(value.doc)?.source??canonical({format:'watchrss-rss-record',version:1,kind:value.doc.kind,features:value.doc.features,value:value.doc.value}),legacy:value.legacy});delete this.state.quarantinedRows?.[row.recordId];if(cloudCompatibility(value.doc).readOnly)(this.state.protectedRows??={})[row.recordId]=true;else delete this.state.protectedRows?.[row.recordId];if(cloudCompatibility(value.doc).opaque){acks[row.recordId]={revision:row.revision,hash:await timed('hashMillis',()=>this.codec.hash(value.doc))};this.state.rows[row.recordId]=row;continue;}const retired=value.doc.value.bookIndexRetired===true||row.tombstone&&!value.doc.value.deleted;
     const v=value.doc.value,publicIndex=value.doc.kind==='article'&&publicArticleIndex(v);
     const hash=await timed('hashMillis',()=>this.codec.hash(value.doc));
     if(!retired&&['article','source','rss-state','book','book-reading'].includes(value.doc.kind)&&(!old||old.revision!==row.revision||value.doc.kind!=='article'||publicIndex)){
      // Already-durable public interactions still need replay when an inventory
      // materializes an article. Aggregate only exact authenticated ACK matches:
      // fresh/changed values, tombstones and unknown formats keep the 50-row path.
      if(retained&&!row.tombstone&&!cloudCompatibility(value.doc).readOnly&&old?.revision===row.revision&&old.hash===hash&&(p.hydrate||value.doc.kind==='rss-state'||publicIndex))cachedInteractions.push(value.doc);
      else docs.push(value.doc);
     }
     acks[row.recordId]={revision:row.revision,hash};
     if(row.tombstone&&!cloudCompatibility(value.doc).readOnly&&['article','source','rss-state','book','book-reading'].includes(value.doc.kind))retiredIds.add(row.recordId);
    }catch(error){if(String(error).includes(CLOUD_HOST_CAPABILITY_UNAVAILABLE)||String(error).includes('cloud_record_count_limit')||/cloud_sync_deadline_exceeded|cloud_sync_suspended|cloud_operation_superseded|library_epoch_mismatch|账号|client_upgrade_required|commitment|device_attestation/.test(String(error)))throw error;this.decoded.delete(row.recordId);projectionEntries.delete(row.recordId);if(String(error).includes('cloud_record_format_depth'))(this.state.quarantinedRows??={})[row.recordId]=true;/* Retain original ciphertext for replay. A poisoned row cannot disable old validated keys. */}finally{key?.fill(0);}
    this.state.rows[row.recordId]=row;
   }
   progress('merging',docs.length);if(docs.length)changed+=await timed('applyMillis',()=>this.apply(docs));await p.current();Object.assign(this.state.records,acks);progress('applied',docs.length);
   // Authenticated tombstones have been applied. Keep CAS revisions/hashes, but
   // do not decrypt and reapply thousands of retired RSS indexes on every run.
   for(const id of retiredIds){delete this.state.rows[id];this.decoded.delete(id);}
  };
  try{
   // Reuse durably applied projections; authenticate only uncovered originals.
   // Hydrate pending interactions even when their public entries do not exist yet.
   const covered=p.lazyProjections?new Set((this.state.projections??[]).flatMap(g=>g.ids.filter(id=>!!this.state.rows[id]))):await hydrateProjections();const retained=Object.values(this.state.rows).filter(row=>!covered.has(row.recordId));
   // Decode in bounded pages. Fresh/unacknowledged values still merge at most
   // fifty at a time; already-durable public interactions aggregate to 500.
   for(let at=0;at<retained.length;at+=50){const batch=retained.slice(at,at+50);await process(batch,true);await applyCachedInteractions(true);await storeProjection(batch);projectionEntries.clear();
    // Amortize full-cache atomic writes; a deadline/suspension checkpoints the
    // remaining completed 50-row batches below, before releasing the lease.
    if(p.writeStateObject||(at+50)%500===0)await this.save();}
   projectionEntries.clear();
   // No GET/cursor advancement or local upload may overtake this replay.
   await applyCachedInteractions(true);
   const startCursor=cursor;
   for(let pages=0;pages<2000;pages++){
    let page:RecordPage;try{page=await p.get(cursor);}catch(e){if(!restarted&&String(e).includes('cloud_record_cursor_invalid')){restarted=true;this.state=this.empty();this.decoded.clear();cursor='0';continue;}throw e;}
    await p.current();if(page.libraryEpoch!==p.epoch)throw Error('library_epoch_mismatch');if(page.formatVersion===0)throw Error('cloud_records_consent_required');
    check(page.formatVersion===1&&Array.isArray(page.items)&&page.items.length<=50&&typeof page.hasMore==='boolean');revision(page.cursor);revision(page.headRevision);check(cmp(page.cursor,cursor)>=0&&cmp(page.headRevision,page.cursor)>=0&&(page.hasMore?(cmp(page.cursor,cursor)>0&&cmp(page.headRevision,page.cursor)>0&&page.items.length>0):page.cursor===page.headRevision));
    let last=cursor;for(const row of page.items){revision(row.revision);check(ID.test(row.recordId)&&typeof row.tombstone==='boolean'&&cmp(row.revision,last)>0&&cmp(row.revision,page.cursor)<=0);last=row.revision;}
    await process(page.items);await storeProjection(page.items);projectionEntries.clear();cursor=page.cursor;this.state.cursor=cursor;await this.save();
    try{const base=BigInt(startCursor);p.pageProgress?.(Number(BigInt(cursor)-base),Number(BigInt(page.headRevision)-base));}catch{}
    if(!page.hasMore)return changed;
   }throw Error('cloud_record_page_limit');
  }catch(error){if(p.writeStateObject&&/cloud_sync_suspended|cloud_sync_deadline_exceeded/.test(String(error)))await this.measured('checkpoint-skip',0,async()=>{});if(/cloud_sync_suspended|cloud_sync_deadline_exceeded/.test(String(error))&&!p.writeStateObject&&p.checkpoint)await p.checkpoint(cpuJsonStringify(this.state));throw error;}finally{anchor.fill(0);}
 }
 private async apply(documents:RecordDocument[]){
  this.applyWarmupMillis=0;
  const metrics=new Map<string,RecordWorkProgress>();
  const measure=async<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>|T):Promise<T>=>{const at=this.now();let success=false;try{const result=await run();success=true;return result;}finally{const old=metrics.get(stage);metrics.set(stage,{event:'records-work',lane:'pull',stage,units:(old?.units??0)+units,durationMillis:(old?.durationMillis??0)+Math.max(0,this.now()-at),outcome:success&&old?.outcome!=='failed'?'complete':'failed'});}};
  try{return await this.p.apply(documents,measure);}finally{this.applyWarmupMillis=metrics.get('reading-index')?.durationMillis??0;for(const m of metrics.values())try{this.p.work?.(m);}catch{}}
 }
 async reapply(scope='standalone',committed?:(unit:string)=>Promise<void>){return cpuWorkAsync('record-merge','items',Object.keys(this.state.rows).length,async ()=>{await this.p.current();if(this.p.lazyProjections){let changed=0;
  if(this.state.replayScope!==scope){this.state.replayScope=scope;this.state.replayDone={};}
  const anchor=await this.key(this.p.anchorVersion);if(!anchor)throw Error('missing_key_version');
  const proof=(binding:string,end:number)=>hex(hmacSha256Bytes(anchor,utf8Encode(cpuJsonStringify(['record-replay-v3',this.p.userId,this.p.epoch,scope,binding,end]))));
  try{for(const group of this.state.projections??[]){const saved=this.state.replayDone?.[group.binding];let at=saved&&Number.isInteger(saved.end)&&saved.end>=0&&saved.end<=group.ids.length&&saved.proof===proof(group.binding,saved.end)?saved.end:0;
   if(at)await committed?.(group.binding+':prefix-'+at);
   while(at<group.ids.length){await this.p.current();const remaining=this.p.remainingMillis?.()??Infinity;
    if(remaining<Math.max(2000,this.rowMillis*2+1000))throw Error('cloud_sync_deadline_exceeded');
    const count=Math.max(1,Math.min(this.replayBatch,50,Math.floor((Math.min(5000,remaining/4)-1000)/Math.max(1,this.rowMillis)))),end=Math.min(group.ids.length,at+count);let started=this.now();
    await this.measured('replay-unit',end-at,async()=>{await this.ensureDecoded(group.ids.slice(at,end));started=this.now();this.applyWarmupMillis=0;const docs=group.ids.slice(at,end).map(id=>this.decoded.get(id)).filter(v=>v&&!cloudCompatibility(v.doc).opaque&&v.doc.value.bookIndexRetired!==true&&!(v.row.tombstone&&!v.doc.value.deleted)&&['article','source','rss-state','book','book-reading'].includes(v.doc.kind)).map(v=>v!.doc);if(docs.length)changed+=await this.apply(docs);(this.state.replayDone??={})[group.binding]={end,proof:proof(group.binding,end)};await this.save();});
    await committed?.(group.binding+':prefix-'+end);this.rowMillis=Math.max(1,(this.now()-started-this.applyWarmupMillis)/(end-at));this.replayBatch=Math.min(50,Math.max(count+1,count*2));at=end;
   }
  }this.replayReady=true;return changed;}finally{anchor.fill(0);this.clearRunKeys();}
 }if(this.p.reapply)return this.p.reapply();return this.apply([...this.decoded.values()].filter(v=>!cloudCompatibility(v.doc).opaque&&v.doc.value.bookIndexRetired!==true&&!(v.row.tombstone&&!v.doc.value.deleted)&&['article','source','rss-state','book','book-reading'].includes(v.doc.kind)).map(v=>v.doc));});}
 async reapplyInventory(inventory:RssInventory){
  const lookup=this.p.inventoryLookups;if(!this.p.lazyProjections||!lookup)return 0;await this.p.current();return this.measured('replay-unit',inventory.items.length,async()=>{
  const versions=[...new Set([this.p.anchorVersion,this.p.version,...Object.values(this.state.rows).map(r=>r.envelope.keyVersion)])];
  const hydrate=async(lookups:RecordDocument[])=>{const ids=new Set<string>();for(const version of versions){const key=await this.key(version);if(!key)continue;try{for(const doc of lookups){const id=await this.codec.id(key,this.p.userId,doc);if(this.state.rows[id])ids.add(id);}}finally{key.fill(0);}}
   await this.ensureDecoded([...ids]);const docs=[...ids].map(id=>this.decoded.get(id)?.doc).filter((d):d is RecordDocument=>!!d&&!cloudCompatibility(d).opaque);if(docs.length)await this.p.hydrate?.(docs);
  };
  try{await hydrate([{kind:'source',value:{url:inventory.url}}]);await hydrate(await lookup(inventory));return await this.p.reapply?.()??0;}finally{this.clearRunKeys();}
  });
 }
 flush(completedPrivateArticleIds:readonly string[]=[],completedBookIds:readonly string[]=[]){if(this.p.lazyProjections&&!this.replayReady)return Promise.resolve(0);return this.flushRecords(completedPrivateArticleIds,completedBookIds,false);}
 /** Public RSS interactions commit independently of slow private body restore.
  * This lane never publishes private metadata or retires any legacy record. */
 flushInteractions(){if(this.p.lazyProjections)return Promise.resolve(0);return this.flushRecords([],[],true);}
 private async flushRecords(completedPrivateArticleIds:readonly string[],completedBookIds:readonly string[],interactionsOnly:boolean){return cpuWorkAsync('record-diff','items',Math.max(this.decoded.size,Object.keys(this.state.rows).length),async ()=>{
  const p=this.p;await p.current();await p.assertUpload();let cleanupAnchor:Uint8Array|undefined,cleanupKey:Uint8Array|undefined;
  try{const anchor=cleanupAnchor=await this.key(p.anchorVersion),key=cleanupKey=await this.key(p.version);if(!anchor||!key){anchor?.fill(0);key?.fill(0);throw Error('missing_key_version');}
  const lane=interactionsOnly?'interactions':'flush';
  const metrics=new Map<string,RecordWorkProgress>();
  const reportWork=()=>{for(const m of metrics.values())try{p.work?.(m);}catch{}metrics.clear();};
  const measure=async<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>|T,cached=false):Promise<T>=>{const at=this.now();let success=false;try{const result=await run();success=true;return result;}finally{const k=stage+':'+cached,old=metrics.get(k);metrics.set(k,{event:'records-work',lane,stage,units:(old?.units??0)+units,durationMillis:(old?.durationMillis??0)+Math.max(0,this.now()-at),cached,outcome:success&&old?.outcome!=='failed'?'complete':'failed'});}};
  let saved=this.state.prepared;if(p.readPreparation){try{saved=cpuJsonParse(await p.readPreparation()??'null')??undefined;}catch(error){await p.current();saved=undefined;}}
  const scope=sha256Hex(utf8Encode(cpuJsonStringify(['record-preparation-v1',p.userId,p.epoch,p.anchorVersion,p.version])));
  const receipts=new WorkReceipts<{id:string;hash:string;proof:string}>(saved?.scope===scope&&Array.isArray(saved.entries)?saved.entries.filter(e=>Array.isArray(e)&&ID.test(e[0])&&e[1]&&ID.test(e[1].id)&&ID.test(e[1].hash)&&ID.test(e[1].proof)):[],100000);
  const receiptProof=(fingerprint:string,r:{id:string;hash:string})=>hex(hmacSha256Bytes(anchor,utf8Encode('watchrss/local-record-preparation/v1:'+scope+':'+fingerprint+':'+r.id+':'+r.hash)));
  let savedPreparation=saved?.scope===scope&&Array.isArray(saved.entries)?saved.entries.at(-1)?.[0]:undefined;
  const persistPreparation=async()=>{const value={scope,entries:receipts.snapshot()};if(p.writePreparation)await p.writePreparation(cpuJsonStringify(value));else this.state.prepared=value;const last=value.entries.at(-1)?.[0];if(last&&last!==savedPreparation){await this.progressCommit?.('prepared:'+scope+':'+last);savedPreparation=last;}};
  const persist=async(cleanup=false,preparationOnly=false)=>measure('checkpoint',1,async()=>{
   if(!p.writePreparation)this.state.prepared={scope,entries:receipts.snapshot()};
   if(!preparationOnly||!p.writePreparation){if(p.writeStateObject){if(!cleanup)await p.writeStateObject(this.state);}else {const value=cpuJsonStringify(this.state);if((cleanup||accepted)&&p.checkpoint)await p.checkpoint(value);else {await p.current();await p.writeState(value);}}}
   if(p.writePreparation)await persistPreparation();if(accepted)await this.progressCommit?.('ack:'+sha256Hex(utf8Encode(cpuJsonStringify(batch.map(r=>[r.recordId,this.state.records[r.recordId]])))));
  });
  let accepted=false,prepared=0;
  let written=0;const hashById=new Map<string,string>();let batch:RecordWrite[]=[];
  const flush=async()=>{if(!batch.length)return;await p.current();await p.assertUpload();const response=await measure('push',batch.length,()=>p.push(batch));check(response.formatVersion===1&&response.items?.length===batch.length);const expected=new Map(batch.map(r=>[r.recordId,r])),seen=new Set<string>();
   for(const row of response.items){revision(row.revision);const item=expected.get(row.recordId);check(item&&!seen.has(row.recordId)&&cmp(row.revision,item!.expectedRevision)>0);seen.add(row.recordId);}for(const row of response.items){const item=expected.get(row.recordId)!;this.state.records[row.recordId]={revision:row.revision,hash:hashById.get(row.recordId)!};if(item!.tombstone)delete this.state.rows[row.recordId];else this.state.rows[row.recordId]={recordId:row.recordId,revision:row.revision,envelope:item!.envelope,tombstone:item!.tombstone};}accepted=true;written+=batch.length;await persist();accepted=false;await p.current();for(const item of batch)if(!item.tombstone){const row=this.state.rows[item.recordId];if(row)this.decoded.set(item.recordId,{row,...await this.codec.decode(key,anchor,p.userId,row)});}batch=[];};
  const add=async(id:string,doc:RecordDocument,tombstone=!!doc.value.deleted,original?:RecordRow,preparedHash?:string)=>{let hash=preparedHash??await measure('hash',1,()=>this.codec.hash(doc));const old=this.state.records[id];let same=await measure('ack-diff',1,()=>old?.hash===hash&&!original);if(p.lazyProjections&&(!same||this.state.protectedRows?.[id]))await this.ensureDecoded([id]);const basis=this.decoded.get(id)?.doc;if(hasArticleRegisters(doc)||(basis&&cloudCompatibility(basis).readOnly)||(!same&&!basis&&this.state.rows[id])){if(hasArticleRegisters(doc))(this.state.protectedRows??={})[id]=true;if(doc.pendingEdit||old?.hash!==hash)(this.state.pendingEdits??={})[id]=true;return;}if(!same&&basis&&p.project){const projected=await p.project(doc,basis),mergedHash=await measure('hash',1,()=>this.codec.hash(projected));if(mergedHash!==hash&&!tombstone){const changed=await this.apply([projected]);if(changed)await this.progressCommit?.('repair:'+id+':'+mergedHash);}doc=projected;hash=mergedHash;same=old?.hash===hash&&!original;}if(same){delete this.state.pendingEdits?.[id];return;}const envelope=original?.envelope??await measure('encode',1,()=>this.codec.encode(key,p.userId,id,p.version,doc,basis??doc));delete this.state.pendingEdits?.[id];const item={recordId:id,expectedRevision:original?.revision??old?.revision??'0',envelope,tombstone};
   if(batch.length&&(batch.length>=50||utf8Encode(cpuJsonStringify({formatVersion:1,items:[...batch,item]})).length>1048576))await flush();hashById.set(id,hash);batch.push(item);};
  try{
   const documents=(await measure('export',1,()=>p.export(measure))).filter(doc=>!interactionsOnly||doc.kind==='rss-state');
   for(const deleting of [true,false]){for(const doc of documents)if(!!doc.value.deleted===deleting){
    if(p.check){p.check();if(prepared%50===0)await p.current();}else await p.current();validateRecord(doc);
    // Hash every exact input locally, including ignored provenance/unknown fields.
    // These disposable receipts cannot acknowledge a write or bypass CAS/eligibility.
    const fingerprint=await measure('canonicalJSON',1,()=>sha256Hex(utf8Encode(canonical({kind:doc.kind,value:doc.value,features:doc.features}))));
    const proof=(r:{id:string;hash:string})=>receiptProof(fingerprint,r);
    let receipt=receipts.get(fingerprint);if(receipt&&receipt.proof!==proof(receipt))receipt=undefined;
    if(!receipt){const id=await measure('identity',1,()=>this.codec.id(anchor,p.userId,doc)),text=await measure('canonicalJSON',1,()=>this.codec.hashText(doc)),hash=await measure('hash',1,()=>p.crypto.sha256(utf8Encode(text)));receipt={id,hash,proof:proof({id,hash})};receipts.set(fingerprint,receipt);}
    else await measure('identity',1,()=>{},true);
    await add(receipt.id,doc,!!doc.value.deleted,undefined,receipt.hash);
    // Commit bounded preparation prefixes without storing plaintext documents.
    // Production discards at most 49 uncommitted entries on timeout; legacy
    // ports additionally checkpoint their tail in the catch path below.
    if(++prepared%(p.writeStateObject?50:500)===0){await persist(false,true);reportWork();}
   }await flush();}

   if(interactionsOnly){await persist();return written;}
   // R3/S8: obsolete public indexes become entity tombstones only AFTER new states commit.
   const completed=new Set(completedPrivateArticleIds);
   const interactions=new Map(documents.filter(d=>d.kind==='rss-state').map(d=>[d.value.sourceId+':'+d.value.articleIdHash,d]));
   const retireScope=await measure('canonicalJSON',1,()=>sha256Hex(utf8Encode(cpuJsonStringify([completedPrivateArticleIds,completedBookIds,this.state.records]))));let retiredWork=0;
   for(const id of p.lazyProjections?Object.keys(this.state.rows):this.decoded.keys()){
    if(p.check){p.check();if(retiredWork%50===0)await p.current();}else await p.current();
    const fingerprint=sha256Hex(utf8Encode('retire:'+retireScope+':'+id+':'+(this.state.rows[id]?.revision??this.decoded.get(id)?.row.revision))),old=receipts.get(fingerprint);
    if(old&&old.proof===receiptProof(fingerprint,old)){retiredWork++;continue;}
    if(p.lazyProjections)await this.ensureDecoded([id]);const item=this.decoded.get(id);if(!item)continue;
    await measure('retire',1,async()=>{
     if(item.row.tombstone)return;const d=item.doc;if(cloudCompatibility(d).readOnly)return;
    const replacement=d.kind==='article'?await p.bookReplacement?.(d):undefined;
    if(replacement){const current=async(doc:RecordDocument)=>this.state.records[await this.codec.id(anchor,p.userId,doc)]?.hash===await this.codec.hash(doc);if(await current(replacement.book)&&(!replacement.reading||await current(replacement.reading))&&(replacement.book.value.deleted||completedBookIds.includes(replacement.book.value.bookId))){const clock=Math.max(0,...Object.entries(d.value).filter(([k,v])=>k.endsWith('At')&&typeof v==='number').map(([,v])=>Number(v)));check(clock<Number.MAX_SAFE_INTEGER);await add(id,{kind:'article',value:{...d.value,bookIndexRetired:true,deleted:true,deletedAt:clock+1,updatedAt:clock+1}},true);}return;}
    const isPublic=d.kind==='article'&&publicArticleIndex(d.value);
    if(isPublic&&isLocalOnlyRssSource(d.value.rssSourceUrl))return;
    const articleId=isPublic?await tryRssArticleId({link:d.value.url,guid:d.value.guid,title:d.value.title,contentHash:d.value.contentHash},p.crypto.sha256):undefined;if(isPublic&&!articleId)return;
    const state=isPublic?interactions.get(await rssSourceKey(d.value.rssSourceUrl,p.crypto.sha256)+':'+await p.crypto.sha256(utf8Encode(articleId!))):undefined;
    const saved=state?!!(state.value.favoriteSaved||state.value.watchLaterSaved):!!(d.value.favoriteSaved||d.value.watchLaterSaved);
    if(isPublic&&(!saved||completed.has(d.value.articleId))){
     if((d.value.isRead||d.value.readingProgress||d.value.readingPositionChangedAt||d.value.favoriteChangedAt||d.value.watchLaterChangedAt||d.value.favoriteSaved||d.value.watchLaterSaved)&&(!state||!this.state.records[await this.codec.id(anchor,p.userId,state)]||['readingPositionChangedAt','favoriteChangedAt','watchLaterChangedAt'].some(k=>(state.value[k]??0)<(d.value[k]??0))))return;
     await add(id,{kind:d.kind,value:{articleId:d.value.articleId,url:d.value.url,rssSourceUrl:d.value.rssSourceUrl,sourceDeviceId:d.value.sourceDeviceId??'',deleted:true,deletedAt:Math.max(1,...Object.entries(d.value).filter(([k,v])=>k.endsWith('At')&&typeof v==='number').map(([,v])=>Number(v)))+1}},true);
    }else if(item.legacy){const newId=await this.codec.id(anchor,p.userId,d);if(this.state.records[newId]){await add(id,d,true,item.row);}}

    });if(!batch.some(r=>r.recordId===id)){const receipt={id,hash:retireScope};receipts.set(fingerprint,{...receipt,proof:receiptProof(fingerprint,receipt)});}
    if(++retiredWork%500===0){await flush();await persist(false,true);reportWork();}
   }await flush();await persist();return written;
  }catch(error){if(p.writeStateObject&&/cloud_sync_suspended|cloud_sync_deadline_exceeded/.test(String(error)))await this.measured('checkpoint-skip',0,async()=>{});if(/cloud_sync_suspended|cloud_sync_deadline_exceeded/.test(String(error))&&!p.writeStateObject&&p.checkpoint)await persist(true);if((error as {status?:number})?.status===426||(error as {code?:string})?.code==='cloud_format_upgrade_required'){for(const item of batch)(this.state.pendingEdits??={})[item.recordId]=true;await this.save();}throw error;}finally{reportWork();}
  }finally{cleanupAnchor?.fill(0);cleanupKey?.fill(0);this.clearRunKeys();}
 });}
}
