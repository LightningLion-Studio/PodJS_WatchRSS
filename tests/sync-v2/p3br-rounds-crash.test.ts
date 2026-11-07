import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {rmSync,statSync} from 'node:fs';
import {SqlFixture,cipher} from './fixture';
import {FileHost} from './p3-fixture';
import {recoveryCipher,now,sha} from './p3b-fixture';
import {ContentFiles} from '@podjs/framework/content-files';
import {WatchSpaceStore} from '../../src/sync-v2/space-store';
import {WatchRecovery} from '../../src/sync-v2/recovery';
import {SEVEN_DAYS} from '../../src/sync-v2/eviction';
import {nextD64} from '../../src/sync-v2/protocol';
for(const mode of ['handoff','release','checked','claim','end','touch','restore'])for(const point of ['before','after'])test('ROUNDS SIGKILL '+mode+' '+point+' commit preserves a complete state',async()=>{
 const child=Bun.spawnSync([process.execPath,'run',join(import.meta.dir,'p3br-rounds-crash-child.ts'),mode,point],{stdout:'pipe',stderr:'pipe'});expect(child.signalCode).toBe('SIGKILL');
 const m=JSON.parse(child.stdout.toString().trim().split('\n').find(line=>line.startsWith('{'))!);let db:SqlFixture|undefined;
 try{
  db=new SqlFixture(join(m.root,m.database));const projection=db.store(),host=new FileHost(join(m.root,'files')),cache=new WatchSpaceStore(db,cipher,new ContentFiles(host.request),m.binding);await cache.init();
  const state=await projection.readState(),savedRound=await cache.roundState(),checked=await cache.examinedPage(savedRound),after=point==='after';
  if(mode==='handoff'||mode==='release'){
   const recovery=new WatchRecovery(projection,cache,{cipher:recoveryCipher,randomId:async()=> 'f'.repeat(32),trustedNow:()=>now+SEVEN_DAYS,source:async()=>[],reserve:async()=>async()=>{}}),pins=state.recoveryEditPins??[],owners=await db.query("SELECT owner FROM podjs_resource_refs WHERE owner LIKE 'edit-recovery:%'"),descriptors=await db.query("SELECT id FROM podjs_resource_rows WHERE id LIKE 'edit-recovery:%'");
   const retained=mode==='handoff'?after:!after;expect(pins.length).toBe(retained?1:0);expect(descriptors.length).toBe(retained?1:0);expect(owners.length>0).toBe(retained);
   if(mode==='handoff'){await recovery.purgeRecovery(now+SEVEN_DAYS);if(after)for(const ref of (await recovery.read(pins[0].copy)).bodyRefs)expect(sha(Buffer.concat(await recovery.readEditBody(pins[0].editId,ref)))).toBe(ref.split(':sha256:')[1]);}
   else {await cache.collect();expect(m.resources.reduce((n:number,r:any)=>n+statSync(host.path(r.path)).size,0)>0).toBe(!after);}
  }else if(mode==='checked'){expect(savedRound).toEqual(m.round);expect(checked.length).toBe(after?3:0);if(after)expect(checked.map(r=>r.entityKey)).toEqual(m.entries.map((r:any)=>r.entityKey));}
  else if(mode==='claim'){expect(savedRound.round).toBe(m.round.round);expect(savedRound.active).toBe(true);expect(savedRound.controller===m.round.controller).toBe(!after);expect(checked.length).toBe(1);if(after)await expect(cache.endRound(m.session)).rejects.toThrow('round_stale');}
  else if(mode==='end'){expect(savedRound.active).toBe(!after);expect(checked.length).toBe(1);const claim=await cache.beginRound();expect(claim.round).toBe(after?nextD64(m.round.round):m.round.round);expect((await cache.examinedPage(claim)).length).toBe(after?0:1);}
  else {
   const row=(await cache.journal.row(m.id))!,value=await cache.open(row),owners=await cache.journal.resourcePage('body:'+m.id);expect(savedRound).toEqual(m.round);expect(checked.length).toBe(1);expect((await cache.uncheckedPage(m.session,now)).length).toBe(after?1:0);
   if(mode==='touch')expect(value.item.dirty).toBe(after);
   else {expect(value.status).toBe(after?'ready':'placeholder');expect(owners.length).toBe(after?1:0);if(after){const [bytes]=await cache.files.read([{path:owners[0].path,offset:0,length:128}]);expect(sha(bytes)).toBe(value.plaintextSha256);}}
  }
  console.log(JSON.stringify({mode,point,round:savedRound,checked:checked.length}));
 }finally{db?.close();rmSync(m.root,{recursive:true,force:true});}
},10000);
