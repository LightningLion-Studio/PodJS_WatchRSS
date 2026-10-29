import {CloudRecordCodec,type RecordDocument,type RecordPorts,type RecordRow} from './records';
import {cloudCompatibility} from './compatibility';
import {rssSourceKey,rssArticleId,legacyWebArticleId} from './rss-identity';
import {utf8Encode} from './types';
import {bytesToBase64} from '@podjs/framework/bytes';
export interface ReadingReference {pseudonym:string;sourceKeys:readonly string[];articleIds:readonly string[];articleHashes:readonly string[];urlSha256:string}
/** Read-only audit for an already authorized runtime. No network, SQL, state
 * write, cursor/ACK advancement or key export. Output is counts by pseudonym.
 * A failed/missing key is unknown coverage, never evidence of cloud data loss. */
export async function auditRetainedReading(ports:Pick<RecordPorts,'userId'|'epoch'|'anchorVersion'|'crypto'|'key'|'readState'|'current'>,targets:readonly ReadingReference[]){
 const p=ports;await p.current();const raw=await p.readState(),state=raw?JSON.parse(raw):undefined;
 if(!state||state.epoch!==p.epoch||!state.rows)throw Error('cloud_record_audit_scope_invalid');
 const keys=new Map<number,Uint8Array|undefined>(),derived=new Map<string,Uint8Array>();
 const key=async(v:number)=>{if(!keys.has(v))keys.set(v,await p.key(v));return keys.get(v);};
 const codec=new CloudRecordCodec({...p.crypto,hkdf:async(k,s,i)=>{const id=[k,s,i].map(bytesToBase64).join(':');if(!derived.has(id))derived.set(id,await p.crypto.hkdf(k,s,i));return derived.get(id)!.slice();}});
 const docs:RecordDocument[]=[],sourceAliases=new Map<string,Set<string>>();let decoded=0,failed=0,opaque=0;
 try{
  const anchor=await key(p.anchorVersion);if(!anchor)throw Error('missing_key_version');
  const rows=Object.values(state.rows) as RecordRow[];
  for(let at=0;at<rows.length;at++){
   if(at%50===0)await p.current();const row=rows[at]!,k=await key(row.envelope.keyVersion);
   if(!k){failed++;continue;}
   let doc:RecordDocument;try{doc=(await codec.decode(k,anchor,p.userId,row)).doc;}catch(error){await p.current();failed++;continue;}
   decoded++;if(cloudCompatibility(doc).opaque){opaque++;continue;}if(row.tombstone||doc.value.deleted||doc.value.bookIndexRetired)continue;docs.push(doc);
   if(doc.kind==='source'&&doc.value.sourceId){try{const source=await rssSourceKey(doc.value.url,p.crypto.sha256),aliases=sourceAliases.get(source)??new Set<string>();aliases.add(doc.value.sourceId);sourceAliases.set(source,aliases);}catch{}}
  }
  const cases=targets.map(t=>({pseudonym:t.pseudonym,readingRecords:0,metadataRecords:0,nondefaultReadingRecords:0}));
  for(const doc of docs){
   const v=doc.value;if(doc.kind!=='rss-state'&&doc.kind!=='article')continue;
   let source:string|undefined,urlHash:string|undefined;const ids=new Set<string>(),hashes=new Set<string>();
   if(doc.kind==='rss-state'){source=v.sourceId;hashes.add(v.articleIdHash);}
   else {try{source=await rssSourceKey(v.rssSourceUrl,p.crypto.sha256);urlHash=await p.crypto.sha256(utf8Encode(v.url));ids.add(v.articleId);ids.add(await rssArticleId({link:v.url,guid:v.guid,title:v.title,contentHash:v.contentHash},p.crypto.sha256));ids.add(await legacyWebArticleId(v.url,p.crypto.sha256));for(const id of ids)hashes.add(await p.crypto.sha256(utf8Encode(id)));}catch{continue;}}
   for(let i=0;i<targets.length;i++){const t=targets[i]!;
    if(!t.sourceKeys.some(s=>source===s||sourceAliases.get(s)?.has(source!)))continue;
    if(urlHash!==t.urlSha256&&!t.articleIds.some(id=>ids.has(id))&&!t.articleHashes.some(h=>hashes.has(h)))continue;
    const result=cases[i]!;if(doc.kind==='article')result.metadataRecords++;else result.readingRecords++;
    if(v.isRead||v.readingProgress||v.readingPositionChangedAt)result.nondefaultReadingRecords++;
   }
  }
  return {readOnly:true,cursor:state.cursor,retainedRows:rows.length,decoded,failed,opaque,completeCoverage:failed===0,cases};
 }finally{for(const k of [...keys.values(),...derived.values()])k?.fill(0);}
}
