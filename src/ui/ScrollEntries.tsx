import {routeActivity} from './route-activity.tsx';
import {routeMemory} from '../navigation/activity-navigation.ts';
import {ScrollRestoration,validScrollSnapshot} from '../navigation/scroll-restoration.ts';
import { visibleEntryRange } from "./visible-range.ts";
import { For, createMemo, onCleanup, type JSX } from "solid-js";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture, type GestureContact } from "@pocketjs/framework/gesture";
import { createScroller, bindDpadScroll, type Scroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { pressNode, hitNode } from "@pocketjs/framework/input";

export interface ScrollEntry { height: number; render: () => JSX.Element }
/** Variable-height, windowed column; the clipping viewport never translates. */
export function ScrollEntries(props: { height: number; entries: ScrollEntry[]; gap?: number; padding?: number; verticalPadding?: number; fixed?: boolean; controller?: Scroller; inputActive?: () => boolean; accessibilityLabel?:string; onRefresh?: () => void; onManualScroll?:()=>void; onTap?:(contact:GestureContact)=>boolean|void; onLongPress?: (contact: GestureContact) => void; onScrollStateChange?:(scrolling:boolean)=>void; onOffsetChange?:(previous:number,current:number)=>void; onSettledRange?:(first:number,last:number)=>void; settleKey?:unknown; ref?: (handle: {scroller: Scroller}) => void }) {
  let viewport: NodeMirror | undefined;
  const rows = createMemo(() => {
    let top = props.verticalPadding ?? props.padding ?? 18;
    return props.entries.map(entry => { const row = { ...entry, top }; top += entry.height + (props.gap ?? 6); return row; });
  });
  const total = () => { const last = rows().at(-1); return last ? last.top + last.height + (props.verticalPadding ?? props.padding ?? 18) : 0; };
  const scroller = props.controller ?? createScroller({ max: () => Math.max(0, total() - props.height) });
  const activity=routeActivity();
  // ReaderBody owns text/byte anchors; InformationScreen owns document anchors.
  // Their supplied controllers must not also receive a generic list offset.
  const ownsDocument=!!props.controller&&['reader','information','bili','douyin'].includes(activity?.entry.page??'');
  const memory=activity&&!ownsDocument?routeMemory(activity.entry):undefined;
  let scrollSlot=0;
  if(memory){while(activity!.scrollSlots.has(scrollSlot))scrollSlot++;activity!.scrollSlots.add(scrollSlot);}
  const scrollKey=memory?`scroll:${scrollSlot}`:undefined;
  const saved=scrollKey?memory!.saved[scrollKey]:undefined;
  const restoration=new ScrollRestoration(validScrollSnapshot(saved)?saved:typeof saved==='number'&&Number.isFinite(saved)&&saved>=0?saved:undefined);
  const checkpoint=()=>{if(scrollKey)memory!.saved[scrollKey]=restoration.snapshot(scroller.offset(),rows());};
  if(memory){activity!.checkpoints.add(checkpoint);onCleanup(()=>{checkpoint();activity!.checkpoints.delete(checkpoint);activity!.scrollSlots.delete(scrollSlot);});}
  const takeScroll=()=>restoration.cancel();
  const visible = createMemo(() => {
    const list=rows(),lower=scroller.offset()-80,upper=scroller.offset()+props.height+80;
    let lo=0,hi=list.length;while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid].top+list[mid].height<lower)lo=mid+1;else hi=mid;}
    const first=lo;hi=list.length;while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid].top<=upper)lo=mid+1;else hi=mid;}
    return list.slice(first,lo);
  });
  const active=()=>props.inputActive?.()??true;
  let refreshEligible=false,pullDistance=0;
  createGesture({ region: {node: () => viewport}, axis: "y",
    onLongPress: props.onLongPress ? contact => { if(active())props.onLongPress?.(contact); } : undefined,
    onDown: () => {if(!active())return;takeScroll();scroller.stop();refreshEligible=scroller.offset()<=0;pullDistance=0;},
    onPanStart: () => {if(!active())return;props.onManualScroll?.();if(!props.fixed)scroller.beginDrag();},
    onPanMove: c => {if(!active())return;if(refreshEligible)pullDistance=Math.max(0,pullDistance+c.fdy);if(!props.fixed)scroller.drag(-c.fdy);},
    onPanEnd: c => {if(!active())return;if(!props.fixed)scroller.endDrag(-c.vy);if(refreshEligible&&pullDistance>=48)props.onRefresh?.();refreshEligible=false;pullDistance=0;},
    onTap: c => {if(!active())return;if(props.onTap?.(c))return;const hit = hitNode(c.x, c.y, c.surface); if (hit) pressNode(hit); },
    onCancel: () => { refreshEligible=false;pullDistance=0;if (scroller.state() === "tracking") scroller.endDrag(0); }
  });
  bindDpadScroll(scroller,{active:()=>active()&&!props.fixed});
  let wasScrolling=false;
  let lastOffset=scroller.offset(),restoredOffset:number|undefined;
  let settledRows:unknown,settledKey:unknown,settledFirst=-1,settledLast=-1;
  onFrame(() => {
    if(memory){
      if(scroller.state()!=='idle'||restoredOffset!==undefined&&scroller.offset()!==restoredOffset){takeScroll();restoredOffset=undefined;}
      const target=restoration.target(Math.max(0,total()-props.height),rows());
      if(target!==undefined){scroller.scrollTo(target,{immediate:true});restoredOffset=target;checkpoint();}
    }
    scroller.step();
    const currentOffset=scroller.offset();if(currentOffset!==lastOffset){props.onOffsetChange?.(lastOffset,currentOffset);lastOffset=currentOffset;}
    const scrolling=active()&&scroller.state()!=="idle";if(scrolling!==wasScrolling){wasScrolling=scrolling;props.onScrollStateChange?.(scrolling);if(!scrolling&&memory){checkpoint();activity!.changed();}}
    if(!active()||scroller.state()!=="idle") {settledRows=undefined;return;}
    if(!props.onSettledRange)return;
    const list=rows(),range=visibleEntryRange(list,scroller.offset(),props.height);
    if(!range)return;
    if(list===settledRows&&props.settleKey===settledKey&&range.first===settledFirst&&range.last===settledLast)return;
    settledRows=list;settledKey=props.settleKey;settledFirst=range.first;settledLast=range.last;
    props.onSettledRange(range.first,range.last);
  });
  onCleanup(() => {scroller.stop();if(wasScrolling)props.onScrollStateChange?.(false);});
  props.ref?.({scroller});
  return <View ref={n => viewport = n} class="relative w-full overflow-hidden" style={{height: props.height}}
    accessibilityLabel={props.accessibilityLabel} accessibilityRole={props.accessibilityLabel?"list":undefined}
    accessibilityState={props.accessibilityLabel?{disabled:!active()}:undefined}
    accessibilityActions={props.accessibilityLabel&&!props.fixed&&total()>props.height?["increment","decrement"]:undefined}
    onAccessibilityAction={props.accessibilityLabel?event=>{
      if(!active()||props.fixed||(event.actionName!=="increment"&&event.actionName!=="decrement"))return;
      takeScroll();props.onManualScroll?.();scroller.scrollBy((event.actionName==="increment"?1:-1)*Math.max(1,props.height*.8),{durMs:120});
    }:undefined}>
    <View class="absolute left-[0] right-[0] top-[0]" style={{height:total(), translateY:props.fixed?0:-scroller.offset()}}>
      <For each={visible()}>{row => <View class="absolute" style={{insetL:props.padding ?? 18,insetR:props.padding ?? 18,insetT:row.top,height:row.height}}>{row.render()}</View>}</For>
    </View>
  </View>;
}
