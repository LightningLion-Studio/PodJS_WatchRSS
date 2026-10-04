import {expect,test} from 'bun:test';
import {ApplicationForegroundSync,type ApplicationForegroundPorts,type ApplicationSyncListener} from '../../src/sync/application-foreground.ts';
import type {LibrarySessionRepository,SessionActionResult} from '../../src/sync/session.ts';
import type {DisplayPowerState} from '@podjs/framework/services';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const result=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {result,resolve,reject};}
async function flush(){for(let i=0;i<25;i++)await Promise.resolve();}
class Clock {
 now=0;timers:{at:number;cancelled:boolean;finish:()=>void}[]=[];
 delay=(ms:number)=>{const d=deferred<void>(),row={at:this.now+ms,cancelled:false,finish:()=>d.resolve()};this.timers.push(row);return {result:d.result,cancel:()=>{row.cancelled=true;d.reject(new Error('cancelled'));}};};
 async advance(ms:number){const end=this.now+ms;while(true){this.timers.sort((a,b)=>a.at-b.at);const next=this.timers.find(t=>!t.cancelled&&t.at<=end);if(!next)break;this.timers.splice(this.timers.indexOf(next),1);this.now=next.at;next.finish();await flush();}this.now=end;await flush();}
}
function fixture(){
 const clock=new Clock(),repository=deferred<LibrarySessionRepository>(),repo={} as LibrarySessionRepository;
 const sessions:{options:Parameters<ApplicationSyncListener['start']>[0];done:ReturnType<typeof deferred<SessionActionResult[]>>;stops:number}[]=[],resources:string[]=[],errors:unknown[]=[],states:string[]=[];
 let life='active',lifecycleHandler:((state:string)=>void)|undefined,displayHandler:((state:DisplayPowerState)=>void)|undefined,changes=0;
 let screen:DisplayPowerState={interactive:true,resumed:true,applied:false,windowKeepScreenOn:false,owners:[]};
 const radio={available:true,enabled:true,permission:'granted'};
 const ports:ApplicationForegroundPorts={repository:()=>repository.result,createListener:r=>{expect(r).toBe(repo);const done=deferred<SessionActionResult[]>();let row:typeof sessions[number];return {start:async options=>{row={options,done,stops:0};sessions.push(row);options.onListening?.();return done.result;},stop:()=>{row.stops++;done.reject(new Error('stopped'));}};},lifecycle:()=>life,onLifecycle:fn=>{lifecycleHandler=fn;return ()=>{lifecycleHandler=undefined;};},display:{state:async()=>screen,onChange:fn=>{displayHandler=fn;return ()=>{displayHandler=undefined;};},keepAwake:async(owner,on)=>{resources.push('screen:'+owner+':'+on);}},radio:{status:async()=>({...radio})},silence:{setEnabled:async on=>{resources.push('enabled:'+on);},lease:async(owner,on)=>{resources.push('lease:'+owner+':'+on);}},delay:clock.delay,onError:e=>errors.push(e),onState:s=>states.push(s),onLibraryChanged:()=>changes++};
 const runtime=new ApplicationForegroundSync(ports);
 return {clock,repository,repo,runtime,ports,sessions,resources,errors,states,changes:()=>changes,subscriptions:()=>Number(!!lifecycleHandler)+Number(!!displayHandler),lifecycle:(value:string)=>{life=value;screen={...screen,resumed:value==='active'};lifecycleHandler?.(value);},screen:(interactive:boolean)=>{screen={...screen,interactive};displayHandler?.(screen);},radio,peer:()=>sessions.at(-1)!.options.onPeer?.({remoteName:'phone',remoteAddress:'fixture'})};
}
test('application waits for its durable repository and stops idle listening after lifecycle grace',async()=>{
 const f=fixture();await flush();expect(f.sessions).toHaveLength(0);f.repository.resolve(f.repo);await f.runtime.ready;expect(f.runtime.state).toBe('listening');expect(f.sessions).toHaveLength(1);
 f.lifecycle('background');await f.clock.advance(2499);expect(f.sessions[0]!.stops).toBe(0);await f.clock.advance(1);expect(f.sessions[0]!.stops).toBe(1);
 f.lifecycle('active');await flush();expect(f.sessions).toHaveLength(2);await f.runtime.dispose();expect(f.subscriptions()).toBe(0);expect(f.runtime.state).toBe('disposed');
});
test('accepted transfer retains listening through pause and releases screen and optional audio leases',async()=>{
 const f=fixture();f.repository.resolve(f.repo);await f.runtime.ready;expect(f.resources).toContain('enabled:false');
 f.runtime.setMediaEnabled(true);f.peer();await flush();expect(f.runtime.state).toBe('transferring');expect(f.resources).toContain('screen:rfcomm-bootstrap:true');expect(f.resources).toContain('lease:rfcomm-bootstrap:true');expect(f.resources.indexOf('enabled:true')).toBeLessThan(f.resources.indexOf('lease:rfcomm-bootstrap:true'));
 f.lifecycle('background');f.screen(false);await f.clock.advance(3000);expect(f.sessions[0]!.stops).toBe(0);
 f.sessions[0]!.options.onActionCompleted?.({request:{action:'syncLibrary'},response:{},ack:null,libraryApplied:true});expect(f.changes()).toBe(1);f.sessions[0]!.done.resolve([]);await flush();expect(f.resources.at(-1)).toBe('screen:rfcomm-bootstrap:false');
 await f.clock.advance(33000);expect(f.resources).toContain('lease:rfcomm-bootstrap:false');await f.runtime.dispose();expect(f.resources.slice(-3)).toEqual(['screen:rfcomm-bootstrap:false','lease:rfcomm-bootstrap:false','enabled:false']);
});
test('stale foreground status cannot reopen a paused application',async()=>{
 const f=fixture(),query=deferred<{available:boolean;enabled:boolean;permission:string}>();f.ports.radio.status=()=>query.result;f.repository.resolve(f.repo);await flush();f.lifecycle('background');query.resolve({available:true,enabled:true,permission:'granted'});await f.runtime.ready;expect(f.sessions).toHaveLength(0);await f.runtime.dispose();
});
test('dispose during initialization prevents listener creation and releases subscriptions',async()=>{
 const f=fixture(),closing=f.runtime.dispose();f.repository.resolve(f.repo);await closing;expect(f.sessions).toHaveLength(0);expect(f.subscriptions()).toBe(0);expect(f.resources.slice(-3)).toEqual(['screen:rfcomm-bootstrap:false','lease:rfcomm-bootstrap:false','enabled:false']);
});
test('disabled radio and exclusive ownership gate listeners and refresh can restore eligibility',async()=>{
 const f=fixture();f.radio.permission='required';f.repository.resolve(f.repo);await f.runtime.ready;expect(f.sessions).toHaveLength(0);f.runtime.setExclusive(true);f.radio.permission='granted';await f.runtime.refresh();expect(f.sessions).toHaveLength(0);f.runtime.setExclusive(false);expect(f.sessions).toHaveLength(1);await f.runtime.dispose();
});
test('resource failure is reported without preventing later cleanup commands',async()=>{
 const f=fixture();f.ports.silence.setEnabled=async on=>{f.resources.push('enabled:'+on);if(on)throw new Error('audio unavailable');};f.runtime.setMediaEnabled(true);f.repository.resolve(f.repo);await f.runtime.ready;expect(f.errors.map(String)).toContain('Error: audio unavailable');f.peer();await flush();await f.runtime.dispose();expect(f.resources.at(-1)).toBe('enabled:false');expect(f.subscriptions()).toBe(0);
});
