import {mount} from '@pocketjs/framework/solid';
import {Text,View} from '@pocketjs/framework/components';
import {kv,setNavigationState} from '@podjs/framework/watch';
import {StartupGate} from '../../../src/ui/StartupGate.tsx';
import {application,textLayout} from '@podjs/framework/services';
import {createSignal} from 'solid-js';
import {InformationDocumentFixture} from './InformationDocumentFixture.tsx';
import {onFrame} from '@pocketjs/framework/lifecycle';
// The package has its own Android data namespace. The actual production gate
// and button callbacks run unchanged; instrumentation only seeds fixture data.
function Content(){setNavigationState({canGoBack:false});kv.set('startup-content-mounts',Number(kv.get('startup-content-mounts')??0)+1);return <View class="absolute inset-0 bg-black"><Text class="text-white">验证主页</Text></View>;}
function StateProbe(){
 const [status,setStatus]=createSignal('读取状态');
 void (async()=>{
  const state=await application.activityState.read();kv.set('activity-state-observed',state);
  if(!state.saved.checkpoint)await application.activityState.write({saved:{checkpoint:{agreed:true,value:'keep'}},retained:{page:2}});
  setStatus('状态已就绪');
 })().catch(error=>{kv.set('activity-state-error',String(error));setStatus(String(error));});
 return <View class="absolute inset-0 bg-black"><Text class="text-white">{status()}</Text></View>;
}
function CapacityProbe(){
 const [status,setStatus]=createSignal('正在验证状态容量');
 void (async()=>{
  const savedBytes=64*1024,retainedBytes=896*1024,overhead=JSON.stringify({payload:''}).length;
  const expected={saved:{payload:'S'.repeat(savedBytes-overhead)},retained:{payload:'R'.repeat(retainedBytes-overhead)}};
  const savedJson=JSON.stringify(expected.saved),retainedJson=JSON.stringify(expected.retained);
  if(savedJson.length!==savedBytes||retainedJson.length!==retainedBytes)throw new Error('ASCII fixture size mismatch');
  const same=async(stage:string)=>{
   const state=await application.activityState.read();
   if(JSON.stringify(state.saved)!==savedJson||JSON.stringify(state.retained)!==retainedJson)throw new Error(`${stage}: complete state differs`);
  };
  const initial=await application.activityState.read();
  const empty=Object.keys(initial.saved).length===0&&Object.keys(initial.retained).length===0;
  if(empty)await application.activityState.write(expected);
  await same(empty?'initial boundary write':'restored boundary state');
  const reject=async(state:typeof expected,stage:string)=>{
   let message:string|undefined;
   try{await application.activityState.write(state);}catch(error){message=String(error);}
   if(message===undefined)throw new Error(`${stage}: one-byte overflow was accepted`);
   await same(stage);return message;
  };
  const savedError=await reject({saved:{payload:expected.saved.payload+'S'},retained:expected.retained},'saved overflow');
  const retainedError=await reject({saved:expected.saved,retained:{payload:expected.retained.payload+'R'}},'retained overflow');
  const previous=kv.get('activity-state-capacity-result');
  const run=previous!==null&&typeof previous==='object'&&!Array.isArray(previous)?Number((previous as Record<string,unknown>).run??0)+1:1;
  kv.set('activity-state-capacity-result',{state:'passed',run,restoredAtLaunch:!empty,initialAcceptedWrites:empty?1:0,
   savedJsonBytes:savedJson.length,retainedJsonBytes:retainedJson.length,readbackMatchesExactly:true,
   savedOverflowRejected:true,retainedOverflowRejected:true,afterSavedOverflowUnchanged:true,afterRetainedOverflowUnchanged:true,
   savedOverflowError:savedError,retainedOverflowError:retainedError,asciiPayloads:true});
  setStatus('状态容量验证已就绪');
 })().catch(error=>{kv.set('activity-state-capacity-error',String(error));setStatus('状态容量验证失败');});
 return <View class="absolute inset-0 bg-black"><Text class="text-white">{status()}</Text></View>;
}
function TextEnvironmentProbe(){
 const [status,setStatus]=createSignal('正在读取文字环境');
 void(async()=>{
  const queried=await textLayout.environment({spValues:[12,14,21,26,12]});
  const empty=await textLayout.environment();
  const previous=kv.get('text-environment-result');
  const run=previous!==null&&typeof previous==='object'&&!Array.isArray(previous)?Number((previous as Record<string,unknown>).run??0)+1:1;
  kv.set('text-environment-result',{state:'passed',run,queried,empty});
  setStatus('文字环境已就绪');
 })().catch(error=>{kv.set('text-environment-error',String(error));setStatus('文字环境验证失败');});
 return <View class="absolute inset-0 bg-black"><Text class="text-white">{status()}</Text></View>;
}
/** Opt-in evidence for the isolated legal tests only. Keep run identity outside
 * Activity state so pending restoration itself is never changed by the probe. */
function legalRestorationEvents():Parameters<typeof StartupGate>[0]['onLegalRestorationEvent'] {
 if(kv.get('legal-restoration-events')!==true)return undefined;
 const key='legal-restoration-event-log',seedId=kv.get('legal-restoration-event-seed');
 if(typeof seedId!=='string'||!seedId)throw Error('Missing legal event fixture seed');
 const frameProbe=kv.get('legal-restoration-frame-probe')===true;
 let frameCount=0;
 type FrameEvidence={frameCount?:number;firstFrameObservedAtEpochMs?:number};
 type Event={sequence:number;run:number;instanceId:string;page:string;event:string;atEpochMs:number;frameCount?:number};
 type Run={run:number;instanceId:string;startedAtEpochMs:number}&FrameEvidence;
 type Log={version:1;seedId:string;run:number;instanceId:string;sequence:number;runs:Run[];events:Event[];droppedEvents:number}&FrameEvidence;
 const value=kv.get(key),prior=value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Partial<Log>:undefined;
 const previous=prior?.version===1&&prior.seedId===seedId&&Number.isSafeInteger(prior.run)&&Number.isSafeInteger(prior.sequence)
  &&Array.isArray(prior.runs)&&Array.isArray(prior.events)&&Number.isSafeInteger(prior.droppedEvents)?prior as Log:undefined;
 const run=(previous?.run??0)+1,startedAtEpochMs=Date.now();
 const instanceId=`${seedId}/${run}/${startedAtEpochMs}/${Math.random().toString(36).slice(2)}`;
 kv.set(key,{version:1,seedId,run,instanceId,sequence:previous?.sequence??0,
  runs:[...(previous?.runs??[]),{run,instanceId,startedAtEpochMs,...(frameProbe?{frameCount}: {})}].slice(-16),
  events:(previous?.events??[]).slice(-256),droppedEvents:previous?.droppedEvents??0,...(frameProbe?{frameCount}: {})} satisfies Log);
 if(frameProbe)onFrame(()=>{
  frameCount++;
  // One observation establishes that rendering resumed. Subsequent frames only
  // increment this local integer; actual event callbacks sample it below.
  if(frameCount!==1)return;
  const current=kv.get(key) as Log|null;
  if(!current||current.seedId!==seedId||current.run!==run||current.instanceId!==instanceId)return;
  const observed={frameCount,firstFrameObservedAtEpochMs:Date.now()};
  kv.set(key,{...current,...observed,runs:current.runs.map(item=>item.run===run&&item.instanceId===instanceId?{...item,...observed}:item)} satisfies Log);
 });
 return (page,event)=>{
  const current=kv.get(key) as Log|null;
  // An old guest finishing disposal must never overwrite the new run's log.
  if(!current||current.seedId!==seedId||current.run!==run||current.instanceId!==instanceId)return;
  const sequence=current.sequence+1;
  const sampled=frameProbe?{frameCount}:{};
  const events=[...current.events,{sequence,run,instanceId,page,event,atEpochMs:Date.now(),...sampled}];
  kv.set(key,{...current,...sampled,sequence,events:events.slice(-256),
   runs:frameProbe?current.runs.map(item=>item.run===run&&item.instanceId===instanceId?{...item,...sampled}:item):current.runs,
   droppedEvents:current.droppedEvents+(events.length>256?1:0)} satisfies Log);
 };
}
mount(()=>{
 if(kv.get('information-document-fixture'))return <InformationDocumentFixture/>;
 if(kv.get('text-environment-fixture'))return <TextEnvironmentProbe/>;
 if(kv.get('activity-state-capacity-fixture'))return <CapacityProbe/>;
 if(kv.get('activity-state-fixture'))return <StateProbe/>;
 const legalBaseUrl=kv.get('startup-legal-base-url');
 const onLegalRestorationEvent=legalRestorationEvents();
 return <StartupGate content={Content} legalBaseUrl={typeof legalBaseUrl==='string'?legalBaseUrl:undefined} onLegalRestorationEvent={onLegalRestorationEvent}/>;
});
