import {benchmark} from '@podjs/framework/benchmark';
import {douyinBench} from '../../douyin/bench.ts';
import {observeDouyinAuth} from './auth-state.ts';
import * as hostServices from '@podjs/framework/services';
import {DOUYIN_NETWORK_TIMEOUT_MS} from '../../douyin/client.ts';
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

export const DOUYIN_ENTRY_SLOW_MS=1500;
export const DOUYIN_ENTRY_LOCAL_WAIT_MS=200;

/** Verified stock may prepare one hidden first-frame session; only entering starts playback. */
function ImmersiveEntryImpl(props: DouyinScreenProps) {
  const guestEntryMs=Date.now();
  traceServiceWork('douyin.entry.guest',()=>{},guestEntryMs);
  const [stockPending,setStockPending]=createSignal(!!props.presentStock);
  let stockEntryClaimed=false,previewToken=0,previewHandedOff=false;
  let preview:ReturnType<NonNullable<DouyinScreenProps['presentStock']>>|undefined;
  const hidePreview=()=>{preview?.cancel();preview=undefined;if(previewToken)props.hideStock?.(previewToken);previewToken=0;};
  const claimStockEntry=()=>{if(stockEntryClaimed)return false;stockEntryClaimed=true;return props.claimStockEntry?.()??true;};
  let entrySeq=(props.active??true)?douyinBench.entry(props.client):0,lastActive=props.active??true;
  const [items,setItems]=createSignal<DouyinItem[]>([]),[busy,setBusy]=createSignal(false),[error,setError]=createSignal(""),[slow,setSlow]=createSignal(false);
  const auth=observeDouyinAuth(props.client),logged=()=>auth()==='logged-in';
  let cursor:string|null=null,hasMore=false,anchor:string|null=null,disposed=false,generation=0;
  const [opening,setOpening]=createSignal(false);
  let failures=0,refreshSeq=0,presentedRefresh=0;
  const finishRefresh=(failed=false,failure?:unknown)=>{if(refreshSeq){douyinBench.refreshDone(refreshSeq,failed,failure);presentedRefresh=refreshSeq;refreshSeq=0;}};
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
    if(auth()==='logged-out')return;
    retryPlayback=false;
    if(measureRefresh){if(presentedRefresh)douyinBench.cancelPresented('refresh_done',presentedRefresh);presentedRefresh=0;refreshSeq=douyinBench.refreshStart();}
    setBusy(true);setError("");setSlow(false);
    // A slow notice is not a failed request. Keep the refresh pending until
    // its feed settles or the full operation exceeds the transport budget.
    const notice=hostServices.delay(DOUYIN_ENTRY_SLOW_MS);
    void notice.result.then(()=>{if(current())setSlow(true);},()=>{});
    const deadline=hostServices.delay(DOUYIN_NETWORK_TIMEOUT_MS);
    const timer={cancel(){notice.cancel();deadline.cancel();}};loadTimer=timer;
    void deadline.result.then(()=>{if(current()){setBusy(false);setSlow(false);setError('内容加载较慢，请稍候');finishRefresh(true,{code:'timeout'});}},()=>{});
    let sealLocal=()=>{};
    try{
      if(!refresh){
        // Inventory and SQL snapshots do not depend on a cookie/secure-store
        // read. One blocked restore must not serialize the other local sources.
        let stockDecided=false,stockChosen=false,queueReady=false,networkPublished=false;
        sealLocal=()=>{networkPublished=true;};
        let cached:ReturnType<DouyinScreenProps['client']['freshPlaybackSnapshot']>|undefined;
        const publishCached=()=>{if(current()&&stockDecided&&!stockChosen&&!networkPublished&&cached?.items.length){setItems(cached.items);anchor=cached.anchorAwemeId;cursor=cached.cursor;hasMore=cached.hasMore;}};
        const restore=(kind:'feed'|'queue')=>traceServiceWork(kind==='queue'?'douyin.entry.restoreQueue':'douyin.entry.restoreFeed',()=>kind==='queue'?props.client.restorePlaybackQueue():props.client.restoreFeed()).then(snapshot=>{
          const value=props.client.freshPlaybackSnapshot(snapshot);
          if(value.items.length&&(kind==='queue'||!queueReady)){if(kind==='queue')queueReady=true;cached=value;publishCached();}
        }).catch(()=>{});
        const queue=restore('queue'),feed=restore('feed');
        const localDeadline=hostServices.delay(DOUYIN_ENTRY_LOCAL_WAIT_MS);
        let stockSettled=false;
        const stockWork=Promise.resolve().then(()=>props.restoreStock?.()??[]).catch(()=>[]).then(value=>{stockSettled=true;return value;});
        const showStock=async(stock:DouyinItem[])=>{
          if(!current())return;
          stockChosen=true;
          const automatic=stock[0].playUrl.startsWith('file:')&&claimStockEntry();
          if(automatic&&props.presentStock){
            preview=props.presentStock(stock[0],guestEntryMs);
            try{const shown=await preview.result;previewToken=shown.token;if(!current()){hidePreview();return;}}
            catch{if(!current())return;}
          }
          // Prewarm starts only after the stored frame reaches the window.
          setStockPending(false);setItems(stock);anchor=stock[0].awemeId;cursor=null;hasMore=true;
          if(automatic){previewHandedOff=true;void enter();}
        };
        const stock=await Promise.race([stockWork,localDeadline.result.then(()=>[] as DouyinItem[])]);
        stockDecided=true;if(!current()){localDeadline.cancel();return;}
        appLogger.i('DouyinEntry',`local_restore stock=${stockSettled?'settled':'timeout'} count=${stock.length}`);
        if(stock.length){localDeadline.cancel();await showStock(stock);return;}
        if(!stockSettled)void stockWork.then(late=>{if(current()&&!items().length&&!networkPublished&&late.length)return showStock(late);}).catch(()=>{});
        setStockPending(false);
        publishCached();
        await Promise.race([Promise.all([feed,queue]),localDeadline.result]);localDeadline.cancel();if(!current())return;
        // Stop late disk replies overwriting a newer background feed result.
        // Fresh feed URLs are sufficient for entry and both prewarm neighbours.
        // Replenish expired queues from feed; never probe detail from the title page.
        if(items().length>=3&&hasMore&&!!cursor?.trim()){setError('');return;}
      }
      if(!logged())return;
      appLogger.d('DouyinEntry',`feed requested reason=${refresh?'refresh':'bootstrap'}`);
      const result=await traceServiceWork("douyin.entry.fetch",()=>props.client.fetchFeedPage({count:16}));if(!current())return;
      if(result.ok){sealLocal();cancelRetry();setError('');failures=0;traceServiceWork("douyin.entry.feedResult",()=>{setItems(result.data.items);cursor=result.data.nextCursor;hasMore=result.data.hasMore;anchor=null;});}
      else{
        setError(formatDouyinError(result.code));
        scheduleRetry(result,current);
        if(result.code==='NOT_LOGGED_IN'){
          await requireLogin(current);
        }
      }
    }catch{if(current()){setError(formatDouyinError('REQUEST_FAILED'));scheduleRetry({code:'REQUEST_FAILED'},current);}}
    finally{if(current())setStockPending(false);timer.cancel();if(loadTimer===timer)loadTimer=undefined;if(current()){setBusy(false);setSlow(false);finishRefresh(!!error());appLogger.d('DouyinEntry',`feed settled items=${items().length} login=${logged()?'present':'required'}`);}}
  };
  const enter=async()=>{
    if(!active()||auth()==='unknown'&&!items().length)return;if(auth()==='logged-out'){douyinBench.loginTap(props.client,logged,()=>props.onNavigate({name:'login'}));return;}if(opening())return;
    if(!items().length){await load(true);return;}
    claimStockEntry();
    // Keep failures on this entry until a source opens. Cached navigation never
    // waits for the feed refresh; the controller returns closed retry metadata.
    const requested=props.route.name==='entry'?props.route.resumeAwemeId:undefined;
    const index=Math.max(0,items().findIndex(item=>item.awemeId===(requested??anchor))),item=items()[index];
    if(playbackFailed){entrySeq=douyinBench.entry(props.client);playbackFailed=false;}
    benchmark.mark('startup_stage',entrySeq,{startup_stage:'play_tap'});
    generation++;loadTimer?.cancel();loadTimer=undefined;setBusy(false);
    cancelRetry();setError("");setOpening(true);retryPlayback=true;
    const revision=generation,current=()=>active()&&revision===generation;
    props.onPlay({...(previewToken?{releaseStartupPreview:hidePreview}:{}),item,playback:item,playlist:items(),cursor:cursor??undefined,hasMore,immersive:true,entrySeq,
      isCurrent:current,
      onFailure:failure=>{hidePreview();if(!current())return;setOpening(false);playbackFailed=true;douyinBench.entryError(entrySeq,failure);setError(formatDouyinError(failure.code));scheduleRetry(failure,current);},
    });
    props.onNavigate({name:"player",awemeId:item.awemeId});
  };
  benchmark.mark('startup_stage',entrySeq,{startup_stage:'entry_mounted'});
  const preloadOwner={};
  createEffect(()=>{const list=items(),enabled=props.active??true;if(enabled&&logged()&&list.length)props.onPreloadWindow?.(preloadOwner,list,anchor,entrySeq);else props.onPreloadStop?.(preloadOwner);});
  onCleanup(()=>props.onPreloadStop?.(preloadOwner));
  // Verified complete stock may enter immediately; other external intents only select an anchor. A tap/swipe enters
  // the player. Ignore legacy debugAutoEnterFlow, including in debug builds.
  createEffect(()=>{const enabled=props.active??true;if(auth()==='logged-out')setStockPending(false);if(enabled&&!lastActive)entrySeq=douyinBench.entry(props.client);lastActive=enabled;const code=auth()==='logged-out'?'needs_login':auth()==='logged-in'&&busy()&&!items().length?'refreshing':undefined;if(enabled&&code){douyinBench.presentEntry(props.client,entrySeq,code);onCleanup(()=>douyinBench.cancelPresented(code,entrySeq));}});
  const gesture=createGesture({region:{rect:()=>active()?{x:0,y:0,w:props.width,h:props.height}:null},axis:"y",panSlop:8,onPanEnd:c=>{if(c.dy< -30||c.dy< -12&&(c.vy??0)< -400)void enter();else if(c.dy>50)void load(true,true);}});
  // Back on the cover after the stream: a stale opening flag must never swallow the next enter.
  createEffect(()=>{if(props.route.name==='entry'&&(props.active??true))untrack(()=>setOpening(false));});
  createEffect(()=>{if((props.active??true)&&auth()!=='logged-out')void untrack(()=>load());else{generation++;loadTimer?.cancel();loadTimer=undefined;cancelRetry();if(refreshSeq||presentedRefresh)douyinBench.cancelPresented('refresh_done',refreshSeq||presentedRefresh);refreshSeq=0;presentedRefresh=0;setBusy(false);setOpening(false);}});onCleanup(()=>{if(!previewHandedOff)hidePreview();disposed=true;if(refreshSeq||presentedRefresh)douyinBench.cancelPresented('refresh_done',refreshSeq||presentedRefresh);refreshSeq=0;presentedRefresh=0;generation++;loadTimer?.cancel();loadTimer=undefined;cancelRetry();gesture.dispose();});
  // Native DouyinTitlePage: 18dp safe padding; centred column "抖音 ⓘ" (titleMedium 21/26), 2dp gap,
  // bodySmall 12/14 hint; 44dp circular arrow button 12dp above the bottom safe edge.
  const titleWidth=getOps().measureText("抖音",23),hintGap=7,hintBox=19.2,groupLeft=(props.width-(titleWidth+hintGap+16))/2;
  const hint=()=>auth()==='unknown'&&!items().length?"正在读取登录状态…":auth()==='logged-out'?"需要登录，请重新登录":(busy()&&!items().length)?(slow()?"内容加载较慢，请稍候":"刷新中..."):items().length?"下拉刷新，向上进入短视频流":"暂无内容，下拉刷新或点箭头重试";
  // Submit no guest scene while restoring: frame zero is the first page content.
  return <Show when={(props.active??true)&&!stockPending()}><View class="absolute inset-0 bg-black">
   <View class="absolute inset-0">
    <View class="absolute left-[18] right-[18] top-[18] h-[42]" onPress={()=>props.onNavigate({name:"channel-info"})} focusable accessibilityRole="button" accessibilityLabel="抖音频道信息">
      <Text class="absolute top-[0] text-[21px] leading-[26] text-[#f5f5f5]" style={{insetL:groupLeft-18}}>抖音</Text>
      <Image src="../assets/icons/info-hint.svg" class="absolute top-[3.4]" style={{insetL:groupLeft-18+titleWidth+hintGap-3.6,width:hintBox,height:hintBox}}/>
      <Text class="absolute left-[0] right-[0] top-[28] text-xs leading-[14] text-center text-[#b6b6b6]">{hint()}</Text>
    </View>
    <Show when={slow()&&items().length>0&&!error()}><Text class="absolute left-[30] right-[30] top-[66] text-xs leading-[14] text-center text-[#b6b6b6]">内容加载较慢，请稍候</Text></Show>
    <Show when={error()}><Text class="absolute left-[30] right-[30] top-[66] text-xs leading-[14] text-center text-[#ff5a5f]">{error()}</Text>
      <View class="absolute left-[65] right-[65] top-[92] h-[36] rounded-[18] items-center justify-center bg-[#2a2a2a]" onPress={()=>void (retryPlayback?enter():load(true,true))} focusable accessibilityRole="button" accessibilityLabel="重试"><Text class="text-sm text-[#f5f5f5]">重试</Text></View>
    </Show>
    {/* 44dp visual circle inside a 120×80 transparent hit area. */}
    <View class="absolute bottom-[12] w-[120] h-[80] rounded-full items-center justify-center" style={{insetL:(props.width-120)/2}} onPress={auth()==='unknown'&&!items().length?undefined:()=>void enter()} focusable={auth()!=='unknown'||items().length>0} accessibilityRole="button" accessibilityLabel={auth()==='unknown'&&!items().length?"正在读取登录状态…":(logged()||auth()==='unknown'&&items().length>0)?(items().length?"向上进入视频流":"刷新抖音内容"):"登录"}>
      <View class="w-[44] h-[44] rounded-full items-center justify-center" style={{bgColor:"#2a2a2aeb"}}><Show when={logged()||auth()==='unknown'&&items().length>0} fallback={<Text class="text-base text-[#f5f5f5]">{auth()==='unknown'?"…":"登录"}</Text>}><Image src="../assets/icons/arrow-upward.svg" class="w-[16] h-[16]"/></Show></View>
    </View>
  </View></View></Show>;
}

export function ImmersiveEntry(props:Parameters<typeof ImmersiveEntryImpl>[0]) {return traceServiceWork("navigation.ImmersiveEntry",()=>ImmersiveEntryImpl(props));}
