import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {initializeSchema} from '../../src/core/schema.ts';
import {SqlLibrarySequenceStore,changeLogStatement} from '../../src/sync/sequence-store.ts';
import {fixture,sessionFixtureParts,replaySessionFixture} from '../helpers/library-session-fixture.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
function database(){const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async statements=>{sql.transaction(()=>{for(const s of statements)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};return {db,sql};}
test('native session ACK outcomes persist the same peer cursors in SQLite',async()=>{
 const f=database();try{await initializeSchema(f.db);const store=new SqlLibrarySequenceStore(f.db,()=>1789340000000);
  for(const row of fixture.cases){await f.db.execute('DELETE FROM sync_peer_state');await replaySessionFixture(row,repo=>{repo.markSuccess=p=>store.markSuccess(p);});
   const r=(await f.db.query('SELECT * FROM sync_peer_state'))[0];const actual=r?{localSeq:Number(r.last_local_seq_acked),remoteSeq:Number(r.last_remote_seq_applied),protocol:Number(r.last_protocol_version),fullSync:Number(r.last_full_sync_at)>0}:null;expect({case:row.input.name,peer:actual}).toEqual({case:row.input.name,peer:row.peer});
  }
 }finally{f.sql.close();}
});
test('native new-peer preparation repairs article changes once and later ACK selects a delta',async()=>{
 const f=database();try{await initializeSchema(f.db);const row=fixture.cases.find(c=>c.input.name==='outgoing-saved-article')!,parts=sessionFixtureParts(row),clock=1789340000000,store=new SqlLibrarySequenceStore(f.db,()=>clock);
  const sources=async(ids?:readonly string[])=>ids?parts.window.rssSources.filter(s=>ids.includes(s.url)):parts.window.rssSources;
  expect(await store.prepareWindow('phone-test',row.deviceId,parts.window.fullArticleManifest,sources,0)).toEqual(parts.window);
  expect((await f.db.query('SELECT reason FROM sync_change_log'))[0]?.reason).toBe('repairState');await store.prepareWindow('phone-test',row.deviceId,parts.window.fullArticleManifest,sources,0);expect((await store.cursor('phone-test')).localMaxSeq).toBe(1);
  await store.markSuccess({remoteDeviceId:'phone-test',localSeqToInclusive:1,remoteSeqToInclusive:71,remoteProtocolVersion:14,fullSnapshot:true});const delta=await store.prepareWindow('phone-test',row.deviceId,parts.window.fullArticleManifest,sources,1);expect(delta.fullSnapshot).toBe(false);expect(delta.articleManifest).toEqual([]);expect(delta.rssSources).toEqual([]);
  expect((await store.prepareWindow('phone-test',row.deviceId,parts.window.fullArticleManifest,sources,0)).fallbackReason).toBe('peerCursorBehind');expect((await store.prepareWindow('phone-test',row.deviceId,parts.window.fullArticleManifest,sources,99)).fallbackReason).toBe('peerCursorAhead');
  const statement=changeLogStatement('rssSource',parts.window.rssSources[0]!.url,201,row.deviceId,'sourceState',clock);await f.db.execute(statement.sql,statement.params);const sourceDelta=await store.prepareWindow('phone-test',row.deviceId,parts.window.fullArticleManifest,sources,1);expect(sourceDelta.articleManifest).toEqual([]);expect(sourceDelta.rssSources).toEqual(parts.window.rssSources);expect(sourceDelta.toSeqInclusive).toBe(2);
 }finally{f.sql.close();}
});
test('failed peer persistence cannot partially move cursors and older ACKs never regress them',async()=>{
 const f=database();try{await initializeSchema(f.db);let clock=100;const store=new SqlLibrarySequenceStore(f.db,()=>clock),pending={remoteDeviceId:'p',localSeqToInclusive:8,remoteSeqToInclusive:7,remoteProtocolVersion:14,fullSnapshot:true};await store.markSuccess(pending);await f.db.execute("CREATE TRIGGER fail_peer BEFORE UPDATE ON sync_peer_state BEGIN SELECT RAISE(ABORT,'disk full'); END");clock=200;await expect(store.markSuccess({...pending,remoteSeqToInclusive:99})).rejects.toThrow('disk full');expect((await store.cursor('p')).lastRemoteSeqApplied).toBe(7);await f.db.execute('DROP TRIGGER fail_peer');await store.markSuccess({...pending,localSeqToInclusive:1,remoteSeqToInclusive:1,fullSnapshot:false});expect(await f.db.query('SELECT last_local_seq_acked,last_remote_seq_applied,last_full_sync_at,updated_at FROM sync_peer_state')).toEqual([{last_local_seq_acked:8,last_remote_seq_applied:7,last_full_sync_at:100,updated_at:200}]);
 }finally{f.sql.close();}
});
