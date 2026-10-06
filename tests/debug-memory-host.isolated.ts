import {expect,test} from 'bun:test';
const debug=process.env.WRSS_MEMORY_DEBUG==='1';
const events:unknown[]=[],requests:any[]=[];
(globalThis as any).pod={capabilities:()=>JSON.stringify(['host.lifecycle']),
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(line:string)=>requests.push(JSON.parse(line))};
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {initializeDebugBuild}=await import('../src/debug/host.ts');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('default host buildInfo controls SDK memory hook installation',async()=>{
 expect((globalThis as any).__podMemoryStats).toBeUndefined();
 const enabled=initializeDebugBuild();await tick();
 expect(requests).toHaveLength(1);expect(requests[0].method).toBe('app.buildInfo');
 events.push({t:'service.result',id:requests[0].id,ok:true,value:{debugBuild:debug}});__pumpPodEvents();
 expect(await enabled).toBe(debug);
 if(debug){
  const read=(globalThis as any).__podMemoryStats;
  expect(typeof read).toBe('function');const stats=JSON.parse(read());
  expect(stats.services.pending).toBe(0);expect(stats.systemText.cached).toBe(0);
  expect(stats.tree.retained).toBe(0);expect(stats.frame.callbacks).toBe(0);
 }else expect((globalThis as any).__podMemoryStats).toBeUndefined();
 expect(requests).toHaveLength(1); // Installing stats starts no guest timer/service request.
});
