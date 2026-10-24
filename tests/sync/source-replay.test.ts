import {test,expect} from 'bun:test';
import {fixture,parseUri} from './ble-v2-fixture';
import {SqlSourceSyncStore} from '../../src/sync/source-store';
test('signed source ordering survives full manifest echoes without writes, new clocks or cloud changes',async()=>{
 const f=await fixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,description,created_at,sort_order) VALUES(1,'https://fixture.invalid/rss','Fixture','',10,100)");
  const make=()=>new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000);
  const first=await make().export('watch');expect(first[0]?.sortOrder).toBe(-100);const baseline=f.changes();
  for(let i=0;i<3;i++){
   const reopened=make();expect(await reopened.merge(first,'phone','watch')).toBe(0);expect(await reopened.export('watch')).toEqual(first);expect(f.changes()).toBe(baseline);
  }
 }finally{f.sql.close();}
});
test('explicit negative reorder remains exact; only missing zero order uses the historical timestamp fallback',async()=>{
 const f=await fixture();try{
  const store=new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000),base={url:'https://fixture.invalid/rss',sourceDeviceId:'phone',title:'Fixture',description:'',siteUrl:null,imageUrl:null,createdAt:10,updatedAt:100,sortOrder:-50,isPinned:false,deleted:false,deletedAt:0};
  expect(await store.merge([base],'phone','watch')).toBe(1);expect((await store.export('watch'))[0]?.sortOrder).toBe(-50);
  const changed={...base,updatedAt:200,sortOrder:-70};expect(await store.merge([changed],'phone','watch')).toBe(1);expect((await store.export('watch'))[0]).toMatchObject({sortOrder:-70,updatedAt:200});expect(await store.merge([changed],'phone','watch')).toBe(0);
  expect(await store.merge([{...base,url:'https://zero.fixture.invalid/rss',sortOrder:0}],'phone','watch')).toBe(1);expect((await store.export('watch')).find(s=>s.url.includes('zero.'))?.sortOrder).toBe(100);
 }finally{f.sql.close();}
});
test('deleted-source replay excludes the production revision guard from applied counts and cloud changes',async()=>{
 const f=await fixture();let cleanups=0;try{
  const store=new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000,async()=>{cleanups++;});
  const base={url:'https://deleted.fixture.invalid/rss',sourceDeviceId:'phone',title:'Fixture',description:'',siteUrl:null,imageUrl:null,createdAt:10,updatedAt:100,sortOrder:100,isPinned:false,deleted:false,deletedAt:0};
  expect(await store.merge([base],'phone','watch')).toBe(1);const deleted={...base,updatedAt:200,deleted:true,deletedAt:200};expect(await store.merge([deleted],'phone','watch')).toBe(1);expect(cleanups).toBe(1);
  const before=await f.db.query('SELECT * FROM sync_source_states'),rev=await f.db.query('SELECT revision FROM sync_library_revision');
  for(let i=0;i<3;i++){expect(await store.merge([deleted],'phone','watch')).toBe(0);expect(await f.db.query('SELECT * FROM sync_source_states')).toEqual(before);expect(await f.db.query('SELECT revision FROM sync_library_revision')).toEqual(rev);expect(cleanups).toBe(1);}
 }finally{f.sql.close();}
});
