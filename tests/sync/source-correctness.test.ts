import {test,expect} from 'bun:test';
import {fixture,parseUri} from './ble-v2-fixture';
import {SqlSourceSyncStore} from '../../src/sync/source-store';
const base={url:'https://synthetic.invalid/rss',sourceDeviceId:'device-b',title:'Fixture',description:'',siteUrl:null,imageUrl:null,createdAt:10,updatedAt:300,sortOrder:50,isPinned:false,deleted:false,deletedAt:0};
test('older deletion cannot destroy a newer explicit resubscription, including after reopen',async()=>{
 const f=await fixture();let cleanup=0;try{const make=()=>new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000,async()=>{cleanup++;});
 await make().merge([base],'peer','watch');const before=await f.db.query('SELECT * FROM sync_source_states'),revision=await f.db.query('SELECT revision FROM sync_library_revision');
 for(let i=0;i<3;i++){expect(await make().merge([{...base,updatedAt:200,deletedAt:200,deleted:true}],'peer','watch')).toBe(0);expect(await f.db.query('SELECT * FROM sync_source_states')).toEqual(before);expect(await f.db.query('SELECT revision FROM sync_library_revision')).toEqual(revision);expect((await make().export('watch'))[0]?.deleted).toBe(false);}
 expect(cleanup).toBe(0);expect((await f.db.query('SELECT * FROM channels')).length).toBe(1);
 }finally{f.sql.close();}
});
test('equal-clock lower writer deletion loses; newer deletion wins and duplicate is a no-op',async()=>{
 const f=await fixture();try{const s=new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000);await s.merge([base],'peer','watch');
 expect(await s.merge([{...base,sourceDeviceId:'device-a',deleted:true,deletedAt:300}],'peer','watch')).toBe(0);
 expect(await s.merge([{...base,updatedAt:400,deleted:true,deletedAt:400}],'peer','watch')).toBe(1);
 expect(await s.merge([{...base,updatedAt:400,deleted:true,deletedAt:400}],'peer','watch')).toBe(0);
 expect((await s.export('watch'))[0]).toMatchObject({deleted:true,deletedAt:400,updatedAt:400});
 }finally{f.sql.close();}
});
test('pre-sync local channel with newer clock is protected from an old remote tombstone',async()=>{
 const f=await fixture();try{await f.db.execute("INSERT INTO channels(url,title,created_at,sort_order) VALUES(?,?,?,?)",[base.url,'Local',500,-500]);
 const store=new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000);
 expect(await store.merge([{...base,deleted:true,deletedAt:300}],'peer','watch')).toBe(0);
 expect((await f.db.query('SELECT title FROM channels'))[0]?.title).toBe('Local');expect(await f.db.query('SELECT * FROM sync_source_states')).toHaveLength(0);
 }finally{f.sql.close();}
});
test('concurrent edit invalidates prepared source deletion transaction and preserves the channel',async()=>{
 const f=await fixture();try{const s=new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000);await s.merge([base],'peer','watch');
 const commit=f.db.transactionChanges!;let fired=false;
 f.db.transactionChanges=async ss=>{if(!fired){fired=true;await f.db.execute("UPDATE channels SET title='Concurrent local title' WHERE url=?",[base.url]);}return commit(ss);};
 await expect(s.merge([{...base,updatedAt:400,deleted:true,deletedAt:400}],'peer','watch')).rejects.toThrow();
 expect((await f.db.query('SELECT title FROM channels'))[0]?.title).toBe('Concurrent local title');expect((await f.db.query('SELECT deleted FROM sync_source_states'))[0]?.deleted).toBe(0);
 }finally{f.sql.close();}
});
