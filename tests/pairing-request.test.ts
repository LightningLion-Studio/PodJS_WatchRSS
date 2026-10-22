import {expect,test} from 'bun:test';
import {PairingRequestBus,PAIRING_REQUEST_INTERVAL_MS} from '../src/ui/pairing-request.ts';
import {bindPairingRequestRoute} from '../src/ui/routes/pairing.ts';

test('pairing requests require foreground and an available route, and never replay on resume',async()=>{
 const bus=new PairingRequestBus(()=>0);let calls=0;
 expect(await bus.request()).toBe(false);
 bus.setForeground(true);expect(await bus.request({})).toBe(false);
 const stop=bus.subscribe(()=>{calls++;return bus.consumePending();});
 bus.setForeground(false);expect(await bus.request({})).toBe(false);expect(calls).toBe(0);
 bus.setForeground(true);expect(bus.consumePending()).toBe(false);expect(calls).toBe(0);
 expect(await bus.request({})).toBe(true);expect(calls).toBe(1);
 stop();expect(bus.consumePending()).toBe(false);
});

test('a pending pairing request is consumed exactly once, including an already-mounted phone page',async()=>{
 const bus=new PairingRequestBus(()=>0);bus.setForeground(true);let opened=0;
 bus.subscribe(()=>true); // Route is already phone-connection.
 bus.subscribe(()=>{if(!bus.consumePending())return false;opened++;return true;});
 expect(await bus.request()).toBe(true);expect(opened).toBe(1);expect(bus.consumePending()).toBe(false);
});

test('new phone page can consume on mount while its route navigation is in progress',async()=>{
 const bus=new PairingRequestBus(()=>0);bus.setForeground(true);
 bus.subscribe(async()=>{expect(bus.consumePending()).toBe(true);return true;});
 expect(await bus.request()).toBe(true);expect(bus.consumePending()).toBe(false);
});

test('trusted sessions have independent ten-second limits with an exact boundary',async()=>{
 let now=0;const bus=new PairingRequestBus(()=>now);bus.setForeground(true);let calls=0;
 bus.subscribe(()=>{calls++;return bus.consumePending();});
 const first={},second={};
 expect(await bus.request(first)).toBe(true);now=9999;
 expect(await bus.request(first)).toBe(false);expect(await bus.request(second)).toBe(true);
 now=PAIRING_REQUEST_INTERVAL_MS;expect(await bus.request(first)).toBe(true);expect(calls).toBe(3);
});

test('failed/declined UI attempts keep the reply false, clear pending, and are rate limited',async()=>{
 let calls=0;const bus=new PairingRequestBus(()=>0);bus.setForeground(true);
 const stop=bus.subscribe(()=>{calls++;throw Error('UI unavailable');});const session={};
 expect(await bus.request(session)).toBe(false);expect(bus.consumePending()).toBe(false);
 expect(await bus.request(session)).toBe(false);expect(calls).toBe(1);stop();
 bus.subscribe(()=>false);expect(await bus.request({})).toBe(false);expect(bus.consumePending()).toBe(false);
});

test('foreground loss or UI disposal invalidates an in-flight and future pending request',async()=>{
 for(const leave of ['background','dispose'] as const){
  const bus=new PairingRequestBus(()=>0);bus.setForeground(true);let resolve!:(value:boolean)=>void;
  const stop=bus.subscribe(()=>new Promise<boolean>(r=>{resolve=r;}));
  const request=bus.request();if(leave==='background')bus.setForeground(false);else stop();
  resolve(true);expect(await request).toBe(false);bus.setForeground(true);expect(bus.consumePending()).toBe(false);
 }
});

test('concurrent requests cannot queue duplicate pages while the first UI handoff is in progress',async()=>{
 let now=0;const bus=new PairingRequestBus(()=>now);bus.setForeground(true);let resolve!:(value:boolean)=>void;
 const stop=bus.subscribe(()=>new Promise<boolean>(r=>{resolve=r;}));const first=bus.request({});
 expect(await bus.request({})).toBe(false);expect(bus.consumePending()).toBe(true);resolve(true);expect(await first).toBe(true);
 now=10_000;expect(bus.consumePending()).toBe(false);stop();
 bus.subscribe(()=>bus.consumePending());expect(await bus.request({})).toBe(true);
});

test('route acknowledgement alone never reports an opened QR panel or leaves a late replay',async()=>{
 const bus=new PairingRequestBus(()=>0);bus.setForeground(true);bus.subscribe(()=>true);
 expect(await bus.request()).toBe(false);expect(bus.consumePending()).toBe(false);
});

test('a late mounted phone page cannot consume an expired request or turn it into opened:true',async()=>{
 let now=0;const bus=new PairingRequestBus(()=>now);bus.setForeground(true);let resolve!:(value:boolean)=>void;
 bus.subscribe(()=>new Promise<boolean>(r=>{resolve=r;}));const request=bus.request();
 now=10_000;expect(bus.consumePending()).toBe(false);resolve(true);expect(await request).toBe(false);
});

test('background and UI disposal release a never-resolving route without trapping later foreground requests',async()=>{
 for(const leave of ['background','dispose'] as const){
  const bus=new PairingRequestBus(()=>0);bus.setForeground(true);
  const stop=bus.subscribe(()=>new Promise<boolean>(()=>{}));const first=bus.request({});
  if(leave==='background')bus.setForeground(false);else stop();
  expect(await first).toBe(false);stop();bus.setForeground(true);
  bus.subscribe(()=>bus.consumePending());expect(await bus.request({})).toBe(true);
 }
});

test('an expired unresolved route cannot monopolize the bus after the ten-second deadline',async()=>{
 let now=0;const bus=new PairingRequestBus(()=>now);bus.setForeground(true);let calls=0;
 bus.subscribe(()=>++calls===1?new Promise<boolean>(()=>{}):bus.consumePending());const session={},first=bus.request(session);
 now=10_000;expect(await bus.request(session)).toBe(true);expect(await first).toBe(false);
});

test('pairing activity leases cover manual pairing and release idempotently without opening duplicate QR pages',async()=>{
 const bus=new PairingRequestBus(()=>0);bus.setForeground(true);let calls=0;
 bus.subscribe(()=>{calls++;return bus.consumePending();});
 const first=bus.acquireActivity(),second=bus.acquireActivity();
 expect(await bus.request({})).toBe(false);first();first();expect(await bus.request({})).toBe(false);
 second();expect(await bus.request({})).toBe(true);expect(calls).toBe(1);
});

test('route binding acknowledges only a foreground navigable current page, including blocked/error routes',async()=>{
 for(const outcome of ['opened','blocked','error','inactive','already-open'] as const){
  const bus=new PairingRequestBus(()=>0);bus.setForeground(true);let page=outcome==='already-open'?'phone-connection':'home',navigations=0;
  const stop=bindPairingRequestRoute({active:()=>outcome!=='inactive',page:()=>page,go:async next=>{navigations++;if(outcome==='error')throw Error('route unavailable');if(outcome==='opened')page=next;}},bus);
  const stopPhone=bus.subscribe(()=>outcome!=='inactive'&&page==='phone-connection'&&bus.consumePending());
  expect(await bus.request()).toBe(outcome==='opened'||outcome==='already-open');
  expect(navigations).toBe(outcome==='inactive'||outcome==='already-open'?0:1);stop();stopPhone();expect(bus.consumePending()).toBe(false);
 }
});
