import {test,expect} from 'bun:test';
import {fixture,body,item,now} from './p3b-fixture';
import {SEVEN_DAYS} from '../../src/sync-v2/eviction';
import {WatchSpaceV2} from '../../src/sync-v2/space';

test('REREVIEW2 an RSS aging past exactly seven days must precede an import on resume',async()=>{
 const f=await fixture();try{
  const rss='0'.repeat(64),blocked='1'.repeat(64),imported='2'.repeat(64);
  await f.add({...body(rss),item:{...item(rss),addedAtMillis:now-SEVEN_DAYS}});
  await f.add({...body(blocked),item:{...item(blocked),dirty:true}});
  await f.add({...body(imported),item:{...item(imported),kind:'import'}});
  await f.cache.setAutoEvict(true);let tick=0;f.space.ports.monotonic=()=>tick++;
  const paused=await f.space.runWindow(1,4);expect(paused.status).toBe('budget');
  f.clock=now+1;
  const result=await f.space.runWindow(1,10000),rssStatus=(await f.cache.open((await f.cache.journal.row(rss))!)).status,importStatus=(await f.cache.open((await f.cache.journal.row(imported))!)).status;
  console.log(JSON.stringify({case:'rss-seven-day-crossing',paused,rssStatus,importStatus,result}));
  expect(rssStatus).toBe('placeholder');expect(importStatus).toBe('ready');
 }finally{f.close();}
});

test('REREVIEW2 exhausted stale controller must not erase a newer paused round',async()=>{
 const f=await fixture();try{
  for(let n=0;n<4;n++){const key=n.toString(16).padStart(64,'0');await f.add({...body(key),item:{...item(key),dirty:true}});}
  await f.cache.setAutoEvict(true);
  const seed=await f.cache.beginRound();await f.cache.markExamined(seed,(await f.cache.journal.page()).map(r=>({entityKey:r.id,version:r.revision,validUntil:null})));
  const original=f.cache.uncheckedPage.bind(f.cache);let newer:any,hook=true;
  f.cache.uncheckedPage=async(session,time,limit=32)=>{
   const rows=await original(session,time,limit);
   if(hook&&rows.length===0){hook=false;
    await f.cache.touch('0'.repeat(64),{openedNow:true});
    const available='f'.repeat(64);await f.add({...body(available),item:{...item(available),kind:'import'}});
    let tick=0;const second=new WatchSpaceV2(f.cache,{...f.space.ports,monotonic:()=>tick++});
    const result=await second.runWindow(1,4);expect(result.status).toBe('budget');newer={state:await f.cache.roundState(),checked:await f.cache.examinedPage(await f.cache.roundState())};expect(newer.checked.length).toBeGreaterThan(0);
   }
   return rows;
  };
  const result=await f.space.runWindow(1,10000),after={state:await f.cache.roundState(),checked:await f.cache.examinedPage(await f.cache.roundState())};
  console.log(JSON.stringify({case:'stale-exhaustion-reset',newer,after,result}));
  expect(after).toEqual(newer);expect(result.status).toBe('candidates-changed');
 }finally{f.close();}
});

test('ROUNDS opened-at seven-day boundary expires a checked decision without a row write',async()=>{
 const f=await fixture();try{
  const rss='0'.repeat(64),blocked='1'.repeat(64),imported='2'.repeat(64);await f.add({...body(rss),item:{...item(rss),lastOpenedAtMillis:now-SEVEN_DAYS}});await f.add({...body(blocked),item:{...item(blocked),dirty:true}});await f.add({...body(imported),item:{...item(imported),kind:'import'}});await f.cache.setAutoEvict(true);let tick=0;f.space.ports.monotonic=()=>tick++;
  expect((await f.space.runWindow(1,4)).status).toBe('budget');const session=await f.cache.roundState(),checked=(await f.cache.examinedPage(session)).find(r=>r.entityKey===rss)!;expect(checked.validUntil).toBe(now+1);const revision=(await f.cache.journal.row(rss))!.revision;
  f.clock=now+1;expect((await f.space.runWindow(1,10000)).freed).toBe(128);expect(checked.version).toBe(revision);expect((await f.cache.open((await f.cache.journal.row(rss))!)).status).toBe('placeholder');expect((await f.cache.open((await f.cache.journal.row(imported))!)).status).toBe('ready');
 }finally{f.close();}
});

test('ROUNDS repeated small windows skip checked metadata and reach a deep candidate',async()=>{
 const f=await fixture();try{
  for(let n=0;n<96;n++){const id=n.toString(16).padStart(64,'0');await f.cache.add({...body(id),item:{...item(id),dirty:true}},[]);}const tail='f'.repeat(64);await f.add({...body(tail),item:{...item(tail),kind:'import'}});await f.cache.setAutoEvict(true);let tick=0;f.space.ports.monotonic=()=>tick++;const before=f.host.readBytes;let scanned=0,freed=0;
  for(let n=0;n<49;n++){const window=await f.space.runWindow(1,4);scanned+=window.scanned;freed+=window.freed;if(freed)break;expect(window.status).toBe('budget');}
  expect(scanned).toBe(97);expect(freed).toBe(128);expect(f.host.readBytes-before).toBe(0);expect(f.db.maxRows).toBeLessThanOrEqual(32);expect((await f.cache.roundState()).active).toBe(false);expect((await f.db.query('SELECT COUNT(*) AS n FROM sync2_space_examined'))[0].n).toBe(97);
 }finally{f.close();}
});

test('ROUNDS a replaced controller cannot mark, finish or commit a placeholder',async()=>{
 const f=await fixture();try{
  await f.add();const row=(await f.cache.journal.page())[0],old=await f.cache.beginRound(),latest=await f.cache.beginRound();await f.cache.markExamined(latest,[{entityKey:row.id,version:row.revision,validUntil:null}]);const state=await f.cache.roundState(),checked=await f.cache.examinedPage(latest),sync=await f.projection.readState();
  await expect(f.cache.markExamined(old,[{entityKey:row.id,version:'999',validUntil:now+1}])).rejects.toThrow('round_stale');await expect(f.cache.endRound(old)).rejects.toThrow('round_stale');
  await expect(f.projection.controlUpdate(sync,{...sync},[...f.cache.headGuard(old,row,now),...f.cache.journal.replace(row,await f.cache.seal(row.id,{...body(),status:'placeholder'}))])).rejects.toThrow('choice_stale');
  expect(await f.cache.roundState()).toEqual(state);expect(await f.cache.examinedPage(latest)).toEqual(checked);expect(await f.projection.readState()).toEqual(sync);expect((await f.cache.open((await f.cache.journal.row(row.id))!)).status).toBe('ready');
 }finally{f.close();}
});

test('ROUNDS stale successful completion preserves successor checks and reports actual freed bytes',async()=>{
 const f=await fixture();try{
  for(let n=0;n<4;n++){const id=n.toString(16).padStart(64,'0');await f.add({...body(id),item:{...item(id),dirty:n>0}});}await f.cache.setAutoEvict(true);const end=f.cache.endRound.bind(f.cache);let newer:any,hook=true;
  f.cache.endRound=async session=>{if(hook){hook=false;let tick=0;expect((await new WatchSpaceV2(f.cache,{...f.space.ports,monotonic:()=>tick++}).runWindow(1,4)).status).toBe('budget');newer={state:await f.cache.roundState(),checked:await f.cache.examinedPage(await f.cache.roundState())};}return end(session);};
  const result=await f.space.runWindow(1,10000);expect(result.status).toBe('candidates-changed');expect(result.freed).toBe(128);expect({state:await f.cache.roundState(),checked:await f.cache.examinedPage(await f.cache.roundState())}).toEqual(newer);
 }finally{f.close();}
});

test('ROUNDS stale capacity result cannot end a successor window',async()=>{
 const f=await fixture();try{
  for(let n=0;n<3;n++){const id=n.toString(16).padStart(64,'0');await f.add({...body(id),item:{...item(id),dirty:true}});}await f.cache.setAutoEvict(true);let newer:any;f.space.ports.capacity=async()=>{let tick=0;expect((await new WatchSpaceV2(f.cache,{...f.space.ports,capacity:async()=>0,monotonic:()=>tick++}).runWindow(1,4)).status).toBe('budget');newer={state:await f.cache.roundState(),checked:await f.cache.examinedPage(await f.cache.roundState())};return 1;};
  const result=await f.space.runWindow(1,10000);expect(result.status).toBe('candidates-changed');expect(result.freed).toBe(0);expect({state:await f.cache.roundState(),checked:await f.cache.examinedPage(await f.cache.roundState())}).toEqual(newer);
 }finally{f.close();}
});

test('ROUNDS time crossing during an import proof rechecks the higher RSS before placeholder commit',async()=>{
 const f=await fixture();try{
  const rss='0'.repeat(64),imported='1'.repeat(64);await f.add({...body(rss),item:{...item(rss),addedAtMillis:now-SEVEN_DAYS}});await f.add({...body(imported),item:{...item(imported),kind:'import'}});await f.cache.setAutoEvict(true);f.beforeProof=async()=>{f.beforeProof=undefined;f.clock=now+1;};
  expect((await f.space.runWindow(1)).status).toBe('candidates-changed');expect((await f.cache.open((await f.cache.journal.row(imported))!)).status).toBe('ready');expect((await f.space.runWindow(1)).freed).toBe(128);expect((await f.cache.open((await f.cache.journal.row(rss))!)).status).toBe('placeholder');
 }finally{f.close();}
});

test('ROUNDS examined storage stays bounded across completed rounds',async()=>{
 const f=await fixture();try{
  for(let n=0;n<16;n++){const id=n.toString(16).padStart(64,'0');await f.cache.add({...body(id),item:{...item(id),dirty:true}},[]);}await f.cache.setAutoEvict(true);
  for(let n=1;n<=10;n++){expect((await f.space.runWindow(1,10000)).scanned).toBe(16);expect(await f.cache.roundState()).toMatchObject({round:String(n),active:false});expect((await f.db.query('SELECT COUNT(*) AS n FROM sync2_space_examined'))[0].n).toBe(16);}
 }finally{f.close();}
});

test('ROUNDS policy decision validity preserves inclusive and maximum clock boundaries',async()=>{
 const {nextEligibilityChange,eligible}=await import('../../src/sync-v2/eviction'),rss={...item(),addedAtMillis:now-SEVEN_DAYS};expect(nextEligibilityChange(rss,now)).toBe(now+1);expect(nextEligibilityChange(rss,now+1)).toBeNull();expect(nextEligibilityChange({...rss,dirty:true},now)).toBeNull();expect(nextEligibilityChange({...rss,addedAtSource:'unknown'},now)).toBeNull();expect(nextEligibilityChange({...item(),kind:'import'},now)).toBeNull();expect(nextEligibilityChange(rss,NaN)).toBeNull();
 const last={...item(),addedAtMillis:Number.MAX_SAFE_INTEGER-SEVEN_DAYS-1};expect(nextEligibilityChange(last,Number.MAX_SAFE_INTEGER-1)).toBe(Number.MAX_SAFE_INTEGER);expect(eligible(last,Number.MAX_SAFE_INTEGER-1)).toBe(false);expect(eligible(last,Number.MAX_SAFE_INTEGER)).toBe(true);
});
