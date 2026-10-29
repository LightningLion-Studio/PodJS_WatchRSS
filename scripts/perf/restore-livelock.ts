import {JsonDeltaJournal} from '@podjs/framework/json-delta-journal';
/** Offline only: real AEAD/record coordinator, synthetic encrypted records,
 * recorded-call latency model. No account, device, network, or production DB. */
import {createHmac} from 'node:crypto';
import {mkdirSync,symlinkSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {crypto as c,key,enabled} from '../../tests/cloud/k2-crypto';
import {CloudRecordCodec,WatchCloudRecords,canonical,type RecordDocument,type RecordPorts} from '../../src/cloud/records';
import {WatchCloudCache} from '../../src/cloud/cache';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),bytes=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
const rc={...c,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')},codec=new CloudRecordCodec(rc);
const user='offline-user',epoch='offline-epoch',backend='https://backend.invalid';
const root=resolve('.codex-tmp/restorefix-livelock');mkdirSync(root,{recursive:true});
async function baseline(label:string){
 const dir=join(root,'before-'+label,'src/cloud');mkdirSync(dir,{recursive:true});
 for(const name of ['books','core','reader','sync','account','logs']){const path=join(root,'before-'+label,'src',name);if(!existsSync(path))symlinkSync(resolve('src',name),path,'dir');}
 const modules=await Array.fromAsync(new Bun.Glob('*.ts').scan('src/cloud'));
 for(const name of modules){const path=join(dir,name);if(['records.ts','cache.ts','host-ports.ts'].includes(name)){const r=Bun.spawnSync(['git','show','07d8bb4e:src/cloud/'+name]);if(r.exitCode!==0)throw Error('baseline_missing');writeFileSync(path,r.stdout);}else if(!existsSync(path))symlinkSync(resolve('src/cloud',name),path);}
 const nm=join(root,'before-'+label,'node_modules');if(!existsSync(nm))symlinkSync(resolve('node_modules'),nm,'dir');
 return {Records:(await import(join(dir,'records.ts'))).WatchCloudRecords,Cache:(await import(join(dir,'cache.ts'))).WatchCloudCache,ports:(await import(join(dir,'host-ports.ts'))).createCloudHostPorts};
}
async function fixture(padding:number,groups=72){
 const docs:RecordDocument[]=Array.from({length:3351},(_,n)=>({kind:'article',value:{articleId:(n+1).toString(16).padStart(64,'0'),url:'https://offline.invalid/'+n,title:'x'.repeat(padding),updatedAt:1,deleted:false}}));
 const state:any={epoch,cursor:'57303',records:{},rows:{},projections:[]};
 const entries:any[]=[];
 for(let n=0;n<docs.length;n++){const d=docs[n],id=await codec.id(key,user,d),row={recordId:id,revision:String(n+1),envelope:await codec.encode(key,user,id,1,d),tombstone:false};state.rows[id]=row;state.records[id]={revision:row.revision,hash:await codec.hash(d)};entries.push({id,text:canonical({format:'watchrss-rss-record',version:1,kind:d.kind,value:d.value}),legacy:false});}
 for(let n=3351;n<3928;n++){const d:RecordDocument={kind:'rss-state',value:{sourceId:'source',articleIdHash:(n+1).toString(16).padStart(64,'0'),isRead:true,readingProgress:.5,readingPositionChangedAt:100+n}};docs.push(d);const id=await codec.id(key,user,d);state.records[id]={revision:'1',hash:await codec.hash(d)};}
 const derived=await c.hkdf(key,utf8Encode(user),utf8Encode('watchrss/local-record-projection/v1'));
 for(let index=0;index<groups;index++){const at=Math.floor(index*entries.length/groups),end=Math.floor((index+1)*entries.length/groups),group=entries.slice(at,end),ids=group.map(e=>e.id),binding=await c.sha256(utf8Encode(JSON.stringify(ids.map(id=>[state.rows[id],state.records[id]])))),sealed=await c.encrypt(derived,utf8Encode(JSON.stringify(['watchrss/local-record-projection/v1',user,epoch,1,binding])),utf8Encode(JSON.stringify({version:1,entries:group})));state.projections.push({ids,keyVersion:1,binding,nonceBase64:b64(sealed.nonce),ciphertextBase64:b64(sealed.ciphertext)});}
 derived.fill(0);return {docs,state,text:JSON.stringify(state)};
}
export async function reproduce(groups=72){
 const empty=await fixture(0,groups),pad=Math.max(0,Math.round((14869335-Buffer.byteLength(empty.text))/(3351*8/3)/3)*3),f=await fixture(pad,groups),old=await baseline(String(groups));
 const cacheRoot='watch-cloud-cache/'+(await c.sha256(utf8Encode(JSON.stringify([backend,user])))).slice(0,32);
 const initial=new Map<string,Uint8Array>([[cacheRoot+'/records.json',utf8Encode(f.text)]]);
 // Existing unrelated snapshot projections must not be decoded/read by records startup.
 for(let n=0;n<606;n++)initial.set(cacheRoot+'/restore-v1/'+n+'.bin',new Uint8Array(1024));
 const latency:Record<string,number>={'file.read':280,'file.write':300,'file.stat':20,'file.hash':50,'file.createTemp':50,'file.delete':50,'file.commit':50,'crypto.largeAesGcmDecrypt':150,'crypto.largeAesGcmEncrypt':150,'crypto.aesGcmDecrypt':150,'crypto.aesGcmEncrypt':150,'crypto.hash':50,'log.append':300,'crypto.hkdfSha256':50};
 const outputs:any={fixture:{retained:3351,recordProjectionGroups:f.state.projections.length,snapshotProjectionFiles:606,existingRestoreUnits:392,existingWork:813,exports:3928,ackCount:Object.keys(f.state.records).length,cacheBytes:Buffer.byteLength(f.text),titlePadding:pad},model:{source:'1174 reads455/127.186s; selected fixed per-call costs, not device timings',callMillis:latency,hmacMillis:60,softMillis:290000,hardMillis:300000},before:[],after:[]};
 for(const mode of ['before','after'] as const){
  const files=new Map([...initial].map(([p,b])=>[p,b.slice()])),sql=new Set<string>(),units=new Set<string>();let temp=0,progress=813;
  for(let round=1;round<=(mode==='before'?3:12);round++){
   let lastLog=-Infinity,hmacCalls=0;let elapsed=0,cleanup=0,phase='startup',lastEnd=0,rowsApplied=0;const counts:Record<string,number>={},work:any[]=[];const wall=performance.now(),startedUnits=progress,startedRows=sql.size;
   const tick=(ms:number)=>{elapsed+=ms;if(elapsed>300000)throw Error('native_hard_deadline');};
   const host=async<T>(method:string,a:any):Promise<T>=>{counts[method]=(counts[method]??0)+1;tick(latency[method]??0);let value:any;
    const put=async(data:Uint8Array)=>{const path='cloud-crypto/.pod-write-'+(++temp)+'.part';files.set(path,data);return {path,size:data.length,sha256:await c.sha256(data)};};
    switch(method){
     case 'file.stat':value={exists:files.has(a.path),file:files.has(a.path),size:files.get(a.path)?.length??0};break;
     case 'file.read':{if(a.path.includes('/restore-v1/'))throw Error('irrelevant_projection_read');const data=files.get(a.path)!;value={dataBase64:b64(data.slice(a.offset,a.offset+a.maxBytes)),offset:a.offset,size:data.length};break;}
     case 'file.createTemp':value={path:a.directory+'/.pod-write-'+(++temp)+'.part'};files.set(value.path,new Uint8Array());break;
     case 'file.write':{const current=a.append?files.get(a.path)!:new Uint8Array();if(a.append&&a.expectedOffset!==current.length)throw Error('offset');const part=bytes(a.dataBase64),next=new Uint8Array(current.length+part.length);next.set(current);next.set(part,current.length);files.set(a.path,next);value={size:next.length};break;}
     case 'file.hash':value={sha256:await c.sha256(files.get(a.path)!)};break;
     case 'file.commit':{const data=files.get(a.path)!;if(data.length!==a.expectedSize||await c.sha256(data)!==a.expectedSha256)throw Error('invalid_commit');files.set(a.target,data.slice());files.delete(a.path);value={};break;}
     case 'file.delete':files.delete(a.path);value={};break;
     case 'crypto.random':value={bytesBase64:b64(await c.random(a.bytes))};break;
     case 'crypto.hash':value={digestBase64:Buffer.from(await c.sha256(bytes(a.dataBase64)),'hex').toString('base64')};break;
     case 'crypto.hkdfSha256':value={keyBase64:b64(await c.hkdf(bytes(a.inputBase64),bytes(a.saltBase64),bytes(a.infoBase64)))};break;
     case 'crypto.aesGcmDecrypt':value={dataBase64:b64(await c.decrypt(bytes(a.keyBase64),bytes(a.aadBase64),bytes(a.nonceBase64),bytes(a.ciphertextBase64)))};break;
     case 'crypto.aesGcmEncrypt':{const sealed=await c.encrypt(bytes(a.keyBase64),bytes(a.aadBase64),bytes(a.dataBase64));value={nonceBase64:b64(sealed.nonce),ciphertextBase64:b64(sealed.ciphertext)};break;}
     case 'crypto.largeAesGcmDecrypt':value=await put(await c.decrypt(bytes(a.keyBase64),bytes(a.aadBase64),bytes(a.nonceBase64),files.get(a.inputPath)!));break;
     case 'crypto.largeAesGcmEncrypt':{const sealed=await c.encrypt(bytes(a.keyBase64),bytes(a.aadBase64),files.get(a.inputPath)!);value={...await put(sealed.ciphertext),nonceBase64:b64(sealed.nonce)};break;}
     default:throw Error('unexpected '+method);
    }return value;
   };
   const ports=(mode==='before'?old.ports:createCloudHostPorts)(host,enabled),cache=new (mode==='before'?old.Cache:WatchCloudCache)(ports.files,ports.crypto.sha256,enabled,backend);
   const current=async()=>{if(elapsed>=290000)throw Error('cloud_sync_deadline_exceeded');};
   const p:RecordPorts={userId:user,epoch,anchorVersion:1,version:1,crypto:{...ports.crypto,hmac:async(k,b)=>{hmacCalls++;tick(60);return rc.hmac(k,b);}},key:async()=>key.slice(),current,assertUpload:current,check:()=>{if(elapsed>=290000)throw Error('cloud_sync_deadline_exceeded');},now:()=>elapsed,remainingMillis:()=>290000-elapsed,
    readState:()=>cache.records(user),writeState:v=>cache.storeRecords(user,v),checkpoint:async v=>{const start=elapsed;try{await cache.storeRecords(user,v);}finally{cleanup+=elapsed-start;}},readPreparation:()=>cache.recordPreparation(user),writePreparation:v=>cache.storeRecordPreparation(user,v),
    hydrate:async()=>{},apply:async docs=>{for(const d of docs){const id=d.value.articleId;if(id){if(sql.has(id))throw Error('completed_SQL_unit_replayed');sql.add(id);rowsApplied++;}tick(1);}return docs.length;},reapply:async()=>0,export:async()=>{phase='export';return f.docs;},get:async after=>({formatVersion:1,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],items:[],cursor:after,headRevision:after,hasMore:false}),push:async()=>{throw Error('unchanged_ACK_must_not_push');},work:m=>{work.push(m);if(mode==='after'&&elapsed-lastLog>=5000){lastLog=elapsed;counts['log.append']=(counts['log.append']??0)+1;tick(300);}if(m.stage==='checkpoint'&&m.outcome==='complete')lastEnd=elapsed;},bookReplacement:async()=>undefined};
   if(mode==='after'){p.lazyProjections=true;p.readStateObject=()=>cache.recordsValue(user);p.writeStateObject=async value=>{await cache.storeRecordsValue(user,value);};}
   const Records=mode==='before'?old.Records:WatchCloudRecords,r=new Records(p);let complete=false,error='',startupDecryptions:number|undefined;
   if(mode==='after')r.trackProgress(async(unit:string)=>{if(!units.has(unit)){units.add(unit);progress++;tick(20);}});
   try{await r.pull();startupDecryptions=(counts['crypto.aesGcmDecrypt']??0)+(counts['crypto.largeAesGcmDecrypt']??0);phase='replay';await r.reapply('restore:1174',async(unit:string)=>{if(!units.has(unit)){units.add(unit);progress++;tick(20);}});phase='flush';await r.flush();complete=true;}catch(e){error=String(e);}
   if(mode==='after'){counts['log.append']=(counts['log.append']??0)+1;tick(300);}
   const receiptText=utf8Decode(files.get(cacheRoot+'/record-preparation.json.delta')??new Uint8Array()),prepared=new Set(receiptText.split('\n').filter(Boolean).flatMap(line=>JSON.parse(line).edits.filter((e:any)=>e.field==='receipts'&&!e.remove).map((e:any)=>e.key))).size;
   const entry={round,exitCheckpointStageMillis:Math.max(0,...work.filter(m=>m.stage==='checkpoint-skip'&&m.outcome!=='started').map(m=>m.durationMillis)),startupDecryptions,hmacCalls,preparedReceipts:prepared,modeledMillis:elapsed,wallMillis:+(performance.now()-wall).toFixed(2),complete,error,phase,newReplayRows:sql.size-startedRows,newUnits:progress-startedUnits,completedRows:sql.size,work:progress,cleanupMillis:cleanup,lastCheckpointAtMillis:lastEnd,counts,workEvents:work.length};outputs[mode].push(entry);console.info('restore-livelock-round',JSON.stringify({mode,...entry}));if(complete)break;
   if(mode==='after'&&sql.size===startedRows&&phase==='replay')throw Error('no_durable_progress');
  }
 }
 outputs.converged=outputs.after.at(-1).complete;outputs.noProgressBefore=outputs.before.every((v:any)=>v.newUnits===0&&v.newReplayRows===0);if(!outputs.converged||!outputs.noProgressBefore)throw Error('convergence_assertion');
 await Bun.write(join(root,groups===72?'scale-result.json':'scale-'+groups+'-result.json'),JSON.stringify(outputs,null,2)+'\n');return outputs;
}
async function inspect(base:string,preparation=false){
 let ignoredTailBytes=0;const journal=new JsonDeltaJournal({read:async path=>{if(path!==base&&path!==base+'.delta')throw Error('unexpected inspection path');const f=Bun.file(path);if(!await f.exists())return;if(f.size>64*1024*1024)throw Error('inspection input limit');return f.text();},fingerprint:async(_path,raw)=>c.sha256(utf8Encode(raw)),replace:async(path,text)=>{ignoredTailBytes=Math.max(0,(await Bun.file(path).exists()?Bun.file(path).size:0)-Buffer.byteLength(text));},append:async()=>{throw Error('read-only inspection');}},base,preparation?['receipts']:['records','rows','projections','protectedRows','protectedVersions','pendingEdits','quarantinedRows','replayDone'],v=>preparation?{scope:v.scope,receipts:v.receipts??Object.fromEntries(v.entries??[])}:{...v,projections:Array.isArray(v.projections)?Object.fromEntries(v.projections.map((g:any)=>[g.binding,g])):v.projections??{}});
 const value=await journal.load(),count=(v:unknown)=>v&&typeof v==='object'?Object.keys(v).length:0;
 console.info(JSON.stringify({readOnly:true,ignoredTailBytes,retained:count(value.rows),ackHints:count(value.records),projectionGroups:count(value.projections),preparationReceipts:count(value.receipts),replayHints:count(value.replayDone),replayHmacVerified:false,sqlApplicationVerified:false}));
}
if(import.meta.main){const file=Bun.argv.find(v=>v.startsWith('--inspect-base='))?.slice('--inspect-base='.length);if(file)await inspect(file,Bun.argv.includes('--preparation'));else await reproduce(Number(Bun.argv.find(v=>v.startsWith('--groups='))?.split('=')[1]??72));}
