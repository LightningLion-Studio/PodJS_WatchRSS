import {expect,mock,spyOn,test} from 'bun:test';
import {oracle} from './upstream-u10-loader.ts';
let logs:any[]=[];
mock.module(Bun.resolveSync('../src/logs/app-logger.ts',import.meta.dir),()=>({appLogger:{d:(...a:any[])=>logs.push(['d',...a]),i:(...a:any[])=>logs.push(['i',...a]),e:(...a:any[])=>logs.push(['e',...a])}}));
const media=await import('../src/media/transport.ts'),tts=await import('../src/tts/transport.ts'),oldMedia=await oracle('media/transport.ts'),oldTts=await oracle('tts/transport.ts');
const outcome=async(fn:()=>unknown)=>{try{return {value:await fn()};}catch(e){return {error:{name:(e as Error).name,message:(e as Error).message}};}};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const request={method:'POST',url:'https://api.test/private?token=secret',headers:{Cookie:'secret'},body:Uint8Array.of(1,2,3),timeoutMs:13000,readTimeoutMs:7000,acceptHttpErrors:true};
test('media raw profile preserves status, download arguments, reads, logs and cleanup on every result',async()=>{
 const spy=spyOn(Date,'now').mockReturnValue(123456);
 try{
  for(const mode of ['ok','zero','foreign','fractional','negative','nan','infinity','empty','overflow','read-error','download-error','remove-error']){
   async function run(api:any){logs=[];const events:any[]=[],payload=Uint8Array.from({length:19},(_,i)=>i+1);let reads=0;
    const ports={download:async(args:any)=>{events.push(['download',args]);if(mode==='download-error')throw Error('SocketTimeoutException: secret');return {path:mode==='foreign'?'other/file':args.path,size:mode==='zero'?0:mode==='fractional'?3.5:mode==='negative'?-1:mode==='nan'?NaN:mode==='infinity'?Infinity:payload.length,status:503,headers:{'content-type':'application/json'}};},read:async(path:string,offset:number)=>{events.push(['read',path,offset]);if(mode==='read-error'&&reads++>0)throw Error('read');if(mode==='empty')return new Uint8Array(0);if(mode==='overflow')return new Uint8Array(20);return payload.slice(offset,offset+3);},remove:async(path:string)=>{events.push(['remove',path]);if(mode==='remove-error')throw Error('cleanup');},base64:(v:Uint8Array)=>{events.push(['encode',[...v]]);return Buffer.from(v).toString('base64');}};
    const transport=api.createMediaTransport(ports),first=await outcome(()=>transport.request(request)),second=await outcome(()=>transport.request({...request,method:'GET',body:undefined,readTimeoutMs:undefined,timeoutMs:undefined,acceptHttpErrors:undefined})),third=await outcome(()=>transport.request({...request,method:'DELETE'}));
    return {first,second,third,events,logs};
   }
   expect(await run(media)).toEqual(await run(oldMedia));
  }
 }finally{spy.mockRestore();}
});
test('TTS strict profile validates allocation ownership and every size/path/offset/EOF/base64 boundary',async()=>{
 for(const mode of ['ok','zero','foreign-allocation','invalid-allocation-type','create-error','initial-remove-error','download-error','foreign-response','negative','fractional','too-large','unsafe','wrong-offset','wrong-size','base64-type','base64-long','base64-noncanonical','empty','premature-eof','missing-eof','read-error','final-remove-error']){
  async function run(api:any){logs=[];const events:any[]=[],owned='tts/.pod-write-fixture_123.part',payload=Uint8Array.from({length:65539},(_,i)=>i%251);let removes=0,reads=0;
   const ports={createTemp:async(dir:string)=>{events.push(['create',dir]);if(mode==='create-error')throw Error('create');return {path:mode==='foreign-allocation'?'tts/unowned.part':mode==='invalid-allocation-type'?42:owned};},download:async(args:any)=>{events.push(['download',args]);if(mode==='download-error')throw Error('late failed download');return {path:mode==='foreign-response'?'tts/other':args.path,size:mode==='zero'?0:mode==='negative'?-1:mode==='fractional'?3.5:mode==='too-large'?8388609:mode==='unsafe'?Number.MAX_SAFE_INTEGER+1:payload.length,status:429,headers:{'content-type':'audio/mpeg'}};},read:async(path:string,offset:number,max:number)=>{
    events.push(['read',path,offset,max]);if(mode==='read-error'&&reads++>0)throw Error('read');const part=payload.slice(offset,offset+max);return {offset:mode==='wrong-offset'?offset+1:offset,size:mode==='wrong-size'?payload.length+1:payload.length,dataBase64:mode==='base64-type'?null:mode==='base64-long'?'A'.repeat(4*Math.ceil(max/3)+1):mode==='base64-noncanonical'?'AB==':mode==='empty'?'':Buffer.from(part).toString('base64'),eof:mode==='premature-eof'?true:mode==='missing-eof'?false:offset+part.length===payload.length};},remove:async(path:string)=>{events.push(['remove',path]);removes++;if(mode==='initial-remove-error'&&removes===1||mode==='final-remove-error'&&removes===2)throw Error('remove');}};
   const result=await outcome(()=>api.createTtsTransport(ports).request(request));return {result,events,logs};
  }
  expect(await run(tts)).toEqual(await run(oldTts));
 }
});
test('request waits for owned cleanup after a delayed failure and never removes the result path',async()=>{
 for(const apiPair of [[media,oldMedia],[tts,oldTts]]){
  async function run(api:any){logs=[];const events:any[]=[],owned='tts/.pod-write-delayed.part';let reject!:(e:unknown)=>void,removeDone!:(v?:unknown)=>void,removes=0,done=false;
   const ports={createTemp:async()=>({path:owned}),download:()=>new Promise((_r,j)=>{events.push('download');reject=j;}),read:async()=>new Uint8Array(0),base64:()=>'',remove:(path:string)=>{events.push(['remove',path]);if(api.createMediaTransport||++removes>1)return new Promise(resolve=>removeDone=resolve);return Promise.resolve();}};
   const requestPromise=outcome(()=>api.createMediaTransport?api.createMediaTransport(ports).request(request):api.createTtsTransport(ports).request(request)).then(result=>{done=true;return result;});await settle();reject(Error('late'));await settle();events.push(['settled-before-cleanup',done]);removeDone();const result=await requestPromise;return {events,result,logs};
  }
  const spy=spyOn(Date,'now').mockReturnValue(9876);try{expect(await run(apiPair[0])).toEqual(await run(apiPair[1]));}finally{spy.mockRestore();}
 }
});
