import {test,expect} from 'bun:test';
import {bookFixture} from '../books/fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {playbackWork,PlaybackWork} from '../../src/core/playback-work';
test('video and speech route owners defer local reconstruction until every route releases',async()=>{
 const f=await bookFixture(),video=playbackWork.hold(),speech=playbackWork.hold();let operations=0,done=false;
 const db={...f.db,query:async(...args:Parameters<typeof f.db.query>)=>{operations++;return f.db.query(...args);}};
 try{const repo=new SqlLibrarySessionRepository(db,f.ports);const task=repo.prepareFastProjection().then(()=>{done=true;});await new Promise(r=>setTimeout(r,20));expect(operations).toBe(0);expect(done).toBe(false);video();await new Promise(r=>setTimeout(r,10));expect(done).toBe(false);speech();await task;expect(done).toBe(true);expect(operations).toBeGreaterThan(0);}
 finally{video();speech();f.sql.close();}
});
test('deferred reconstruction rechecks cancellation without advancing work',async()=>{
 const gate=new PlaybackWork(),release=gate.hold();let cancelled=false,commits=0;const task=gate.wait(()=>{if(cancelled)throw Error('cancelled');}).then(()=>{commits++;});cancelled=true;release();await expect(task).rejects.toThrow('cancelled');expect(commits).toBe(0);
});
