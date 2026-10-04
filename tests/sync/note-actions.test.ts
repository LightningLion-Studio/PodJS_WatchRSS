import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {MemoRepository} from '../../src/notes/index.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {parseSyncedNotes} from '../../src/sync/note-actions.ts';
function fixture(){const raw=new Database(':memory:');const db={query:async(sql:string,p:readonly unknown[]=[])=>raw.query(sql).all(...p as any[]) as Record<string,unknown>[],execute:async(sql:string,p:readonly unknown[]=[])=>{raw.query(sql).run(...p as any[]);},transaction:async(s:{sql:string;params?:readonly unknown[]}[])=>{raw.transaction(()=>{for(const x of s)raw.query(x.sql).run(...(x.params??[]) as any[]);})();}};const repo=new MemoRepository(db,'watch');let changed=0;const handle=createApplicationActionHandler({notes:repo,deviceId:async()=>'watch-id',notesChanged:()=>{changed++;}});return {raw,repo,handle,changes:()=>changed};}
const remote=(more:Record<string,unknown>={})=>({noteId:'a',markdown:'# phone',contentHash:'same',baseContentHash:'same',updatedAt:100,...more});
test('native note conflict rule includes clean older overwrite, dirty protection, equal timestamp and tombstones',async()=>{
 const f=fixture();try{
  expect(await f.handle({action:'syncNotes',notes:[remote()]})).toMatchObject({success:true,version:1,deviceId:'watch-id',applied:1});
  expect(await f.handle({action:'syncNotes',notes:[remote({updatedAt:1,markdown:'older clean baseline',contentHash:'dirty'})]})).toMatchObject({applied:1});
  expect(await f.handle({action:'syncNotes',notes:[remote({updatedAt:0,markdown:'stale'})]})).toMatchObject({applied:0});
  expect((await f.repo.get('a'))?.markdown).toBe('older clean baseline');
  expect(await f.handle({action:'syncNotes',notes:[remote({updatedAt:1,deleted:true,deletedAt:1})]})).toMatchObject({applied:1});
  expect(await f.repo.list()).toEqual([]);
  const response=await f.handle({action:'syncNotes'});expect(response).toMatchObject({applied:0,notes:[{noteId:'a',deleted:true}]});expect((response.notes as any[])[0]).not.toHaveProperty('plainText');
 }finally{f.raw.close();}
});
test('malformed later entry does not partially apply earlier notes and sends failure',async()=>{const f=fixture();try{await f.repo.initialize();expect(await f.handle({action:'syncNotes',notes:[remote(),null]})).toMatchObject({success:false});expect(await f.repo.allIncludingDeleted()).toEqual([]);expect(f.changes()).toBe(0);}finally{f.raw.close();}});
test('wire defaults preserve markdown and folder null, with incoming booleans and times',()=>{expect(parseSyncedNotes({notes:[{noteId:'a',markdown:'x\r\ny',pinned:'true',updatedAt:'10'}]})).toMatchObject([{folderId:null,markdown:'x\r\ny',pinned:true,updatedAt:10,deleted:false}]);expect(()=>parseSyncedNotes({notes:[{}]})).toThrow('缺少笔记 ID');});
test('duplicate incoming IDs apply sequentially as native repository does',async()=>{const f=fixture();try{expect(await f.handle({action:'syncNotes',notes:[remote(),remote({markdown:'last'})]})).toMatchObject({applied:2});expect((await f.repo.get('a'))?.markdown).toBe('last');expect(f.changes()).toBe(1);expect(await f.handle({action:'unknown'})).toMatchObject({success:false,errorCode:'unsupported_action'});}finally{f.raw.close();}});

test('framed persistent session routes notes and continues after a rejected action',async()=>{
 const {LibrarySyncSession}=await import('../../src/sync/session.ts');const f=fixture();let closed=false;const written:Record<string,unknown>[]=[];
 const input=[{action:'syncNotes',notes:[remote()],requestPersistentSession:true,supportsPersistentSession:true},{action:'ack',success:true,applied:true},{action:'syncNotes',notes:[null]},{action:'ack',success:true,applied:true},{action:'syncSession',phase:'complete'},{action:'ack',success:true,applied:true}];
 try{
  const repository={deviceId:async()=>'watch-id'} as import('../../src/sync/session.ts').LibrarySessionRepository;
  const session=new LibrarySyncSession({readFrame:async()=>{const next=input.shift();if(!next)throw new Error('Unexpected read');return next;},writeFrame:async(frame)=>{written.push(frame);},close:async()=>{closed=true;}},repository,{handleAction:f.handle});
  const result=await session.run();expect(result).toHaveLength(3);expect(result[0].ack?.applied).toBe(true);expect(written[0]).toMatchObject({action:'syncNotes',success:true,applied:1,persistentSessionAccepted:true});expect(written[1]).toMatchObject({success:false});expect(written[2]).toMatchObject({action:'syncSession',success:true});expect(await f.repo.list()).toHaveLength(1);expect(closed).toBe(true);
 }finally{f.raw.close();}
});
