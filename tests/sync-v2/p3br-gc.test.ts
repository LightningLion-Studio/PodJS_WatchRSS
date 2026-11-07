import {test,expect} from 'bun:test';
import {fixture,body,item,id,now,binding} from './p3b-fixture';
import {digest} from '../../src/sync-v2/protocol';
import {statSync} from 'node:fs';

test('REVIEW3 controller replacement between GC batches must retain actual freed byte accounting',async()=>{
 const f=await fixture();try{
  const resources=[];for(let n=0;n<33;n++){const key=digest(['gc-batch',n]),path=binding+'/'+key+'.data';await f.cache.files.publish(path,new Uint8Array(128).fill(33));resources.push({id:key,path,bytes:128});}
  for(let at=0;at<resources.length;at+=32)await f.cache.register(resources.slice(at,at+32));await f.cache.add({...body(),item:{...item(),localBytes:33*128}},resources.map(r=>r.id));await f.cache.unstage(resources);
  await f.cache.setAutoEvict(true);const original=f.space.collect.bind(f.space);let takeover=false;
  f.space.collect=async session=>{const result=await original(session);if(!takeover&&result.files===32){takeover=true;await f.cache.beginRound();}return result;};
  const result=await f.space.runWindow(33*128,10000),remaining=resources.reduce((n,r)=>n+statSync(f.host.path(r.path)).size,0),actualFreed=33*128-remaining;
  console.log(JSON.stringify({case:'gc-batch-takeover',result,actualFreed,remaining,takeover}));
  expect(result.status).toBe('candidates-changed');expect(result.freed).toBe(actualFreed);
 }finally{f.close();}
});

test('REVIEW3 an old GC session must fail before writing the durable GC cursor',async()=>{
 const f=await fixture();try{
  const resource=await f.add();await f.cache.setAutoEvict(true);await f.cache.trustedTime(now);
  const row=(await f.cache.journal.row(id))!;await f.db.transaction(f.cache.placeholder(row,await f.cache.seal(id,{...body(),status:'placeholder'}),now));
  const old=await f.cache.beginRound(),latest=await f.cache.beginRound(),before=await f.db.query('SELECT last_id FROM podjs_resource_gc_cursor WHERE binding=?',[binding]);
  await expect(f.space.collect(old)).rejects.toThrow('round_stale');
  const after=await f.db.query('SELECT last_id FROM podjs_resource_gc_cursor WHERE binding=?',[binding]);
  console.log(JSON.stringify({case:'stale-gc-cursor-write',before,after,bytes:statSync(f.host.path(resource.path)).size,roundUnchanged:JSON.stringify(await f.cache.roundState())===JSON.stringify({...latest,active:true})}));
  expect(statSync(f.host.path(resource.path)).size).toBe(128);expect(after).toEqual(before);
 }finally{f.close();}
});

async function snapshot(f:Awaited<ReturnType<typeof fixture>>){const tables=['podjs_resource_gc_cursor','podjs_resources','podjs_resource_rows','podjs_resource_refs','sync2_space_round','sync2_space_examined','sync2_space_settings','syncv2_state'];return Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await f.db.query('SELECT * FROM '+table)).map(row=>JSON.stringify(row)).sort()])));}
async function pending(f:Awaited<ReturnType<typeof fixture>>){const resource=await f.add();await f.cache.setAutoEvict(true);await f.cache.trustedTime(now);const row=(await f.cache.journal.row(id))!;await f.db.transaction(f.cache.placeholder(row,await f.cache.seal(id,{...body(),status:'placeholder'}),now));return resource;}

test('REVIEW3 invalid GC entry changes no durable table or clock',async()=>{
 const f=await fixture();try{
  const resource=await pending(f),old=await f.cache.beginRound();await f.cache.beginRound();const before=await snapshot(f);f.clock=now+100;f.beforeProof=async()=>{throw Error('stale_entry_must_not_authorize');};
  await expect(f.space.collect(old)).rejects.toThrow('round_stale');expect(await snapshot(f)).toEqual(before);expect(f.requests).toBe(0);expect(statSync(f.host.path(resource.path)).size).toBe(128);
 }finally{f.close();}
});

test('REVIEW3 takeover during GC proof rolls back clock, cursor and retirement',async()=>{
 const f=await fixture();try{
  const resource=await pending(f),old=await f.cache.beginRound();let before:any;f.clock=now+100;f.beforeProof=async()=>{f.beforeProof=undefined;await f.cache.beginRound();before=await snapshot(f);};
  await expect(f.space.collect(old)).rejects.toThrow('round_stale');expect(await snapshot(f)).toEqual(before);expect(f.requests).toBe(1);expect(statSync(f.host.path(resource.path)).size).toBe(128);
 }finally{f.close();}
});

test('REVIEW3 takeover after retirement preserves intent and stops before native deletion',async()=>{
 const f=await fixture();try{
  const resource=await pending(f),old=await f.cache.beginRound(),stat=f.cache.files.stat.bind(f.cache.files);let before:any,latest:any,once=true;
  f.cache.files.stat=async paths=>{const result=await stat(paths);if(once){once=false;latest=await f.cache.beginRound();before=await snapshot(f);}return result;};
  await expect(f.space.collect(old)).rejects.toThrow('round_stale');expect(await snapshot(f)).toEqual(before);expect(statSync(f.host.path(resource.path)).size).toBe(128);expect(await f.db.query('SELECT retired,deleted FROM podjs_resources')).toEqual([{retired:1,deleted:0}]);
  expect((await f.space.collect(latest)).freed).toBe(128);
 }finally{f.close();}
});

test('REVIEW3 takeover after native deletion retains byte accounting and rejects acknowledgement writes',async()=>{
 const f=await fixture();try{
  const resource=await f.add();await f.cache.setAutoEvict(true);const discard=f.cache.files.discard.bind(f.cache.files);let before:any,latest:any,once=true;
  f.cache.files.discard=async path=>{const result=await discard(path);if(once){once=false;latest=await f.cache.beginRound();before=await snapshot(f);}return result;};
  const result=await f.space.runWindow(128,10000);expect(result.status).toBe('candidates-changed');expect(result.freed).toBe(128);expect(await snapshot(f)).toEqual(before);expect(statSync(f.host.path(resource.path)).size).toBe(0);expect(await f.db.query('SELECT retired,deleted FROM podjs_resources')).toEqual([{retired:1,deleted:0}]);
  expect(await f.space.collect(latest)).toEqual({freed:0,files:1});expect(await f.db.query('SELECT deleted FROM podjs_resources')).toEqual([{deleted:1}]);
 }finally{f.close();}
});

test('REVIEW3 a moving trusted clock permits repeated protected GC commits',async()=>{
 const f=await fixture();try{
  for(let n=0;n<2;n++){const key=String(n).repeat(64);await f.add(body(key));}await f.cache.setAutoEvict(true);let tick=0;f.space.ports.trustedNow=()=>now+tick++;
  expect(await f.space.runWindow(256,10000)).toMatchObject({status:'sufficient',freed:256});
 }finally{f.close();}
});
