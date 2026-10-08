import {expect,test} from 'bun:test';
import {LifecycleReadingProgressStore} from '../src/reader/lifecycle-progress.ts';
import {ReadingProgressWriteQueue} from '../src/reader/progress-write-queue.ts';
import {normalizeReadingProgress} from '../src/reader/progress.ts';
const value=(offset:number,updatedAt=100)=>normalizeReadingProgress({offset,updatedAt,progress:offset/1000,textAnchor:{character:offset,fraction:.25}});
function storage(){const values=new Map<string,unknown>();return {values,get:<T>(key:string)=>values.get(key) as T|undefined,set:(key:string,v:unknown)=>{values.set(key,JSON.parse(JSON.stringify(v)));},delete:(key:string)=>values.delete(key)};}

test('an older queued/inflight SQL sample cannot erase a newer lifecycle checkpoint',async()=>{
 const disk=storage(),queue=new ReadingProgressWriteQueue();let stored=value(1),release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 const sql={load:async()=>stored,save:async(_id:number,offset:number)=>{await gate;stored=value(offset);}};
 const store=new LifecycleReadingProgressStore(sql,disk);
 const old=queue.enqueue(store.prepareSave(7,value(40)));
 store.checkpoint(7,value(419,200));
 release();await old;
 expect(disk.get<any>('watchrss.reader.checkpoint.7').value.offset).toBe(419);
 // A new cold realm reconciles to SQL, then removes exactly its durable snapshot.
 const cold=new LifecycleReadingProgressStore(sql,disk);
 expect((await cold.load(7)).offset).toBe(419);expect(stored.offset).toBe(419);expect(disk.values.size).toBe(0);
});

test('a later foreground sample acknowledges an old checkpoint; an older acknowledgement cannot delete a replacement',async()=>{
 const disk=storage();let stored=value(1),release!:()=>void;
 let gate=Promise.resolve();const sql={load:async()=>stored,save:async(_id:number,offset:number)=>{await gate;stored=value(offset);}};
 const store=new LifecycleReadingProgressStore(sql,disk);store.checkpoint(7,value(100));
 await store.prepareSave(7,value(105))();expect(disk.values.size).toBe(0);
 store.checkpoint(7,value(200));gate=new Promise<void>(resolve=>release=resolve);
 const writing=store.prepareSave(7,value(210))();store.checkpoint(7,value(220));release();await writing;
 expect(disk.get<any>('watchrss.reader.checkpoint.7').value.offset).toBe(220);
});

test('a failed recovery keeps the checkpoint; a newer synchronized position wins',async()=>{
 const disk=storage();const failed=new LifecycleReadingProgressStore({load:async()=>value(1),save:async()=>{throw Error('SQL offline');}},disk);
 failed.checkpoint(7,value(419));await expect(failed.load(7)).rejects.toThrow('SQL offline');expect(disk.values.size).toBe(1);
 const synced=new LifecycleReadingProgressStore({load:async()=>value(800,101),save:async()=>{throw Error('must not overwrite sync');}},disk);
 expect((await synced.load(7)).offset).toBe(800);expect(disk.values.size).toBe(0);
});

test('imported anchors retain chunk and header/footer positions through process loss',async()=>{
 const disk=storage(),snapshot=normalizeReadingProgress({offset:730,progress:.75,updatedAt:100,importedAnchor:{marker:'book',chunkIndex:4,charOffset:83,fraction:.2,section:'footer',sectionOffset:11}});
 const sql={load:async()=>value(1),save:async()=>{}};
 new LifecycleReadingProgressStore(sql,disk).checkpoint(7,snapshot);
 expect(await new LifecycleReadingProgressStore(sql,disk).load(7)).toEqual(snapshot);
});


test('production list lifecycle checkpoint survives a cold realm with saved scroll only',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',new URL('./activity-lifecycle.isolated.ts',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
});
