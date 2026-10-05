import {test,expect} from 'bun:test';
import {createCloudTransport} from '../../src/cloud/transport';
import {WatchCloudClient} from '../../src/cloud/client';
import {crypto,enabled} from './k2-crypto';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {SupabaseTusUploader} from '../../src/cloud/tus';
test('large PATCH uses bounded chunks/bodyPath, response file validation and cleanup on success/failure',async()=>{
 const files=new Map<string,Uint8Array>();let n=0,fail=false;const methods:string[]=[];
 const transport=createCloudTransport(async<T>(method:string,a:any):Promise<T>=>{methods.push(method);expect(JSON.stringify(a).length).toBeLessThan(65536);let out:any;
  if(method==='file.createTemp'){out={path:`cloud-http/.pod-write-${++n}.part`};files.set(out.path,new Uint8Array());}
  else if(method==='file.write'){const old=files.get(a.path)!,part=Buffer.from(a.dataBase64,'base64');expect(a.expectedOffset).toBe(old.length);const b=new Uint8Array(old.length+part.length);b.set(old);b.set(part,old.length);files.set(a.path,b);out={size:b.length};}
  else if(method==='file.delete'){files.delete(a.path);out={};}
  else if(method==='http.download'){expect(a.method).toBe('PATCH');expect(files.get(a.bodyPath)!.length).toBe(4*1024*1024+33);expect(a.followRedirects).toBe(false);expect(a.maxBytes).toBe(8*1024*1024);expect(a.callTimeoutMs).toBe(120000);if(fail)throw Error('timeout');files.set(a.path,utf8Encode('ok'));out={path:a.path,size:2,status:204,headers:{'Upload-Offset':'9'}};}
  else if(method==='file.read'){const b=files.get(a.path)!;out={size:b.length,offset:a.offset,dataBase64:Buffer.from(b.slice(a.offset,a.offset+a.maxBytes)).toString('base64')};}
  else throw Error(method);return out;
 },enabled);
 const request={method:'PATCH',url:'https://upload.invalid/tus',headers:{},body:new Uint8Array(4*1024*1024+33)};
 expect(utf8Decode((await transport.request(request)).body)).toBe('ok');expect(files.size).toBe(0);fail=true;await expect(transport.request(request)).rejects.toThrow('timeout');expect(files.size).toBe(0);
 await expect(transport.request({...request,url:'http://fixture.invalid'})).rejects.toThrow('地址');
});
test('401 refreshes once; signed GET has no credentials; recent128/all public inventories remain explicit',async()=>{
 const seen:{url:string;headers:Record<string,string>}[]=[];const refresh:boolean[]=[];let token='old';
 const client=new WatchCloudClient({request:async r=>{seen.push({url:r.url,headers:{...r.headers}});if(r.headers.authorization==='Bearer old')return {status:401,headers:{},body:new Uint8Array()};const json=r.url.endsWith('/resolve')?{source:{id:'feed'}}:r.url.includes('/entries?')?{source:{title:'Feed'},entries:[{id:1,title:'entry'}]}:{member:{}};return {status:200,headers:{},body:utf8Encode(JSON.stringify(json))};}},{baseUrl:'https://backend.invalid',accessToken:'unused',refreshToken:async force=>{refresh.push(force);if(force)token='new';return token;}},crypto,enabled);
 await client.bootstrap();expect(refresh).toEqual([false,true]);expect(seen.map(r=>r.headers.authorization)).toEqual(['Bearer old','Bearer new']);
 expect((await client.resolveRssSource('https://feed.invalid/rss','all')).items[0].url).toBe('https://feed.invalid/rss?watchrss_entry=1');await client.resolveRssSource('https://feed.invalid/rss');expect(seen.some(r=>r.url.endsWith('limit=all'))).toBe(true);expect(seen.some(r=>r.url.endsWith('limit=128'))).toBe(true);
});
test('TUS cannot send signed token to a cross-origin Location',async()=>{
 const data=utf8Encode('bytes');let calls=0;const upload=new SupabaseTusUploader({request:async()=>{calls++;return {status:201,headers:{Location:'https://other.invalid/upload'},body:new Uint8Array()};}},crypto,{guard:enabled});
 await expect(upload.upload({kind:'chunk',sha256:await crypto.sha256(data),sizeBytes:data.length,objectPath:'x',signedUrl:'',token:'secret',tusEndpoint:'https://upload.invalid/tus',bucketName:'b'},data)).rejects.toThrow('来源');expect(calls).toBe(1);
});
