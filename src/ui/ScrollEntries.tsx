import { visibleEntryRange } from "./visible-range.ts";
import { createWindowRows } from "./windowed-rows.ts";
import { For, createMemo, onCleanup, type JSX } from "solid-js";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture, type GestureContact } from "@pocketjs/framework/gesture";
import { createScroller, bindDpadScroll, type Scroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { pressNode, hitNode } from "@pocketjs/framework/input";

export interface ScrollEntry { height: number; render: () => JSX.Element; retain?:boolean }
/** Variable-height, windowed column; the clipping viewport never translates. */
export function ScrollEntries(props: { height: number; entries: ScrollEntry[]; gap?: number; padding?: number; verticalPadding?: number; retainRows?:number; fixed?: boolean; controller?: Scroller; inputActive?: () => boolean; accessibilityLabel?:string; onRefresh?: () => void; onManualScroll?:()=>void; onTap?:(contact:GestureContact)=>boolean|void; onLongPress?: (contact: GestureContact) => void; onScrollStateChange?:(scrolling:boolean)=>void; onOffsetChange?:(previous:number,current:number)=>void; onSettledRange?:(first:number,last:number)=>void; settleKey?:unknown; ref?: (handle: {scroller: Scroller}) => void }) {
  let viewport: NodeMirror | undefined;
  const rows = createMemo(() => {
    let top = props.verticalPadding ?? props.padding ?? 18;
    return props.entries.map(entry => { const row = { ...entry, top }; top += entry.height + (props.gap ?? 6); return row; });
  });
  const total = () => { const last = rows().at(-1); return last ? last.top + last.height + (props.verticalPadding ?? props.padding ?? 18) : 0; };
  const scroller = props.controller ?? createScroller({ max: () => Math.max(0, total() - props.height) });
  const windowRows=createWindowRows<ReturnType<typeof rows>[number]>(props.retainRows);
  const visible = createMemo(() => windowRows(rows(),scroller.offset()-80,scroller.offset()+props.height+80));
  const active=()=>props.inputActive?.()??true;
  let refreshEligible=false,pullDistance=0;
  createGesture({ region: {node: () => viewport}, axis: "y",
    onLongPress: props.onLongPress ? contact => { if(active())props.onLongPress?.(contact); } : undefined,
    onDown: () => {if(!active())return;scroller.stop();refreshEligible=scroller.offset()<=0;pullDistance=0;},
    onPanStart: () => {if(!active())return;props.onManualScroll?.();if(!props.fixed)scroller.beginDrag();},
    onPanMove: c => {if(!active())return;if(refreshEligible)pullDistance=Math.max(0,pullDistance+c.fdy);if(!props.fixed)scroller.drag(-c.fdy);},
    onPanEnd: c => {if(!active())return;if(!props.fixed)scroller.endDrag(-c.vy);if(refreshEligible&&pullDistance>=48)props.onRefresh?.();refreshEligible=false;pullDistance=0;},
    onTap: c => {if(!active())return;if(props.onTap?.(c))return;const hit = hitNode(c.x, c.y, c.surface); if (hit) pressNode(hit); },
    onCancel: () => { refreshEligible=false;pullDistance=0;if (scroller.state() === "tracking") scroller.endDrag(0); }
  });
  bindDpadScroll(scroller,{active:()=>active()&&!props.fixed});
  let wasScrolling=false;
  let lastOffset=scroller.offset();
  let settledRows:unknown,settledKey:unknown,settledFirst=-1,settledLast=-1;
  onFrame(() => {
    scroller.step();
    const currentOffset=scroller.offset();if(currentOffset!==lastOffset){props.onOffsetChange?.(lastOffset,currentOffset);lastOffset=currentOffset;}
    const scrolling=active()&&scroller.state()!=="idle";if(scrolling!==wasScrolling){wasScrolling=scrolling;props.onScrollStateChange?.(scrolling);}
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
      props.onManualScroll?.();scroller.scrollBy((event.actionName==="increment"?1:-1)*Math.max(1,props.height*.8),{durMs:120});
    }:undefined}>
    <View class="absolute left-[0] right-[0] top-[0]" style={{height:total(), translateY:props.fixed?0:-scroller.offset()}}>
      <For each={visible()}>{row => <View class="absolute" style={{insetL:props.padding ?? 18,insetR:props.padding ?? 18,insetT:row.top,height:row.height}}>{row.render()}</View>}</For>
    </View>
  </View>;
}
