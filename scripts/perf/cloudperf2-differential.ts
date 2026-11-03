import {checkMerge,checkMergeEdges} from '../../tests/cloud/fixtures/cloudperf2-merge-cases';
async function run(ctx:any){
 if(!(globalThis as any).__podByteCodecs?.mergeJsonRegisters)throw Error('native merge missing');
 let calls=0,accepted=0;const port=(globalThis as any).__podByteCodecs,original=port.mergeJsonRegisters;
 port.mergeJsonRegisters=(...a:any[])=>{calls++;const result=original(...a);if(result)accepted++;return result;};
 await ctx.request('perf',{event:'start',stage:'merge-differential',bytes:0,items:1010});
 checkMergeEdges();for(let i=0;i<1000;i++)checkMerge(i);
 await ctx.request('perf',{event:'end',stage:'merge-differential',bytes:0,items:1010,nativeCalls:calls,nativeAccepted:accepted});
 await ctx.request('perf',{event:'start',stage:'large-library-differential',bytes:0,items:10000});
 let bytes=0;for(let i=0;i<10000;i++)bytes+=checkMerge(i,i%100===0);
 await ctx.request('perf',{event:'end',stage:'large-library-differential',bytes,items:10000,nativeCalls:calls,nativeAccepted:accepted});return 'success';
};

(globalThis as any).backgroundHandler=async(ctx:any)=>{try{return await run(ctx);}catch(error){await ctx.request("perf",{event:"end",stage:"failure",error:String(error),stack:(error as Error).stack});throw error;}};
