import { createSignal, createEffect, untrack, onCleanup, Show } from "solid-js";
import { View, Text } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import type { DouyinScreenProps } from "./index.tsx";
import type { DouyinItem } from "../../douyin/types.ts";

/** Title page owns no player; the single host session starts only on entering the flow. */
export function ImmersiveEntry(props: DouyinScreenProps) {
  const [items,setItems]=createSignal<DouyinItem[]>([]),[busy,setBusy]=createSignal(false),[error,setError]=createSignal(""),[logged,setLogged]=createSignal(true);
  let cursor:string|null=null,hasMore=false,anchor:string|null=null,disposed=false;
  const active=()=>!disposed&&(props.active??true);
  const load=async(refresh=false)=>{
    if(busy())return;setBusy(true);setError("");
    try{
      const signed=await props.client.isLoggedIn();if(disposed)return;setLogged(signed);if(!signed)return;
      if(!refresh){const feed=await props.client.restoreFeed(),queue=await props.client.restorePlaybackQueue(),cached=queue.items.length?queue:feed;if(disposed)return;setItems(cached.items);anchor=cached.anchorAwemeId;cursor=cached.cursor;hasMore=cached.hasMore;if(cached.items.length){void props.client.resolvePlayback(anchor??cached.items[0].awemeId).catch(()=>{});return;}}
      const result=await props.client.fetchFeedPage({count:12});if(disposed)return;
      if(result.ok){setItems(result.data.items);cursor=result.data.nextCursor;hasMore=result.data.hasMore;anchor=null;}else setError(result.message);
    }catch(e){if(!disposed)setError(String(e));}finally{if(!disposed)setBusy(false);}
  };
  const enter=async()=>{
    if(!active()||busy())return;if(!items().length){await load(true);return;}
    setBusy(true);setError("");
    try{const index=Math.max(0,items().findIndex(item=>item.awemeId===anchor)),candidates=items().slice(index),failed=new Set<string>();for(const item of candidates){
      const result=await props.client.resolvePlayback(item.awemeId);if(!active())return;
      if(!result.ok){setError(result.message);if(result.code==="NOT_LOGGED_IN"){setLogged(false);return;}failed.add(item.awemeId);continue;}
      props.onPlay({item:result.data,playback:result.data,playlist:items().filter(candidate=>!failed.has(candidate.awemeId)),cursor:cursor??undefined,hasMore,immersive:true});props.onNavigate({name:"player",awemeId:item.awemeId});return;
    }}catch(e){if(active())setError(String(e));}finally{if(!disposed)setBusy(false);}
  };
  const gesture=createGesture({region:{rect:()=>active()?{x:0,y:0,w:props.width,h:props.height}:null},axis:"y",panSlop:8,onPanEnd:c=>{if(c.dy < -50)void enter();else if(c.dy>50)void load(true);}});
  createEffect(()=>{if(props.active??true)void untrack(()=>load());});onCleanup(()=>{disposed=true;gesture.dispose();});
  return <View class="absolute inset-0 bg-black">
    <View class="absolute left-[24] right-[24] top-[32] h-[76] items-center" onPress={()=>props.onNavigate({name:"channel-info"})} focusable><Text class="text-lg text-white">抖音 ›</Text><Text class="text-xs text-[#b6b6b6]">{busy()?"刷新中...":items().length?"下拉刷新，向上进入短视频流":"暂无内容，下拉刷新或点箭头重试"}</Text></View>
    <Show when={error()}><Text class="absolute left-[25] right-[25] top-[114] text-xs text-[#ff5a5f]">{error()}</Text></Show>
    <View class="absolute left-[82] right-[82] bottom-[24] h-[44] rounded-[22] bg-[#2a2a2a] items-center justify-center" onPress={()=>logged()?void enter():props.onNavigate({name:"login"})} focusable><Text class="text-base text-white">{logged()?"↑":"登录"}</Text></View>
  </View>;
}
