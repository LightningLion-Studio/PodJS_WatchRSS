import {test,expect} from 'bun:test';
import {fixture,body,id,now} from './p3b-fixture';
import {scope,crypt} from './p3-fixture';
import {SyncV2Http} from '../../src/sync-v2/http';
import {WatchContentHttp} from '../../src/sync-v2/content-http';
import {contentHttpTransport} from '../../src/sync-v2/content-runtime';
import {canonical} from '../../src/sync-v2/protocol';
import {mkdirSync,writeFileSync,readFileSync,unlinkSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';

for(const takeover of ['proof','bootstrap','cold-capabilities'])test('REVIEW5 invalid GC token starts no new HTTP request after '+takeover,async()=>{
 const f=await fixture();try{
  const resource=await f.add();await f.cache.setAutoEvict(true);await f.cache.trustedTime(now);const row=(await f.cache.journal.row(id))!;await f.db.transaction(f.cache.placeholder(row,await f.cache.seal(id,{...body(),status:'placeholder'}),now));
  const original=f.space.ports.remote,pin=original.http.servicePin!,service=await pin.assertBootstrap(),root=join(f.root,'http');mkdirSync(root);let serial=0,old:any,before:string|undefined;const calls:{method:string;current:boolean}[]=[],live=new Map<string,Buffer>();
  const takeoverNow=async()=>{await f.cache.beginRound();before=canonical(await f.db.query('SELECT * FROM syncv2_state'));};
  const host:any=async(method:string,args:any)=>{
   if(method==='content.http'){
    calls.push({method,current:!old||await f.cache.isCurrentRound(old)});expect(args.managedTemp).toBe(true);const route=args.url.split('/sync/v2')[1].split('?')[0];let value:any;
    if(route==='/capabilities'){value={version:2,scope,minVersion:2,maxVersion:2,features:[],maxPartBytes:65536,historyDays:7,flags:{read:true,indexWrite:false,contentWrite:true,relay:false,gc:false,historyRestore:false},receiptKeyId:service.receiptKeyId,receiptSigningPublicKey:service.receiptSigningPublicKey};if(old&&takeover==='cold-capabilities')await takeoverNow();}
    else {const response=await original.availability(f.proof);value={version:2,scope,availability:{scope,entityKey:id,bodyRevision:f.proof.bodyRevision,recipeOid:f.proof.recipeOid,...response},leaseId:null,expiresAtMillis:null};}
    const path='sync2-content-http/slot-0/response-'+(++serial).toString(16)+'.data',data=Buffer.from(JSON.stringify(value));mkdirSync(join(root,'sync2-content-http/slot-0'),{recursive:true});writeFileSync(join(root,path),data);live.set(path,data);return {path,status:200,size:data.length,headers:{}};
   }
   if(method==='content.http.release'){const path=join(root,args.path);if(existsSync(path))unlinkSync(path);live.delete(args.path);return {released:true};}
   if(method==='file.read'){const data=readFileSync(join(root,args.path));return {offset:args.offset,size:data.length,dataBase64:data.subarray(args.offset,args.offset+args.maxBytes).toString('base64')};}
   throw Error('unexpected transport call '+method);
  };
  const http=new SyncV2Http(contentHttpTransport(host),'http://127.0.0.1:18999',scope,async()=>({userId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',accessToken:'synthetic',legacyDeviceId:'synthetic',scope}),false,pin,true);
  if(takeover!=='cold-capabilities')await http.capabilities();calls.length=0;old=await f.cache.beginRound();f.space.ports.remote=new WatchContentHttp(http,crypt,()=>now);
  if(takeover==='proof'){const proof=f.space.ports.localProof;f.space.ports.localProof=async(...args)=>{const result=await proof(...args);await takeoverNow();return result;};}
  if(takeover==='bootstrap'){const bootstrap=pin.assertBootstrap.bind(pin);let once=true;pin.assertBootstrap=async(...args:any[])=>{const result=await bootstrap(...args);if(once){once=false;await takeoverNow();}return result;};}
  await expect(f.space.collect(old)).rejects.toThrow('round_stale');expect(before).toBeDefined();expect(canonical(await f.db.query('SELECT * FROM syncv2_state'))).toBe(before!);expect(statSync(f.host.path(resource.path)).size).toBe(128);
  expect(calls.every(c=>c.current)).toBe(true);expect(calls.length).toBe(takeover==='cold-capabilities'?1:0);expect(live.size).toBe(0);
 }finally{f.close();}
});

test('REVIEW5 async request guards are checked after auth and preserve shared HTTP ownership',async()=>{
 const f=await fixture();try{
  const service=await f.space.ports.remote.http.servicePin!.assertBootstrap();let active=true,requests=0,original=0,checks=0;
  const http=new SyncV2Http({request:async()=>{requests++;return {status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({version:2,scope,minVersion:2,maxVersion:2,features:[],maxPartBytes:65536,historyDays:7,flags:{read:true,indexWrite:false,contentWrite:true,relay:false,gc:false,historyRestore:false},receiptKeyId:service.receiptKeyId,receiptSigningPublicKey:service.receiptSigningPublicKey}))};}},'http://127.0.0.1:18999',scope,async()=>({userId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',legacyDeviceId:'synthetic',accessToken:'synthetic',scope}),false,f.space.ports.remote.http.servicePin,true);
  http.requestGuard=()=>{original++;};const owned=http.requestGuard,view=http.readOnly(async()=>{checks++;if(!active)throw Error('round_stale');});active=false;
  await expect(view.capabilities()).rejects.toThrow('round_stale');expect(requests).toBe(0);expect(checks).toBe(1);expect(original).toBe(1);expect(http.requestGuard).toBe(owned);await http.capabilities();expect(requests).toBe(1);
 }finally{f.close();}
});
