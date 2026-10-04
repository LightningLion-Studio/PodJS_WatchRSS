import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {fileChunks,bytesToBase64} from '@podjs/framework/services';
import {NoteAssetReceiver} from '../../src/sync/note-assets.ts';
import native from '../fixtures/note-assets-native.json';
const key='note-assets-result';
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
async function run(){
 const started=Date.now(),paths=['notes/assets/test.png','notes/assets/.test.png.part'];let steps=0;
 for(const path of paths)check(!(await fileChunks.stat(path)).exists,'Fixture path already exists');
 for(const c of native.cases){
  const receiver=new NoteAssetReceiver(fileChunks);
  try{
   for(let i=0;i<c.steps.length;i++){
    const spec=c.steps[i] as Record<string,any>,request={...spec,data:spec.data??bytesToBase64(new Uint8Array(spec.dataLength).fill(spec.dataByte))};let response:unknown,error:unknown;
    try{response=await receiver.apply(request);}catch(e){error=e;}
    const expected=c.results[i] as {error?:string;response?:unknown;files:Record<string,{size:number;sha256:string}>};
    check(expected.error?!!error:!error,c.name+' '+i+' result: '+String(error));
    if(!expected.error){for(const [field,value] of Object.entries(expected.response as Record<string,unknown>))check((response as Record<string,unknown>)[field]===value,c.name+' response '+field);}
    for(const path of paths){const state=await fileChunks.stat(path),entry=expected.files[path];check(state.file===!!entry,c.name+' file existence '+path);if(entry){const hash=await fileChunks.hash(path);check(hash.size===entry.size&&hash.sha256===entry.sha256,c.name+' hash '+path);}}
    steps++;kv.set(key,{state:'running',scenario:c.name,steps});
   }
  }finally{for(const path of paths)await fileChunks.remove(path);}
 }
 kv.set(key,{state:'passed',nativeScenarios:native.cases.length,nativeSteps:steps,realHostFiles:true,chunk512KiB:true,hashValidation:true,preservedOldTarget:true,ownedFilesRemoved:true,elapsedMs:Date.now()-started});
}
mount(()=><Text>Note asset verification</Text>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
