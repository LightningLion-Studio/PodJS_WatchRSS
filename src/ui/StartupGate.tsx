import {openBrowserUrl} from "../browser/open.ts";
import {For,Show,createEffect,createMemo,createSignal,onCleanup,untrack,type JSX} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createGesture} from '@pocketjs/framework/gesture';
import {onFrame} from '@pocketjs/framework/lifecycle';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {getDisplayMetrics,kv,onAxisDelta,onSystemBack,onLifecycleChange,lifecycle,RelativeAxis,RelativeAxisUnits,setNavigationState} from '@podjs/framework/watch';
import {application,type ActivityState} from '@podjs/framework/services';
import {captureIntro,restoreIntro,captureCustomization,restoreCustomization,type CustomizationDraft} from '../onboarding/restoration.ts';
import {captureLegalNavigation,hydrateLegalNavigation,prepareLegalNavigation,type LegalNavigation,type StartupLegalPage} from '../onboarding/legal-restoration.ts';
import {createLegalRecoveryFiles} from '../onboarding/legal-recovery-files.ts';
import {createLegalSnapshotWriter} from '../onboarding/legal-snapshot-writer.ts';
import {startupDestination} from '../onboarding/state.ts';
import {OnboardingStore,type OnboardingStorage} from '../onboarding/store.ts';
import {OnboardingController,type OnboardingSession} from '../onboarding/controller.ts';
import {observeHostInternet} from '../onboarding/network-host.ts';
import {ReaderPresetStore,activeReaderPreset,onReaderPresetsChanged,notifyReaderPresetsChanged,type ReaderPresetState} from '../reader/preset-store.ts';
import {defaultReaderPreset} from '../reader/preset.ts';
import {readerFontResolver} from '../reader/font-assets.ts';
import {readerChrome} from '../reader/chrome.ts';
import {SettingsStore} from '../settings/store.ts';
import {OnboardingScreen} from './OnboardingScreen.tsx';
import {PrivacyPolicyConsentScreen} from './PrivacyPolicyConsentScreen.tsx';
import {useReaderTitleEntry} from './ReaderTitleEntry.tsx';
import {ReaderBackground} from './ReaderBackground.tsx';
import {InformationScreen,type InformationPage,type InformationSnapshot,type InformationRestorationEvent} from './InformationScreens.tsx';
import {BackMotion} from './back-motion.ts';
import {ScrollEntries} from './ScrollEntries.tsx';
import {watchUiLines} from './text-layout.ts';
import {STARTUP_EXIT_DURATION_MS,startupExitFrame} from './startup-transition.ts';

/** Content is a factory so it cannot mount or start foreground work before the
 * native startup version gates have resolved. Storage injection is for isolated
 * fixtures; normal callers use the app's existing KV namespace. */
export function StartupGate(props:{content:()=>JSX.Element;storage?:OnboardingStorage;legalBaseUrl?:string;onLegalRestorationEvent?:(page:StartupLegalPage,event:InformationRestorationEvent)=>void}){
 const storage=props.storage??kv,store=new OnboardingStore(storage);
 const [session,setSession]=createSignal<OnboardingSession>();
 const [fatal,setFatal]=createSignal('');
 let controller:OnboardingController|undefined;
 let activityState:ActivityState={saved:{},retained:{}},generation=0;
 const legalFiles=createLegalRecoveryFiles(),legalBaseUrl=props.legalBaseUrl??'https://sly-data-plane.watchrss.cn';
 let restoredLegal:LegalNavigation={pages:[],snapshots:[]};
 let legalWriter:ReturnType<typeof createLegalSnapshotWriter>|undefined;
 onCleanup(()=>{generation++;legalWriter?.close();});
 const saveActivityState=()=>{const current=generation;void application.activityState.write(activityState).catch(error=>{if(current===generation)setFatal(String(error));});};
 const saveCustomization=(draft:CustomizationDraft)=>{
  const current=controller?.snapshot();if(current?.destination!=='intro'||current.intro.page!==2)return;
  activityState=captureCustomization(activityState,draft);saveActivityState();
 };
 const saveLegal=(navigation:LegalNavigation)=>legalWriter?.save(navigation);
 const changed=(value:OnboardingSession)=>{
  activityState=captureIntro(activityState,value.destination==='intro'?value.intro:undefined);
  if(value.destination==='content'||value.destination==='finished'){
   const empty:LegalNavigation={pages:[],snapshots:[]};
   // Supersede a body write still in flight before clearing the published stack.
   legalWriter?.save(empty);
   activityState=captureLegalNavigation(activityState,empty);
  }
  saveActivityState();setSession(value);
 };
 const load=()=>{const current=++generation;legalWriter?.close();setFatal('');setSession(undefined);void(async()=>{
  const restored=await application.activityState.read();if(current!==generation)return;
  activityState=restored;
  if(startupDestination(store.load())==='intro')restoreCustomization(restored);
  const loadedLegal:LegalNavigation=startupDestination(store.load())==='content'?{pages:[],snapshots:[]}:
   await hydrateLegalNavigation(restored,legalFiles,legalBaseUrl,error=>console.warn('Legal snapshot restore',String(error)));
  if(current!==generation)return;
  restoredLegal=loadedLegal;
  const owner=restoredLegal.owner??`task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  legalWriter=createLegalSnapshotWriter({
   initial:restoredLegal,
   prepare:(navigation,previous)=>prepareLegalNavigation(navigation,legalFiles,legalBaseUrl,owner,previous),
   publish:async navigation=>{
    if(current!==generation)return;
    // Commit files before references. Publication is irreversible even if the
    // host acknowledgement is lost: an Android saved Bundle may now use them.
    const next=captureLegalNavigation(activityState,navigation);
    for(const reference of navigation.bodyReferences??[])if(reference)legalFiles.markPublished(reference);
    activityState=next;
    await application.activityState.write(next);
   },
   discard:reference=>legalFiles.discardUnpublished(reference),
   onError:error=>{if(current===generation)setFatal(String(error));},
  });
  controller=new OnboardingController(store,changed,startupDestination(store.load())==='intro'?restoreIntro(restored):undefined);
  changed(controller.snapshot());
 })().catch(error=>{if(current===generation)setFatal(String(error));});};
 load();
 const destination=createMemo(()=>session()?.destination);
 return <StartupTransition ready={()=>!!fatal()||!!session()} render={()=><Show when={!fatal()} fallback={<StartupFailure message={fatal()} onRetry={load}/>}><Show when={destination()==='content'} fallback={<Show when={session()}>{value=><OnboardingHost session={value()} controller={controller!} legalBaseUrl={props.legalBaseUrl} restoreCustomization={()=>restoreCustomization(activityState)} saveCustomization={saveCustomization} restoreLegal={()=>restoredLegal} saveLegal={saveLegal} onLegalRestorationEvent={props.onLegalRestorationEvent}/>}</Show>}>
   <StartupContent render={props.content}/>
  </Show></Show>}/>;
}

function StartupTransition(props:{ready:()=>boolean;render:()=>JSX.Element}){
 const [elapsed,setElapsed]=createSignal(0),[finished,setFinished]=createSignal(false);let started:number|undefined;
 const now=()=>globalThis.performance?.now?.()??Date.now();
 createEffect(()=>{if(!props.ready()){started=undefined;setElapsed(0);setFinished(false);return;}if(started===undefined){started=now();setElapsed(0);setFinished(false);}});
 onFrame(()=>{if(started===undefined||finished())return;const value=Math.max(0,now()-started);setElapsed(value);if(value>=STARTUP_EXIT_DURATION_MS)setFinished(true);});
 return <><Show when={props.ready()}>{props.render()}</Show><Show when={!finished()}><StartupLoading exitElapsedMs={elapsed()}/></Show></>;
}

function StartupLoading(props:{exitElapsedMs:number}){
 setNavigationState({canGoBack:false,rootSwipeEnabled:false});onCleanup(()=>setNavigationState({canGoBack:false}));
 const metrics=getDisplayMetrics(),badge=82,frame=()=>startupExitFrame(props.exitElapsedMs);
 // Pod apps cannot own the host Android splash window; animate the first app
 // surface while the resolved destination is already mounted underneath.
 return <View debugName="WatchRssLaunchOverlay" accessibilityLabel="腕上RSS正在启动" accessibilityHidden={props.exitElapsedMs>0} onPress={()=>{}} class="absolute inset-0 bg-[#030506]" style={{opacity:frame().opacity,scale:frame().scale}}>
  <View class="absolute w-[126] h-[126] rounded-[9999] bg-[#15211f]" style={{insetL:(metrics.logicalWidth-126)/2,insetT:(metrics.logicalHeight-126)/2-20}}/>
  <View class="absolute rounded-[9999] bg-[#111719] border-[#ff6026] border-[1] items-center justify-center" style={{insetL:(metrics.logicalWidth-badge)/2,insetT:(metrics.logicalHeight-badge)/2-20,width:badge,height:badge}}><Text class="text-[21px] leading-[26] text-[#ff7845]">RSS</Text></View>
  <Text class="absolute left-[18] right-[18] text-lg leading-[22] text-[#f5f5f5] text-center" style={{insetT:metrics.logicalHeight/2+35}}>腕上RSS</Text>
  <Text class="absolute left-[18] right-[18] text-xs leading-[14] text-[#b6b6b6] text-center" style={{insetT:metrics.logicalHeight/2+62}}>抬腕即读，轻巧聚合</Text>
 </View>;
}

function StartupContent(props:{render:()=>JSX.Element}){return props.render();}

function StartupFailure(props:{message:string;onRetry:()=>void}){
 setNavigationState({canGoBack:false,rootSwipeEnabled:false});
 onCleanup(()=>setNavigationState({canGoBack:false}));
 const metrics=getDisplayMetrics();
 const lines=()=>watchUiLines(props.message,{width:metrics.logicalWidth-36,measure:text=>getOps().measureText(text,0)});
 return <View class="absolute inset-0 bg-black"><ScrollEntries height={metrics.logicalHeight} entries={[
  {height:30,render:()=> <Text class="text-lg text-white">启动记录无法读取</Text>},
  {height:lines().length*14,render:()=> <Text class="text-xs leading-[14] text-[#e54d4d]">{lines().join('\n')}</Text>},
  {height:48,render:()=> <View focusable onPress={props.onRetry} class="absolute inset-0 rounded-[24] bg-[#23272a] items-center justify-center"><Text class="text-sm text-white">重新读取</Text></View>}
 ]}/></View>;
}

function OnboardingHost(props:{session:OnboardingSession;controller:OnboardingController;legalBaseUrl?:string;restoreCustomization:()=>CustomizationDraft;saveCustomization:(draft:CustomizationDraft)=>void;restoreLegal:()=>LegalNavigation;saveLegal:(navigation:LegalNavigation)=>void;onLegalRestorationEvent?:(page:StartupLegalPage,event:InformationRestorationEvent)=>void}){
 const metrics=getDisplayMetrics(),width=metrics.logicalWidth,height=metrics.logicalHeight;
 const presets=new ReaderPresetStore(),settings=new SettingsStore();
 const [presetState,setPresetState]=createSignal<ReaderPresetState>();
 const [presetRevision,setPresetRevision]=createSignal(0);
 const [error,setError]=createSignal('');
 const readPresets=()=>{try{setPresetState(presets.load());setPresetRevision(v=>v+1);}catch(error){report(error);}};
 function report(error:unknown){setError(String(error));}
 readPresets();onCleanup(onReaderPresetsChanged(readPresets));
 const [clock,setClock]=createSignal(new Date()),[active,setActive]=createSignal(lifecycle()==='active');
 onCleanup(onLifecycleChange(value=>setActive(value==='active')));
 const preset=createMemo(()=>{const state=presetState();return state?.records.length?activeReaderPreset(state,clock()):defaultReaderPreset(undefined,undefined,true,settings.load().fontSizeSp);});
 const fonts=createMemo(()=>readerFontResolver(presetState()??{},presetRevision()));
 const backgroundSnapshot=createMemo(()=>({state:presetState()??presets.load(),revision:presetRevision()}));
 const privacyTitle=useReaderTitleEntry(()=>"隐私政策更新",()=>width-28,preset,fonts,()=>"#ffffff");
 type LegalEntry={page:StartupLegalPage;scroller?:Scroller;snapshot?:()=>InformationSnapshot;restoredState?:InformationSnapshot;restoreMode?:'recreated'|'retained-underlying'};
 const initialLegal=untrack(props.restoreLegal);
 const [legal,setLegal]=createSignal<LegalEntry[]>(initialLegal.pages.map((page,index)=>({page,restoredState:initialLegal.snapshots[index]??undefined,restoreMode:initialLegal.restoreModes?.[index]??'recreated'})));
 const currentLegal=()=>legal().at(-1);
 let introHandle:{onBack:()=>boolean;scroller:()=>Scroller|undefined}|undefined,privacyScroller:Scroller|undefined;
 const motion=new BackMotion(width),[offset,setOffset]=createSignal(0);
 const destination=createMemo(()=>props.session.destination);
 createEffect(()=>{if(!active()){motion.reset();setOffset(0);}});
 const saveLegal=(entries:LegalEntry[])=>props.saveLegal({pages:entries.map(entry=>entry.page),snapshots:entries.map(entry=>entry.page==='beian'?null:entry.snapshot?.()??entry.restoredState??null)});
 const cacheSnapshot=(entry:LegalEntry,snapshot:InformationSnapshot)=>{if(entry.page==='beian'||!legal().includes(entry))return;entry.restoredState=snapshot;saveLegal(legal());};
 const openLegal=(page:InformationPage)=>{if(motion.phase!=='idle')return;if(page!=='privacy'&&page!=='useragreement'&&page!=='beian')return;currentLegal()?.scroller?.stop();const entries=[...legal(),{page}];saveLegal(entries);setLegal(entries);};
 const closeLegal=()=>{currentLegal()?.scroller?.stop();const entries=legal().slice(0,-1);saveLegal(entries);setLegal(entries);motion.reset();setOffset(0);};
 const operate=(action:()=>void)=>{try{action();setError('');}catch(error){report(error);}};
 const finish=()=>{void application.finishTask().catch(report);};
 createEffect(()=>{if(destination()==='intro'){let first=true;const restoredNetwork=untrack(()=>props.session.intro.internet!=='checking');onCleanup(observeHostInternet(status=>{const skip=first&&status==='checking'&&restoredNetwork;first=false;if(!skip)props.controller.dispatch({type:'internet',status});}));}});
 createEffect(()=>{if(destination()==='finished')finish();});
 createEffect(()=>setNavigationState({canGoBack:!!error()||legal().length>0||destination()==='intro'&&(props.session.intro.page>0||props.session.intro.offlineWarning),rootSwipeEnabled:false}));
 onCleanup(()=>setNavigationState({canGoBack:false}));
 onCleanup(onSystemBack(()=>{
  if(error()){setError('');return true;}
  if(currentLegal()){if(motion.phase==='idle'){motion.begin(0);motion.release(0,Date.now(),false,true);}return true;}
  return props.controller.back();
 }));
 onCleanup(onAxisDelta(RelativeAxis.Primary,delta=>{
  if(!active()||error()||motion.phase!=='idle'||props.session.intro.offlineWarning)return;
  const top=currentLegal();
  const scroller=top?top.scroller:(destination()==='intro'?introHandle?.scroller():privacyScroller);
  scroller?.scrollBy(delta*48/(12*RelativeAxisUnits.PerDegree),{durMs:120});
 }));
 createGesture({region:{rect:()=>currentLegal()&&active()&&motion.phase!=='settling'?{x:0,y:0,w:width,h:height}:null},axis:'x',panSlop:8,
  onPanStart:c=>{currentLegal()?.scroller?.stop();motion.begin(c.dx);setOffset(motion.offset);},
  onPanMove:c=>{motion.move(c.dx);setOffset(motion.offset);},onPanEnd:c=>motion.release(c.vx,Date.now()),onCancel:()=>motion.release(0,Date.now(),true)});
 onFrame(()=>{
  if(presetState()?.selection.mode==='SYSTEM'&&Math.floor(Date.now()/60000)!==Math.floor(clock().getTime()/60000))setClock(new Date());
  if(motion.phase==='settling'){const result=motion.tick(Date.now());setOffset(motion.offset);if(result==='commit')closeLegal();else if(result==='cancel'){motion.reset();setOffset(0);}}
 });
 const toggleTheme=()=>operate(()=>{
  // Seed legacy settings only when an explicit theme action needs preset IDs;
  // existing records, including tombstones, follow the established store policy.
  presets.ensureSeeded(true,settings.load().fontSizeSp);
  setPresetState(presets.setThemeMode(readerChrome(preset()).dark?'LIGHT':'DARK'));
  notifyReaderPresetsChanged();
 });
 const errorLines=()=>watchUiLines(error(),{width:width-48,measure:text=>getOps().measureText(text,0)});
 return <View class="relative bg-black overflow-hidden" style={{width,height}}>
  <View class="absolute inset-0" accessibilityHidden={!!currentLegal()||!!error()}>
   <Show when={destination()==='intro'}><OnboardingScreen width={width} height={height} state={props.session.intro} readerDark={readerChrome(preset()).dark} onToggleReaderTheme={toggleTheme} onAction={action=>operate(()=>props.controller.dispatch(action))} onOpenLegal={openLegal} restoreCustomization={props.restoreCustomization} saveCustomization={props.saveCustomization} active={()=>active()&&!currentLegal()&&!error()} ref={value=>{introHandle=value;}}/></Show>
   <Show when={destination()==='privacy'}><PrivacyPolicyConsentScreen width={width} height={height} title={privacyTitle()} background={<Show when={presetState()}><ReaderBackground background={preset().background} snapshot={backgroundSnapshot()} width={width} height={height} active={active()&&!currentLegal()}/></Show>} onOpenPrivacy={()=>openLegal('privacy')} onAgree={()=>operate(()=>props.controller.agreePrivacy())} onDisagree={()=>props.controller.declinePrivacy()} active={()=>active()&&!currentLegal()&&!error()} ref={value=>{privacyScroller=value.scroller;}}/></Show>
  </View>
  <For each={legal()}>{entry=><View accessibilityHidden={currentLegal()!==entry||!!error()} class="absolute inset-0 bg-black overflow-hidden" style={{translateX:currentLegal()===entry?offset():0,opacity:legal().indexOf(entry)>=legal().length-2?1:0}}><View class="absolute inset-0 bg-black" accessibilityHidden onPress={()=>{}}/><InformationScreen width={width} height={height} preset={preset()} fonts={fonts()} backgroundSnapshot={backgroundSnapshot()} page={entry.page} legalBaseUrl={props.legalBaseUrl??'https://sly-data-plane.watchrss.cn'} onNavigate={openLegal} onOpenUrl={url=>{void openBrowserUrl(url,"information",preset()).catch(report);}} restoredState={entry.restoredState} restoreMode={entry.restoreMode} onSnapshotChange={snapshot=>cacheSnapshot(entry,snapshot)} onRestorationEvent={event=>props.onLegalRestorationEvent?.(entry.page,event)} accessibilityLabel="协议正文" active={()=>currentLegal()===entry&&active()&&!error()} ref={value=>{entry.scroller=value.scroller;entry.snapshot=value.snapshot;}}/></View>}</For>
  <Show when={error()}><View onPress={()=>{}} class="absolute inset-0 bg-[#000000eb] flex-col items-center justify-center"><Text class="text-xs leading-[14] text-[#e54d4d]" style={{width:width-48,height:errorLines().length*14}}>{errorLines().join('\n')}</Text><View focusable onPress={()=>{setError('');if(destination()==='finished')finish();}} class="mt-[12] h-[40] px-[20] rounded-[20] bg-[#23272a] items-center justify-center"><Text class="text-sm text-white">{destination()==='finished'?'重试退出':'知道了'}</Text></View></View></Show>
 </View>;
}
