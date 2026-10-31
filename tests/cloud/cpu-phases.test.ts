import {test,expect} from 'bun:test';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';
import {RESTORE_CPU_STAGES} from '../../src/cloud/cpu-phases';
import {cpuWorkAsync,cpuJsonParse,observeCpuWork,pulseCpuWork,type CpuWorkMetric} from '@podjs/framework/cpu-work';
const metric=(stage='crc32',outcome:CpuWorkMetric['outcome']='started'):CpuWorkMetric=>({event:'cpu-work',stage,scale:'bytes',sizeClass:3,elapsedMillis:5000,outcome});
test('release worker and app agree on the complete closed CPU phase set',()=>{
 const root=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');const java=readFileSync(root+'/platforms/android/runtime/src/main/java/dev/podjs/runtime/CloudWorkerOutcome.java','utf8');
 const block=java.split('CPU_STAGE_IDS=')[1]!.split(';')[0]!;const stages=[...block.matchAll(/"([a-z0-9-]+)"/g)].map(m=>m[1]);expect([...new Set(stages)].sort()).toEqual([...RESTORE_CPU_STAGES].sort());
 const worker=readFileSync(root+'/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWorker.java','utf8');expect(worker).toContain('CloudWorkerOutcome.cpuDiagnostic');expect(worker).toContain('android.util.Log.i("PodJSCloudWorker",cpu)');
});
test('CPU logging excludes content, identities, exact sizes and unknown phase/scale values',async()=>{
 const out:string[]=[];const d=backgroundDiagnostics(async(_m,a)=>{out.push(String(a.text));return {} as any;});
 await d.cpu({...metric(),url:'https://private.invalid/?token=secret',objectId:'private'}as any);
 await d.cpu(metric('private id'));await d.cpu({...metric(),scale:'private'}as any);await d.cpu({...metric(),sizeClass:17});await d.flush();
 const text=out.join('');expect(text).toContain('"stage":"crc32"');expect(text).toContain('"sizeClass":3');expect(text).not.toMatch(/secret|private|objectId|"url"|"sizeClass":17/);
});
test('an async CPU start drains earlier log work before a synchronous parse, and host failure is nonfatal',async()=>{
 const lines:string[]=[],order:string[]=[];let release!:()=>void;let first=true;
 const d=backgroundDiagnostics(async(_m,a)=>{if(first){first=false;await new Promise<void>(r=>{release=r;});}lines.push(String(a.text));order.push('log');return {}as any;});
 const pending=d.cpu(metric('crc32'));const stop=observeCpuWork(d.cpu);
 const work=cpuWorkAsync('json-scan','chars',70000,async()=>{order.push('compute');return cpuJsonParse('"'+'x'.repeat(70000)+'"');});expect(order).toEqual([]);release();expect((await work).length).toBe(70000);stop();await pending;await d.flush();
 expect(lines.slice(0,2).join('')).toContain('"stage":"json-scan"');expect(order.indexOf('compute')).toBeGreaterThan(0);
 const broken=backgroundDiagnostics(async()=>{throw Error('log failure');});const end=observeCpuWork(broken.cpu);try{expect(await cpuWorkAsync('crc32','bytes',65536,async()=>9)).toBe(9);pulseCpuWork();await broken.flush();}finally{end();}
});
test('repeated CPU phases retain bounded records and do not create a per-item log flood',async()=>{
 let calls=0,bytes=0;const d=backgroundDiagnostics(async(_m,a)=>{calls++;bytes+=String(a.text).length;return {}as any;});
 for(let i=0;i<50000;i++){void d.cpu(metric());void d.cpu(metric('crc32','complete'));}await d.flush();expect(calls).toBeLessThan(5);expect(bytes).toBeLessThan(13000);
});

test('a granted native trace bypasses the promise/file queue and carries numeric phase fields only',async()=>{
 const root=globalThis as any,previous=root.__podCpuTrace,rows:unknown[][]=[];let files=0;root.__podCpuTrace=(...args:unknown[])=>{rows.push(args);return true;};
 try{const d=backgroundDiagnostics(async()=>{files++;return {}as any;});await d.cpu(metric('json-parse'));await d.flush();expect(files).toBe(0);expect(rows).toEqual([[RESTORE_CPU_STAGES.indexOf('json-parse'),0,3,5000,0,0]]);expect(rows[0]!.every(value=>typeof value==='number')).toBe(true);}finally{if(previous===undefined)delete root.__podCpuTrace;else root.__podCpuTrace=previous;}
});
