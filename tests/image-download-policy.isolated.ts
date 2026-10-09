import {expect,mock,test} from 'bun:test';
const events:any[]=[],emitted:any[]=[];
(globalThis as any).pod={capabilities:()=>JSON.stringify(['host.lifecycle','data.files.chunks','crypto.basic','net.download','image.decode']),takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,emit:(line:string)=>emitted.push(JSON.parse(line))};
mock.module('@pocketjs/framework/gesture',()=>({cancelActiveTouches(){}}));
mock.module('@pocketjs/framework/input',()=>({dispatchAccessibilityAction(){}}));
mock.module('@pocketjs/framework/services',()=>({registerServicePump(){}}));
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {imageCachePorts}=await import('../src/cache/host.ts');
const {ManagedCache}=await import('../src/cache/managed.ts');
const tick=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const reply=async(value:any)=>{events.push({t:'service.result',id:emitted.at(-1).id,ok:true,value});__pumpPodEvents();await tick();};
test('cards retain 8MiB while body and preview use configurable 64MiB streamed downloads',async()=>{
 for(const [inline,bound] of [[false,8*1024*1024],[true,64*1024*1024]] as const){
  const cache=new ManagedCache(imageCachePorts());const request=cache.acquire('https://arbitrary.example/original',{},inline);await tick();await reply({digestBase64:btoa('a'.repeat(32))});await reply({exists:false,file:false,size:0});
  expect(emitted.at(-1).method).toBe('http.download');expect(emitted.at(-1).args).toMatchObject({url:'https://arbitrary.example/original',maxBytes:bound,path:expect.stringMatching(inline?/\.inline\.img$/:/\.img$/)});
  // Cancellation propagates to the pending host download; a failed download
  // never reaches image validation or file.read of the source.
  request.cancel();expect(emitted.at(-1).t).toBe('service.cancel');const id=emitted.at(-1).id;events.push({t:'service.result',id,ok:false,error:{code:'cancelled',message:'cancelled'}});__pumpPodEvents();await expect(request.result).rejects.toThrow();await tick();
  expect(emitted.filter(x=>x.method==='file.read')).toHaveLength(0);
 }
 const ports=imageCachePorts({largeImageBytes:32*1024*1024});const op=ports.download('https://arbitrary.example/original','managed-cache/images/x.inline.img',{});expect(emitted.at(-1).args.maxBytes).toBe(32*1024*1024);await reply({});await op.result;
 expect(()=>imageCachePorts({largeImageBytes:65*1024*1024})).toThrow();
});
