import {readFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {buildBackground} from '../../../../PodJS/podjs-watch/packages/cli/src/background-build';
import {javaHostMethods} from '../../../../PodJS/podjs-watch/packages/cli/src/host-method-contract';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {writeWrss} from '../../src/cloud/wrss';
import {MANUAL_INTENT_KEY,manualEpochKey} from '../../src/cloud/manual-handoff';
import {cloudAccountIdentity} from '../../src/cloud/identity';
import {contentFixture} from './content-fixture';
import {createHmac,generateKeyPairSync} from 'node:crypto';
import {commit,attest} from '../../src/cloud/v2';
import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import handler from '../../src/cloud/background';
import {article} from './library-fixture';
import {crypto,key} from './k2-crypto';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {initializeSchema} from '../../src/core/schema';
import type {BackgroundContext} from '@podjs/framework/background-handler';
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
test('release and debug workers require explicit persisted consent, then skip unbound accounts without network',async()=>{
 for(const debug of [false,true])for(const consent of [false,true]){
  const calls:string[]=[];
  const context:BackgroundContext={appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:Date.now()+300000,payload:null,isCancelled:()=>false,request:async(m,a:any)=>{
   if(m==='kv.get'){expect(a.key).toBe('watchrss.onboarding');calls.push('consent');return {exists:consent,value:{oobeSeenVersion:3,privacyPolicyAgreedVersion:1}};}
   expect(m).toBe('cloud.host');calls.push(a.method);if(a.method==='app.buildInfo')return {debugBuild:debug};if(a.method==='secure.get')return {exists:false};throw Error('unexpected '+a.method);
  }};
  expect(await handler(context)).toBe('success');expect(calls).toEqual(consent?['app.buildInfo','consent','secure.get']:['app.buildInfo','consent']);
 }
});
test('automatic and manual headless handlers use actual SQLite/codec/coordinator with durable progress and no UI or real HTTP',async()=>{
 const stackLimit=Error.stackTraceLimit;Error.stackTraceLimit=100;
 const output=mkdtempSync(join(tmpdir(),'wrss-headless-contract-'));
 const worker=readFileSync(resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/src/bytes.ts'))),'../../../platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWorker.java'),'utf8'),methods=javaHostMethods(worker);
 const artifact=(await buildBackground({'watchrss-cloud-sync':resolve(import.meta.dir,'../../src/cloud/background.ts')},output))['watchrss-cloud-sync']!;
 const source=readFileSync(join(output,artifact.file),'utf8');
 const headless=async(context:BackgroundContext)=>{const realm:Record<string,any>={};runInNewContext(source,realm);expect(realm.pod).toBeUndefined();expect(realm.frame).toBeUndefined();expect(realm.setTimeout).toBeUndefined();const result=await realm.backgroundHandler(context);expect(realm.__podYieldCodecTurn).toBeUndefined();return result;};
 try{for(const entry of ['automatic','manual','periodic-with-grant','manual-manifest','manual-manifest-metadata','manual-manifest-denied','manual-records-denied']){
 const fixtureSpki=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64');
 const manual=entry!=='automatic',withManifest=entry.startsWith('manual-manifest');let denyYield=entry==='manual-manifest-denied',denyRecords=entry==='manual-records-denied';let acknowledgements=0;const logs:string[]=[],yieldStacks:string[]=[];
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const secure=new Map<string,string>(),files=new Map<string,Uint8Array>();let id=0,reserved:any,leased=false;const calls:string[]=[];
 const account={userId:'user',watchDeviceToken:'fixture-token',backendBaseUrl:'https://backend.invalid',tokenExpiresAtMillis:9e15,watchRefreshToken:'',entitlement:{plan:'member',active:true},telemetryConfig:{}};
 if(manual)secure.set(MANUAL_INTENT_KEY,JSON.stringify({version:1,token:'manual_fixture',scope:cloudAccountIdentity(account),mode:'recent128',createdAt:1}));
 const epoch='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff';if(manual)secure.set(manualEpochKey(account),epoch);const v2={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
 secure.set('watchrss.cloud.keys.'+await crypto.sha256(utf8Encode(JSON.stringify(['https://backend.invalid','user'])))+'.'+epoch+'.1',b64(key));
 secure.set('state_json',JSON.stringify(account));secure.set('watchrss.cloud.keys.'+await crypto.sha256(utf8Encode('user')),JSON.stringify({1:b64(key)}));
 const resultFile=async(data:Uint8Array,directory='cloud-crypto')=>{const path=`${directory}/.pod-write-${++id}.part`;files.set(path,data);return {path,size:data.length,sha256:await crypto.sha256(data)};};
 const original=article({articleId:await crypto.sha256(utf8Encode('https://article.invalid/a')),url:'https://article.invalid/a',title:'Article',contentHtml:null,contentText:'Private body',contentHash:'fixture-original',readingProgress:0,readingPositionChangedAt:1}),stem='bodies/'+await crypto.sha256(utf8Encode(original.articleId)),restoreRows=entry==='manual-manifest-metadata'?[{...original,contentText:undefined,contentHtml:undefined,contentTextEntry:stem+'.txt',contentHtmlEntry:null}]:[];
 const remote=withManifest?await new WatchCloudCodec(crypto,{require(){}}).create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'headless-remote',createdAtMillis:1,parentHeads:{},observedHeads:{},settings:{fixturePadding:'x'.repeat(280000)},objects:[{name:'private-library.wrss',compress:false,bytes:writeWrss(new Map([['manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3}))],['articles.json',utf8Encode(JSON.stringify(restoreRows))],[stem+'.txt',utf8Encode(original.contentText)]]))}]}):undefined;
 const remoteHash=remote?await crypto.sha256(remote.encryptedManifest):'';const remoteHead=remote?{id:remote.manifest.snapshotId,sourceDeviceId:'phone',deviceSequence:1,keyVersion:1,manifestSha256:remoteHash,manifestSizeBytes:remote.encryptedManifest.length,parentHeads:{},observedHeads:{}}:undefined;
 const request=async(method:string,a:any):Promise<any>=>{
  calls.push(method);expect(methods.has(method)).toBe(true);expect(JSON.stringify(a).length).toBeLessThan(1024*1024);
  if(denyYield&&method==='runtime.delay'||denyRecords&&method==='http.download'&&a.url.includes('/records?'))throw Error('permission_denied');
  switch(method){
   case 'app.buildInfo':return {debugBuild:false};
   case 'runtime.delay':expect(a).toEqual({milliseconds:1});yieldStacks.push(new Error().stack??'');await new Promise(resolve=>setTimeout(resolve,1));return null;
   case 'log.append':logs.push(a.text);return {};
   case 'cloud.acquire':expect(leased).toBe(false);leased=true;return {acquired:true};
   case 'cloud.release':leased=false;return {};
   case 'secure.acquire':expect(a.key).toBe('watchrss.account.session.v1');return {acquired:true};
   case 'secure.release':expect(a.key).toBe('watchrss.account.session.v1');return {};
   case 'discovery.networkSnapshot':return {active:true,validated:true,wifi:true,metered:false};
   case 'secure.get':return {exists:secure.has(a.key),value:secure.get(a.key)};
   case 'secure.set':secure.set(a.key,a.value);return {};
   case 'secure.compareAndSet':if((secure.get(a.key)??null)!==a.expected)return {updated:false};if(a.value===null)secure.delete(a.key);else secure.set(a.key,a.value);return {updated:true};
   case 'secure.update':if(a.expected)for(const [k,v]of Object.entries(a.expected))if((secure.get(k)??null)!==v)return {updated:false};for(const [k,v] of Object.entries(a.values)){if(v===null)secure.delete(k);else secure.set(k,String(v));}return {updated:true};
   case 'file.list':return {entries:[]};
   case 'secure.delete':secure.delete(a.key);return {};
   case 'file.createTemp':return resultFile(new Uint8Array(),a.directory);
   case 'file.write':{const old=a.append?files.get(a.path)!:new Uint8Array(),part=unb64(a.dataBase64);if(a.append)expect(a.expectedOffset).toBe(old.length);const out=new Uint8Array(old.length+part.length);out.set(old);out.set(part,old.length);files.set(a.path,out);return {size:out.length};}
   case 'file.read':{const b=files.get(a.path)!;return {size:b.length,offset:a.offset,dataBase64:b64(b.slice(a.offset,a.offset+a.maxBytes))};}
   case 'file.delete':files.delete(a.path);return {};
   case 'file.stat':return {exists:files.has(a.path),file:files.has(a.path),size:files.get(a.path)?.length??0};
   case 'file.hash':return {size:files.get(a.path)!.length,sha256:await crypto.sha256(files.get(a.path)!)};
   case 'file.commit':{const bytes=files.get(a.path)!;expect(bytes.length).toBe(a.expectedSize);expect(await crypto.sha256(bytes)).toBe(a.expectedSha256);files.set(a.target,bytes);files.delete(a.path);return {path:a.target,size:bytes.length,sha256:a.expectedSha256,reused:false};}
   case 'uri.parse':{const u=new URL(a.value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};}
   case 'file.htmlText':return resultFile(utf8Encode(utf8Decode(files.get(a.path)!).replace(/<[^>]*>/g,'')));
   case 'file.gzip':return resultFile(await crypto.gzip(files.get(a.path)!));
   case 'file.gunzip':return resultFile(await crypto.gunzip(files.get(a.path)!,a.maxOutputBytes));
   case 'crypto.random':return {bytesBase64:b64(await crypto.random(a.bytes))};
   case 'crypto.hmacSha256':return {digestBase64:createHmac('sha256',unb64(a.keyBase64)).update(unb64(a.dataBase64)).digest('base64')};
   case 'crypto.hash':return {digestBase64:Buffer.from(await crypto.sha256(unb64(a.dataBase64)),'hex').toString('base64')};
   case 'crypto.ecdhPublicKey':return {publicKeySpki:fixtureSpki};
   case 'crypto.hkdfSha256':return {keyBase64:b64(await crypto.hkdf(unb64(a.inputBase64),unb64(a.saltBase64),unb64(a.infoBase64)))};
   case 'crypto.aesGcmEncrypt':{const sealed=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.dataBase64));return {nonceBase64:b64(sealed.nonce),ciphertextBase64:b64(sealed.ciphertext)};}
   case 'crypto.aesGcmDecrypt':return {dataBase64:b64(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),unb64(a.ciphertextBase64)))};
   case 'crypto.largeAesGcmEncrypt':{const sealed=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),files.get(a.inputPath)!);return {...await resultFile(sealed.ciphertext),nonceBase64:b64(sealed.nonce)};}
   case 'crypto.largeAesGcmDecrypt':return resultFile(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),files.get(a.inputPath)!));
   case 'sql.query':return sql.query(a.sql).all(...a.params);
   case 'sql.execute':sql.query(a.sql).run(...a.params);return null;
   case 'sql.transaction':return sql.transaction(()=>{const changes=a.statements.map((s:any)=>{sql.query(s.sql).run(...(s.params??[]));return (sql.query('SELECT changes() AS n').get() as any).n;});return a.reportChanges?changes:null;})();
   case 'http.download':{
    const j=a.bodyPath?JSON.parse(utf8Decode(files.get(a.bodyPath)!)):{};let response:any={};if(a.url.startsWith('https://objects.invalid/')){const hash=a.url.split('/').at(-1),body=hash===remoteHash?remote!.encryptedManifest:remote!.newChunks.get(hash)!;expect(body).toBeDefined();files.set(a.path,body.slice());return {path:a.path,size:body.length,status:200,headers:{}};}expect(a.url.startsWith('https://backend.invalid/')).toBe(true);expect(a.headers.authorization).toBe('Bearer fixture-token');
    if(a.url.endsWith('/bootstrap'))response={...contentFixture,member:{plan:'member',active:true,readable:true,writable:true,quotaBytes:1e9},libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[{keyVersion:1,commitment:await commit(v2,key,'user',epoch,1),rotationProof:null}],devices:[{deviceId:(sql.query('SELECT device_id FROM sync_local_identity').get() as any).device_id,publicKeySpki:fixtureSpki,attestationKeyVersion:1,attestation:await attest(v2,key,'user',epoch,(sql.query('SELECT device_id FROM sync_local_identity').get() as any).device_id,fixtureSpki)}],keyEnvelopes:[]};
    else if(a.url.includes('/records?'))response={...contentFixture,formatVersion:1,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[{keyVersion:1,commitment:await commit(v2,key,'user',epoch,1),rotationProof:null}],items:[],cursor:'0',headRevision:'0',hasMore:false};
    else if(a.url.endsWith('/records'))response={formatVersion:1,items:j.items.map((v:any,i:number)=>({recordId:v.recordId,revision:String(i+1)}))};
    else if(a.url.endsWith('/heads'))response={...contentFixture,heads:remoteHead?[remoteHead]:[]};
    else if(a.url.endsWith('/snapshots/headless-remote'))response={snapshot:{manifestSignedUrl:'https://objects.invalid/'+remoteHash},chunks:remote!.manifest.objects.flatMap(o=>o.chunks).map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes,signedUrl:'https://objects.invalid/'+c.ciphertextSha256}))};
    else if(a.url.endsWith('/ack')){acknowledgements++;response={};}
    else if(a.url.endsWith('/reserve')){reserved=j;response={snapshotId:j.snapshotId,reservedBytes:0,missingObjects:[]};}
    else if(a.url.endsWith('/complete'))expect(j.snapshotId).toBe(reserved.snapshotId);
    files.set(a.path,utf8Encode(JSON.stringify(response)));return {path:a.path,size:files.get(a.path)!.length,status:200,headers:{}};
   }
   default:throw Error('Unexpected headless host call: '+method);
  }
 };
 try{
  await initializeSchema({query:async (q,p=[])=>sql.query(q).all(...p) as Record<string,unknown>[],transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]));})();}},{seedBuiltinChannels:false});
  sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','Private',1,1)");
  sql.exec("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'Article','Private body','https://article.invalid/a','a',1)");
  const context:BackgroundContext={appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:Date.now()+300000,payload:entry==='manual'||withManifest?{manual:true,token:'manual_fixture'}:null,isCancelled:()=>false,request:async(m,a:any)=>{if(m==='kv.get')return {exists:true,value:a.key==='watchrss.onboarding'?{oobeSeenVersion:3,privacyPolicyAgreedVersion:1}:JSON.stringify({progress:.5,offset:3,updatedAt:7})};expect(m).toBe('cloud.host');return request(a.method,a.args);}};
  if(denyYield||denyRecords){
   const deniedMethod=denyYield?'runtime.delay':'http.download';
   expect(await headless(context)).toBe('failure');expect(leased).toBe(false);expect(secure.has(MANUAL_INTENT_KEY)).toBe(true);expect(reserved).toBeUndefined();
   const diagnostics=logs.join('').trim().split('\n').map(line=>JSON.parse(line.slice(line.indexOf('{'))));
   expect(diagnostics.some(d=>d.event==='format-sync'&&d.outcome==='failed'&&d.category==='runtime'&&d.code==='cloud_host_capability_unavailable'&&d.method===deniedMethod)).toBe(true);
   if(denyRecords)expect(diagnostics.some(d=>d.event==='records-failed'&&d.code==='cloud_host_capability_unavailable'&&d.method===deniedMethod)).toBe(true);
   const grant=JSON.parse(secure.get(MANUAL_INTENT_KEY)!);expect(grant.mode).toBe('recent128');expect(grant.token).toBe('manual_fixture');denyYield=false;denyRecords=false;
  }
  expect(await headless(context),entry+' '+logs.join('')).toBe('success');
  if(withManifest){expect(calls).toContain('crypto.largeAesGcmDecrypt');expect(yieldStacks.some(s=>s.includes('equalBytesAsync'))).toBe(true);expect(yieldStacks.some(s=>s.includes('parseRawJsonAsync'))).toBe(true);expect(acknowledgements).toBe(1);}
  if(entry==='manual-manifest-metadata'){const diagnostics=logs.join('');expect(diagnostics).toContain('\"stage\":\"cloudMetadata\"');expect(diagnostics).toContain('\"stage\":\"cloudSources\"');}
  expect((sql.query('SELECT progress FROM article_reading_state WHERE article_id=1').get() as any).progress).toBe(.5);expect(leased).toBe(false);expect(reserved.deviceSequence).toBe(1);expect(reserved.chunks).toHaveLength(1);expect(sql.query('SELECT device_id FROM sync_local_identity').get()).toBeTruthy();expect([...secure.values()].some(v=>v.includes('content_hash_full'))).toBe(true);expect([...files.keys()].some(p=>p.includes('.pod-write-'))).toBe(false);expect(calls).toContain('crypto.aesGcmEncrypt');
 expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
 }finally{sql.close();}
 }}finally{Error.stackTraceLimit=stackLimit;rmSync(output,{recursive:true,force:true});}
});

test('manual headless grant is bound to durable token and backend/account scope before any library, writer or network work',async()=>{
 const account={userId:'user',watchDeviceToken:'fixture-token',backendBaseUrl:'https://backend.invalid',tokenExpiresAtMillis:9e15,watchRefreshToken:'',entitlement:{plan:'member',active:true}};
 for(const mismatch of ['token','scope','epoch']){const methods:string[]=[];const intent={version:2,token:'opaque_1',scope:mismatch==='scope'?'other':cloudAccountIdentity(account),mode:'recent128',createdAt:1,epoch:'old-epoch'};
 const result=await handler({appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:Date.now()+300000,payload:{manual:true,token:mismatch==='token'?'stale':'opaque_1'},isCancelled:()=>false,request:async(method,args:any)=>{
  if(method==='kv.get')return {exists:true,value:{oobeSeenVersion:3,privacyPolicyAgreedVersion:1}};
  methods.push(args.method);if(args.method==='app.buildInfo')return {debugBuild:false};
  if(args.method==='secure.compareAndSet'){expect(args.args.key).toBe(MANUAL_INTENT_KEY);expect(args.args.value).toBeNull();return {updated:true};}if(args.method==='secure.get')return {exists:true,value:args.args.key===manualEpochKey(account)?'new-epoch':JSON.stringify(args.args.key===MANUAL_INTENT_KEY?intent:account)};throw Error('unauthorized side effect: '+args.method);
 }});expect(result).toBe('success');expect(methods.slice(0,3)).toEqual(['app.buildInfo','secure.get','secure.get']);expect(methods.every(m=>['app.buildInfo','secure.get','secure.compareAndSet'].includes(m))).toBe(true);
 }
});

test('background cooperative deadline leaves checkpoint cleanup time before the native hard stop',async()=>{
 const account={userId:'user',watchDeviceToken:'fixture',backendBaseUrl:'https://backend.invalid',tokenExpiresAtMillis:9e15,watchRefreshToken:'',entitlement:{plan:'member',active:true}};
 const methods:string[]=[];
 const result=await handler({appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:Date.now()+5000,payload:null,isCancelled:()=>false,request:async(method,args:any)=>{
  if(method==='kv.get')return {exists:true,value:{oobeSeenVersion:3,privacyPolicyAgreedVersion:1}};
  methods.push(args.method);
  if(args.method==='app.buildInfo')return {debugBuild:false};
  if(args.method==='secure.get')return {exists:args.args.key==='state_json',value:args.args.key==='state_json'?JSON.stringify(account):undefined};
  if(args.method==='cloud.acquire')return {acquired:true};
  if(args.method==='cloud.release')return {};
  if(args.method==='discovery.networkSnapshot')return {active:true,validated:true,wifi:true,metered:false};
  throw Error('Unexpected work after cooperative deadline: '+args.method);
 }});
 expect(result).toBe('retry');expect(methods).toContain('cloud.release');expect(methods.some(m=>m.startsWith('sql.')||m==='http.download'||m==='crypto.random')).toBe(false);
});
