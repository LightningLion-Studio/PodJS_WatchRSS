import {expect,test} from 'bun:test';
import {PairingRequestBus} from '../../src/ui/pairing-request.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {ACTION_OPEN_PAIRING,FrameDecoder,type JsonObject} from '../../src/sync/protocol.ts';
import {foregroundRequestFilter} from '../../src/sync/action-policy.ts';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session.ts';
import {IpSyncController} from '../../src/sync/ip-controller.ts';
import {ipFixture,flush} from '../helpers/ip-fixture.ts';

const reply=(opened:boolean)=>({success:true,action:ACTION_OPEN_PAIRING,opened});
const ack={action:'ack',success:true,applied:true};
function handler(bus?:PairingRequestBus){
 let sensitiveCalls=0;
 const unexpected=()=>{sensitiveCalls++;throw Error('openPairing must not read/write account, key, library or telemetry data');};
 const handle=createApplicationActionHandler({notes:new Proxy({} as never,{get:unexpected}),deviceId:unexpected,notesChanged:unexpected,clearLibrary:unexpected,accountStore:{read:unexpected,save:unexpected},accountBindingHash:unexpected,accountTelemetry:{recordSyncAccount:unexpected,backlogCount:unexpected},requestPairingPage:bus?session=>bus.request(session):undefined});
 return {handle,sensitiveCalls:()=>sensitiveCalls};
}

test('openPairing responds with exact UI-only shape and ignores account/key fields and forged wire sessions',async()=>{
 const bus=new PairingRequestBus(()=>0);bus.setForeground(true);bus.subscribe(()=>bus.consumePending());
 const h=handler(bus),context={session:{}};
 expect(await h.handle({action:ACTION_OPEN_PAIRING,sessionId:'forged-a',userId:'secret-user',key:'private-key',token:'secret-token'},undefined,context)).toEqual(reply(true));
 expect(await h.handle({action:ACTION_OPEN_PAIRING,sessionId:'forged-b'},undefined,context)).toEqual(reply(false));
 expect(await h.handle({action:ACTION_OPEN_PAIRING,sessionId:'forged-a'},undefined,{session:{}})).toEqual(reply(true));
 expect(h.sensitiveCalls()).toBe(0);
});

test('no UI, background, missing hook and thrown hook all retain success:true with opened:false',async()=>{
 const bus=new PairingRequestBus(()=>0),h=handler(bus);bus.subscribe(()=>true);
 expect(await h.handle({action:ACTION_OPEN_PAIRING})).toEqual(reply(false));
 expect(await handler().handle({action:ACTION_OPEN_PAIRING})).toEqual(reply(false));
 const failed=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch',notesChanged:()=>{},requestPairingPage:()=>{throw Error('secret route error');}});
 expect(await failed({action:ACTION_OPEN_PAIRING})).toEqual(reply(false));expect(h.sensitiveCalls()).toBe(0);
});

test('persistent Bluetooth/IP coordinator shares its locally generated limiter identity and keeps ACK flow intact',async()=>{
 let now=0;const bus=new PairingRequestBus(()=>now);bus.setForeground(true);bus.subscribe(()=>bus.consumePending());const h=handler(bus);
 const requests=[0,9999,10000],frames:JsonObject[]=[{action:ACTION_OPEN_PAIRING,sessionId:'a',requestPersistentSession:true,supportsPersistentSession:true},ack,{action:ACTION_OPEN_PAIRING,sessionId:'b'},ack,{action:ACTION_OPEN_PAIRING,sessionId:'c'},ack,{action:'syncSession',phase:'complete'},ack],writes:JsonObject[]=[];
 let reads=0,closed=0;const repo={deviceId:async()=>'watch'} as LibrarySessionRepository;
 const results=await new LibrarySyncSession({readFrame:async()=>{reads++;const frame=frames.shift()!;if(frame.action===ACTION_OPEN_PAIRING)now=requests.shift()!;return frame;},writeFrame:async value=>{writes.push(value);},close:async()=>{closed++;}},repo,{filterRequest:foregroundRequestFilter,handleAction:h.handle}).run();
 expect(writes.slice(0,3).map(x=>x.opened)).toEqual([true,false,true]);expect(writes[0]).toMatchObject({supportsPersistentSession:true,persistentSessionAccepted:true});
 expect(results).toHaveLength(4);expect(results.every(r=>r.ack?.applied&&!r.libraryApplied)).toBe(true);expect(reads).toBe(8);expect(closed).toBe(1);expect(h.sensitiveCalls()).toBe(0);
});

test('separate accepted connections get separate limiter identities without trusting request device/session IDs',async()=>{
 const bus=new PairingRequestBus(()=>0);bus.setForeground(true);bus.subscribe(()=>bus.consumePending());const h=handler(bus),repo={deviceId:async()=>'watch'} as LibrarySessionRepository;
 for(let i=0;i<2;i++){
  const frames=[{action:ACTION_OPEN_PAIRING,deviceId:'same-phone',sessionId:'same-untrusted-id'},ack];const writes:JsonObject[]=[];
  await new LibrarySyncSession({readFrame:async()=>frames.shift()!,writeFrame:async v=>{writes.push(v);},close:async()=>{}},repo,{filterRequest:foregroundRequestFilter,handleAction:h.handle}).run();expect(writes).toEqual([reply(true)]);
 }
 expect(h.sensitiveCalls()).toBe(0);
});

test('IP route retains limiter identity across nonpersistent coordinator instances on one WebSocket',async()=>{
 const f=ipFixture();await f.sign();const bus=new PairingRequestBus(()=>f.clock.now);bus.setForeground(true);bus.subscribe(()=>bus.consumePending());const h=handler(bus);
 const controller=new IpSyncController({...f.ports,repository:{deviceId:async()=>'watch'} as LibrarySessionRepository,now:()=>f.clock.now},{filterRequest:foregroundRequestFilter,handleAction:h.handle});
 try{
  expect(await controller.offer({...f.descriptor})).toBe(true);await flush();
  for(const sessionId of ['forged-1','forged-2']){f.feed({action:ACTION_OPEN_PAIRING,sessionId});f.feed(ack);await flush();}
  const decoder=new FrameDecoder();expect(f.writes.flatMap(b=>decoder.push(b))).toEqual([reply(true),reply(false)]);
  expect(f.closed).toHaveLength(0);expect(h.sensitiveCalls()).toBe(0);
 }finally{await controller.dispose();}
});
