import {test,expect} from 'bun:test';
import {missingPage,type MissingIndex} from '../../src/sync/library-binary/missing';
import {Grant,ObjectSlots,StreamBindings} from '../../src/sync/library-binary/state';
import {appliedReceipt} from '../../src/sync/library-binary/digests';
import {hash} from '../../src/sync/library-binary/wire';
import {object,binding,selection,request} from './helpers';
const snapshot={state:'READY',nextManifestPage:1,expiresAtMillis:30000,completion:null,admitted:true};
function fixture(){const o=object(),index:MissingIndex={objectCount:1,locate:async id=>id===o.objectId?0:null,at:async n=>n===0?o:null,receipt:async()=>null,readChunk:async()=>null,objectStaged:async()=>false};return {o,index,grant:new Grant('c',1),r:request('missing',{afterObjectId:null,afterChunkIndex:null,limit:1})};}
test('disconnect before ACK queries only actual durable blocks; corrupt local chunk becomes missing',async()=>{
 const f=fixture();expect((await missingPage(f.r,binding,f.grant,selection,f.index,snapshot)).items).toMatchObject([{state:'PENDING',missingRanges:[[0,1]]}]);
 f.index.readChunk=async()=>new Uint8Array([97,98,99]);f.index.objectStaged=async()=>true;expect((await missingPage(f.r,binding,f.grant,selection,f.index,snapshot)).items).toMatchObject([{state:'STAGED',missingRanges:[]}]);
 f.index.readChunk=async()=>new Uint8Array([97,98,100]);expect((await missingPage(f.r,binding,f.grant,selection,f.index,snapshot)).items).toMatchObject([{state:'PENDING',missingRanges:[[0,1]]}]);
});
test('APPLIED inventory uses full business receipt without released staging files',async()=>{
 const f=fixture(),apply=request('apply',{objectId:f.o.objectId}),receipt=appliedReceipt(apply,f.o.objectId,'watch','merged');f.index.receipt=async()=>receipt;f.index.readChunk=async()=>{throw Error('released staging must not be touched');};
 const result=await missingPage(f.r,binding,f.grant,selection,f.index,snapshot);expect(result.items).toMatchObject([{state:'APPLIED',missingRanges:[],receipt}]);
 f.index.receipt=async()=>({...receipt,resultDigest:'f'.repeat(64)});await expect(missingPage(f.r,binding,f.grant,selection,f.index,snapshot)).rejects.toThrow('RECEIPT_CONFLICT');
});
test('PLANNING heartbeat reads no index; positive limit is fenced by peak admission',async()=>{
 const f=fixture();f.index.at=async()=>{throw Error('no data lookup');};f.r=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0});
 expect(await missingPage(f.r,binding,f.grant,selection,f.index,{...snapshot,state:'PLANNING',admitted:false})).toMatchObject({state:'PLANNING',items:[],done:true});
 f.r=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:1});await expect(missingPage(f.r,binding,f.grant,selection,f.index,{...snapshot,admitted:false})).rejects.toThrow('MANIFEST_INCOMPLETE');
});
test('missing paginates ranges within fixed limits and keeps cursor within original object',async()=>{
 const f=fixture(),bytes=new Uint8Array(65536);f.o.size=65536*6;f.o.chunkHashes=Array(6).fill(hash(bytes));f.index.readChunk=async(_o,n)=>n%2?bytes:null;
 const s={...selection,limits:{...selection.limits,maxRangesPerPage:2}};
 const first=await missingPage(f.r,binding,f.grant,s,f.index,snapshot);expect(first.items).toMatchObject([{missingRanges:[[0,1],[2,3]]}]);expect(first.next).toEqual({afterObjectId:f.o.objectId,afterChunkIndex:3});expect(first.done).toBe(false);
 const next=request('missing',{...(first.next as object),limit:1});const second=await missingPage(next,binding,f.grant,s,f.index,snapshot);expect(second.items).toMatchObject([{missingRanges:[[4,5]]}]);expect(second.done).toBe(true);

});
test('stream identity is immutable across completion/replan',()=>{
 const b=new StreamBindings();b.bind(binding);b.bind({...binding});for(const changed of [{jobId:'a'.repeat(32)},{planDigest:'b'.repeat(64)},{selectionDigest:'c'.repeat(64)}])expect(()=>b.bind({...binding,...changed})).toThrow('PLAN_CONFLICT');
});
test('object slots preserve dependencies, two directions and M=1 sequencing',()=>{
 const slots=new ObjectSlots(4,true);expect(()=>slots.acquire('1'.repeat(64),1,false)).toThrow('DEPENDENCIES_PENDING');slots.acquire('1'.repeat(64),1,true);slots.acquire('2'.repeat(64),1,true);expect(()=>slots.acquire('3'.repeat(64),1,true)).toThrow('WINDOW_FULL');slots.acquire('4'.repeat(64),2,true);slots.acquire('5'.repeat(64),2,true);
 const one=new ObjectSlots(1,true);expect(()=>one.acquire('1'.repeat(64),2,true)).toThrow('WINDOW_FULL');one.acquire('2'.repeat(64),1,true);one.applied('2'.repeat(64),1);one.acquire('1'.repeat(64),2,true,true);
});
test('identical object IDs in opposite jobs use distinct object slots',()=>{
 const slots=new ObjectSlots(2,true),id='a'.repeat(64);slots.acquire(id,1,true);slots.acquire(id,2,true);slots.applied(id,1);expect(()=>slots.acquire('b'.repeat(64),2,true)).toThrow('WINDOW_FULL');slots.acquire('b'.repeat(64),1,true);
});
