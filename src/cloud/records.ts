import {ARTICLE_REGISTER_FEATURE,hasArticleRegisters,readArticleRegisters,normalizeArticleRegisters,mergeArticleRegisters,articleKnownCanonical} from './article-register';
import {bindCloudRaw,markCloudReadOnly,isolateCloudRaw,releaseKnownCloudRaw,cloudRaw,cloudCompatibility,recordRawSchema,recordFields,knownRecordValue,rawRecordText,parseRawJson,rawJsonValue,emptyCompatibilityStatus,type CloudFeatures} from './compatibility';
import {validateBookShape,validateBook,validateBookReading} from '../books/protocol';
import {CLOUD_HOST_CAPABILITY_UNAVAILABLE,CLOUD_SYNC_SUSPENDED} from './execution';
import {isImportedContentUrl} from '../core/imported-content';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {rssSourceKey,tryRssArticleId,isLocalOnlyRssSource} from './rss-identity';
import type {SnapshotCrypto} from './codec';
import {utf8Encode,utf8Decode,type CloudTrust} from './types';
export type RecordKind='article'|'source'|'rss-state'|'book'|'book-reading';
export interface RecordDocument {kind:string;value:Record<string,any>;features?:CloudFeatures;/** Local intent only; never serialized. */pendingEdit?:boolean;/** Physical-row export suppression only, never wire identity. */projectionAliases?:readonly string[]}
export interface RecordEnvelope {algorithm:'A256GCM';keyVersion:number;nonceBase64:string;ciphertextBase64:string}
export interface RecordRow {recordId:string;revision:string;envelope:RecordEnvelope;tombstone:boolean}
export interface RecordPage extends CloudTrust {formatVersion:0|1;items:RecordRow[];cursor:string;headRevision:string;hasMore:boolean}
export interface RecordWrite {recordId:string;expectedRevision:string;envelope:RecordEnvelope;tombstone:boolean}
export interface RecordPullMetrics {decryptions:number;retired:number;elapsedMillis:number;outcome:'complete'|'paused'|'failed'}
export interface RecordReplayProgress {event:'records-replay';stage:'decoding'|'merging'|'applied';batchRows:number;documents:number;keyMillis:number;decodeMillis:number;hashMillis:number;applyMillis:number;elapsedMillis:number}
export interface RecordPorts {
 userId:string;epoch:string;anchorVersion:number;version:number;
 key(version:number):Promise<Uint8Array|undefined>;
 crypto:SnapshotCrypto&{hmac(key:Uint8Array,bytes:Uint8Array):Promise<string>};
 readState():Promise<string|undefined>;writeState(value:string):Promise<void>;
 /** Persist completed replay batches on foreground suspension, rechecking the
  * account independently of foreground eligibility. Never used after revocation. */
 checkpoint?(value:string):Promise<void>;
 /** Numeric work counters only; never include record IDs, keys or plaintext. */
 report?(metrics:RecordPullMetrics):void;
 progress?(metrics:RecordReplayProgress):void;
 /** Fraction of the server revision range replayed so far; numbers only. */
 pageProgress?(done:number,total:number):void;
 get(after:string):Promise<RecordPage>;push(items:RecordWrite[]):Promise<{formatVersion:1;items:{recordId:string;revision:string}[]}>;
 refreshKeys?():Promise<void>;current():Promise<void>;assertUpload():Promise<void>;
 bookReplacement?(legacy:RecordDocument):Promise<{book:RecordDocument;reading?:RecordDocument}|undefined>;
 apply(documents:RecordDocument[]):Promise<number>;export():Promise<RecordDocument[]>;
}
const check=(ok:unknown)=>{if(!ok)throw Error('cloud_record_invalid');};
const ID=/^[a-f0-9]{64}$/;
export function revision(v:string){check(typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&(v.length<19||v<='9223372036854775807'));return v;}
const cmp=(a:string,b:string)=>a.length-b.length||(a===b?0:a<b?-1:1);
export function canonical(value:any):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
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
 readPlaintext(text:string):RecordDocument {const node=parseRawJson(text,{maxBytes:65520}),raw=rawJsonValue<any>(node);check(raw&&raw.format==='watchrss-rss-record'&&raw.version===1);let doc:RecordDocument=bindCloudRaw({kind:raw.kind,value:raw.value,...(raw.features===undefined?{}:{features:raw.features})},node,recordRawSchema(raw.kind),16384);if(doc.kind==='article'&&doc.value&&hasArticleRegisters(doc)){if(doc.features?.roCompat?.includes(ARTICLE_REGISTER_FEATURE)&&cloudCompatibility(doc).opaque&&cloudCompatibility(doc).reason!=='invalid_features')return doc;doc=readArticleRegisters(text);if(!cloudCompatibility(doc).readOnly)markCloudReadOnly(doc,'article_provenance_write_disabled');}if(!Object.prototype.hasOwnProperty.call(recordFields,doc.kind))isolateCloudRaw(doc,'unknown_kind');if(!cloudCompatibility(doc).opaque)validateRecord(doc);return doc;}
 async hash(doc:RecordDocument){if(hasArticleRegisters(doc)&&!cloudCompatibility(doc).opaque)return this.c.sha256(utf8Encode(articleKnownCanonical(normalizeArticleRegisters(doc))));if(cloudCompatibility(doc).opaque)return this.c.sha256(utf8Encode(cloudRaw(doc)?.source??canonical(doc)));doc={...doc,value:knownRecordValue(doc.kind,doc.value)};if(doc.kind==='book'||doc.kind==='book-reading'){validateRecord(doc);const v={...doc.value};if('readingProgress'in v)v.readingProgress=Math.floor(v.readingProgress*1e6+.5)/1e6;return this.c.sha256(utf8Encode(doc.kind+':'+canonical(v)));}const value={...doc.value};delete value.sourceDeviceId;if(doc.kind==='source')delete value.createdAt;if('readingProgress'in value)value.readingProgress=Math.floor(value.readingProgress*1e6+.5)/1e6;return this.c.sha256(utf8Encode(canonical({kind:doc.kind,value})));}
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
interface RecordState {protectedVersions?:Record<string,RecordRow[]>;quarantinedRows?:Record<string,boolean>;protectedRows?:Record<string,boolean>;pendingEdits?:Record<string,boolean>;epoch:string;cursor:string;records:Record<string,{revision:string;hash:string}>;rows:Record<string,RecordRow>}
/** Disposable encrypted projection, account/epoch scoped by the cache; no plaintext library in it. */
export class WatchCloudRecords {
 private state!:RecordState;private codec:CloudRecordCodec;private decoded=new Map<string,{row:RecordRow;doc:RecordDocument;legacy:boolean}>();
 private decryptions=0;private retired=0;
 get compatibility(){const out=emptyCompatibilityStatus();for(const item of this.decoded.values()){const p=cloudCompatibility(item.doc);if(p.opaque)out.opaque++;else if(p.readOnly)out.readOnly++;}for(const id of Object.keys(this.state?.protectedRows??{}))if(!this.decoded.has(id))out.readOnly++;out.opaque+=Object.keys(this.state?.quarantinedRows??{}).length;out.editPending=Object.keys(this.state?.pendingEdits??{}).length;out.upgradeRequired=!!(out.opaque||out.readOnly||out.editPending);return out;}
 constructor(private p:RecordPorts){this.codec=new CloudRecordCodec({...p.crypto,decrypt:async(...args)=>{this.decryptions++;return p.crypto.decrypt(...args);}});}
 private empty():RecordState{return {epoch:this.p.epoch,cursor:'0',records:{},rows:{}};}
 private async save(){await this.p.current();await this.p.writeState(JSON.stringify(this.state));}
 async pull(){
  this.decryptions=0;this.retired=0;const began=Date.now();let outcome:RecordPullMetrics['outcome']='complete';
  try{return await this.pullRecords();}catch(error){outcome=String(error).includes('cloud_sync_suspended')?'paused':'failed';throw error;}
  finally{try{this.p.report?.({decryptions:this.decryptions,retired:this.retired,elapsedMillis:Math.max(0,Date.now()-began),outcome});}catch{/* Diagnostics cannot change sync behavior. */}}
 }
 private async pullRecords(){
  const p=this.p;await p.current();this.state=this.empty();const raw=await p.readState();if(raw)try{const s=JSON.parse(raw);revision(s.cursor);check(s.records&&s.rows&&typeof s.records==='object'&&typeof s.rows==='object'&&!Array.isArray(s.records)&&!Array.isArray(s.rows)&&Object.keys(s.records).length<=50000&&Object.keys(s.rows).length<=50000);
   for(const name of ['protectedRows','pendingEdits','quarantinedRows'])if(s[name]!==undefined)check(s[name]&&typeof s[name]==='object'&&!Array.isArray(s[name])&&Object.keys(s[name]).length<=50000&&Object.entries(s[name]).every(([id,v])=>ID.test(id)&&v===true));
   if(s.protectedVersions!==undefined){check(s.protectedVersions&&typeof s.protectedVersions==='object'&&!Array.isArray(s.protectedVersions));let count=Object.keys(s.rows).length;for(const [id,versions]of Object.entries(s.protectedVersions) as [string,RecordRow[]][]){check(ID.test(id)&&Array.isArray(versions));for(const row of versions){check(row.recordId===id&&row.envelope&&typeof row.tombstone==='boolean');revision(row.revision);}count+=versions.length;}check(count<=50000);}
   for(const [id,v]of Object.entries(s.records) as [string,{revision:string;hash:string}][]){check(ID.test(id)&&v&&ID.test(v.hash));revision(v.revision);}
   for(const [id,v]of Object.entries(s.rows) as [string,RecordRow][]){check(ID.test(id)&&v&&v.recordId===id&&v.envelope&&typeof v.tombstone==='boolean');revision(v.revision);}
   if(s.epoch===p.epoch)this.state=s;
  }catch{/* Cache loss requires cursor zero, never a library reset. */}
  let cursor=this.state.cursor,restarted=false,changed=0;const refreshed=new Set<number>();const anchor=await p.key(p.anchorVersion);if(!anchor)throw Error('missing_key_version');
  const cachedInteractions:RecordDocument[]=[];
  const applyCachedInteractions=async(final=false)=>{
   while(cachedInteractions.length>=500||final&&cachedInteractions.length){
    await p.current();const docs=cachedInteractions.splice(0,500),started=Date.now();
    const report=(stage:'merging'|'applied')=>{try{p.progress?.({event:'records-replay',stage,batchRows:docs.length,documents:docs.length,keyMillis:0,decodeMillis:0,hashMillis:0,applyMillis:stage==='applied'?Math.max(0,Date.now()-started):0,elapsedMillis:Math.max(0,Date.now()-started)});}catch{}};
    report('merging');changed+=await p.apply(docs);await p.current();report('applied');
   }
  };
  const process=async(rows:RecordRow[],retained=false)=>{await p.current();const started=Date.now(),times={keyMillis:0,decodeMillis:0,hashMillis:0,applyMillis:0};const timed=async<T>(name:keyof typeof times,run:()=>Promise<T>)=>{const at=Date.now();try{return await run();}finally{times[name]+=Math.max(0,Date.now()-at);}};const progress=(stage:RecordReplayProgress['stage'],documents:number)=>{try{p.progress?.({event:'records-replay',stage,batchRows:rows.length,documents,...times,elapsedMillis:Math.max(0,Date.now()-started)});}catch{}};progress('decoding',0);const docs:RecordDocument[]=[],acks:Record<string,{revision:string;hash:string}>={},retiredIds=new Set<string>();
   for(const row of rows){const old=this.state.records[row.recordId];if(old&&cmp(old.revision,row.revision)>0)continue;
    // This exact tombstone revision was authenticated and acknowledged earlier.
    // Compact old-version caches too: they retained every retired ciphertext.
    // Never produce a deletion/value from this hint; new revisions and failed
    // ciphertext (no acknowledgement) must still authenticate below.
    if(row.tombstone&&old?.revision===row.revision&&!this.state.protectedRows?.[row.recordId]){delete this.state.rows[row.recordId];this.decoded.delete(row.recordId);this.retired++;continue;}
    await p.current();let key:Uint8Array|undefined;
    try{key=await timed('keyMillis',()=>p.key(row.envelope.keyVersion));if(!key&&p.refreshKeys&&!refreshed.has(row.envelope.keyVersion)){refreshed.add(row.envelope.keyVersion);await p.refreshKeys();await p.current();key=await timed('keyMillis',()=>p.key(row.envelope.keyVersion));}if(!key)throw Error('missing_key_version');const value=await timed('decodeMillis',()=>this.codec.decode(key!,anchor,p.userId,row));check(cloudCompatibility(value.doc).opaque||!value.doc.value.deleted||row.tombstone);const previous=this.decoded.get(row.recordId);if(previous&&previous.row.revision!==row.revision&&(hasArticleRegisters(previous.doc)||hasArticleRegisters(value.doc))){const versions=(this.state.protectedVersions??={})[row.recordId]??=[];const unique=[...versions];for(const original of [previous.row,row])if(!unique.some(r=>r.revision===original.revision&&r.envelope.ciphertextBase64===original.envelope.ciphertextBase64))unique.push(original);if(Object.keys(this.state.rows).length+Object.values(this.state.protectedVersions??{}).reduce((n,v)=>n+v.length,0)+unique.length-versions.length>50000)throw Error('cloud_record_count_limit');this.state.protectedVersions[row.recordId]=unique;}this.decoded.set(row.recordId,{row,...value});delete this.state.quarantinedRows?.[row.recordId];if(cloudCompatibility(value.doc).readOnly)(this.state.protectedRows??={})[row.recordId]=true;else delete this.state.protectedRows?.[row.recordId];if(cloudCompatibility(value.doc).opaque){acks[row.recordId]={revision:row.revision,hash:await timed('hashMillis',()=>this.codec.hash(value.doc))};this.state.rows[row.recordId]=row;continue;}const retired=value.doc.value.bookIndexRetired===true||row.tombstone&&!value.doc.value.deleted;
     const v=value.doc.value,publicIndex=value.doc.kind==='article'&&publicArticleIndex(v);
     const hash=await timed('hashMillis',()=>this.codec.hash(value.doc));
     if(!retired&&['article','source','rss-state','book','book-reading'].includes(value.doc.kind)&&(!old||old.revision!==row.revision||value.doc.kind!=='article'||publicIndex)){
      // Already-durable public interactions still need replay when an inventory
      // materializes an article. Aggregate only exact authenticated ACK matches:
      // fresh/changed values, tombstones and unknown formats keep the 50-row path.
      if(retained&&!row.tombstone&&!cloudCompatibility(value.doc).readOnly&&old?.revision===row.revision&&old.hash===hash&&(value.doc.kind==='rss-state'||publicIndex))cachedInteractions.push(value.doc);
      else docs.push(value.doc);
     }
     acks[row.recordId]={revision:row.revision,hash};
     if(row.tombstone&&!cloudCompatibility(value.doc).readOnly&&['article','source','rss-state','book','book-reading'].includes(value.doc.kind))retiredIds.add(row.recordId);
    }catch(error){if(String(error).includes(CLOUD_HOST_CAPABILITY_UNAVAILABLE)||String(error).includes('cloud_record_count_limit')||/cloud_sync_deadline_exceeded|cloud_sync_suspended|cloud_operation_superseded|library_epoch_mismatch|账号|client_upgrade_required|commitment|device_attestation/.test(String(error)))throw error;this.decoded.delete(row.recordId);if(String(error).includes('cloud_record_format_depth'))(this.state.quarantinedRows??={})[row.recordId]=true;/* Retain original ciphertext for replay. A poisoned row cannot disable old validated keys. */}finally{key?.fill(0);}
    this.state.rows[row.recordId]=row;
   }
   progress('merging',docs.length);if(docs.length)changed+=await timed('applyMillis',()=>p.apply(docs));await p.current();Object.assign(this.state.records,acks);progress('applied',docs.length);
   // Authenticated tombstones have been applied. Keep CAS revisions/hashes, but
   // do not decrypt and reapply thousands of retired RSS indexes on every run.
   for(const id of retiredIds){delete this.state.rows[id];this.decoded.delete(id);}
  };
  try{
   // Replay encrypted retained rows, including states that preceded public entries.
   const retained=Object.values(this.state.rows);
   // Decode in bounded pages. Fresh/unacknowledged values still merge at most
   // fifty at a time; already-durable public interactions aggregate to 500.
   for(let at=0;at<retained.length;at+=50){await process(retained.slice(at,at+50),true);if(cachedInteractions.length>=500)await applyCachedInteractions();}
   // No GET/cursor advancement or local upload may overtake this replay.
   await applyCachedInteractions(true);
   const startCursor=cursor;
   for(let pages=0;pages<2000;pages++){
    let page:RecordPage;try{page=await p.get(cursor);}catch(e){if(!restarted&&String(e).includes('cloud_record_cursor_invalid')){restarted=true;this.state=this.empty();this.decoded.clear();cursor='0';continue;}throw e;}
    await p.current();if(page.libraryEpoch!==p.epoch)throw Error('library_epoch_mismatch');if(page.formatVersion===0)throw Error('cloud_records_consent_required');
    check(page.formatVersion===1&&Array.isArray(page.items)&&page.items.length<=50&&typeof page.hasMore==='boolean');revision(page.cursor);revision(page.headRevision);check(cmp(page.cursor,cursor)>=0&&cmp(page.headRevision,page.cursor)>=0&&(page.hasMore?(cmp(page.cursor,cursor)>0&&cmp(page.headRevision,page.cursor)>0&&page.items.length>0):page.cursor===page.headRevision));
    let last=cursor;for(const row of page.items){revision(row.revision);check(ID.test(row.recordId)&&typeof row.tombstone==='boolean'&&cmp(row.revision,last)>0&&cmp(row.revision,page.cursor)<=0);last=row.revision;}
    await process(page.items);cursor=page.cursor;this.state.cursor=cursor;await this.save();
    try{const base=BigInt(startCursor);p.pageProgress?.(Number(BigInt(cursor)-base),Number(BigInt(page.headRevision)-base));}catch{}
    if(!page.hasMore)return changed;
   }throw Error('cloud_record_page_limit');
  }catch(error){if(/cloud_sync_suspended|cloud_sync_deadline_exceeded/.test(String(error))&&p.checkpoint)await p.checkpoint(JSON.stringify(this.state));throw error;}finally{anchor.fill(0);}
 }
 async reapply(){await this.p.current();return this.p.apply([...this.decoded.values()].filter(v=>!cloudCompatibility(v.doc).opaque&&v.doc.value.bookIndexRetired!==true&&!(v.row.tombstone&&!v.doc.value.deleted)&&['article','source','rss-state','book','book-reading'].includes(v.doc.kind)).map(v=>v.doc));}
 flush(completedPrivateArticleIds:readonly string[]=[],completedBookIds:readonly string[]=[]){return this.flushRecords(completedPrivateArticleIds,completedBookIds,false);}
 /** Public RSS interactions commit independently of slow private body restore.
  * This lane never publishes private metadata or retires any legacy record. */
 flushInteractions(){return this.flushRecords([],[],true);}
 private async flushRecords(completedPrivateArticleIds:readonly string[],completedBookIds:readonly string[],interactionsOnly:boolean){
  const p=this.p;await p.current();await p.assertUpload();const anchor=await p.key(p.anchorVersion),key=await p.key(p.version);if(!anchor||!key){anchor?.fill(0);key?.fill(0);throw Error('missing_key_version');}
  let written=0;const hashById=new Map<string,string>();let batch:RecordWrite[]=[];
  const flush=async()=>{if(!batch.length)return;await p.current();await p.assertUpload();const response=await p.push(batch);await p.current();check(response.formatVersion===1&&response.items?.length===batch.length);const expected=new Map(batch.map(r=>[r.recordId,r])),seen=new Set<string>();
   for(const row of response.items){revision(row.revision);const item=expected.get(row.recordId);check(item&&!seen.has(row.recordId)&&cmp(row.revision,item!.expectedRevision)>0);seen.add(row.recordId);this.state.records[row.recordId]={revision:row.revision,hash:hashById.get(row.recordId)!};if(item!.tombstone)delete this.state.rows[row.recordId];else this.state.rows[row.recordId]={recordId:row.recordId,revision:row.revision,envelope:item!.envelope,tombstone:item!.tombstone};}for(const item of batch)if(!item.tombstone){const row=this.state.rows[item.recordId];if(row)this.decoded.set(item.recordId,{row,...await this.codec.decode(key,anchor,p.userId,row)});}written+=batch.length;batch=[];await this.save();};
  const add=async(id:string,doc:RecordDocument,tombstone=!!doc.value.deleted,original?:RecordRow)=>{const hash=await this.codec.hash(doc),old=this.state.records[id],basis=this.decoded.get(id)?.doc;if(hasArticleRegisters(doc)||(basis&&cloudCompatibility(basis).readOnly)||(!basis&&this.state.rows[id])){if(hasArticleRegisters(doc))(this.state.protectedRows??={})[id]=true;if(doc.pendingEdit||old?.hash!==hash)(this.state.pendingEdits??={})[id]=true;return;}if(old?.hash===hash&&!original){delete this.state.pendingEdits?.[id];return;}const envelope=original?.envelope??await this.codec.encode(key,p.userId,id,p.version,doc,basis??doc);delete this.state.pendingEdits?.[id];const item={recordId:id,expectedRevision:original?.revision??old?.revision??'0',envelope,tombstone};
   if(batch.length&&(batch.length>=50||utf8Encode(JSON.stringify({formatVersion:1,items:[...batch,item]})).length>1048576))await flush();hashById.set(id,hash);batch.push(item);};
  try{
   const documents=(await p.export()).filter(doc=>!interactionsOnly||doc.kind==='rss-state');for(const deleting of [true,false]){for(const doc of documents)if(!!doc.value.deleted===deleting)await add(await this.codec.id(anchor,p.userId,doc),doc);await flush();}
   if(interactionsOnly){await this.save();return written;}
   // R3/S8: obsolete public indexes become entity tombstones only AFTER new states commit.
   const completed=new Set(completedPrivateArticleIds);
   const interactions=new Map(documents.filter(d=>d.kind==='rss-state').map(d=>[d.value.sourceId+':'+d.value.articleIdHash,d]));
   for(const [id,item]of this.decoded){if(item.row.tombstone)continue;const d=item.doc;if(cloudCompatibility(d).readOnly)continue;
    const replacement=d.kind==='article'?await p.bookReplacement?.(d):undefined;
    if(replacement){const current=async(doc:RecordDocument)=>this.state.records[await this.codec.id(anchor,p.userId,doc)]?.hash===await this.codec.hash(doc);if(await current(replacement.book)&&(!replacement.reading||await current(replacement.reading))&&(replacement.book.value.deleted||completedBookIds.includes(replacement.book.value.bookId))){const clock=Math.max(0,...Object.entries(d.value).filter(([k,v])=>k.endsWith('At')&&typeof v==='number').map(([,v])=>Number(v)));check(clock<Number.MAX_SAFE_INTEGER);await add(id,{kind:'article',value:{...d.value,bookIndexRetired:true,deleted:true,deletedAt:clock+1,updatedAt:clock+1}},true);}continue;}
    const isPublic=d.kind==='article'&&publicArticleIndex(d.value);
    if(isPublic&&isLocalOnlyRssSource(d.value.rssSourceUrl))continue;
    const articleId=isPublic?await tryRssArticleId({link:d.value.url,guid:d.value.guid,title:d.value.title,contentHash:d.value.contentHash},p.crypto.sha256):undefined;if(isPublic&&!articleId)continue;
    const state=isPublic?interactions.get(await rssSourceKey(d.value.rssSourceUrl,p.crypto.sha256)+':'+await p.crypto.sha256(utf8Encode(articleId!))):undefined;
    const saved=state?!!(state.value.favoriteSaved||state.value.watchLaterSaved):!!(d.value.favoriteSaved||d.value.watchLaterSaved);
    if(isPublic&&(!saved||completed.has(d.value.articleId))){
     if((d.value.isRead||d.value.readingProgress||d.value.readingPositionChangedAt||d.value.favoriteChangedAt||d.value.watchLaterChangedAt||d.value.favoriteSaved||d.value.watchLaterSaved)&&(!state||!this.state.records[await this.codec.id(anchor,p.userId,state)]||['readingPositionChangedAt','favoriteChangedAt','watchLaterChangedAt'].some(k=>(state.value[k]??0)<(d.value[k]??0))))continue;
     await add(id,{kind:d.kind,value:{articleId:d.value.articleId,url:d.value.url,rssSourceUrl:d.value.rssSourceUrl,sourceDeviceId:d.value.sourceDeviceId??'',deleted:true,deletedAt:Math.max(1,...Object.entries(d.value).filter(([k,v])=>k.endsWith('At')&&typeof v==='number').map(([,v])=>Number(v)))+1}},true);
    }else if(item.legacy){const newId=await this.codec.id(anchor,p.userId,d);if(this.state.records[newId]){await add(id,d,true,item.row);}}
   }await flush();await this.save();return written;
  }catch(error){if((error as {status?:number})?.status===426||(error as {code?:string})?.code==='cloud_format_upgrade_required'){for(const item of batch)(this.state.pendingEdits??={})[item.recordId]=true;await this.save();}throw error;}finally{anchor.fill(0);key.fill(0);}
 }
}
