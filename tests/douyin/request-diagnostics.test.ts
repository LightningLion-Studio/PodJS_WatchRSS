import {test,expect,afterEach} from 'bun:test';
import {DouyinClient} from '../../src/douyin/client.ts';
import {createDouyinLoginProbe} from '../../src/douyin/login-probe.ts';
import {douyinRequestDiagnostic,douyinRetryAfter} from '../../src/douyin/request-diagnostics.ts';
const rows:any[]=[];const original=(globalThis as any).pod;
function capture(){rows.length=0;(globalThis as any).pod={benchmark:(line:string)=>{rows.push(JSON.parse(line));return 1;}};}
afterEach(()=>{(globalThis as any).pod=original;});
function fixture(status:number,body:string,signing=false){
 let calls=0;const values=new Map([['douyin.cookie','PRIVATE_COOKIE']]);
 const client=new DouyinClient({secureStorage:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}},signer:{sign:()=>{if(signing)throw Error('PRIVATE_SIGNING');return 'PRIVATE_SIGNATURE';}},transport:{request:async()=>{calls++;return {status,headers:{'Retry-After':'9'},body:new TextEncoder().encode(body)};}},auth403:{sleep:async()=>{},timer:()=>({result:new Promise(()=>{}),cancel(){}})}});
 return {client,values,calls:()=>calls};
}
for(const [status,body,error,challenge,code] of [[200,'{"status_code":0,"aweme_list":[]}','success',false,0],[403,'denied','forbidden',false,-1],[200,'<!doctype html><html>PRIVATE_TEXT</html>','challenge',true,-1],[200,'','empty',false,-1],[200,'blocked','blocked',false,-1],[200,'{"status_code":123}','api_status',false,123],[429,'{}','http',false,-1]] as const)test(`closed feed outcome ${error}`,async()=>{
 capture();const f=fixture(status,body);await f.client.fetchFeedPage();const actual=rows.filter(r=>r.error_code===error);expect(actual.length).toBeGreaterThan(0);expect(actual[0]).toMatchObject({category:'feed',http_status:status,douyin_status_code:code,challenge,signing_ok:true,cookie_present:true});expect(JSON.stringify(rows)).not.toContain('PRIVATE');expect(f.values.has('douyin.cookie')).toBe(true);
 if(challenge){expect(f.calls()).toBe(1);expect(actual[0].retry_after_ms).toBeGreaterThan(0);}
});
test('signing failure records no network attempt',async()=>{capture();const f=fixture(200,'{}',true);await f.client.fetchFeedPage();expect(f.calls()).toBe(0);expect(rows[0]).toMatchObject({error_code:'signing',http_status:0,signing_ok:false});});
test('detail request has its own category',async()=>{capture();await fixture(403,'denied').client.fetchDetail('123');expect(rows.some(r=>r.category==='detail'&&r.http_status===403)).toBe(true);});
for(const [status,body,error] of [[200,'{"status_code":0}','success'],[200,'{"status_code":8}','api_status'],[403,'denied','forbidden'],[200,'<html>PRIVATE</html>','challenge']] as const)test(`probe ${status} ${error}`,async()=>{
 capture();const probe=createDouyinLoginProbe({signer:{sign:()=> 'PRIVATE'},transport:{request:async()=>({status,headers:{},body:new TextEncoder().encode(body)})}});await (probe({cookie:'PRIVATE_COOKIE',timeoutMs:5000}) as any).result;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({category:'auth_probe',http_status:status,error_code:error,cookie_present:true,signing_ok:true});expect(JSON.stringify(rows)).not.toContain('PRIVATE');
});
test('retry-after parses seconds and HTTP date without text output',()=>{expect(douyinRetryAfter({'Retry-After':'12'},0)).toBe(12000);expect(douyinRetryAfter({'retry-after':'Thu, 01 Jan 1970 00:00:30 GMT'},0)).toBe(30000);expect(douyinRetryAfter({'Retry-After':'PRIVATE'},0)).toBe(0);});

test('request phases copy bounded numbers only',()=>{
 capture();const base={category:'feed',http_status:200,douyin_status_code:0,challenge:false,signing_ok:true,cookie_present:true,retry_after_ms:0,error_code:'success'} as const;
 douyinRequestDiagnostic({...base,request_queue_ms:12,request_text_ms:600000,response_bytes:67108864});expect(rows[0]).toMatchObject({request_queue_ms:12,request_text_ms:600000,response_bytes:67108864});
 douyinRequestDiagnostic({...base,request_queue_ms:-1,request_text_ms:600001,response_bytes:67108865,request_status_ms:'PRIVATE' as any});for(const key of ['request_queue_ms','request_text_ms','response_bytes','request_status_ms'])expect(rows[1][key]).toBeUndefined();expect(JSON.stringify(rows)).not.toContain('PRIVATE');
});
