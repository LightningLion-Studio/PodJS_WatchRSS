import {test,expect} from 'bun:test';
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
  const artifact=(await buildBackground({v2:entry},dir)).v2!;expect(artifact.bytes).toBeLessThanOrEqual(1048576);
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
