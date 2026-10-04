import {mount} from '@pocketjs/framework/solid';
import {Text,View} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {delay,fileChunks,discovery,application} from '@podjs/framework/services';
import {OnboardingScreen} from '../../../src/ui/OnboardingScreen.tsx';
import {PrivacyPolicyConsentScreen} from '../../../src/ui/PrivacyPolicyConsentScreen.tsx';
import {initialIntroState,transitionIntro,type IntroAction} from '../../../src/onboarding/state.ts';
import {observeHostInternet} from '../../../src/onboarding/network-host.ts';
import {useReaderTitleEntry} from '../../../src/ui/ReaderTitleEntry.tsx';
import {defaultReaderPreset} from '../../../src/reader/preset.ts';
import {readerFontResolver} from '../../../src/reader/font-assets.ts';

// This fixture never loads the user's settings or onboarding store. Staged
// rendering is driven by in-memory state, not injected physical input.
const metrics=getDisplayMetrics(),[intro,setIntro]=createSignal(initialIntroState());
const [stage,setStage]=createSignal('welcome'),[dark,setDark]=createSignal(true);
let completionRequests=0;
const action=(value:IntroAction)=>{const next=transitionIntro(intro(),value);setIntro(next.state);if(next.complete)completionRequests++;};
const key='onboarding-ui-result';
async function advance(name:string){
 const deadline=Date.now()+60000;
 while(!(await fileChunks.stat('onboarding-advance-'+name)).file){if(Date.now()>deadline)throw Error('Stage timeout '+name);await delay(150).result;}
}
async function probeNetwork(){
 const statuses:string[]=[];
 const dispose=observeHostInternet(status=>statuses.push(status));
 try{
  const deadline=Date.now()+10000;
  while(statuses.at(-1)==='checking'){if(Date.now()>deadline)throw Error('Network monitor timeout');await delay(50).result;}
  const snapshot=await discovery.networkSnapshot();
  kv.set(key,{state:'running',stage:'network-observed',snapshot,statuses});await advance('network-observed');
 }finally{dispose();}
 await delay(250).result;
 kv.set(key,{state:'running',stage:'network-released',statuses});await advance('network-released');
}
async function capture(name:string){
 setStage(name);await delay(1500).result;
 kv.set(key,{state:'running',stage:name,intro:intro(),completionRequests,metrics});
 await advance(name);
}
async function run(){
 await probeNetwork();
 await capture('welcome');action({type:'next'});await capture('agreement');
 action({type:'next'});if(!intro().agreementError||completionRequests)throw Error('Agreement gate');await capture('agreement-error');
 action({type:'agreement',agreed:true});await capture('agreement-checked');action({type:'next'});await capture('customization');
 action({type:'next'});await capture('network-checking');action({type:'next'});if(completionRequests)throw Error('Checking gate');
 action({type:'internet',status:'unavailable'});await capture('network-unavailable');action({type:'next'});await capture('offline-warning');
 action({type:'back'});if(intro().offlineWarning||intro().page!==3)throw Error('Warning back');
 action({type:'internet',status:'bluetooth'});await capture('network-bluetooth');action({type:'next'});await capture('bluetooth-warning');
 action({type:'internet',status:'available'});if(intro().offlineWarning)throw Error('Online warning dismissal');await capture('network-available');
 action({type:'next'});if(completionRequests!==1)throw Error('Completion request');
 await capture('privacy');kv.set(key,{state:'passed',stage:'done',completionRequests,consentPersistenceExercised:false,physicalInputExercised:false});
 await advance('done');
 // Exit through the public JS bridge; instrumentation verifies destruction.
 await application.finishTask();
}
function App(){const preset=defaultReaderPreset(),fonts=readerFontResolver({});const title=useReaderTitleEntry(()=>"隐私政策更新",()=>metrics.logicalWidth-28,()=>preset,()=>fonts,()=>"#ffffff");return <Show when={stage()!=='privacy'} fallback={<PrivacyPolicyConsentScreen width={metrics.logicalWidth} height={metrics.logicalHeight} background={<View class="absolute inset-0 bg-black"/>} title={title()} onOpenPrivacy={()=>{}} onAgree={()=>{}} onDisagree={()=>{}}/>}>
 <OnboardingScreen width={metrics.logicalWidth} height={metrics.logicalHeight} state={intro()} onAction={action} readerDark={dark()} onToggleReaderTheme={()=>setDark(v=>!v)} onOpenLegal={()=>{}}/>
 </Show>;}
mount(App);void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
