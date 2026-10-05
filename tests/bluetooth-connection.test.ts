import {afterEach,expect,test} from 'bun:test';
import {BluetoothConnectionController,type BluetoothConnectionState} from '../src/ui/bluetooth-connection.ts';
import type {ApplicationSyncEvent,ApplicationSyncState} from '../src/sync/application-foreground.ts';
import {clearRemoteInput,completeRemoteInput,enqueueRemoteInput,subscribeRemoteInput,takeRemoteInput} from '../src/remote-input/inbox.ts';
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const disposers:(()=>void)[]=[];
afterEach(()=>{for(const stop of disposers.splice(0))stop();clearRemoteInput();});
function fixture(returnRemoteUrl=false){
 const events=new Set<(event:ApplicationSyncEvent)=>void>(),states:BluetoothConnectionState[]=[],urls:unknown[]=[];
 const radio={available:true,permission:'granted',enabled:true};let requests=0,refreshes=0;
 let permission:()=>Promise<string>=async()=>{radio.permission='granted';return 'granted';};
 const sync={state:'listening' as ApplicationSyncState,subscribe:(fn:(event:ApplicationSyncEvent)=>void)=>{events.add(fn);return ()=>{events.delete(fn);};},refresh:async()=>{refreshes++;}};
 const controller=new BluetoothConnectionController({sync,radio:{status:async()=>({...radio}),requestPermission:()=>{requests++;return permission();}}},{abilityLabel:'收藏',returnRemoteUrl,onUrl:(...args)=>urls.push(args)},state=>states.push(state));
 disposers.push(()=>controller.dispose());
 return {controller,radio,sync,events,states,urls,requests:()=>requests,refreshes:()=>refreshes,permission:(fn:()=>Promise<string>)=>{permission=fn;},emit:(event:ApplicationSyncEvent)=>{for(const fn of events)fn(event);},start:async()=>{controller.setActive(true);await flush();}};
}
const completed=(action:string,extra:Partial<Extract<ApplicationSyncEvent,{type:'completed'}>>={}):ApplicationSyncEvent=>({type:'completed',action,success:true,message:'',count:4,received:5,applied:3,...extra});
test('permission denial, retry, grant; busy waiting hides terminal state until a result',async()=>{
 const f=fixture();f.radio.permission='required';f.permission(async()=> 'required');await f.start();
 expect(f.controller.state).toEqual({status:'缺少蓝牙权限',detail:'请允许蓝牙权限后重试',busy:false});expect(f.refreshes()).toBe(0);
 f.permission(async()=>{f.radio.permission='granted';return 'granted';});await f.controller.retry();
 expect(f.requests()).toBe(2);expect(f.refreshes()).toBe(1);expect(f.controller.state).toEqual({status:'等待手机蓝牙连接…',detail:'请在手机 Companion 中选择对应操作',busy:true});
});
test('result text matches native and survives the application listener restart',async()=>{
 const f=fixture();await f.start();f.emit(completed('pullSavedItems'));
 expect(f.controller.state).toEqual({status:'已通过蓝牙同步',detail:'已向手机发送 4 条收藏',busy:false});
 f.emit({type:'state',state:'listening'});f.emit(completed('syncLibrary'));expect(f.controller.state.status).toBe('已通过蓝牙同步');
 await f.controller.retry();f.emit(completed('syncLibrary'));expect(f.controller.state.detail).toBe('收到 5 条，应用 3 项变更');
 await f.controller.retry();f.emit(completed('probe'));expect(f.controller.state).toEqual({status:'蓝牙连接成功',detail:'手机已完成握手',busy:false});
});
test('failed action and transport errors provide native failure and allow retry',async()=>{
 const f=fixture();await f.start();f.emit(completed('syncLibrary',{success:false,message:'同步被拒绝'}));
 expect(f.controller.state).toEqual({status:'蓝牙同步失败',detail:'同步被拒绝',busy:false});
 await f.controller.retry();f.emit({type:'error',message:'连接断开'});expect(f.controller.state.detail).toBe('连接断开');
});
test.each([true,false])('URL handoff returns or opens Add RSS exactly once; shared queue retained (%s)',async returnRemoteUrl=>{
 const f=fixture(returnRemoteUrl);enqueueRemoteInput('https://old.test');await f.start();expect(f.urls).toEqual([]);
 completeRemoteInput({request:{action:'remoteInput',url:'  https://feed.test/rss  '},response:{success:false}});expect(f.urls).toEqual([]);
 completeRemoteInput({request:{action:'remoteInput',url:'  https://feed.test/rss  '},response:{success:true}});
 f.emit(completed('remoteInput'));enqueueRemoteInput('https://second.test');
 expect(f.urls).toEqual([['https://feed.test/rss',returnRemoteUrl?'return':'add']]);expect(f.controller.state.status).toBe('已收到 RSS 地址');
 expect(takeRemoteInput()).toBe('https://old.test');expect(takeRemoteInput()).toBe('https://feed.test/rss');expect(takeRemoteInput()).toBe('https://second.test');
});
test('inactive and disposed pages ignore deliveries and pending permission completions',async()=>{
 const f=fixture();f.radio.permission='required';let grant!:(value:string)=>void;f.permission(()=>new Promise(resolve=>{grant=resolve;}));await f.start();
 expect(f.controller.state).toEqual({status:'等待手机蓝牙连接…',detail:null,busy:false});
 f.controller.setActive(false);enqueueRemoteInput('https://inactive.test');grant('granted');await flush();expect(f.refreshes()).toBe(0);expect(f.urls).toEqual([]);
 f.radio.permission='granted';await f.start();f.controller.dispose();const count=f.states.length;
 f.emit(completed('probe'));enqueueRemoteInput('https://disposed.test');expect(f.states).toHaveLength(count);expect(f.events.size).toBe(0);expect(f.urls).toEqual([]);
});
test('unsupported/disabled radio, platform exception and disposed runtime are retryable failures',async()=>{
 const f=fixture();f.radio.available=false;await f.start();expect(f.controller.state.detail).toBe('当前设备不支持蓝牙连接');
 f.radio.available=true;f.radio.enabled=false;await f.controller.retry();expect(f.controller.state.detail).toBe('请开启蓝牙后重试');
 f.radio.enabled=true;f.radio.permission='required';f.permission(async()=>{throw Error('权限服务失败');});await f.controller.retry();expect(f.controller.state.detail).toBe('权限服务失败');
 f.radio.permission='granted';f.sync.state='disposed';await f.controller.retry();expect(f.controller.state.busy).toBe(false);
});
test('inbox observation preserves queue order, unsubscribe and exception isolation',()=>{
 const values:string[]=[];const bad=subscribeRemoteInput(()=>{throw Error('observer');}),stop=subscribeRemoteInput(url=>values.push(url));disposers.push(bad,stop);
 enqueueRemoteInput('  ');enqueueRemoteInput('https://one.test');stop();enqueueRemoteInput('https://two.test');
 expect(values).toEqual(['https://one.test']);expect(takeRemoteInput()).toBe('https://one.test');expect(takeRemoteInput()).toBe('https://two.test');expect(takeRemoteInput()).toBeUndefined();
});
