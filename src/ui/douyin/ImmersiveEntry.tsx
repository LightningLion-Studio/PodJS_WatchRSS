import {douyinBench} from '../../douyin/bench.ts';
import {observeDouyinAuth} from './auth-state.ts';
import * as hostServices from '@podjs/framework/services';
import {DOUYIN_AUTH403_MAX_COOLDOWN_MS} from '../../douyin/auth403.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import { createSignal, createEffect, untrack, onCleanup, Show } from "solid-js";
import { View, Text, Image } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { createGesture } from "@pocketjs/framework/gesture";
import type { DouyinScreenProps } from "./index.tsx";
import { isDouyinTemporaryFailure,isDouyinRetryableFailure,formatDouyinError } from "../../douyin/errors.ts";
import { appLogger } from "../../logs/app-logger.ts";
import type { DouyinItem } from "../../douyin/types.ts";

export const DOUYIN_ENTRY_TIMEOUT_MS=1500;

/** Title page owns no player; the single host session starts only on entering the flow. */
function ImmersiveEntryImpl(props: DouyinScreenProps) {
  let entrySeq=(props.active??true)?douyinBench.entry(props.client):0,lastActive=props.active??true;
  const [items,setItems]=createSignal<DouyinItem[]>([]),[busy,setBusy]=createSignal(false),[error,setError]=createSignal("");
  const auth=observeDouyinAuth(props.client),logged=()=>auth()==='logged-in';
  let cursor:string|null=null,hasMore=false,anchor:string|null=null,disposed=false,generation=0;
  const [opening,setOpening]=createSignal(false);
  let failures=0,refreshSeq=0,presentedRefresh=0;
  const finishRefresh=(failed=false)=>{if(refreshSeq){douyinBench.refreshDone(refreshSeq,failed);presentedRefresh=refreshSeq;refreshSeq=0;}};
  let loadTimer:{cancel():void}|undefined;
  let retryTimer:{cancel():void}|undefined;
  const cancelRetry=()=>{retryTimer?.cancel();retryTimer=undefined;};
  let retryPlayback=false,playbackFailed=false;
  const scheduleRetry=(result:{code:import('../../douyin/types.ts').DouyinErrorCode;retryAfterMs?:number},current:()=>boolean)=>{
    if(!isDouyinRetryableFailure(result.code))return;
    setError(formatDouyinError(result.code));cancelRetry();
    const backoff=Math.min(30000,1000*2**Math.min(5,failures++));
    const wait=Number.isFinite(result.retryAfterMs)?Math.max(1000,Math.min(DOUYIN_AUTH403_MAX_COOLDOWN_MS,result.retryAfterMs!)):isDouyinTemporaryFailure(result.code)?Math.min(DOUYIN_AUTH403_MAX_COOLDOWN_MS,30000*2**Math.min(5,failures-1)):backoff;
    const timer=hostServices.delay(wait);retryTimer=timer;
    void timer.result.then(()=>{if(retryTimer!==timer)return;retryTimer=undefined;if(current())void (retryPlayback?enter():load(true));},()=>{});
  };
  const active=()=>!disposed&&(props.active??true);
  const requireLogin=async(current:()=>boolean)=>{
    if(!current())return;cancelRetry();setItems([]);anchor=null;cursor=null;hasMore=false;setError(formatDouyinError('NOT_LOGGED_IN'));
    // Only the client may expire verified authentication. A screen never infers it.
  };
  const load=async(refresh=false,measureRefresh=false)=>{
    if(!active()||busy()||opening())return;
    cancelRetry();
    const own=++generation,current=()=>active()&&own===generation;
    if(auth()!=='logged-in')return;
    retryPlayback=false;
    if(measureRefresh){if(presentedRefresh)douyinBench.cancelPresented('refresh_done',presentedRefresh);presentedRefresh=0;refreshSeq=douyinBench.refreshStart();}
    setBusy(true);setError("");
    // Cached content remains navigable while replacement runs in the background.
    // Bound the whole UI operation, including queued storage and auth probes.
    // Expiry fences late continuations; it does not infer logout or clear auth.
    const deadline=hostServices.delay(DOUYIN_ENTRY_TIMEOUT_MS);loadTimer=deadline;
    void deadline.result.then(()=>{if(current()){generation++;setBusy(false);setError(formatDouyinError('REQUEST_FAILED'));finishRefresh(true);const revision=generation;scheduleRetry({code:'REQUEST_FAILED'},()=>active()&&revision===generation);}},()=>{});
    try{
      if(!refresh){
        const stock=await props.restoreStock?.()??[];if(!current())return;
        if(stock.length){setItems(stock);anchor=stock[0].awemeId;cursor=null;hasMore=true;return;}
        let queueReady=false;
        const restore=(kind:'feed'|'queue')=>traceServiceWork(kind==='queue'?'douyin.entry.restoreQueue':'douyin.entry.restoreFeed',()=>kind==='queue'?props.client.restorePlaybackQueue():props.client.restoreFeed()).then(value=>{
          if(current()&&value.items.length&&(kind==='queue'||!queueReady)){
            if(kind==='queue')queueReady=true;
            setItems(value.items);anchor=value.anchorAwemeId;cursor=value.cursor;hasMore=value.hasMore;
          }return value;
        });
        const [feed,queue]=await Promise.all([restore('feed'),restore('queue')]);if(!current())return;
        const cached=queue.items.length?queue:feed;
        traceServiceWork("douyin.entry.restoreResult",()=>{setItems(cached.items);anchor=cached.anchorAwemeId;cursor=cached.cursor;hasMore=cached.hasMore;});
        // Native restores the title page immediately; a small/incomplete bootstrap
        // needs a 16-item feed request. Expired detail refresh is background work.
        if(cached.items.length>=3&&hasMore&&!!cursor?.trim()){
          void traceServiceWork("douyin.entry.resolve",()=>props.client.resolvePlayback(anchor??cached.items[0].awemeId)).then(async result=>{
            if(!current())return;
            if(result.ok){failures=0;traceServiceWork("douyin.entry.resolveResult",()=>setItems(old=>old.map(item=>item.awemeId===result.data.awemeId?result.data:item)));return;}
            // Old queues can contain only expired/unresolvable detail URLs. Keep
            // immediate navigation, but replenish from a fresh feed in the background
            // so the preload window does not retry the same stale identities forever.
            if(isDouyinTemporaryFailure(result.code)){scheduleRetry(result,current);return;}
            if(result.code==='NOT_LOGGED_IN'){await requireLogin(current);return;}
            if(result.code==='CANCELLED')return;
            appLogger.i('DouyinEntry','expired queue anchor failed; refreshing feed');
            const fresh=await props.client.fetchFeedPage({count:16});
            if(!current())return;
            if(!fresh.ok){if(fresh.code==='NOT_LOGGED_IN')await requireLogin(current);else if(isDouyinRetryableFailure(fresh.code))scheduleRetry(fresh,current);return;}
            failures=0;cursor=fresh.data.nextCursor;hasMore=fresh.data.hasMore;anchor=null;setItems(fresh.data.items);
          }).catch(()=>{if(current())scheduleRetry({code:'REQUEST_FAILED'},current);});
          return;
        }
      }
      appLogger.d('DouyinEntry',`feed requested reason=${refresh?'refresh':'bootstrap'}`);
      const result=await traceServiceWork("douyin.entry.fetch",()=>props.client.fetchFeedPage({count:16}));if(!current())return;
      if(result.ok){failures=0;traceServiceWork("douyin.entry.feedResult",()=>{setItems(result.data.items);cursor=result.data.nextCursor;hasMore=result.data.hasMore;anchor=null;});}
      else{
        setError(formatDouyinError(result.code));
        scheduleRetry(result,current);
        if(result.code==='NOT_LOGGED_IN'){
          await requireLogin(current);
        }
      }
    }catch{if(current()){setError(formatDouyinError('REQUEST_FAILED'));scheduleRetry({code:'REQUEST_FAILED'},current);}}
    finally{deadline.cancel();if(loadTimer===deadline)loadTimer=undefined;if(current()){setBusy(false);finishRefresh(!!error());appLogger.d('DouyinEntry',`feed settled items=${items().length} login=${logged()?'present':'required'}`);}}
  };
  const enter=async()=>{
    if(!active()||auth()==='unknown')return;if(!logged()){douyinBench.loginTap(props.client,logged,()=>props.onNavigate({name:'login'}));return;}if(opening())return;
    if(!items().length){await load(true);return;}
    // Keep failures on this entry until a source opens. Cached navigation never
    // waits for the feed refresh; the controller returns closed retry metadata.
    const requested=props.route.name==='entry'?props.route.resumeAwemeId:undefined;
    const index=Math.max(0,items().findIndex(item=>item.awemeId===(requested??anchor))),item=items()[index];
    if(playbackFailed){entrySeq=douyinBench.entry(props.client);playbackFailed=false;}
    generation++;loadTimer?.cancel();loadTimer=undefined;setBusy(false);
    cancelRetry();setError("");setOpening(true);retryPlayback=true;
    const revision=generation,current=()=>active()&&revision===generation;
    props.onPlay({item,playback:item,playlist:items(),cursor:cursor??undefined,hasMore,immersive:true,entrySeq,
      isCurrent:current,
      onFailure:failure=>{if(!current())return;setOpening(false);playbackFailed=true;douyinBench.entryError(entrySeq);setError(formatDouyinError(failure.code));scheduleRetry(failure,current);},
    });
    props.onNavigate({name:"player",awemeId:item.awemeId});
  };
  const preloadOwner={};
  createEffect(()=>{const list=items(),enabled=props.active??true;if(enabled&&logged()&&list.length)props.onPreloadWindow?.(preloadOwner,list,anchor);else props.onPreloadStop?.(preloadOwner);});
  onCleanup(()=>props.onPreloadStop?.(preloadOwner));
  // External entry intents may select an anchor, but only a tap/swipe enters
  // the player. Ignore legacy debugAutoEnterFlow, including in debug builds.
  createEffect(()=>{const enabled=props.active??true;if(enabled&&!lastActive)entrySeq=douyinBench.entry(props.client);lastActive=enabled;const code=auth()==='logged-out'?'needs_login':busy()&&!items().length?'refreshing':undefined;if(enabled&&code){douyinBench.presentEntry(props.client,entrySeq,code);onCleanup(()=>douyinBench.cancelPresented(code,entrySeq));}});
  const gesture=createGesture({region:{rect:()=>active()?{x:0,y:0,w:props.width,h:props.height}:null},axis:"y",panSlop:8,onPanEnd:c=>{if(c.dy < -50)void enter();else if(c.dy>50)void load(true,true);}});
  createEffect(()=>{if((props.active??true)&&auth()==='logged-in')void untrack(()=>load());else{generation++;loadTimer?.cancel();loadTimer=undefined;cancelRetry();if(refreshSeq||presentedRefresh)douyinBench.cancelPresented('refresh_done',refreshSeq||presentedRefresh);refreshSeq=0;presentedRefresh=0;setBusy(false);setOpening(false);}});onCleanup(()=>{disposed=true;if(refreshSeq||presentedRefresh)douyinBench.cancelPresented('refresh_done',refreshSeq||presentedRefresh);refreshSeq=0;presentedRefresh=0;generation++;loadTimer?.cancel();loadTimer=undefined;cancelRetry();gesture.dispose();});
  // Native DouyinTitlePage: 18dp safe padding; centred column "抖音 ⓘ" (titleMedium 21/26), 2dp gap,
  // bodySmall 12/14 hint; 44dp circular arrow button 12dp above the bottom safe edge.
  const titleWidth=getOps().measureText("抖音",23),hintGap=7,hintBox=19.2,groupLeft=(props.width-(titleWidth+hintGap+16))/2;
  const hint=()=>auth()==='unknown'?"正在读取登录状态…":!logged()?"需要登录，请重新登录":(busy()&&!items().length)?"刷新中...":items().length?"下拉刷新，向上进入短视频流":"暂无内容，下拉刷新或点箭头重试";
  return <View class="absolute inset-0 bg-black">
   <View class="absolute inset-0">
    <View class="absolute left-[18] right-[18] top-[18] h-[42]" onPress={()=>props.onNavigate({name:"channel-info"})} focusable accessibilityRole="button" accessibilityLabel="抖音频道信息">
      <Text class="absolute top-[0] text-[21px] leading-[26] text-[#f5f5f5]" style={{insetL:groupLeft-18}}>抖音</Text>
      <Image src="../assets/icons/info-hint.svg" class="absolute top-[3.4]" style={{insetL:groupLeft-18+titleWidth+hintGap-3.6,width:hintBox,height:hintBox}}/>
      <Text class="absolute left-[0] right-[0] top-[28] text-xs leading-[14] text-center text-[#b6b6b6]">{hint()}</Text>
    </View>
    <Show when={error()}><Text class="absolute left-[30] right-[30] top-[66] text-xs leading-[14] text-center text-[#ff5a5f]">{error()}</Text>
      <View class="absolute left-[65] right-[65] top-[92] h-[36] rounded-[18] items-center justify-center bg-[#2a2a2a]" onPress={()=>void (retryPlayback?enter():load(true,true))} focusable accessibilityRole="button" accessibilityLabel="重试"><Text class="text-sm text-[#f5f5f5]">重试</Text></View>
    </Show>
    <View class="absolute bottom-[30] w-[44] h-[44] rounded-full items-center justify-center" style={{insetL:(props.width-44)/2,bgColor:"#2a2a2aeb"}} onPress={auth()==='unknown'?undefined:()=>void enter()} focusable={auth()!=='unknown'} accessibilityRole="button" accessibilityLabel={auth()==='unknown'?"正在读取登录状态…":logged()?(items().length?"向上进入视频流":"刷新抖音内容"):"登录"}><Show when={logged()} fallback={<Text class="text-base text-[#f5f5f5]">{auth()==='unknown'?"…":"登录"}</Text>}><Image src="../assets/icons/arrow-upward.svg" class="w-[16] h-[16]"/></Show></View>
  </View></View>;
}

export function ImmersiveEntry(props:Parameters<typeof ImmersiveEntryImpl>[0]) {return traceServiceWork("navigation.ImmersiveEntry",()=>ImmersiveEntryImpl(props));}
