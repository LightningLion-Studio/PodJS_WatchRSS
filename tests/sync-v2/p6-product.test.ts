import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {SqlFixture,vector,productCipherHost,noteValue} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serviceInfo} from './p2-fixture';
import {initializeMemoSchema} from '../../src/notes/repository';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {watchSyncV2Product,leasedSyncV2Session} from '../../src/sync-v2/product-start';
import {jsonBytes,bytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {unhex,sha256Hex} from '@podjs/framework/crypto';
import {descriptorOid} from '../../src/sync-v2/identity';
import {signControl} from '../../src/sync-v2/signing';
import {sealV2,openV2} from '../../src/sync-v2/sealed';
import {buildArticleBody,articleBodyRevision,articleBodyBytes,articleBodyResolver} from '../../src/sync-v2/article-body';
import {WatchSyncV2UiState} from '../../src/sync-v2/ui-state';
import {TrustedClock} from '../../src/sync-v2/trusted-time';
const f=vector('identity-bootstrap'),scope=f.context.scope,legacy='00000000-0000-0000-0000-000000000002';
const user=f.context.accountId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
const account={userId:user,backendBaseUrl:'http://127.0.0.1:18991',watchDeviceToken:'synthetic-only'};
class ProductBackend extends SyntheticIndexBackend {
 present=true;registrations:any[]=[];
 override window():any{const w:any=super.window();w.refs=this.device.commitOid?[{deviceId:this.device.ref.split('/')[2],commitOid:this.device.commitOid,refRevision:this.device.revision}]:[];return w;}
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2','')),json=(v:any)=>({status:200,headers:{},body:jsonBytes({version:2,scope,...v})});
  if(path==='/repo/descriptor')return this.present?json({descriptorOid:descriptorOid(f.descriptor),descriptor:f.descriptor,recoveryOid:'id-key-recovery:sha256:'+sha256Hex(jsonBytes(f.capsule))}):{status:404,headers:{},body:jsonBytes({error:{code:'object_missing'}})};
  if(path.startsWith('/repo/id-key-recovery/'))return {status:200,headers:{},body:jsonBytes(f.capsule)};
  if(path==='/checkpoint'){const w=this.window(),cp=await signControl(crypto,'','wrss.sync.v2/checkpoint-sign',{scope,checkpointId:'c'.repeat(32),serverRevision:this.serverRevision,refs:w.refs,account:this.account,historyFloorRevision:'0',historyFloorMillis:0,windowId:w.windowId,issuedAtMillis:100,expiresAtMillis:300000});return json(cp);}
  if(path==='/devices/signing-key'){const v=parseCanonicalJson(r.body);this.registrations=[v];return json({deviceId:v.body.deviceId,keyId:v.body.keyId,registered:true});}
  if(path==='/devices/signing-keys'){const bindings=[];for(const v of this.registrations)bindings.push({...v,deviceMapping:await signControl(crypto,'','wrss.sync.v2/device-mapping',{scope,deviceId:v.body.deviceId,keyId:v.body.keyId,legacyDeviceId:legacy,approvalRevision:'0'})});return json({bindings,revocationRevision:'0'});}
  const result=await super.request(r);
  if(path==='/state-refs'){const v=parseCanonicalJson(r.body),t=this.tables.get(v.body.stateOid),registered=this.registrations[0];Object.assign(t,{authorDeviceId:registered.body.deviceId,keyId:registered.body.keyId});}
  return result;
 }
}
async function fixture(){
 const db=new SqlFixture(),secrets=new Map<string,string>(),local=productCipherHost();await initializeMemoSchema(db);const n=noteValue();await db.execute('INSERT INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[n.noteId,null,n.title,n.markdown,n.plainText,n.contentHash,n.baseContentHash,n.baseMarkdown,0,n.createdAt,n.updatedAt,n.modifiedBy,0,0]);
 const raw=(s:string)=>Buffer.from(s,'base64'),out=(b:Uint8Array)=>Buffer.from(b).toString('base64');
 const host:any=async(method:string,a:any)=>{
  if(method==='secure.get'){const value=secrets.get(a.key);return value===undefined?{exists:false}:{exists:true,value,totalChars:value.length,offset:0,version:1};}
  if(method==='secure.compareAndSet'){if((secrets.get(a.key)??null)!==a.expected)return {updated:false};secrets.set(a.key,a.value);return {updated:true};}
  if(method==='sql.query')return db.query(a.sql,a.params);
  if(method==='sql.transaction')return db.transaction(a.statements);
  if(method==='crypto.v2.signingKey')return {publicKeySec1:out(publicBytes)};
  if(method==='crypto.v2.sign')return {signatureBase64:out(await crypto.sign('',raw(a.dataBase64)))};
  if(method==='crypto.v2.verify')return {valid:await crypto.verify(raw(a.publicKeySec1),raw(a.dataBase64),raw(a.signatureBase64))};
  if(method==='crypto.hkdfSha256')return {keyBase64:out(await crypto.hkdf(raw(a.inputBase64),raw(a.saltBase64),raw(a.infoBase64)))};
  if(method==='crypto.v2.encrypt')return {ciphertextBase64:out(await crypto.encrypt(raw(a.keyBase64),raw(a.nonceBase64),raw(a.dataBase64),raw(a.aadBase64)))};
  if(method==='runtime.delay')return {};
  return local.host(method,a);
 };
 const server=new ProductBackend(),options={host,transport:server,account,legacyDeviceId:legacy,allowLoopback:true,keys:{currentKeyVersion:async()=>f.descriptor.body.wrappingKeyVersion,accountKey:async()=>unhex(f.wrapKeyHex)},repository:{cloudRestoreMetadata:async()=>({articles:[],next:undefined}),cloudArticleBody:async()=>undefined},session:async()=>account,bootstrap:async()=>({accountId:f.context.accountId,syncV2:serviceInfo,devices:[{deviceId:legacy,revokedAt:null}]}),now:()=>100,clock:new TrustedClock(()=>100)};
 return {db,secrets,server,options};
}
test('P6 product capsule receive → R0 → first snapshot → UI install → unload uses production adapters',async()=>{
 const f=await fixture();let ui:any;
 const listener=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const response=await f.server.request({method:request.method,url:request.url,headers:{...Object.fromEntries(request.headers),'Content-Type':request.headers.get('content-type')??''},body:request.method==='GET'?undefined:new Uint8Array(await request.arrayBuffer())});return new Response(response.body,{status:response.status,headers:response.headers});}});
 f.options.account={...account,backendBaseUrl:listener.url.origin};f.options.session=async()=>f.options.account;
 f.options.transport={async request(r:any){const response=await fetch(r.url,{method:r.method,headers:r.headers,body:r.body,redirect:'manual'});return {status:response.status,headers:Object.fromEntries(response.headers),body:new Uint8Array(await response.arrayBuffer())};}} as any;
 const product=watchSyncV2Product({enabled:true,drainOnStop:true,announced:async()=>true,open:()=>openApplicationSyncV2(f.options),install:v=>{ui=v;}});
 try{expect(await product.start('account')).not.toBeNull();expect(ui).toBeDefined();expect(f.server.account.revision).toBe('1');expect(f.server.registrations).toHaveLength(1);expect((await ui.snapshot()).ownDeviceId).toBe(f.server.registrations[0].body.deviceId);expect((await f.db.query('SELECT count(*) n FROM memo_notes'))[0].n).toBe(1);expect(f.secrets.size).toBeGreaterThan(0);await product.stop();expect(ui).toBeUndefined();expect((await f.db.query('SELECT enabled FROM syncv2_control'))[0].enabled).toBe(0);await expect(product.start('account')).resolves.not.toBeNull();expect(f.server.account.revision).toBe('1');await product.stop();}finally{listener.stop(true);f.db.close();}
});
test('P6 product waits for creator without opening SQL projection when descriptor is absent',async()=>{const f=await fixture();try{f.server.present=false;const calls=f.db.calls;expect(await openApplicationSyncV2(f.options)).toBeNull();expect(f.db.calls).toBe(calls);expect(f.server.registrations).toHaveLength(0);}finally{f.db.close();}});
test('P6 product session rejects old UI calls after logout',async()=>{const f=await fixture();try{const opened=await openApplicationSyncV2(f.options);await opened!.close();await expect(opened!.ui.syncNow()).rejects.toThrow('feature_disabled');}finally{f.db.close();}});

test('P6-1 sealed reads resolve exact header version; missing key never decrypts',async()=>{
 const id=new Uint8Array(32).fill(1),one=new Uint8Array(32).fill(2),two=new Uint8Array(32).fill(3),versions:number[]=[],sealed=await sealV2(crypto,id,one,scope,'state',1,jsonBytes({a:1}));let decrypts=0;
 const c={...crypto,decrypt:async(...args:Parameters<typeof crypto.decrypt>)=>{decrypts++;return crypto.decrypt(...args);}};
 expect((await openV2(c,id,async v=>{versions.push(v);return v===1?one:two;},scope,sealed.oid,sealed.bytes)).value).toEqual({a:1});expect(versions).toEqual([1]);expect(decrypts).toBe(1);
 await expect(openV2(c,id,async()=>{throw Error('key_unavailable');},scope,sealed.oid,sealed.bytes)).rejects.toThrow('key_unavailable');expect(decrypts).toBe(1);
});
test('P6-9 article mapping selects UTF-8 text before HTML and keeps book/asset placeholders',async()=>{
 expect(articleBodyBytes({contentText:'你好',contentHtml:'<p>x</p>'})).toEqual(bytes('你好'));expect(articleBodyBytes({contentHtml:'<p>x</p>'})).toEqual(bytes('<p>x</p>'));expect(articleBodyBytes({contentText:''})).toBeNull();expect(articleBodyBytes({contentText:'\ud800'})).toEqual(bytes('�'));
 const keys={id:new Uint8Array(32).fill(1),content:new Uint8Array(32).fill(2),version:1},id='a'.repeat(64),plain=bytes('正文🙂\n'.repeat(50000)),built=await buildArticleBody(crypto,keys,scope,id,plain);
 expect(built.recipe.bodyRevision).toBe(articleBodyRevision(id,plain));expect(built.recipe.blocks.length).toBeGreaterThan(1);expect(built.recipe.ranges).toEqual([]);
 const recipe=await openV2(crypto,keys.id,keys.content,scope,built.binding.recipeOid!,built.objects.at(-1)!.bytes);expect(recipe.value).toEqual(built.recipe);
 let read=0;const resolve=articleBodyResolver({crypto,keys,scope,read:async()=>{read++;return {article:{contentText:'正文'},manifest:{bodyAvailable:true}} as any;}});
 for(const kind of ['book','asset','note'])expect(await resolve({candidate:{meta:{kind}}},null)).toBeNull();expect(read).toBe(0);
 const binding=await resolve({entityKey:id,candidate:{meta:{kind:'article',logicalId:'x'}}},null);expect(binding!.recipeOid).toBeNull();expect(binding!.promiseId).not.toBeNull();expect(binding!.bodyRevision).toBe(articleBodyRevision(id,bytes('正文')));
});
test('P6-6 product UI maps legacy clock_unknown without changing core errors',async()=>{
 const ui=new WatchSyncV2UiState({runtime:{pull:async()=>{throw Error('clock_unknown');},publish:async()=>{}},control:{} as any,projection:{} as any,productErrors:true});await expect(ui.syncNow()).rejects.toThrow('trusted_time_unavailable');
});
test('P6-6 near-backward verified checkpoints refresh age without moving trusted time backwards',()=>{let mono=0;const clock=new TrustedClock(()=>mono);clock.observe(1000000);mono=86400000;clock.observe(clock.now()!-1000);mono++;expect(clock.now()).not.toBeNull();});
test('P6 product lease wrapper fences snapshots and mutations but keeps subscribe synchronous',async()=>{let acquired=0;const s=leasedSyncV2Session({ui:{snapshot:async()=>1,mutate:async()=>2,subscribe:()=>()=>{}},close:async()=>{}},async work=>{acquired++;return work();});expect(typeof s.ui.subscribe()).toBe('function');expect(acquired).toBe(0);expect(await s.ui.snapshot()).toBe(1);expect(await s.ui.mutate()).toBe(2);expect(acquired).toBe(2);});

test('P6-1 cloud index reads an older authenticated version and missing version preserves account/ACK',async()=>{
 const {p5Fixture,keys,approved}=await import('./p5-fixture'),{WatchCloudIndex}=await import('../../src/sync-v2/cloud-index');
 const f=await p5Fixture();try{
  await f.publish();await f.edit('new remote title');await f.scan();await f.publisher.prepare('a'.repeat(32),'key',{commitOid:f.server.device.commitOid,revision:f.server.device.revision},randomBytes(16).toString('hex'));await f.publisher.flush();
  const before=await f.projection.readState(),acks=f.server.acks.length;
  const missing=new WatchCloudIndex(f.projection,f.http,crypto,{...keys,version:2,content:new Uint8Array(32).fill(9),readContentKey:async()=>{throw Error('key_unavailable');}},approved,async()=>{},()=>f.server.clock);
  await expect(missing.pull(f.server.window())).rejects.toThrow('key_unavailable');expect(await f.projection.readState()).toEqual(before);expect(f.server.acks.length).toBe(acks);
  const versions:number[]=[],reader=new WatchCloudIndex(f.projection,f.http,crypto,{...keys,version:2,content:new Uint8Array(32).fill(9),readContentKey:async v=>{versions.push(v);if(v!==1)throw Error('key_unavailable');return keys.content;}},approved,async()=>{},()=>f.server.clock);
  await reader.pull(f.server.window());expect(versions.length).toBeGreaterThan(0);expect(versions.every(v=>v===1)).toBe(true);expect((await f.projection.readState()).account!.oid).toBe(f.server.account.commitOid);
 }finally{f.close();}
});

test('P6-9 byte hashes match Mini de7e5f5 with the same synthetic randomness',async()=>{
 // Generated by the fixed commit's production buildArticleBody (identity codec).
 let count=1;const result=await buildArticleBody({...crypto,random:async n=>new Uint8Array(n).fill(count++)},{id:new Uint8Array(32).fill(1),content:new Uint8Array(32).fill(2),version:1},scope,'a'.repeat(64),bytes('P6 正文🙂\n'));
 expect(result.binding).toEqual({bodyRevision:'3c1ebc8dbe12aa2ff0560ebdf6a3476c',promiseId:null,recipeOid:'recipe:sha256:8689421dfdcdbd6b75ee6756288143a3611133e6ffd2411c6a20c98bb398e0d2',opaqueContentId:'42de3d5622b19772fd8c01bb9f45998d27731ed2f8d5f86de4937bfd02abcb25',contentBytes:14});
 expect(result.objects[0].oid).toBe('blob:sha256:8109a61e5c15d6a17a06ba0b443348742897c08443afba3e47e5630921136fb8');
});

test('P6 production stop waits for late opener cleanup before returning',async()=>{
 let release!:()=>void,entered!:()=>void,closed=false;const waiting=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
 const product=watchSyncV2Product({enabled:true,drainOnStop:true,announced:async()=>true,install:()=>{},open:async()=>{entered();await waiting;return {ui:{},close:async()=>{closed=true;}};}});
 const start=product.start('old');await ready;let stopped=false;const stop=product.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);release();expect(await start).toBeNull();await stop;expect(closed).toBe(true);expect(product.active).toBe(false);
});

test('P6 cache-only content assembly retains the closed upload gate',async()=>{
 const {WatchContentHttp}=await import('../../src/sync-v2/content-http'),{SyncV2Http}=await import('../../src/sync-v2/http');let requests=0;
 const http=new SyncV2Http({request:async()=>{requests++;throw Error('network forbidden');}},account.backendBaseUrl,scope,async()=>{throw Error('session forbidden');});
 const content=new WatchContentHttp(http,crypto,()=>100,true);await expect(content.reserve('blob:sha256:'+'a'.repeat(64),1,'a'.repeat(32))).rejects.toThrow('feature_disabled');expect(requests).toBe(0);
});

test('P6 product resumes R0 after a scan failure and retains the original business library',async()=>{
 const f=await fixture(),native=f.options.host;let fail=true;f.options.host=async(method:string,args:any)=>{if(fail&&method==='sql.transaction'&&args.statements.some((s:any)=>s.sql.includes('INSERT INTO syncv2_candidates'))){fail=false;throw Error('scan_disk_failure');}return native(method,args);};
 try{await expect(openApplicationSyncV2(f.options)).rejects.toThrow('scan_disk_failure');expect((await f.db.query('SELECT count(*) n FROM memo_notes'))[0].n).toBe(1);expect((await f.db.query('SELECT count(*) n FROM syncv2_checkpoint'))[0].n).toBe(1);expect(f.server.account.commitOid).toBeNull();const reopened=await openApplicationSyncV2(f.options);expect(reopened).not.toBeNull();expect(f.server.account.revision).toBe('1');expect((await f.db.query('SELECT count(*) n FROM memo_notes'))[0].n).toBe(1);await reopened!.close();}finally{f.db.close();}
});


test('P6 product resolves a lost first-publication response before pulling the new account head',async()=>{
 const f=await fixture();try{f.server.losePublish=true;await expect(openApplicationSyncV2(f.options)).rejects.toThrow('synthetic_response_lost');expect(f.server.account.revision).toBe('1');const reopened=await openApplicationSyncV2(f.options);expect(reopened).not.toBeNull();expect(f.server.account.revision).toBe('1');expect((await reopened!.ui.snapshot()).enabled).toBe(true);await reopened!.close();}finally{f.db.close();}
});


test('P6 protected CAS checks account inside the v1 lease before publishing any late key',async()=>{
 const {accountBoundCasHost}=await import('../../src/sync-v2/product');
 for(const current of [null,{...account,userId:'other'},{...account,backendBaseUrl:'https://other.invalid'}]){
  const calls:string[]=[];const host:any=async(method:string)=>{calls.push(method);if(method==='secure.acquire')return {acquired:true};if(method==='secure.release')return {};throw Error('CAS must not run');};
  const bound=accountBoundCasHost(host,account,async()=>current);await expect(bound('secure.compareAndSet',{})).rejects.toThrow('cloud_account_busy');expect(calls).toEqual(['secure.acquire','secure.release']);
 }
});
test('P6 logout during capsule decryption cannot reinstall K_id after account cleanup',async()=>{
 const {accountBoundCasHost}=await import('../../src/sync-v2/product'),f=await fixture(),native=f.options.host;let loggedIn=true;
 f.options.host=accountBoundCasHost(async<T>(method:string,args:Record<string,unknown>)=>{if(method==='secure.acquire')return {acquired:true} as T;if(method==='secure.release')return {} as T;const result=await native(method,args);if(method==='crypto.aesGcmDecrypt')loggedIn=false;return result;},account,async()=>loggedIn?account:null);
 try{await expect(openApplicationSyncV2(f.options)).rejects.toThrow('cloud_account_busy');expect(f.secrets.size).toBe(0);expect((await f.db.query('SELECT count(*) n FROM memo_notes'))[0].n).toBe(1);}finally{f.db.close();}
});
