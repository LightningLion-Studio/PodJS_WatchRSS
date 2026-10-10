import {debugGate} from '../../debug/host.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import { createSignal, createEffect, untrack, onCleanup, Show } from "solid-js";
import { View, Text, Image } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { createGesture } from "@pocketjs/framework/gesture";
import type { DouyinScreenProps } from "./index.tsx";
import { formatDouyinError } from "../../douyin/errors.ts";
import { appLogger } from "../../logs/app-logger.ts";
import type { DouyinItem } from "../../douyin/types.ts";

/** Title page owns no player; the single host session starts only on entering the flow. */
function ImmersiveEntryImpl(props: DouyinScreenProps) {
  const [items,setItems]=createSignal<DouyinItem[]>([]),[busy,setBusy]=createSignal(false),[error,setError]=createSignal(""),[logged,setLogged]=createSignal(true);
  let cursor:string|null=null,hasMore=false,anchor:string|null=null,disposed=false,generation=0;
  const active=()=>!disposed&&(props.active??true);
  const load=async(refresh=false)=>{
    if(!active()||busy())return;
    const own=++generation,current=()=>active()&&own===generation;
    setBusy(true);setError("");
    try{
      const signed=await props.client.isLoggedIn();if(!current())return;setLogged(signed);if(!signed){setItems([]);setError(formatDouyinError('NOT_LOGGED_IN'));return;}
      if(!refresh){
        const feed=await traceServiceWork("douyin.entry.restoreFeed",()=>props.client.restoreFeed()),queue=await traceServiceWork("douyin.entry.restoreQueue",()=>props.client.restorePlaybackQueue());if(!current())return;
        const cached=queue.items.length?queue:feed;
        traceServiceWork("douyin.entry.restoreResult",()=>{setItems(cached.items);anchor=cached.anchorAwemeId;cursor=cached.cursor;hasMore=cached.hasMore;});
        // Native restores the title page immediately; a small/incomplete bootstrap
        // needs a 16-item feed request. Expired detail refresh is background work.
        if(cached.items.length>=3&&(!hasMore||!!cursor?.trim())){
          void traceServiceWork("douyin.entry.resolve",()=>props.client.resolvePlayback(anchor??cached.items[0].awemeId)).then(result=>{
            traceServiceWork("douyin.entry.resolveResult",()=>{if(current()&&result.ok)setItems(old=>old.map(item=>item.awemeId===result.data.awemeId?result.data:item));});
          }).catch(()=>{});
          return;
        }
      }
      appLogger.d('DouyinEntry',`feed requested reason=${refresh?'refresh':'bootstrap'}`);
      const result=await traceServiceWork("douyin.entry.fetch",()=>props.client.fetchFeedPage({count:16}));if(!current())return;
      if(result.ok){traceServiceWork("douyin.entry.feedResult",()=>{setItems(result.data.items);cursor=result.data.nextCursor;hasMore=result.data.hasMore;anchor=null;});}
      else{
        setError(formatDouyinError(result.code));
        if(result.code==='NOT_LOGGED_IN'){
          setLogged(false);setItems([]);anchor=null;cursor=null;hasMore=false;
          await props.client.clearCookie();
        }
      }
    }catch{if(current())setError(formatDouyinError('REQUEST_FAILED'));}
    finally{if(current()){setBusy(false);appLogger.d('DouyinEntry',`feed settled items=${items().length} login=${logged()?'present':'required'}`);}}
  };
  const enter=async()=>{
    if(!active()||busy())return;if(!logged()){props.onNavigate({name:'login'});return;}
    if(!items().length){await load(true);return;}
    // Native enterVideoFlow only switches pages. Do not hold "刷新中" while
    // serially resolving old queue entries; the player's recovery owns failures.
    const index=Math.max(0,items().findIndex(item=>item.awemeId===anchor)),item=items()[index];
    setError("");
    props.onPlay({item,playback:item,playlist:items(),cursor:cursor??undefined,hasMore,immersive:true});
    props.onNavigate({name:"player",awemeId:item.awemeId});
  };
  let debugEntered=false;
  createEffect(()=>{
    const route=props.route;
    if(debugGate.allowed&&route.name==='entry'&&route.debugAutoEnterFlow&&!debugEntered&&active()&&!busy()&&logged()&&items().length){
      debugEntered=true;if(route.resumeAwemeId)anchor=route.resumeAwemeId;
      void untrack(enter);
    }
  });
  const gesture=createGesture({region:{rect:()=>active()?{x:0,y:0,w:props.width,h:props.height}:null},axis:"y",panSlop:8,onPanEnd:c=>{if(c.dy < -50)void enter();else if(c.dy>50)void load(true);}});
  createEffect(()=>{if(props.active??true)void untrack(()=>load());else{generation++;setBusy(false);}});onCleanup(()=>{disposed=true;generation++;gesture.dispose();});
  // Native DouyinTitlePage: 18dp safe padding; centred column "抖音 ⓘ" (titleMedium 21/26), 2dp gap,
  // bodySmall 12/14 hint; 44dp circular arrow button 12dp above the bottom safe edge.
  const titleWidth=getOps().measureText("抖音",23),hintGap=7,hintBox=19.2,groupLeft=(props.width-(titleWidth+hintGap+16))/2;
  const hint=()=>busy()?"刷新中...":items().length?"下拉刷新，向上进入短视频流":"暂无内容，下拉刷新或点箭头重试";
  return <View class="absolute inset-0 bg-black">
   <View class="absolute inset-0">
    <View class="absolute left-[18] right-[18] top-[18] h-[42]" onPress={()=>props.onNavigate({name:"channel-info"})} focusable accessibilityRole="button" accessibilityLabel="抖音频道信息">
      <Text class="absolute top-[0] text-[21px] leading-[26] text-[#f5f5f5]" style={{insetL:groupLeft-18}}>抖音</Text>
      <Image src="../assets/icons/info-hint.svg" class="absolute top-[3.4]" style={{insetL:groupLeft-18+titleWidth+hintGap-3.6,width:hintBox,height:hintBox}}/>
      <Text class="absolute left-[0] right-[0] top-[28] text-xs leading-[14] text-center text-[#b6b6b6]">{hint()}</Text>
    </View>
    <Show when={error()}><Text class="absolute left-[30] right-[30] top-[66] text-xs leading-[14] text-center text-[#ff5a5f]">{error()}</Text></Show>
    <View class="absolute bottom-[30] w-[44] h-[44] rounded-full items-center justify-center" style={{insetL:(props.width-44)/2,bgColor:"#2a2a2aeb"}} onPress={()=>logged()?void enter():props.onNavigate({name:"login"})} focusable accessibilityRole="button" accessibilityLabel={logged()?(items().length?"向上进入视频流":"刷新抖音内容"):"登录"}><Text class="text-base text-[#f5f5f5]">{logged()?"↑":"登录"}</Text></View>
  </View></View>;
}

export function ImmersiveEntry(props:Parameters<typeof ImmersiveEntryImpl>[0]) {return traceServiceWork("navigation.ImmersiveEntry",()=>ImmersiveEntryImpl(props));}
