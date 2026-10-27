import {test,expect} from 'bun:test';
import {WatchCloudClient,CloudRequestError} from '../../src/cloud/client';
import {fixture} from './service-fixture';
import {crypto,enabled} from './k2-crypto';
import {utf8Encode} from '../../src/cloud/types';

for(const endpoint of ['/records','/reserve','/complete'])test(`floor 426 at ${endpoint} exposes terminal upgrade state without clearing local writes or retrying`,async()=>{
 const f=await fixture();let cleared=0;f.session.invalidate=async()=>{cleared++;};
 if(endpoint==='/records')f.session.records=async()=>({pull:async()=>0,flushInteractions:async()=>{throw new CloudRequestError(426,'cloud_format_upgrade_required');}}) as any;
 else f.fault(r=>r.url.endsWith(endpoint)?{status:426,error:'cloud_format_upgrade_required'}:undefined);
 expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status).toMatchObject({errorCode:'cloud_format_upgrade_required',phase:'error',retryable:false,message:'请升级到最新版本以继续同步',formatCompatibility:{editPending:1,upgradeRequired:true}});
 expect(cleared).toBe(0);expect(await f.state.lastContentHash(true)).toBeUndefined();
 if(endpoint!=='/records'){expect(await f.cache.pending('user')).toBeDefined();expect(f.calls.filter(c=>c.url.endsWith(endpoint))).toHaveLength(1);}
});

test('new opted-in client admits every content writer, refreshes before writes, while reads remain ungated',async()=>{
 const calls:any[]=[],http={request:async(r:any)=>{calls.push(r);return {status:200,headers:{},body:utf8Encode(JSON.stringify(r.url.endsWith('/format-capabilities')?{protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:true}}:r.url.endsWith('/reserve')?{snapshotId:'legacy-body',missingObjects:[]}:{}))};}};
 const client=new WatchCloudClient(http,{baseUrl:'https://fixture.test',accessToken:'synthetic',r48WriteV1:true},crypto,enabled);client.setEpoch('epoch');client.setContentGeneration('55555555-5555-4555-8555-555555555555');
 await client.pushRecords([]);const body=utf8Encode('encrypted'),sha256=await crypto.sha256(body);
 await client.reserveSnapshot({manifest:{snapshotId:'legacy-body',sourceDeviceId:'watch',deviceSequence:1,keyVersion:1,parentHeads:{},observedHeads:{},allChunks:[]},encryptedManifest:body});
 await client.uploadObject({transport:'epoch-proxy',uploadMethod:'PUT',reservationId:'synthetic',uploadUrl:'https://fixture.test/functions/v1/cloud/uploads/synthetic',sizeBytes:body.length,sha256} as any,body);
 await client.completeSnapshot('legacy-body',[]);
 const writes=calls.filter(c=>c.method!=='GET');expect(writes).toHaveLength(4);expect(writes.every(c=>c.headers['x-watchrss-r48-write-v1']==='1')).toBe(true);expect(calls.filter(c=>c.url.endsWith('/format-capabilities'))).toHaveLength(4);
});

test('server withdrawal prevents opted-in records CAS even with a formerly fresh permission',async()=>{
 const calls:any[]=[];let allow=true;
 const client=new WatchCloudClient({request:async(r:any)=>{calls.push(r);return {status:200,headers:{},body:utf8Encode(JSON.stringify({protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:allow}}))};}},
 {baseUrl:'https://fixture.test',accessToken:'synthetic',r48WriteV1:true},crypto,enabled);
 expect(await client.refreshR48WriteGate()).toBe(true);allow=false;
 await expect(client.pushRecords([])).rejects.toThrow('cloud_format_write_disabled');expect(calls.every(c=>c.method==='GET')).toBe(true);
});
