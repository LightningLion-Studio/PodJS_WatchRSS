import {expect,test} from 'bun:test';
import {orderLegacyChapters} from '../../src/books/legacy-order';
test('13830 SQL-lexical chapter URLs parse each ordinal once, yield bounded slices and preserve numeric ordering',async()=>{
 let reads=0,slices=0;const input=Array.from({length:13830},(_,i)=>({id:i,get link(){reads++;return 'https://watchrss.local/import-epub/fixture/chapter/'+i;}})).sort((a,b)=>a.id.toString()<b.id.toString()?-1:1);
 const result=await orderLegacyChapters(input,undefined,{yieldTurn:async()=>{},stepLimit:1024,onSlice:(_ms,n)=>{slices++;expect(n).toBeLessThanOrEqual(1024);}});
 expect(reads).toBe(input.length);expect(slices).toBeGreaterThan(16);expect(result.ordinals).toEqual(Array.from({length:input.length},(_,i)=>i));expect(result.rows.map(r=>r.id)).toEqual(result.ordinals);expect(input[2]!.id).toBe(10);
});
test('legacy ties and missing ordinals preserve the old URL tie order; cancellation stops instead of publishing',async()=>{
 const input=[{link:'b/chapter/2'},{link:'a/chapter/2'},{link:'no-number'},{link:'x/chapter/1'}];const r=await orderLegacyChapters(input,undefined,{yieldTurn:async()=>{}});expect(r.rows.map(v=>v.link)).toEqual(['no-number','x/chapter/1','a/chapter/2','b/chapter/2']);
 let cancelled=false;await expect(orderLegacyChapters(input,()=>{if(cancelled)throw Error('cloud_sync_suspended');},{yieldTurn:async()=>{cancelled=true;}})).rejects.toThrow('cloud_sync_suspended');
});
