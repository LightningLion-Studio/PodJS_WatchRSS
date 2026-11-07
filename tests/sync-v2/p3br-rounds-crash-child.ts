/** Synthetic subprocess only. The parent owns and removes its temporary root. */
import {fixture,body,item,id,now} from './p3b-fixture';
import {restoredSetup} from './p3br-formal-fixture';
import {SEVEN_DAYS} from '../../src/sync-v2/eviction';
const [mode,point]=process.argv.slice(2),formal=['handoff','release'].includes(mode),s=formal?await restoredSetup():null,f=s?null:await fixture(),cache=s?.cache??f!.cache,db=s?.f.db??f!.db;
let session:any,fresh:any,entries:any[]=[];
if(s){if(mode==='release'){await s.restore();s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);await s.installCurrent();}}
else {
 for(let n=0;n<(mode==='checked'?3:1);n++){const key=mode==='checked'?String(n).repeat(64):id;await f!.add({...body(key),item:{...item(key),dirty:mode==='checked'||mode==='claim'||mode==='end'}});}
 if(mode==='restore'){await cache.setAutoEvict(true);await f!.space.runWindow(1);fresh={id:'9'.repeat(64),path:cache.binding+'/'+'9'.repeat(64)+'.data',bytes:128};await cache.files.publish(fresh.path,new Uint8Array(128).fill(33));}
 session=await cache.beginRound();entries=(await cache.journal.page()).map(row=>({entityKey:row.id,version:row.revision,validUntil:null}));if(mode!=='checked')await cache.markExamined(session,entries);
}
console.log(JSON.stringify({root:s?.root??f!.root,database:formal?'projection.sqlite':'state.sqlite',binding:cache.binding,mode,point,session,entries,round:await cache.roundState(),id,resources:s?.resources??[]}));
const original=db.transaction.bind(db);db.transaction=async statements=>{
 const target=mode==='handoff'?statements.some(x=>x.sql.startsWith('INSERT INTO podjs_resource_rows')&&x.params?.some(p=>String(p).startsWith('edit-recovery:'))):mode==='release'?statements.some(x=>x.sql.startsWith('DELETE FROM podjs_resource_rows')&&x.params?.some(p=>String(p).startsWith('edit-recovery:'))):mode==='checked'?statements.some(x=>x.sql.startsWith('INSERT INTO sync2_space_examined')):mode==='claim'?statements.some(x=>x.sql.startsWith('UPDATE sync2_space_round SET round=')):mode==='end'?statements.some(x=>x.sql.startsWith('UPDATE sync2_space_round SET active=0')):statements.some(x=>x.sql.startsWith('UPDATE podjs_resource_rows'));
 if(!target)return original(statements);db.raw.exec('BEGIN IMMEDIATE');for(const x of statements)db.raw.query(x.sql).run(...x.params??[] as any);if(point==='after')db.raw.exec('COMMIT');process.kill(process.pid,'SIGKILL');throw Error('SIGKILL failed');
};
if(mode==='handoff')await s!.restore();else if(mode==='release')await s!.recovery.releaseAcknowledgedEdits();else if(mode==='checked')await cache.markExamined(session,entries);else if(mode==='claim')await cache.beginRound();else if(mode==='end')await cache.endRound(session);else if(mode==='touch')await cache.touch(id,{dirty:true});else await f!.space.restore(id,async()=>({resources:[fresh],size:128,read:async()=>new Uint8Array(128).fill(33)}));
throw Error('target transaction not found');
