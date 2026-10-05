import { createSignal, createEffect, untrack, onCleanup, Show } from "solid-js";
import { View, Text } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import type { DouyinScreenProps } from "./index.tsx";
import { formatDouyinError } from "../../douyin/errors.ts";
import { appLogger } from "../../logs/app-logger.ts";
import type { DouyinItem } from "../../douyin/types.ts";

/** Title page owns no player; the single host session starts only on entering the flow. */
export function ImmersiveEntry(props: DouyinScreenProps) {
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
        const feed=await props.client.restoreFeed(),queue=await props.client.restorePlaybackQueue();if(!current())return;
        const cached=queue.items.length?queue:feed;
        setItems(cached.items);anchor=cached.anchorAwemeId;cursor=cached.cursor;hasMore=cached.hasMore;
        // Native restores the title page immediately; a small/incomplete bootstrap
        // needs a 16-item feed request. Expired detail refresh is background work.
        if(cached.items.length>=3&&(!hasMore||!!cursor?.trim())){
          void props.client.resolvePlayback(anchor??cached.items[0].awemeId).then(result=>{
            if(current()&&result.ok)setItems(old=>old.map(item=>item.awemeId===result.data.awemeId?result.data:item));
          }).catch(()=>{});
          return;
        }
      }
      appLogger.d('DouyinEntry',`feed requested reason=${refresh?'refresh':'bootstrap'}`);
      const result=await props.client.fetchFeedPage({count:16});if(!current())return;
      if(result.ok){setItems(result.data.items);cursor=result.data.nextCursor;hasMore=result.data.hasMore;anchor=null;}
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
  const gesture=createGesture({region:{rect:()=>active()?{x:0,y:0,w:props.width,h:props.height}:null},axis:"y",panSlop:8,onPanEnd:c=>{if(c.dy < -50)void enter();else if(c.dy>50)void load(true);}});
  createEffect(()=>{if(props.active??true)void untrack(()=>load());else{generation++;setBusy(false);}});onCleanup(()=>{disposed=true;generation++;gesture.dispose();});
  return <View class="absolute inset-0 bg-black">
    <View class="absolute left-[24] right-[24] top-[32] h-[76] items-center" onPress={()=>props.onNavigate({name:"channel-info"})} focusable><Text class="text-lg text-white">抖音 ›</Text><Text class="text-xs text-[#b6b6b6]">{busy()?"刷新中...":items().length?"下拉刷新，向上进入短视频流":"暂无内容，下拉刷新或点箭头重试"}</Text></View>
    <Show when={error()}><Text class="absolute left-[25] right-[25] top-[114] text-xs text-[#ff5a5f]">{error()}</Text></Show>
    <View class="absolute left-[82] right-[82] bottom-[24] h-[44] rounded-[22] bg-[#2a2a2a] items-center justify-center" onPress={()=>logged()?void enter():props.onNavigate({name:"login"})} focusable><Text class="text-base text-white">{logged()?"↑":"登录"}</Text></View>
  </View>;
}
