import {test,expect} from 'bun:test';
import {readCloudSecure} from '../../src/cloud/secure-read';
import {cloudStatePort} from '../../src/cloud/state-sql';
import type {CloudHostRequest} from '../../src/cloud/host-ports';
test('lightweight preflight and worker use bounded pages for a 1 MiB legacy value',async()=>{
 const value='x'.repeat(1024*1024)+'😀';let calls=0;
 const host:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{expect(method).toBe('secure.get');expect(args.maxChars).toBe(16384);calls++;return {exists:true,value:value.slice(Number(args.offset),Number(args.offset)+16384),offset:args.offset,totalChars:value.length,version:17} as T;};
 expect(await cloudStatePort(host).get('state_json')).toBe(value);expect(calls).toBe(65);
});
test('replacement that shrinks a value restarts at zero and never joins snapshots',async()=>{
 const value='x'.repeat(20000);let calls=0;
 const host:CloudHostRequest=async<T>(_method:string,args:Record<string,unknown>)=>{calls++;if(calls===1)return {exists:true,value:value.slice(0,16384),offset:0,totalChars:value.length,version:1} as T;if(calls===2){expect(args.version).toBe(1);return {exists:true,changed:true} as T;}expect(args.offset).toBe(0);return {exists:true,value:'new',offset:0,totalChars:3,version:2} as T;};
 expect(await readCloudSecure(host,'legacy')).toBe('new');expect(calls).toBe(3);
});
test('deletion during migration restarts before returning absence; repeated mutation is bounded',async()=>{
 let calls=0;const removed:CloudHostRequest=async<T>()=> (++calls===1?{exists:true,value:'old',offset:0,totalChars:20000,version:1}:{exists:false}) as T;
 expect(await readCloudSecure(removed,'legacy')).toBeUndefined();expect(calls).toBe(3);
 calls=0;const churn:CloudHostRequest=async<T>()=>{calls++;return {exists:true,changed:true} as T;};await expect(readCloudSecure(churn,'legacy')).rejects.toThrow('secure_read_failed');expect(calls).toBe(3);
});
test('empty, oversized, and nonadvancing replies retain corruption checks',async()=>{
 for(const r of [{exists:true,value:'',offset:0,totalChars:1,version:1},{exists:true,value:'x',offset:0,totalChars:2*1024*1024+1,version:1}]){const host:CloudHostRequest=async<T>()=>r as T;await expect(readCloudSecure(host,'legacy')).rejects.toThrow('secure_store_corrupt');}
 const empty:CloudHostRequest=async<T>()=>({exists:true,value:'',offset:0,totalChars:0,version:1}) as T;expect(await readCloudSecure(empty,'legacy')).toBe('');
});

test('worker request size errors retain only a closed code and code-owned method',async()=>{
 const {cloudHostFailure}=await import('../../src/cloud/host-capability');
 const {recordFailureDiagnostic}=await import('../../src/cloud/record-diagnostic');
 const {backgroundDiagnostics}=await import('../../src/cloud/background-diagnostic');
 const {cloudFormatFailure}=await import('../../src/cloud/format-diagnostic');
 const error=cloudHostFailure('request_too_large','sql.transaction');expect(cloudFormatFailure(error)).toBe('capacity');
 const row=JSON.parse(recordFailureDiagnostic(error));expect(row.code).toBe('request_too_large');expect(row.method).toBe('sql.transaction');
 const logs:string[]=[];const host:CloudHostRequest=async<T>(_m:string,args:Record<string,unknown>)=>{logs.push(String(args.text));return undefined as T;};
 const d=backgroundDiagnostics(host);d.report(JSON.stringify({...row,payload:'PRIVATE',key:'PRIVATE'}));await d.flush();expect(logs.join('')).toContain('request_too_large');expect(logs.join('')).not.toContain('PRIVATE');
});
