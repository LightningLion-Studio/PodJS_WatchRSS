/** Opt-in isolated integration. Fixture is injected in memory by instrumentation. */
import {createSyncV2Crypto,unhex,hex} from '@podjs/framework/crypto';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {canonical,exact} from '../../../src/sync-v2/protocol';
import {SyncV2Http,parseNetwork} from '../../../src/sync-v2/http';
import {WatchServiceKeyPin} from '../../../src/sync-v2/service-key';
import {WatchSigningKeys} from '../../../src/sync-v2/signing-keys';
import {WatchProjectionStore} from '../../../src/sync-v2/store';
import {ProjectionGate} from '../../../src/sync-v2/gate';
import {projectionSql,localProjectionCipher} from '../../../src/sync-v2/host';
import {WatchCloudIndex} from '../../../src/sync-v2/cloud-index';
import {WatchIndexPublisher} from '../../../src/sync-v2/publisher';
import {bookId as deriveBookId} from '../../../src/books/protocol';
import {sha256Hex} from '@podjs/framework/crypto';
const assert=(v:unknown,code:string)=>{if(!v)throw Error(code);};
(globalThis as any).backgroundHandler=async(ctx:any)=>{
 const f=ctx.payload,host:any=(method:string,args:any)=>ctx.request('cloud.host',{method,args});
 const mark=(phase:string,details:any={})=>host('result',{phase,...details});
 let phase='bootstrap';
 try{
 const crypto=createSyncV2Crypto(host),origin='http://127.0.0.1:18942';
 let losePublish=false,publishCalls=0;
 const transport={async request(r:any){const out=await host('http',{...r,body:r.body?encodeBase64(r.body):null});if(r.url.endsWith('/account/publish')){publishCalls++;if(losePublish&&out.status===200){losePublish=false;throw Error('synthetic_response_lost');}}return {...out,body:decodeBase64(out.body)};}};
 const session=async()=>({accessToken:f.auth.accessToken,legacyDeviceId:f.legacyDeviceId,userId:f.userId,scope:f.scope});
 const bootstrap=async()=>{const r=await transport.request({method:'POST',url:origin+'/functions/v1/cloud/bootstrap',headers:f.headers,body:new Uint8Array([123,125])});assert(r.status===200,'bootstrap_http');const b=parseNetwork(r.body);return {accountId:f.accountId,syncV2:b.syncV2,devices:b.devices};};
 const secure={async get(key:string){return host('secure.get',{key});},async compareAndSet(key:string,expected:string|null,value:string){return (await host('secure.compareAndSet',{key,expected,value})).updated;}};
 const pin=new WatchServiceKeyPin(secure,f.accountId,bootstrap),http=new SyncV2Http(transport,origin,f.scope,session,true,pin);
 const caps=await http.capabilities();assert(caps.receiptKeyId===f.servicePin.receiptKeyId&&caps.receiptSigningPublicKey===f.servicePin.receiptSigningPublicKey,'fixture_pin_mismatch');await mark('c3',{keyId:caps.receiptKeyId});
 phase='signing-keys';const authors=new WatchSigningKeys(http,crypto,unhex(f.crypto.idKeyHex),async()=>(await bootstrap()).devices);
 let window=await http.negotiate([],['note-conflicts.v1']);await authors.refresh(window.windowId);
 const list=await http.json('GET','/devices/signing-keys?windowId='+window.windowId);assert(list.bindings.length===4,'four_bindings');for(const b of list.bindings)authors.get(b.body.deviceId);await mark('c4',{bindings:list.bindings.length});
 phase='store';const db=projectionSql(host),store=new WatchProjectionStore(db,localProjectionCipher(host,'integration-watch'),new ProjectionGate(true),f.scope,'49'.repeat(16),unhex(f.crypto.idKeyHex));await store.initialize();
 const keys={id:unhex(f.crypto.idKeyHex),content:unhex(f.crypto.contentKeyHex),version:f.crypto.wrappingKeyVersion};
 const reader=new WatchCloudIndex(store,http,crypto,keys,async id=>authors.get(id),async(w)=>{const v=await http.json('GET','/checkpoint');exact(v,['version','scope','body','signature']);const c=await pin.checkpoint(crypto,{body:v.body,signature:v.signature},f.scope,Date.now());assert(canonical(c.account)===canonical(w.account)&&c.serverRevision===w.serverRevision,'ref_conflict');});
 phase='read-other';const pull=async()=>{for(let i=0;i<16;i++){try{const w=await http.negotiate([],['note-conflicts.v1']);await authors.refresh(w.windowId);const result=await reader.pull(w);return {window:w,result};}catch(e){if((e as Error).message!=='ref_conflict')throw e;}}throw Error('concurrency_retry_exhausted');};
 const readOther=async()=>{const incoming=await pull(),state=await store.readState();if(!state.cloud?.current)return false;const rows=await store.cloudRows(state.cloud.current.treeRoot,'',64),header=await store.readHeader(state.cloud.current.commitOid);assert(incoming.result.bodyReads===0,'body_read');if(header?.body.authorDeviceId===f.deviceId)return false;assert(rows.length>0,'incoming_empty');await mark('read-other',{rows:rows.length,author:header.body.authorDeviceId,commitOid:state.cloud.current.commitOid,bodyReads:0});return true;};
 let sawOther=await readOther();
 phase='scan';const fingerprint=sha256Hex(new Uint8Array([19,42,58])),bookId=await deriveBookId(fingerprint,async b=>sha256Hex(b)),sourceId='watch-p2-feed',articleHash=sha256Hex(new Uint8Array([42,19]));
 const noteId='watch-p2-integration-note',sourceUrl='https://watch-p2.invalid/feed.xml';
 const documents:any[]=[
 {kind:'book',logicalId:bookId,value:{bookId,fingerprint,title:'Watch synthetic book',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:100,sourceDeviceId:f.deviceId}},
 {kind:'book-reading',logicalId:bookId+':1',value:{bookId,chapterIndex:1,isRead:true,readingProgress:0.25,readingPositionBytes:32,readingPositionContentHash:'synthetic',readingPositionChangedAt:100,sourceDeviceId:f.deviceId}},
 {kind:'source',logicalId:sourceUrl,value:{url:sourceUrl,sourceId,title:'Watch synthetic RSS',updatedAt:100}},
 {kind:'rss-state',logicalId:sourceId+':'+articleHash,value:{sourceId,articleIdHash:articleHash,isRead:true,readingProgress:0.5,readingPositionChangedAt:100}},
 {kind:'note',logicalId:noteId,value:{noteId,folderId:null,title:'Watch synthetic note',markdown:'Synthetic watch note\n',plainText:'Synthetic watch note',contentHash:'synthetic-content',baseContentHash:'synthetic-base',baseMarkdown:'',pinned:false,createdAt:100,updatedAt:100,modifiedBy:f.deviceId,deleted:false,deletedAt:0}},
 ].map(r=>({...r,addedAtMillis:100}));
 await store.beginScan({schema:'v2-rc6c',descriptorPin:'isolated-watch',accountScope:f.accountId,capability:'p2-index'});await store.scanPage({page:async()=>({rows:documents,after:'done',done:true}),changed:async()=>[]});
 phase='publish';const publisher=new WatchIndexPublisher(store,http,crypto,keys);let prepared:any,result:any;
 for(let attempt=0;attempt<16;attempt++){
  const {window:w}=await pull(),own=w.refs.find((r:any)=>r.deviceId===f.deviceId);const pending=(await store.readState()).cloud?.pendingPublish;prepared=pending?{commitOid:pending.commitOid,rows:null,deviceSequence:(await store.readState()).cloud.deviceSequence}:await publisher.prepare(f.deviceId,'fixture',{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'},hex(await crypto.random(16)));losePublish=true;
  try{const one=publisher.flush(),two=publisher.flush();assert(one===two,'flush_not_shared');await Promise.all([one,two]);throw Error('response_loss_not_injected');}catch(e){const code=String((e as Error).message);if(code==='synthetic_response_lost'){result=await publisher.flush();break;}if(code!=='ref_conflict')throw e;await publisher.retryAfterConflict(async()=>{await pull();});await mark('cas-retry',{attempt:attempt+1});}
 }
 assert(result&&result.account.commitOid===prepared.commitOid,'publish_retry_exhausted');const calls=publishCalls;
 await mark('published',{commitOid:prepared.commitOid,rows:prepared.rows,deviceSequence:prepared.deviceSequence,serverRevision:result.serverRevision,publishCalls:calls});
 await pull();const current=await store.readState(),persisted=await store.cloudRows(current.cloud.current.treeRoot,'',64);assert(documents.every(d=>persisted.some((r:any)=>r.meta.kind===d.kind&&r.meta.logicalId===d.logicalId)),'snapshot_incomplete');
 const plaintext=await db.query('SELECT body FROM syncv2_cloud_rows');assert(plaintext.every(r=>!String(r.body).includes('Watch synthetic')),'plaintext_persisted');await mark('snapshot-persisted',{rows:persisted.length,bodyReads:0});
 sawOther=sawOther||await readOther();assert(sawOther,'other_snapshot_missing');await mark('read-other-status',{verified:true});
 await mark('incomplete',{reason:'old-generation-live-check-remains'});return 'failure';
 }catch(e){await mark('failed',{phase,code:String((e as Error)?.message??e).slice(0,100),stack:String((e as Error)?.stack??'').split('\n').slice(1,4).join('\n')});return 'failure';}
};
