import {expect,test} from 'bun:test';
import {ForegroundSyncController,type ForegroundSyncFacts,type ForegroundTimer,type ForegroundListener} from '../../src/sync/foreground.ts';
import type {LibrarySessionOptions,SessionActionResult} from '../../src/sync/session.ts';
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const result=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {result,resolve,reject};}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const enabled:ForegroundSyncFacts={resumed:true,interactive:true,exclusive:false,permission:true,enabled:true};
class Clock {
 now=0;timers:{at:number;cancelled:boolean;finish:()=>void}[]=[];
 delay=(ms:number):ForegroundTimer=>{const d=deferred<void>();const entry={at:this.now+ms,cancelled:false,finish:()=>d.resolve()};this.timers.push(entry);return {result:d.result,cancel:()=>{entry.cancelled=true;d.reject(new Error('cancelled'));}};};
 async advance(ms:number){const end=this.now+ms;while(true){this.timers.sort((a,b)=>a.at-b.at);const next=this.timers.find(t=>!t.cancelled&&t.at<=end);if(!next)break;this.timers.splice(this.timers.indexOf(next),1);this.now=next.at;next.finish();await flush();}this.now=end;await flush();}
}
function fixture(){
 const clock=new Clock(),sessions:{options:Parameters<ForegroundListener['start']>[0];done:ReturnType<typeof deferred<SessionActionResult[]>>;stops:number}[]=[],screen:boolean[]=[],media:string[]=[],errors:unknown[]=[];
 const controller=new ForegroundSyncController({delay:clock.delay,createListener:()=>{const done=deferred<SessionActionResult[]>();let row:typeof sessions[number];return {start:async options=>{row={options,done,stops:0};sessions.push(row);return done.result;},stop:()=>{row.stops++;done.reject(new Error('stopped'));}};},keepScreenOn:v=>{screen.push(v);},acquireMedia:owner=>media.push('acquire:'+owner),releaseMedia:owner=>media.push('release:'+owner),onError:e=>errors.push(e)});
 return {controller,clock,sessions,screen,media,errors,peer:(i:number)=>sessions[i]!.options.onPeer?.({remoteName:'phone',remoteAddress:'test'})};
}
test('all native foreground conditions gate listening and brief pauses preserve a listener',async()=>{
 const f=fixture();for(const key of Object.keys(enabled) as (keyof ForegroundSyncFacts)[]){f.controller.update({...enabled,[key]:!enabled[key]});expect(f.sessions).toHaveLength(0);}
 f.controller.update(enabled);expect(f.sessions).toHaveLength(1);
 f.controller.update({...enabled,resumed:false});await f.clock.advance(2499);expect(f.sessions[0]!.stops).toBe(0);
 f.controller.update(enabled);await f.clock.advance(1);expect(f.sessions[0]!.stops).toBe(0);expect(f.sessions).toHaveLength(1);
 f.controller.update({...enabled,interactive:false});await f.clock.advance(2500);expect(f.sessions[0]!.stops).toBe(1);
 f.controller.update(enabled);await flush();expect(f.sessions).toHaveLength(2);await f.controller.dispose();
});
test('a transfer survives backgrounding and idle listening stops after its completion grace',async()=>{
 const f=fixture();f.controller.update(enabled);f.peer(0);f.controller.update({...enabled,resumed:false});await f.clock.advance(10000);
 expect(f.sessions[0]!.stops).toBe(0);expect(f.screen.at(-1)).toBe(true);expect(f.media).toEqual(['acquire:rfcomm-bootstrap']);
 f.sessions[0]!.done.resolve([]);await flush();expect(f.sessions).toHaveLength(2);expect(f.screen.at(-1)).toBe(false);
 await f.clock.advance(2499);expect(f.sessions[1]!.stops).toBe(0);await f.clock.advance(1);expect(f.sessions[1]!.stops).toBe(1);
 await f.clock.advance(30000);expect(f.media.at(-1)).toBe('release:rfcomm-bootstrap');await f.controller.dispose();
});
test('retry delay is 500ms and shutdown cancels pending retries',async()=>{
 const f=fixture();f.controller.update(enabled);f.sessions[0]!.done.reject(new Error('radio failed'));await flush();expect(f.errors).toHaveLength(1);
 await f.clock.advance(499);expect(f.sessions).toHaveLength(1);await f.clock.advance(1);expect(f.sessions).toHaveLength(2);
 f.sessions[1]!.done.reject(new Error('again'));await flush();await f.controller.dispose();await f.clock.advance(1000);expect(f.sessions).toHaveLength(2);
});
test('reconnecting before media handoff expiry renews its lease and disposal releases once',async()=>{
 const f=fixture();f.controller.update(enabled);f.peer(0);f.sessions[0]!.done.resolve([]);await flush();await f.clock.advance(29999);f.peer(1);await f.clock.advance(1);
 expect(f.media.filter(s=>s.startsWith('release'))).toEqual([]);f.sessions[1]!.done.resolve([]);await flush();await f.controller.dispose();await f.clock.advance(30000);
 expect(f.media.filter(s=>s.startsWith('release'))).toEqual(['release:rfcomm-bootstrap']);
});
test('resume during stopping waits for old session cleanup before creating its replacement',async()=>{
 const clock=new Clock(),pending=[deferred<SessionActionResult[]>(),deferred<SessionActionResult[]>()];let starts=0,stops=0;
 const controller=new ForegroundSyncController({delay:clock.delay,createListener:()=>{const done=pending[starts]!;return {start:()=>{starts++;return done.result;},stop:()=>{stops++;}};},keepScreenOn:()=>{},acquireMedia:()=>{},releaseMedia:()=>{}});
 controller.update(enabled);controller.update({...enabled,resumed:false});await clock.advance(2500);controller.update(enabled);expect(starts).toBe(1);expect(stops).toBe(1);
 pending[0]!.reject(new Error('closed'));await flush();expect(starts).toBe(2);
 const closed=controller.dispose();pending[1]!.reject(new Error('closed'));await closed;expect(stops).toBe(2);
});

test('an unexpected listener factory failure does not spin an unbounded restart loop',async()=>{
 const clock=new Clock(),errors:unknown[]=[];let calls=0;
 const controller=new ForegroundSyncController({delay:clock.delay,createListener:()=>{calls++;throw new Error('factory failed');},keepScreenOn:()=>{},acquireMedia:()=>{},releaseMedia:()=>{},onError:e=>errors.push(e)});
 controller.update(enabled);await flush();expect(calls).toBe(1);expect(errors).toHaveLength(1);await expect(controller.dispose()).resolves.toBeUndefined();
});
