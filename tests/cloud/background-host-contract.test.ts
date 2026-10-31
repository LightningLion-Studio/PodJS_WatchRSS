import handler from '../../src/cloud/background';
import {tmpdir} from 'node:os';

import {test,expect} from 'bun:test';
import {readFileSync,realpathSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';

import {cloudDiagnosticHostMethod,CloudHostCapabilityError} from '../../src/cloud/host-capability';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';
import {cloudCleanupFailure} from '../../src/cloud/failure';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';
const root=resolve(import.meta.dir,'../..');
export const frameworkRoot=resolve(dirname(realpathSync(root+'/node_modules/@podjs/framework/src/bytes.ts')),'../../..');
const {buildBackground}=await import(resolve(frameworkRoot,'packages/cli/src/background-build.ts'));
const {javaHostMethods,literalHostMethods}=await import(resolve(frameworkRoot,'packages/cli/src/host-method-contract.ts'));
export const workerSource=readFileSync(frameworkRoot+'/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWorker.java','utf8');
export const workerMethods=javaHostMethods(workerSource);
test('tree-shaken background source and host-port requests fit the Java closed METHODS set',async()=>{
 const output=mkdtempSync(join(tmpdir(),'wrss-host-contract-'));try{
 const artifact=(await buildBackground({cloud:root+'/src/cloud/background.ts'},output)).cloud!;
 const sources=[{path:root+'/src/cloud/host-ports.ts',text:readFileSync(root+'/src/cloud/host-ports.ts','utf8')},{path:join(output,artifact.file),text:readFileSync(join(output,artifact.file),'utf8')}],required=literalHostMethods(sources),outer=new Set(JSON.parse(readFileSync(root+'/pod.config.json','utf8')).backgroundServices as string[]);
 expect(sources.some(s=>s.path.endsWith('/cloud/host-ports.ts'))).toBe(true);expect(sources[1]!.text).toContain('crypto.verifyP256');
 expect(required.has('runtime.delay')).toBe(true);expect(required.has('crypto.verifyP256')).toBe(true);expect(required.has('sql.transaction')).toBe(true);
 const inner=[...required].filter(m=>!outer.has(m));
 expect(inner.filter(m=>!workerMethods.has(m))).toEqual([]);
 expect(inner.filter(m=>!cloudDiagnosticHostMethod(m))).toEqual([]);
 // Reverse check: the exact 1175 omission must fail this production-source contract.
 expect(inner.filter(m=>!new Set([...workerMethods].filter(m=>m!=='runtime.delay')).has(m))).toEqual(['runtime.delay']);
 for(const denied of ['ui.draw','debug.exportCredentials','app.openUrl','runtime.afterPaint'])expect(workerMethods.has(denied)).toBe(false);
 }finally{rmSync(output,{recursive:true,force:true});}
});
test('capability code, canonical records-failed event and fixed method survive cleanup and background logging',async()=>{
 const lines:string[]=[],sink=backgroundDiagnostics(async(method,args)=>{expect(method).toBe('log.append');lines.push(String(args.text));return {} as any;});
 const error=cloudCleanupFailure(new CloudHostCapabilityError('runtime.delay'),Error('secret cleanup URL https://private.invalid'));
 const detail=recordFailureDiagnostic(error,'pull',1);expect(JSON.parse(detail)).toMatchObject({event:'records-failed',code:'cloud_host_capability_unavailable',method:'runtime.delay'});sink.report(detail);
 sink.report(JSON.stringify({event:'format-sync',code:'cloud_host_capability_unavailable',method:'runtime.delay',category:'runtime',outcome:'failed'}));
 sink.report(JSON.stringify({event:'records-failed',code:'cloud_host_capability_unavailable',method:'runtime.delay?token=secret'}));await sink.flush();
 const events=lines.join('').trim().split('\n').map(line=>JSON.parse(line.slice(line.indexOf('{'))));
 expect(events.some(e=>e.event==='records-failed'&&e.method==='runtime.delay')).toBe(true);expect(events.some(e=>e.event==='format-sync'&&e.code==='cloud_host_capability_unavailable'&&e.method==='runtime.delay')).toBe(true);
 expect(lines.join('')).not.toContain('secret');expect(events.at(-1).method).toBeUndefined();
});

test('capability rejection before service initialization is diagnosed and never becomes gate success',async()=>{
 for(const denied of ['app.buildInfo','secure.get']){
  const lines:string[]=[],calls:string[]=[];
  const result=await handler({appId:'fixture',taskId:'watchrss-cloud-sync',deadlineMs:Date.now()+300000,payload:null,isCancelled:()=>false,request:async(route,args:any)=>{
   if(route==='kv.get')return {exists:true,value:{oobeSeenVersion:3,privacyPolicyAgreedVersion:1}};
   expect(route).toBe('cloud.host');calls.push(args.method);if(args.method===denied)throw Error('permission_denied');if(args.method==='log.append'){lines.push(args.args.text);return {};}
   if(args.method==='app.buildInfo')return {debugBuild:false};throw Error('unexpected preflight call');
  }});
  expect(result).toBe('failure');expect(calls).not.toContain('cloud.acquire');expect(calls).not.toContain('http.download');
  expect(lines.join('')).toContain('"code":"cloud_host_capability_unavailable"');expect(lines.join('')).toContain('"method":"'+denied+'"');
 }
});
