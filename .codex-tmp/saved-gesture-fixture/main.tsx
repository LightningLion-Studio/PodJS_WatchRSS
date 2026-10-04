import {mount} from "@pocketjs/framework/solid";
import {createSignal} from "solid-js";
import {View,Text} from "@pocketjs/framework/components";
import {getDisplayMetrics} from "@podjs/framework/watch";
import {SavedItemsScreen,type SavedDisplayItem} from "../../src/ui/SavedItemsScreen.tsx";

const metrics=getDisplayMetrics();
const initial:SavedDisplayItem[]=[
  {key:"fixture:alpha",kind:"rss",title:"手势验收 A：收藏列表第一条",summary:"左滑阈值、纵向滚动和长按排序。",channelTitle:"隔离测试源 A",savedAt:1790280000000,sortOrder:0,articleId:"alpha"},
  {key:"fixture:bravo",kind:"rss",title:"手势验收 B：收藏列表第二条",summary:"三条固定项目，用于跨行拖动。",channelTitle:"隔离测试源 B",savedAt:1790280060000,sortOrder:1,articleId:"bravo"},
  {key:"fixture:charlie",kind:"rss",title:"手势验收 C：收藏列表第三条",summary:"仅夹具状态会被移除或重排。",channelTitle:"隔离测试源 C",savedAt:1790280120000,sortOrder:2,articleId:"charlie"}
];
mount(()=>{
  const [items,setItems]=createSignal(initial.slice());
  const [removed,setRemoved]=createSignal<SavedDisplayItem|null>(null);
  const [events,setEvents]=createSignal<string[]>(["READY:A,B,C"]);
  const record=(entry:string)=>setEvents(values=>[...values,entry].slice(-5));
  return <View class="absolute inset-0 bg-black">
    <SavedItemsScreen width={metrics.logicalWidth} height={metrics.logicalHeight} active={true} type="favorite" items={items()} loading={false} undoVisible={!!removed()} onOpen={item=>record(`OPEN:${item.key}`)} onRemove={item=>{record(`REMOVE:${item.key}`);setItems(values=>values.filter(value=>value.key!==item.key));setRemoved(item);}} onUndo={()=>{if(!removed())return;record(`UNDO:${removed()!.key}`);setItems(values=>[...values,removed()!].sort((a,b)=>a.sortOrder-b.sortOrder));setRemoved(null);}} onReorder={next=>{record(`REORDER:${next.map(item=>item.key.split(":")[1]).join(",")}`);setItems(next);}} onError={message=>record(`ERROR:${message}`)}/>
    <View class="absolute left-[2] right-[2] bottom-[2] rounded-[4] bg-[#17191a]"><Text class="text-[10px] leading-[12px] text-[#55ff88]">{events().join(" | ")}</Text></View>
  </View>;
});
