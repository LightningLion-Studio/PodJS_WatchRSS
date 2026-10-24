import {test,expect} from 'bun:test';
import {SettingsStore} from '../../src/settings/store.ts';
import {ipFixture,flush,deferred} from '../helpers/ip-fixture.ts';
import type {IpEndpoint} from '../../src/sync/ip-protocol.ts';
import {IpSyncController} from '../../src/sync/ip-controller.ts';
import {FrameDecoder} from '../../src/sync/protocol.ts';
import {LibrarySyncSession,type TransferByteProgress,type LibrarySessionRepository} from '../../src/sync/session.ts';
const repository=()=>({deviceId:async()=>'watch'} as LibrarySessionRepository);
test('IP owner keeps a nonpersistent transport between actions, then honors persistent completion',async()=>{
 const f=ipFixture();await f.sign();const media:boolean[]=[],routes:unknown[]=[],errors:unknown[]=[],progress:TransferByteProgress[]=[];
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,mediaLease:async on=>{media.push(on);},onRoute:r=>routes.push(r),onError:e=>errors.push(e)},{onTransferProgress:p=>progress.push(p)});
 expect(await controller.offer({...f.descriptor,hmac:'wrong'})).toBe(false);expect(f.opens).toHaveLength(0);
 expect(await controller.offer({...f.descriptor})).toBe(true);await flush();expect(routes).toHaveLength(1);
 const decoder=new FrameDecoder();f.feed({action:'syncLibrary',phase:'probe',version:14});f.feed({action:'ack',success:true,applied:true});await flush();expect(f.writes.flatMap(b=>decoder.push(b))).toHaveLength(1);expect(f.closed).toHaveLength(0);expect(media).toEqual([true]);
 f.feed({action:'syncLibrary',phase:'probe',version:14,requestPersistentSession:true,supportsPersistentSession:true});f.feed({action:'ack',success:true,applied:true});f.feed({action:'syncSession',phase:'complete'});f.feed({action:'ack',success:true,applied:true});await flush();const allFrames=new FrameDecoder();expect(f.writes.flatMap(b=>allFrames.push(b))).toHaveLength(3);expect(progress.filter(p=>p.direction==='write').reduce((n,p)=>n+p.bytes,0)).toBe(f.writes.reduce((n,b)=>n+b.length,0));expect(progress.some(p=>p.direction==='read'&&p.bytes===4)).toBe(true);expect(f.closed).toContain('stream-1');expect(routes.at(-1)).toBeNull();expect(errors).toHaveLength(0);await controller.dispose();expect(media).toEqual([true,false]);
});
test('active IP transfer survives backgrounding and releases transport after the post-transfer grace',async()=>{
 const f=ipFixture();await f.sign();const handled=deferred<Record<string,unknown>>(),controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now},{handleAction:()=>handled.result});
 await controller.offer({...f.descriptor});await flush();f.feed({action:'syncNotes'});await flush();controller.setActive(false);await f.clock.advance(3000);expect(f.closed).toHaveLength(0);
 handled.resolve({success:true});f.feed({action:'ack',success:true,applied:true});await flush();await f.clock.advance(29999);expect(f.closed).toHaveLength(0);await f.clock.advance(1);expect(f.closed).toContain('stream-1');await controller.dispose();
});
test('idle IP route closes after 2.5 seconds in the background',async()=>{
 const f=ipFixture();await f.sign();const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now});await controller.offer({...f.descriptor});await flush();controller.setActive(false);await f.clock.advance(2499);expect(f.closed).toHaveLength(0);await f.clock.advance(1);expect(f.closed).toContain('stream-1');await controller.dispose();
});
test('route probing tries at most three candidates in descending native priority',async()=>{
 const f=ipFixture();f.descriptor.endpoints=[50,400,100,300].map(priority=>({endpointId:String(priority),address:'10.0.0.'+(priority/50),family:'ipv4',transportKind:'unknownLocal',priority}));await f.sign();f.ports.sockets.connect=url=>{f.opens.push(url);return {result:Promise.reject(new Error('unreachable')),cancel:()=>{}};};const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now});await controller.offer({...f.descriptor});await flush();expect(f.opens).toEqual(['ws://10.0.0.8:8888/sync','ws://10.0.0.6:8888/sync','ws://10.0.0.2:8888/sync']);await controller.dispose();
});
test('Bluetooth probe advertises upgrade only after the installed handler accepts its descriptor',async()=>{
 for(const accepts of [false,true]){let calls=0,at=0;const inbound=[{action:'syncLibrary',phase:'probe',version:14,ipEndpointDescriptor:{id:'phone'}},{action:'ack',success:true,applied:true}];const session=new LibrarySyncSession({readFrame:async()=>inbound[at++]!,writeFrame:async()=>{},close:async()=>{}},repository(),{offerIpEndpoint:async d=>{calls++;expect(d).toEqual({id:'phone'});return accepts;}});const result=await session.run();expect(result[0]!.response.ipUpgradeAccepted).toBe(accepts);expect(calls).toBe(1);}
});
test('a newer bootstrap descriptor cancels an in-flight probe and selects the new endpoint',async()=>{
 const f=ipFixture();await f.sign();const pending=deferred<{id:string}>(),connect=f.ports.sockets.connect;let cancelled=false;
 f.ports.sockets.connect=(url,options)=>{if(url.includes('10.0.0.1:')){f.opens.push(url);return {result:pending.result,cancel:()=>{cancelled=true;pending.reject(new Error('replaced'));}};}return connect(url,options);};
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now});await controller.offer({...f.descriptor});await flush();f.descriptor.epoch=2;f.descriptor.endpoints=[{...f.descriptor.endpoints[0]!,address:'10.0.0.2'}];await f.sign();await controller.offer({...f.descriptor});await flush();expect(cancelled).toBe(true);expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync','ws://10.0.0.2:8888/sync']);await controller.dispose();expect(f.closed).toContain('stream-1');
});
test('background stop cancels the entire candidate search rather than starting the next address',async()=>{
 const f=ipFixture();f.descriptor.endpoints[0]!.transportKind='unknownLocal';f.descriptor.endpoints.push({...f.descriptor.endpoints[0]!,endpointId:'second',address:'10.0.0.2'});await f.sign();const pending=deferred<{id:string}>();f.ports.sockets.connect=url=>{f.opens.push(url);return {result:pending.result,cancel:()=>pending.reject(new Error('stopped'))};};const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now});await controller.offer({...f.descriptor});await flush();controller.setActive(false);await f.clock.advance(2500);expect(f.opens).toHaveLength(1);await controller.dispose();
});
test('mDNS expands failed signed routes after signature validation without changing the signed descriptor',async()=>{
 const f=ipFixture();f.descriptor.endpoints[0]!.priority=50;await f.sign();let scans=0;const connect=f.ports.sockets.connect;f.ports.sockets.connect=(url,options)=>url.includes('10.0.0.1:')?(f.opens.push(url),{result:Promise.reject(new Error('unreachable')),cancel(){}}):connect(url,options);
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,discover:port=>{scans++;expect(port).toBe(8888);return {result:Promise.resolve([{endpointId:'mdns-10.0.0.2',address:'10.0.0.2',family:'ipv4',transportKind:'wifiLan',priority:300}]),cancel:()=>{}};}});
 expect(await controller.offer({...f.descriptor,hmac:'invalid'})).toBe(false);expect(scans).toBe(0);
 await controller.offer({...f.descriptor});await flush();expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync','ws://10.0.0.2:8888/sync']);expect(f.descriptor.endpoints).toHaveLength(1);await controller.dispose();
});
test('disposal cancels pending discovery and cannot start a route',async()=>{
 const f=ipFixture();await f.sign();f.ports.sockets.connect=url=>{f.opens.push(url);return {result:Promise.reject(new Error('unreachable')),cancel(){}};};const pending=deferred<[]>();let cancelled=false;
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,discover:()=>({result:pending.result,cancel:()=>{cancelled=true;pending.reject(new Error('cancelled'));}})});
 await controller.offer({...f.descriptor});await flush();await controller.dispose();expect(cancelled).toBe(true);expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync']);
});
test('failed discovery retains signed bootstrap routes',async()=>{
 const f=ipFixture();await f.sign();const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,discover:()=>({result:Promise.reject(new Error('unavailable')),cancel:()=>{}})});
 await controller.offer({...f.descriptor});await flush();expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync']);await controller.dispose();
});
test('descriptor expiry during discovery prevents probing',async()=>{
 const f=ipFixture();f.descriptor.expiresAt=100;await f.sign();f.ports.sockets.connect=url=>{f.opens.push(url);return {result:Promise.reject(new Error('unreachable')),cancel(){}};};const pending=deferred<IpEndpoint[]>();
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,discover:()=>({result:pending.result,cancel:()=>pending.reject(new Error('cancelled'))})});
 await controller.offer({...f.descriptor});await flush();await f.clock.advance(101);pending.resolve([{endpointId:'mdns',address:'10.0.0.2',family:'ipv4',transportKind:'wifiLan',priority:300}]);await flush();expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync']);await controller.dispose();
});
test('a discovered endpoint cannot bypass server authentication',async()=>{
 const f=ipFixture();await f.sign();f.ack.serverDeviceId='impostor';f.ack.hmac='forged';const errors:unknown[]=[];
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,onError:error=>errors.push(error),discover:()=>({result:Promise.resolve([{endpointId:'mdns',address:'10.0.0.2',family:'ipv4',transportKind:'wifiLan',priority:400}]),cancel:()=>{}})});
 await controller.offer({...f.descriptor});await flush();expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync','ws://10.0.0.2:8888/sync']);expect(f.closed).toEqual(['stream-1','stream-1']);expect(errors.some(error=>String(error).includes('认证失败'))).toBe(true);expect(f.writes).toHaveLength(0);await controller.dispose();
});
test('foreground acquisition authenticates a BLE descriptor before selecting a route',async()=>{
 for(const valid of [false,true]){const f=ipFixture();await f.sign();let acquisitions=0;const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,acquireDescriptor:()=>{acquisitions++;return {result:Promise.resolve({...f.descriptor,...(!valid?{hmac:'forged'}:{})}),cancel:()=>{}};}});controller.setActive(true);await flush();expect(acquisitions).toBe(1);expect(f.opens).toHaveLength(valid?1:0);await controller.dispose();}
});
test('authenticated RFCOMM bootstrap replaces BLE acquisition without starting another scan',async()=>{
 const f=ipFixture();await f.sign();const pending=deferred<null>();let acquisitions=0,cancelled=false,mdns=0;
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,acquireDescriptor:()=>{acquisitions++;return {result:pending.result,cancel:()=>{cancelled=true;pending.reject(new Error('bootstrap received'));}};},discover:()=>{mdns++;return {result:Promise.resolve([]),cancel:()=>{}};}});controller.refresh();await flush();expect(await controller.offer({...f.descriptor})).toBe(true);await flush();expect(cancelled).toBe(true);expect(acquisitions).toBe(1);expect(mdns).toBe(1);expect(f.opens).toHaveLength(1);await controller.dispose();
});
test('ordinary refresh bursts coalesce while BLE acquisition is pending',async()=>{
 const f=ipFixture();await f.sign();const pending=deferred<null>();let scans=0;const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,acquireDescriptor:()=>{scans++;return {result:pending.result,cancel:()=>pending.reject(new Error('cancelled'))};}});controller.refresh();for(let i=0;i<12;i++)controller.refresh();await flush();pending.resolve(null);await flush();expect(scans).toBe(1);await controller.dispose();
});
test('network-style refresh does not scan in background or during a live transfer',async()=>{
 const f=ipFixture();await f.sign();const handled=deferred<Record<string,unknown>>();let acquisitions=0;
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,acquireDescriptor:()=>{acquisitions++;return {result:Promise.resolve(null),cancel:()=>{}};}},{handleAction:()=>handled.result});
 controller.setActive(false);controller.refresh();await flush();expect(acquisitions).toBe(0);
 controller.setActive(true);await flush();expect(acquisitions).toBe(1);await controller.offer({...f.descriptor});await flush();acquisitions=0;
 f.feed({action:'syncNotes'});await flush();controller.refresh();await flush();expect(acquisitions).toBe(0);
 handled.resolve({success:true});f.feed({action:'ack',success:true,applied:true});await flush();expect(acquisitions).toBe(1);await controller.dispose();
});
test('unexpected route EOF schedules fresh discovery without needing a network event',async()=>{
 const f=ipFixture();await f.sign();const pending=deferred<null>();let discoveries=0;
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,acquireDescriptor:()=>{discoveries++;return {result:pending.result,cancel:()=>pending.reject(new Error('disposed'))};}});
 await controller.offer({...f.descriptor});await flush();await f.ports.streams.close('stream-1');await flush();expect(discoveries).toBe(0);await f.clock.advance(500);expect(discoveries).toBe(1);await controller.dispose();
});
test('cached-bootstrap recovery debounces and backgrounding cancels the pending retry',async()=>{
 for(const background of [false,true]){const f=ipFixture();await f.sign();const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now});await controller.offer({...f.descriptor});await flush();await f.ports.streams.close('stream-1');await flush();expect(f.opens).toHaveLength(1);if(background)controller.setActive(false);await f.clock.advance(499);expect(f.opens).toHaveLength(1);await f.clock.advance(1);expect(f.opens).toHaveLength(background?1:2);await controller.dispose();}
});
test('normal persistent completion never triggers failure recovery',async()=>{
 const f=ipFixture();await f.sign();let discoveries=0;const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,acquireDescriptor:()=>{discoveries++;return {result:Promise.resolve(null),cancel:()=>{}};}});
 await controller.offer({...f.descriptor});await flush();f.feed({action:'syncLibrary',phase:'probe',version:14,requestPersistentSession:true,supportsPersistentSession:true});f.feed({action:'ack',success:true,applied:true});f.feed({action:'syncSession',phase:'complete'});f.feed({action:'ack',success:true,applied:true});await flush();await f.clock.advance(1000);expect(discoveries).toBe(0);expect(f.opens).toHaveLength(1);await controller.dispose();
});
test('an immediately closed route queues recovery while initial selection is still settling',async()=>{
 const f=ipFixture();await f.sign();await f.ports.streams.close('stream-1');let discoveries=0;const pending=deferred<null>();
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,acquireDescriptor:()=>{discoveries++;return {result:pending.result,cancel:()=>pending.reject(new Error('disposed'))};}});
 await controller.offer({...f.descriptor});await flush();expect(discoveries).toBe(0);await f.clock.advance(500);expect(discoveries).toBe(1);await controller.dispose();
});

import {foregroundRequestFilter} from '../../src/sync/action-policy.ts';
test('IP automatic policy rejects extra actions without closing the route; allowed next action dispatches',async()=>{
 const f=ipFixture();await f.sign();const handled:string[]=[];
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now},{filterRequest:foregroundRequestFilter,handleAction:async r=>{handled.push(String(r.action));return {success:true,action:r.action};}});
 await controller.offer({...f.descriptor});await flush();
 for(const action of ['remoteInput','clearLibrary']){f.feed({action});f.feed({action:'ack',success:true,applied:true});await flush();}
 const decoder=new FrameDecoder(),replies=f.writes.flatMap(b=>decoder.push(b));
 expect(replies.map(r=>r.success)).toEqual([false,true]);expect(handled).toEqual(['clearLibrary']);expect(f.closed).toHaveLength(0);await controller.dispose();
});

test('saved native phone setting does not reject IP bootstrap or close its transport',async()=>{
 const data=new Map<string,unknown>();
 const storage={get:<T>(key:string)=>data.get(key) as T|undefined,set:(key:string,value:unknown)=>{data.set(key,value);}};
 new SettingsStore(storage).update({phoneConnectionEnabled:false});
 const f=ipFixture();await f.sign();const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now});
 expect(await controller.offer({...f.descriptor})).toBe(true);await flush();expect(f.opens).toHaveLength(1);
 new SettingsStore(storage).update({phoneConnectionEnabled:true});new SettingsStore(storage).update({phoneConnectionEnabled:false});
 controller.refresh();await flush();await f.clock.advance(3000);expect(f.closed).toHaveLength(0);
 expect(new SettingsStore(storage).load().phoneConnectionEnabled).toBe(false);await controller.dispose();
});

test('changing saved phone setting during descriptor authentication does not reject a valid bootstrap',async()=>{
 const data=new Map<string,unknown>();const settings=new SettingsStore({get:<T>(key:string)=>data.get(key) as T|undefined,set:(key:string,value:unknown)=>{data.set(key,value);}});
 const f=ipFixture();await f.sign();const pending=deferred<string>();f.ports.crypto.hmac=()=>pending.result;
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now});
 const offering=controller.offer({...f.descriptor});settings.update({phoneConnectionEnabled:false});pending.resolve(f.descriptor.hmac);
 expect(await offering).toBe(true);await flush();expect(f.opens).toHaveLength(1);expect(settings.load().phoneConnectionEnabled).toBe(false);await controller.dispose();
});

test('R47 refuses an impossible LAN upgrade instead of making the phone wait for it',async()=>{
 const {canOfferIpRoutes}=await import('../../src/sync/ip-controller');const f=ipFixture();await f.sign();let checked=0;
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,canOffer:async descriptor=>{checked++;return canOfferIpRoutes(descriptor,{active:true,bluetooth:true,localWifi:false});}});
 expect(await controller.offer({...f.descriptor,hmac:'invalid'})).toBe(false);expect(checked).toBe(0);
 expect(await controller.offer({...f.descriptor})).toBe(false);await flush();expect(f.opens).toEqual([]);expect(checked).toBe(1);
 expect(canOfferIpRoutes(f.descriptor,{active:true,bluetooth:true,localWifi:true})).toBe(true);
 expect(canOfferIpRoutes(f.descriptor,{active:true,bluetooth:true})).toBe(true);
 expect(canOfferIpRoutes({...f.descriptor,endpoints:[{...f.descriptor.endpoints[0]!,transportKind:'bluetoothBridge'}]},{active:true,bluetooth:true,localWifi:false})).toBe(true);
 await controller.dispose();
});


test('a healthy signed route does not wait for the 1500ms mDNS window and cancels it',async()=>{
 const f=ipFixture();await f.sign();const pending=deferred<[]>();let cancelled=false,scans=0;
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,discover:()=>{scans++;return {result:pending.result,cancel(){cancelled=true;pending.reject(new Error('discovery cancelled'));}};}});
 await controller.offer({...f.descriptor});await flush();
 expect(scans).toBe(1);expect(f.clock.now).toBe(0);expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync']);expect(cancelled).toBe(true);expect(f.closed).toHaveLength(0);
 await controller.dispose();expect(f.closed).toContain('stream-1');
});

test('signed and discovered waves share a three-attempt budget and never repeat an address',async()=>{
 const f=ipFixture();await f.sign();f.ports.sockets.connect=url=>{f.opens.push(url);return {result:Promise.reject(new Error('unreachable')),cancel(){}};};
 const extra=[['duplicate','10.0.0.1',500],['second','10.0.0.2',400],['second-alias','10.0.0.2',350],['third','10.0.0.3',300],['fourth','10.0.0.4',200]].map(([endpointId,address,priority])=>({endpointId:String(endpointId),address:String(address),priority:Number(priority),family:'ipv4' as const,transportKind:'wifiLan' as const}));
 const controller=new IpSyncController({...f.ports,repository:repository(),now:()=>f.clock.now,discover:()=>({result:Promise.resolve(extra),cancel(){}})});
 await controller.offer({...f.descriptor});await flush();expect(f.opens).toEqual(['ws://10.0.0.1:8888/sync','ws://10.0.0.2:8888/sync','ws://10.0.0.3:8888/sync']);await controller.dispose();
});
