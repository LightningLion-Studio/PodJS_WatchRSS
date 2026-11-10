import {test,expect} from 'bun:test';
import {fixture,account,f} from './p6-fix-fixture';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {watchSyncV2Product} from '../../src/sync-v2/product-start';
import {accountBoundCasHost} from '../../src/sync-v2/product';
import {parseCanonicalJson} from '../../src/sync-v2/protocol';
import {unhex} from '@podjs/framework/crypto';
const defer=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
// Production opener, scanner, signer, publisher, reader and controller run intact.
// Only host IO and the synthetic server are controlled at their boundaries.
for(const phase of ['capsule-crypto','capabilities'])test('P6 RW01 logout during '+phase+' immediately clears keys and cancels opening',async()=>{
 const x=await fixture(),entered=defer(),release=defer(),buffers:Uint8Array[]=[];let loggedIn=true,paused=false,installs=0;
 const native=x.options.host;
 const host:any=async(method:string,args:any)=>{
  if(method==='secure.acquire')return {acquired:true};if(method==='secure.release')return {};
  const result=await native(method,args);
  if(phase==='capsule-crypto'&&method==='crypto.hkdfSha256'&&!paused){paused=true;entered.resolve();await release.promise;}
  return result;
 };
 const transport={request:async(r:any)=>{if(phase==='capabilities'&&new URL(r.url).pathname.endsWith('/capabilities')&&!paused){paused=true;entered.resolve();await release.promise;}return x.server.request(r);}};
 const options={...x.options,host:accountBoundCasHost(host,account,async()=>loggedIn?account:null),transport,keys:{currentKeyVersion:async()=>f.descriptor.body.wrappingKeyVersion,accountKey:async()=>{const b=unhex(f.wrapKeyHex);buffers.push(b);return b;}},session:async()=>{if(!loggedIn)throw Error('cloud_account_busy');return account;}};
 let next:Awaited<ReturnType<typeof fixture>>|undefined;
 const product=watchSyncV2Product({enabled:true,drainOnStop:true,announced:async()=>true,open:lifetime=>openApplicationSyncV2({...next?.options??options,lifetime}),install:p=>{if(p)installs++;}});
 let stopping:Promise<void>|undefined;const starting=product.start('owner').catch(e=>e);
 try{
  await entered.promise;loggedIn=false;x.secrets.clear();let stopped=false;stopping=product.stop().then(()=>{stopped=true;});
  expect(buffers.length).toBeGreaterThan(0);expect(buffers.every(b=>b.every(n=>n===0))).toBe(true);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([stopping,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('opening_not_cancelled')),1000);})]);}finally{clearTimeout(timer);}
  expect(stopped).toBe(true);expect(product.active).toBe(false);expect(installs).toBe(0);
  // A new owner opens before the old synthetic IO is released.
  next=await fixture();expect(await product.start('new-owner')).not.toBeNull();expect(installs).toBe(1);
  await product.stop();
 }finally{release.resolve();await starting;await stopping;await product.stop();next?.db.close();expect(x.secrets.size).toBe(0);x.db.close();}
});

test('P6 RW02 concurrent first publish yields once, retires only the rejected journal and returns choice UI across restarts',async()=>{
 const a=await fixture(),b=await fixture();let second:any,interleaved=false,winningHead:string|null=null;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");b.options.transport=a.server;
 const options={...a.options,transport:{request:async(r:any)=>{if(!interleaved&&r.url.endsWith('/objects/reserve')){interleaved=true;second=await openApplicationSyncV2(b.options);winningHead=a.server.account.commitOid;}return a.server.request(r);}}};
 try{
  for(let i=0;i<3;i++){
   const opened=await openApplicationSyncV2(options);expect(opened).not.toBeNull();
   try{const state=await (opened!.ui as any).o.projection.readState();expect(state.cloud.pendingPublish).toBeNull();expect(state.cloud.deviceSequence).toBe('1');expect(state.pendingChoice).toBeTruthy();expect((await opened!.ui.snapshot()).phase).toBe('awaiting_choice');expect((await opened!.ui.openChoice()).cloud.map(r=>r.title)).toContain('remote b');}finally{await opened!.close();}
  }
  const requests=a.server.publishedBodies.map(s=>parseCanonicalJson(Buffer.from(s,'base64'))),failed=requests.filter(r=>r.account.body.expectedOid===null&&r.account.body.newCommitOid!==winningHead);
  expect(failed).toHaveLength(1);expect(a.server.account.revision).toBe('1');expect(a.server.account.commitOid).toBe(winningHead);expect(a.server.applied).toHaveLength(0);
  expect((await a.db.query('SELECT note_id,title FROM memo_notes'))[0]).toEqual({note_id:'local-a',title:'local a'});
 }finally{await second?.close();a.db.close();b.db.close();}
});

test('P6 RW02 failed winner identity refresh preserves rejected pending and recovers on restart without another send',async()=>{
 const a=await fixture(),b=await fixture();let second:any,opened:any,interleaved=false,denyWinner=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");b.options.transport=a.server;
 const options={...a.options,transport:{request:async(r:any)=>{
  if(!interleaved&&r.url.endsWith('/objects/reserve')){interleaved=true;second=await openApplicationSyncV2(b.options);denyWinner=true;}
  if(denyWinner&&r.url.endsWith('/repo/descriptor')){a.server.present=false;try{return await a.server.request(r);}finally{a.server.present=true;}}
  return a.server.request(r);
 }}};
 try{
  await expect(openApplicationSyncV2(options)).rejects.toThrow('identity_not_installed');const sends=a.server.publishedBodies.length,head=a.server.account.commitOid;
  denyWinner=false;opened=await openApplicationSyncV2(options);const state=await (opened!.ui as any).o.projection.readState();
  expect(state.cloud.pendingPublish).toBeNull();expect(state.pendingChoice).toBeTruthy();expect(state.cloud.deviceSequence).toBe('1');expect(a.server.publishedBodies).toHaveLength(sends);expect(a.server.account.commitOid).toBe(head);
  expect((await a.db.query('SELECT note_id FROM memo_notes'))[0]!.note_id).toBe('local-a');
 }finally{await opened?.close();await second?.close();a.db.close();b.db.close();}
});

for(const outcome of ['lost-before','lost-after'])test('P6 RW02 '+outcome+' preserves and reconciles the exact signed pending request',async()=>{
 const x=await fixture();let lost=false,opened:any;const sent:string[]=[];
 const options={...x.options,transport:{request:async(r:any)=>{
  if(r.url.endsWith('/account/publish')){sent.push(Buffer.from(r.body).toString('base64'));if(!lost){lost=true;if(outcome==='lost-before')throw Error('synthetic_response_lost');await x.server.request(r);throw Error('synthetic_response_lost');}}
  return x.server.request(r);
 }}};
 try{
  await expect(openApplicationSyncV2(options)).rejects.toThrow('synthetic_response_lost');
  opened=await openApplicationSyncV2(options);expect(opened).not.toBeNull();
  const state=await opened.ui.o.projection.readState();expect(state.cloud.pendingPublish).toBeNull();expect(state.cloud.deviceSequence).toBe('1');expect(x.server.account.revision).toBe('1');
  expect(sent).toHaveLength(outcome==='lost-before'?2:1);expect(sent.every(s=>s===sent[0])).toBe(true);
 }finally{await opened?.close();x.db.close();}
});

for(const corrupt of ['{','{}','','tampered-proof','invalid-unregistered','unreadable'])test('P6 RW03 corrupt signer '+JSON.stringify(corrupt)+' preserves authenticated reception and durable ACK until repaired',async()=>{
 const seed=await fixture(),x=await fixture();let remote:any,opened:any;
 try{
  remote=await openApplicationSyncV2(seed.options);await x.db.execute('DELETE FROM memo_notes');x.options.transport=seed.server;
  opened=await openApplicationSyncV2(x.options);await opened.close();opened=null;
  const slot=[...x.secrets.keys()].find(k=>k.startsWith('watchrss.syncv2.signer.'))!,saved=x.secrets.get(slot)!;
  const identitySlot=[...x.secrets.keys()].find(k=>k.includes('watchrss.syncv2.identity.'))!,identity=x.secrets.get(identitySlot);
  const damaged=corrupt==='invalid-unregistered'?JSON.stringify({...JSON.parse(saved),registered:false,registration:0}):corrupt==='tampered-proof'?JSON.stringify({...JSON.parse(saved),registration:{...JSON.parse(saved).registration,bindingProof:'A'.repeat(44)}}):corrupt==='unreadable'?saved:corrupt;
  let unreadable=corrupt==='unreadable',signs=0;const native=x.options.host;
  x.options.host=async(method:string,args:any)=>{if(unreadable&&method==='secure.get'&&args.key===slot)throw Error('synthetic_signer_read_failed');if(method==='crypto.v2.sign')signs++;return native(method,args);};
  x.secrets.set(slot,damaged);await seed.db.execute("UPDATE memo_notes SET title='later authenticated note',updated_at=9");await remote!.sync!();
  const ackCount=seed.server.applied.length,registrationCount=seed.server.registrations.length;
  opened=await openApplicationSyncV2(x.options);expect(opened).not.toBeNull();const projection=opened.ui.o.projection,state=await projection.readState();
  expect((await x.db.query('SELECT title FROM memo_notes'))[0]!.title).toBe('later authenticated note');expect(state.activeGeneration).toBe(seed.server.account.commitOid);expect(state.cloud.pendingApplied).toBeTruthy();
  const snapshot=await opened.ui.snapshot();expect(snapshot.enabled).toBe(true);expect(snapshot.phase).toBe('blocked');expect(snapshot.errorCode).toBe('signing_state_unavailable');expect(snapshot.ownDeviceId).toBeNull();
  await opened.ui.syncNow();expect(seed.server.applied).toHaveLength(ackCount);expect(seed.server.registrations).toHaveLength(registrationCount);expect(x.secrets.get(slot)).toBe(damaged);expect(signs).toBe(0);expect(x.secrets.get(identitySlot)).toBe(identity);
  // New signing also fails before sequence allocation, without replacing the key.
  const sequence=(await projection.readState()).cloud.deviceSequence;
  await expect(opened.ui.o.runtime.publish()).rejects.toThrow('signing_state_unavailable');expect((await projection.readState()).cloud.deviceSequence).toBe(sequence);
  const pending=(await projection.readState()).cloud.pendingApplied;unreadable=false;x.secrets.set(slot,saved);await opened.ui.syncNow();
  expect(seed.server.applied).toHaveLength(ackCount+1);expect(seed.server.applied.at(-1).requestId).toBe(pending.requestId);expect((await projection.readState()).cloud.pendingApplied).toBeNull();expect((await opened.ui.snapshot()).errorCode).toBeNull();
 }finally{await remote?.close();await opened?.close();seed.db.close();x.db.close();}
});
