import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import handler from '../../src/cloud/background';
import {crypto,key} from './k2-crypto';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {initializeSchema} from '../../src/core/schema';
import type {BackgroundContext} from '@podjs/framework/background-handler';
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
test('background release reads buildInfo only; unbound debug worker skips successfully',async()=>{
 const calls:string[]=[];let debug=false;
 const context:BackgroundContext={appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:300000,payload:null,isCancelled:()=>false,request:async(m,a:any)=>{expect(m).toBe('debug.cloudHost');calls.push(a.method);if(a.method==='app.buildInfo')return {debugBuild:debug};if(a.method==='secure.get')return {exists:false};throw Error('unexpected '+a.method);}};
 expect(await handler(context)).toBe('success');expect(calls).toEqual(['app.buildInfo']);debug=true;calls.length=0;expect(await handler(context)).toBe('success');expect(calls).toEqual(['app.buildInfo','secure.get']);
});
test('headless handler uses actual SQLite/codec/coordinator: registers and uploads with durable state, no UI or real HTTP',async()=>{
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const secure=new Map<string,string>(),files=new Map<string,Uint8Array>();let id=0,reserved:any,leased=false;const calls:string[]=[];
 const account={userId:'user',watchDeviceToken:'fixture-token',backendBaseUrl:'https://backend.invalid',tokenExpiresAtMillis:9e15,watchRefreshToken:'',entitlement:{plan:'member',active:true},telemetryConfig:{}};
 secure.set('state_json',JSON.stringify(account));secure.set('watchrss.cloud.keys.'+await crypto.sha256(utf8Encode('user')),JSON.stringify({1:b64(key)}));
 const resultFile=async(data:Uint8Array,directory='cloud-crypto')=>{const path=`${directory}/.pod-write-${++id}.part`;files.set(path,data);return {path,size:data.length,sha256:await crypto.sha256(data)};};
 const request=async(method:string,a:any):Promise<any>=>{
  calls.push(method);expect(JSON.stringify(a).length).toBeLessThan(1024*1024);
  switch(method){
   case 'app.buildInfo':return {debugBuild:true};
   case 'cloud.acquire':expect(leased).toBe(false);leased=true;return {acquired:true};
   case 'cloud.release':leased=false;return {};
   case 'discovery.networkSnapshot':return {active:true,validated:true,wifi:true,metered:false};
   case 'secure.get':return {exists:secure.has(a.key),value:secure.get(a.key)};
   case 'secure.set':secure.set(a.key,a.value);return {};
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
   case 'crypto.hash':return {digestBase64:Buffer.from(await crypto.sha256(unb64(a.dataBase64)),'hex').toString('base64')};
   case 'crypto.ecdhPublicKey':return {publicKeySpki:'fixture-spki'};
   case 'crypto.hkdfSha256':return {keyBase64:b64(await crypto.hkdf(unb64(a.inputBase64),unb64(a.saltBase64),unb64(a.infoBase64)))};
   case 'crypto.largeAesGcmEncrypt':{const sealed=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),files.get(a.inputPath)!);return {...await resultFile(sealed.ciphertext),nonceBase64:b64(sealed.nonce)};}
   case 'crypto.largeAesGcmDecrypt':return resultFile(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),files.get(a.inputPath)!));
   case 'sql.query':return sql.query(a.sql).all(...a.params);
   case 'sql.execute':sql.query(a.sql).run(...a.params);return null;
   case 'sql.transaction':return sql.transaction(()=>{const changes=a.statements.map((s:any)=>{sql.query(s.sql).run(...(s.params??[]));return (sql.query('SELECT changes() AS n').get() as any).n;});return a.reportChanges?changes:null;})();
   case 'http.download':{
    const j=a.bodyPath?JSON.parse(utf8Decode(files.get(a.bodyPath)!)):{};let response:any={};expect(a.url.startsWith('https://backend.invalid/')).toBe(true);expect(a.headers.authorization).toBe('Bearer fixture-token');
    if(a.url.endsWith('/bootstrap'))response={member:{plan:'member',active:true,readable:true,writable:true,quotaBytes:1e9},devices:[],keyEnvelopes:[]};
    else if(a.url.endsWith('/heads'))response={heads:[]};
    else if(a.url.endsWith('/reserve')){reserved=j;response={snapshotId:j.snapshotId,reservedBytes:0,missingObjects:[]};}
    else if(a.url.endsWith('/complete'))expect(j.snapshotId).toBe(reserved.snapshotId);
    files.set(a.path,utf8Encode(JSON.stringify(response)));return {path:a.path,size:files.get(a.path)!.length,status:200,headers:{}};
   }
   default:throw Error('Unexpected headless host call: '+method);
  }
 };
 try{
  await initializeSchema({query:async q=>sql.query(q).all() as Record<string,unknown>[],transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]));})();}},{seedBuiltinChannels:false});
  sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','Private',1,1)");
  sql.exec("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'Article','Private body','https://article.invalid/a','a',1)");
  expect(await handler({appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:300000,payload:null,isCancelled:()=>false,request:async(m,a:any)=>{if(m==='kv.get')return {exists:true,value:JSON.stringify({progress:.5,offset:3,updatedAt:7})};expect(m).toBe('debug.cloudHost');return request(a.method,a.args);}})).toBe('success');
  expect((sql.query('SELECT progress FROM article_reading_state WHERE article_id=1').get() as any).progress).toBe(.5);expect(leased).toBe(false);expect(reserved.deviceSequence).toBe(1);expect(reserved.chunks).toHaveLength(2);expect(sql.query('SELECT device_id FROM sync_local_identity').get()).toBeTruthy();expect([...secure.values()].some(v=>v.includes('content_hash_full'))).toBe(true);expect([...files.keys()].some(p=>p.includes('.pod-write-'))).toBe(false);expect(calls).toContain('crypto.largeAesGcmEncrypt');
 }finally{sql.close();}
});
