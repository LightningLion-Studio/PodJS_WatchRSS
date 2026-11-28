import {test,expect} from 'bun:test';
import {finishSyncV2Background} from '../../src/cloud/background-v2';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {CURRENT_OOBE_VERSION,PRIVACY_POLICY_VERSION} from '../../src/onboarding/state';
const framework=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');
const {buildBackground}=await import(resolve(framework,'packages/cli/src/background-build.ts'));
test('full v2 headless bundle stays bounded and consent/account/network gates issue no business traffic',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'podnotes-v2-headless-'));try{
  const entry=join(dir,'entry.ts');writeFileSync(entry,`export {runSyncV2Background as default} from ${JSON.stringify(resolve(import.meta.dir,'../../src/cloud/background-v2.ts'))};`);
  const artifact=(await buildBackground({v2:entry},dir)).v2!;expect(artifact.bytes).toBeLessThanOrEqual(1048576-32*1024);
  const source=readFileSync(join(dir,artifact.file),'utf8');
  for(const phase of ['consent','account','offline']){
   const realm:any={};runInNewContext(source,realm);expect(realm.pod).toBeUndefined();expect(realm.frame).toBeUndefined();const calls:string[]=[];
   const result=await realm.backgroundHandler({deadlineMs:Date.now()+300000,isCancelled:()=>false,request:async(method:string,args:any)=>{
    if(method==='kv.get')return {
     exists:phase!=='consent',
     value:{oobeSeenVersion:CURRENT_OOBE_VERSION,privacyPolicyAgreedVersion:PRIVACY_POLICY_VERSION},
    };
    expect(method).toBe('cloud.host');calls.push(args.method);
    if(args.method==='app.buildInfo')return {debugBuild:false};
    if(args.method==='secure.get')return phase==='account'?{exists:false}:{exists:true,value:JSON.stringify({userId:'fixture',watchDeviceToken:'synthetic',backendBaseUrl:'https://backend.invalid'})};
    if(args.method==='discovery.networkSnapshot')return {active:false,validated:false,wifi:false,metered:true};
    throw Error('unexpected host '+args.method);
   }});
   expect(result).toBe(phase==='offline'?'retry':'success');
   expect(calls.includes('secure.get')).toBe(phase!=='consent');
   expect(calls.includes('discovery.networkSnapshot')).toBe(phase==='offline');
   expect(calls.some(c=>c.startsWith('http.')||c.startsWith('file.')||c==='cloud.acquire')).toBe(false);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test.each([
 [null,'success'],
 ['cloud_v2_read_only','failure'],
 ['cloud_v2_pending','failure'],
 ['choice_pending','failure'],
 ['body_channel_source_missing','failure'],
 ['body_channel_capacity_pending','failure'],
 ['replay_detected','failure'],
 ['body_channel_waiting_wifi','retry'],
 ['transport_error','retry'],
 ['network_timeout','retry'],
] as const)('headless v2 maps %s to %s and retires the grant only at a terminal outcome',async(completionError,expected)=>{
 let completed=0;
 expect(await finishSyncV2Background({completionError},async()=>++completed)).toBe(expected);
 expect(completed).toBe(expected==='retry'?0:1);
});

test('headless v2 continues a durable chunk as progress without retiring the grant',async()=>{
 expect(await finishSyncV2Background({completionError:'cloud_v2_pending',chunked:true},async()=>{throw Error('grant retired');})).toEqual({status:'retry',progress:true});
});
