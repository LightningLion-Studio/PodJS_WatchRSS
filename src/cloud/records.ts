import {isImportedContentUrl} from '../core/imported-content';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {rssSourceKey,tryRssArticleId,isLocalOnlyRssSource} from './rss-identity';
import type {SnapshotCrypto} from './codec';
import {utf8Encode,utf8Decode,type CloudTrust} from './types';
export type RecordKind='article'|'source'|'rss-state';
export interface RecordDocument {kind:string;value:Record<string,any>}
export interface RecordEnvelope {algorithm:'A256GCM';keyVersion:number;nonceBase64:string;ciphertextBase64:string}
export interface RecordRow {recordId:string;revision:string;envelope:RecordEnvelope;tombstone:boolean}
export interface RecordPage extends CloudTrust {formatVersion:0|1;items:RecordRow[];cursor:string;headRevision:string;hasMore:boolean}
export interface RecordWrite {recordId:string;expectedRevision:string;envelope:RecordEnvelope;tombstone:boolean}
export interface RecordPorts {
 userId:string;epoch:string;anchorVersion:number;version:number;
 key(version:number):Promise<Uint8Array|undefined>;
 crypto:SnapshotCrypto&{hmac(key:Uint8Array,bytes:Uint8Array):Promise<string>};
 readState():Promise<string|undefined>;writeState(value:string):Promise<void>;
 get(after:string):Promise<RecordPage>;push(items:RecordWrite[]):Promise<{formatVersion:1;items:{recordId:string;revision:string}[]}>;
 refreshKeys?():Promise<void>;current():Promise<void>;assertUpload():Promise<void>;
 apply(documents:RecordDocument[]):Promise<number>;export():Promise<RecordDocument[]>;
}
const check=(ok:unknown)=>{if(!ok)throw Error('cloud_record_invalid');};
const ID=/^[a-f0-9]{64}$/;
export function revision(v:string){check(typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&(v.length<19||v<='9223372036854775807'));return v;}
const cmp=(a:string,b:string)=>a.length-b.length||(a===b?0:a<b?-1:1);
export function canonical(value:any):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function validateRecord(doc:RecordDocument){
 check(doc&&typeof doc.kind==='string'&&!!doc.kind&&doc.value&&typeof doc.value==='object'&&!Array.isArray(doc.value));const v=doc.value;
 if(!['article','source','rss-state'].includes(doc.kind))return;
 check(!['contentText','contentHtml','contentTextGzip','contentHtmlGzip','body','chapters'].some(k=>k in v));
 if(doc.kind==='rss-state'){check(Object.keys(v).every(k=>['sourceId','articleIdHash','sourceDeviceId','isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt'].includes(k)));check(typeof v.sourceId==='string'&&v.sourceId.length>0&&ID.test(v.articleIdHash));}else check(typeof v[doc.kind==='article'?'articleId':'url']==='string'&&!!v[doc.kind==='article'?'articleId':'url'].trim());
 for(const [k,value]of Object.entries(v)){if(/(?:At|Bytes|SortOrder)$/.test(k))check(Number.isSafeInteger(value));if(/(?:At|Bytes)$/.test(k))check(Number(value)>=0);if(['isRead','deleted','favoriteSaved','watchLaterSaved','independentSaved','isPinned'].includes(k))check(typeof value==='boolean');}
 if('readingProgress'in v)check(typeof v.readingProgress==='number'&&Number.isFinite(v.readingProgress)&&v.readingProgress>=0&&v.readingProgress<=1);
}
const publicArticleIndex=(v:Record<string,any>)=>/^https?:\/\//.test(v.rssSourceUrl??'')&&!isImportedContentUrl(v.rssSourceUrl)&&!isImportedContentUrl(v.url);
export class CloudRecordCodec {
 constructor(private c:RecordPorts['crypto']){}
 async id(key:Uint8Array,user:string,doc:RecordDocument){validateRecord(doc);const v=doc.value,identity=doc.kind==='rss-state'?v.sourceId+':'+v.articleIdHash:doc.kind==='article'?v.articleId:v.url;const derived=await this.c.hkdf(key,utf8Encode(user),utf8Encode('watchrss/cloud/record-id/v1'));try{return await this.c.hmac(derived,utf8Encode(doc.kind+':'+identity));}finally{derived.fill(0);}}
 async hash(doc:RecordDocument){const value={...doc.value};delete value.sourceDeviceId;if(doc.kind==='source')delete value.createdAt;if('readingProgress'in value)value.readingProgress=Math.floor(value.readingProgress*1e6+.5)/1e6;return this.c.sha256(utf8Encode(canonical({kind:doc.kind,value})));}
 async encode(key:Uint8Array,user:string,id:string,version:number,doc:RecordDocument):Promise<RecordEnvelope>{
  validateRecord(doc);check(ID.test(id)&&Number.isInteger(version)&&version>0);const bytes=utf8Encode(canonical({format:'watchrss-rss-record',version:1,...doc}));check(bytes.length+16<=65536);const derived=await this.c.hkdf(key,utf8Encode(user),utf8Encode('watchrss/cloud/record/v1'));
  try{const out=await this.c.encrypt(derived,utf8Encode(`watchrss-cloud-record-v1:${user}:${id}:${version}`),bytes);return {algorithm:'A256GCM',keyVersion:version,nonceBase64:bytesToBase64(out.nonce),ciphertextBase64:bytesToBase64(out.ciphertext)};}finally{derived.fill(0);bytes.fill(0);}
 }
 async decode(key:Uint8Array,anchor:Uint8Array,user:string,row:RecordRow){
  const e=row.envelope;check(ID.test(row.recordId)&&e?.algorithm==='A256GCM'&&Number.isInteger(e.keyVersion)&&e.keyVersion>0);check(typeof e.ciphertextBase64==='string'&&e.ciphertextBase64.length<=87384&&typeof e.nonceBase64==='string'&&e.nonceBase64.length===16);
  const nonce=base64ToBytes(e.nonceBase64),bytes=base64ToBytes(e.ciphertextBase64);check(nonce.length===12&&bytes.length>=16&&bytes.length<=65536&&bytesToBase64(bytes)===e.ciphertextBase64);
  const derived=await this.c.hkdf(key,utf8Encode(user),utf8Encode('watchrss/cloud/record/v1'));let plain:Uint8Array|undefined;
  try{plain=await this.c.decrypt(derived,utf8Encode(`watchrss-cloud-record-v1:${user}:${row.recordId}:${e.keyVersion}`),nonce,bytes);const raw=JSON.parse(utf8Decode(plain));check(raw.format==='watchrss-rss-record'&&raw.version===1);const doc:RecordDocument={kind:raw.kind,value:raw.value};validateRecord(doc);let legacy=false;
   if(['article','source','rss-state'].includes(doc.kind)&&await this.id(anchor,user,doc)!==row.recordId){check(await this.id(key,user,doc)===row.recordId);legacy=true;}return {doc,legacy};
  }catch{throw Error('cloud_record_invalid');}finally{derived.fill(0);plain?.fill(0);}
 }
}
interface RecordState {epoch:string;cursor:string;records:Record<string,{revision:string;hash:string}>;rows:Record<string,RecordRow>}
/** Disposable encrypted projection, account/epoch scoped by the cache; no plaintext library in it. */
export class WatchCloudRecords {
 private state!:RecordState;private codec:CloudRecordCodec;private decoded=new Map<string,{row:RecordRow;doc:RecordDocument;legacy:boolean}>();
 constructor(private p:RecordPorts){this.codec=new CloudRecordCodec(p.crypto);}
 private empty():RecordState{return {epoch:this.p.epoch,cursor:'0',records:{},rows:{}};}
 private async save(){await this.p.current();await this.p.writeState(JSON.stringify(this.state));}
 async pull(){
  const p=this.p;await p.current();this.state=this.empty();const raw=await p.readState();if(raw)try{const s=JSON.parse(raw);revision(s.cursor);check(s.records&&s.rows&&typeof s.records==='object'&&typeof s.rows==='object'&&!Array.isArray(s.records)&&!Array.isArray(s.rows)&&Object.keys(s.records).length<=50000&&Object.keys(s.rows).length<=50000);
   for(const [id,v]of Object.entries(s.records) as [string,{revision:string;hash:string}][]){check(ID.test(id)&&v&&ID.test(v.hash));revision(v.revision);}
   for(const [id,v]of Object.entries(s.rows) as [string,RecordRow][]){check(ID.test(id)&&v&&v.recordId===id&&v.envelope&&typeof v.tombstone==='boolean');revision(v.revision);}
   if(s.epoch===p.epoch)this.state=s;
  }catch{/* Cache loss requires cursor zero, never a library reset. */}
  let cursor=this.state.cursor,restarted=false,changed=0;const refreshed=new Set<number>();const anchor=await p.key(p.anchorVersion);if(!anchor)throw Error('missing_key_version');
  const process=async(rows:RecordRow[])=>{const docs:RecordDocument[]=[],acks:Record<string,{revision:string;hash:string}>={};
   for(const row of rows){await p.current();const old=this.state.records[row.recordId];if(old&&cmp(old.revision,row.revision)>0)continue;let key:Uint8Array|undefined;
    try{key=await p.key(row.envelope.keyVersion);if(!key&&p.refreshKeys&&!refreshed.has(row.envelope.keyVersion)){refreshed.add(row.envelope.keyVersion);await p.refreshKeys();await p.current();key=await p.key(row.envelope.keyVersion);}if(!key)throw Error('missing_key_version');const value=await this.codec.decode(key,anchor,p.userId,row);check(!value.doc.value.deleted||row.tombstone);this.decoded.set(row.recordId,{row,...value});const retired=row.tombstone&&!value.doc.value.deleted;
     const v=value.doc.value,publicIndex=value.doc.kind==='article'&&publicArticleIndex(v);
     if(!retired&&['article','source','rss-state'].includes(value.doc.kind)&&(!old||old.revision!==row.revision||value.doc.kind!=='article'||publicIndex))docs.push(value.doc);
     acks[row.recordId]={revision:row.revision,hash:await this.codec.hash(value.doc)};
    }catch(error){if(/library_epoch_mismatch|账号|client_upgrade_required|commitment|device_attestation/.test(String(error)))throw error;/* Retain original ciphertext for replay. A poisoned row cannot disable old validated keys. */}finally{key?.fill(0);}
    this.state.rows[row.recordId]=row;
   }
   if(docs.length)changed+=await p.apply(docs);await p.current();Object.assign(this.state.records,acks);
  };
  try{
   // Replay encrypted retained rows, including states that preceded public entries.
   await process(Object.values(this.state.rows));
   for(let pages=0;pages<2000;pages++){
    let page:RecordPage;try{page=await p.get(cursor);}catch(e){if(!restarted&&String(e).includes('cloud_record_cursor_invalid')){restarted=true;this.state=this.empty();this.decoded.clear();cursor='0';continue;}throw e;}
    await p.current();if(page.libraryEpoch!==p.epoch)throw Error('library_epoch_mismatch');if(page.formatVersion===0)throw Error('cloud_records_consent_required');
    check(page.formatVersion===1&&Array.isArray(page.items)&&page.items.length<=50&&typeof page.hasMore==='boolean');revision(page.cursor);revision(page.headRevision);check(cmp(page.cursor,cursor)>=0&&cmp(page.headRevision,page.cursor)>=0&&(page.hasMore?(cmp(page.cursor,cursor)>0&&cmp(page.headRevision,page.cursor)>0&&page.items.length>0):page.cursor===page.headRevision));
    let last=cursor;for(const row of page.items){revision(row.revision);check(ID.test(row.recordId)&&typeof row.tombstone==='boolean'&&cmp(row.revision,last)>0&&cmp(row.revision,page.cursor)<=0);last=row.revision;}
    await process(page.items);cursor=page.cursor;this.state.cursor=cursor;await this.save();if(!page.hasMore)return changed;
   }throw Error('cloud_record_page_limit');
  }finally{anchor.fill(0);}
 }
 async reapply(){await this.p.current();return this.p.apply([...this.decoded.values()].filter(v=>!(v.row.tombstone&&!v.doc.value.deleted)&&['article','source','rss-state'].includes(v.doc.kind)).map(v=>v.doc));}
 async flush(completedPrivateArticleIds:readonly string[]=[]){
  const p=this.p;await p.current();await p.assertUpload();const anchor=await p.key(p.anchorVersion),key=await p.key(p.version);if(!anchor||!key){anchor?.fill(0);key?.fill(0);throw Error('missing_key_version');}
  let written=0;const hashById=new Map<string,string>();let batch:RecordWrite[]=[];
  const flush=async()=>{if(!batch.length)return;await p.current();await p.assertUpload();const response=await p.push(batch);await p.current();check(response.formatVersion===1&&response.items?.length===batch.length);const expected=new Map(batch.map(r=>[r.recordId,r])),seen=new Set<string>();
   for(const row of response.items){revision(row.revision);const item=expected.get(row.recordId);check(item&&!seen.has(row.recordId)&&cmp(row.revision,item!.expectedRevision)>0);seen.add(row.recordId);this.state.records[row.recordId]={revision:row.revision,hash:hashById.get(row.recordId)!};this.state.rows[row.recordId]={recordId:row.recordId,revision:row.revision,envelope:item!.envelope,tombstone:item!.tombstone};}written+=batch.length;batch=[];await this.save();};
  const add=async(id:string,doc:RecordDocument,tombstone=!!doc.value.deleted,original?:RecordRow)=>{const hash=await this.codec.hash(doc),old=this.state.records[id];if(old?.hash===hash&&!original)return;const envelope=original?.envelope??await this.codec.encode(key,p.userId,id,p.version,doc),item={recordId:id,expectedRevision:original?.revision??old?.revision??'0',envelope,tombstone};
   if(batch.length&&(batch.length>=50||utf8Encode(JSON.stringify({formatVersion:1,items:[...batch,item]})).length>1048576))await flush();hashById.set(id,hash);batch.push(item);};
  try{
   const documents=await p.export();for(const deleting of [true,false]){for(const doc of documents)if(!!doc.value.deleted===deleting)await add(await this.codec.id(anchor,p.userId,doc),doc);await flush();}
   // R3/S8: obsolete public indexes become entity tombstones only AFTER new states commit.
   const completed=new Set(completedPrivateArticleIds);
   const interactions=new Map(documents.filter(d=>d.kind==='rss-state').map(d=>[d.value.sourceId+':'+d.value.articleIdHash,d]));
   for(const [id,item]of this.decoded){if(item.row.tombstone)continue;const d=item.doc;
    const isPublic=d.kind==='article'&&publicArticleIndex(d.value);
    if(isPublic&&isLocalOnlyRssSource(d.value.rssSourceUrl))continue;
    const articleId=isPublic?await tryRssArticleId({link:d.value.url,guid:d.value.guid,title:d.value.title,contentHash:d.value.contentHash},p.crypto.sha256):undefined;if(isPublic&&!articleId)continue;
    const state=isPublic?interactions.get(await rssSourceKey(d.value.rssSourceUrl,p.crypto.sha256)+':'+await p.crypto.sha256(utf8Encode(articleId!))):undefined;
    const saved=state?!!(state.value.favoriteSaved||state.value.watchLaterSaved):!!(d.value.favoriteSaved||d.value.watchLaterSaved);
    if(isPublic&&(!saved||completed.has(d.value.articleId))){
     if((d.value.isRead||d.value.readingProgress||d.value.readingPositionChangedAt||d.value.favoriteChangedAt||d.value.watchLaterChangedAt||d.value.favoriteSaved||d.value.watchLaterSaved)&&(!state||!this.state.records[await this.codec.id(anchor,p.userId,state)]||['readingPositionChangedAt','favoriteChangedAt','watchLaterChangedAt'].some(k=>(state.value[k]??0)<(d.value[k]??0))))continue;
     await add(id,{kind:d.kind,value:{articleId:d.value.articleId,url:d.value.url,rssSourceUrl:d.value.rssSourceUrl,sourceDeviceId:d.value.sourceDeviceId??'',deleted:true,deletedAt:Math.max(1,...Object.entries(d.value).filter(([k,v])=>k.endsWith('At')&&typeof v==='number').map(([,v])=>Number(v)))+1}},true);
    }else if(item.legacy){const newId=await this.codec.id(anchor,p.userId,d);if(this.state.records[newId]){await add(id,d,true,item.row);}}
   }await flush();return written;
  }finally{anchor.fill(0);key.fill(0);}
 }
}
