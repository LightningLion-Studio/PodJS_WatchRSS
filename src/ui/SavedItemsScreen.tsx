import {Image,Text,View} from "@pocketjs/framework/components";
import {createEffect,createMemo,createSignal,Show} from "solid-js";
import {createGesture} from "@pocketjs/framework/gesture";
import {onFrame} from "@pocketjs/framework/lifecycle";
import type {Scroller} from "@pocketjs/framework/kinetics";
import {getOps} from "@pocketjs/framework/host";
import {measuredLines} from "../reader/measured-text.ts";
import {DownloadPhoneAppDialog} from "./DownloadPhoneAppDialog.tsx";
import {ScrollEntries,type ScrollEntry} from "./ScrollEntries.tsx";

export interface SavedDisplayItem {
  key:string;
  kind:"rss"|"douyin";
  title:string;
  summary:string;
  channelTitle:string;
  savedAt:number;
  sortOrder:number;
  articleId?:string;
  awemeId?:string;
}

const SAFE=18, GAP=6, HEADER_HEIGHT=66, PROMPT_HEIGHT=60, ROW_HEIGHT=84;
const ITEM_START=SAFE+HEADER_HEIGHT+GAP+PROMPT_HEIGHT+GAP;
const STEP=ROW_HEIGHT+GAP;
const pad=(n:number)=>String(n).padStart(2,"0");
function savedTime(timestamp:number){if(!timestamp||timestamp<0)return "未更新";const date=new Date(timestamp);return `${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;}
function move<T>(items:T[],from:number,to:number){const next=items.slice(),[item]=next.splice(from,1);next.splice(to,0,item!);return next;}

export function SavedItemsScreen(props:{width:number;height:number;active:boolean;type:"favorite"|"watchLater";items:SavedDisplayItem[];loading:boolean;undoVisible:boolean;onOpen:(item:SavedDisplayItem)=>void;onRemove:(item:SavedDisplayItem)=>void;onUndo:()=>void;onReorder:(items:SavedDisplayItem[])=>void;onError:(message:string)=>void;ref?:(handle:{scroller:Scroller})=>void}){
  const [display,setDisplay]=createSignal(props.items);
  const [dragKey,setDragKey]=createSignal<string|null>(null),[dragOffset,setDragOffset]=createSignal(0);
  const [swipeKey,setSwipeKey]=createSignal<string|null>(null),[swipeOffset,setSwipeOffset]=createSignal(0);
  const [download,setDownload]=createSignal(false);
  const [skeletonAlpha,setSkeletonAlpha]=createSignal(.8);
  let scroller:Scroller|undefined,downKey:string|null=null,dragStart:SavedDisplayItem[]=[];
  let swipeReturn:{start:number;at:number}|null=null;
  let touchY=0;
  createEffect(()=>{if(!dragKey())setDisplay(props.items);});
  const title=()=>props.type==="favorite"?"我的收藏":"稍后再看";
  const operation=()=>props.type==="favorite"?"同步收藏":"同步稍后再看";
  const rowAt=(screenY:number)=>{
    const y=screenY+(scroller?.offset()??0)-ITEM_START;
    if(y<0)return null;
    const index=Math.floor(y/STEP);
    return y-index*STEP<ROW_HEIGHT?display()[index]??null:null;
  };
  const resetSwipe=()=>{swipeReturn=null;setSwipeKey(null);setSwipeOffset(0);};
  const returnSwipe=()=>{const start=swipeOffset();if(!swipeKey()||start===0){resetSwipe();return;}swipeReturn={start,at:Date.now()};};
  const finishDrag=(commit:boolean)=>{
    const original=dragStart,updated=display();
    setDragKey(null);setDragOffset(0);dragStart=[];
    if(!commit){setDisplay(original);return;}
    if(original.map(item=>item.key).join("\u0000")!==updated.map(item=>item.key).join("\u0000"))props.onReorder(updated);
  };
  createGesture({region:{rect:()=>props.active&&!props.loading&&display().length?{x:0,y:Math.max(0,ITEM_START-(scroller?.offset()??0)),w:props.width,h:props.height}:null},axis:"x",panSlop:8,
    onDown:c=>{downKey=rowAt(c.y)?.key??null;touchY=c.y;},
    onLongPress:()=>{if(!downKey)return;dragStart=display().slice();setDragKey(downKey);setDragOffset(0);resetSwipe();},
    onMove:c=>{
      touchY=c.y;
      const key=dragKey();if(!key)return;
      let delta=dragOffset()+c.fdy,items=display(),index=items.findIndex(item=>item.key===key);
      if(index<0)return;
      while(delta>=STEP/2&&index<items.length-1){items=move(items,index,index+1);index++;delta-=STEP;}
      while(delta<=-STEP/2&&index>0){items=move(items,index,index-1);index--;delta+=STEP;}
      setDisplay(items);setDragOffset(delta);
    },
    onUp:()=>{if(dragKey())finishDrag(true);downKey=null;},
    onPanStart:()=>{if(!downKey)return;swipeReturn=null;setSwipeKey(downKey);setSwipeOffset(0);},
    onPanMove:c=>{if(swipeKey())setSwipeOffset(Math.max(-(props.width-2*SAFE),Math.min(0,c.dx)));},
    onPanEnd:()=>{const key=swipeKey();const remove=key&&swipeOffset()<=-(props.width-2*SAFE)*.35;if(remove){resetSwipe();const item=display().find(value=>value.key===key);if(item)props.onRemove(item);}else returnSwipe();},
    onCancel:()=>{if(dragKey())finishDrag(false);returnSwipe();downKey=null;}
  });
  onFrame(()=>{
    if(props.loading&&props.active)setSkeletonAlpha(.72+.16*Math.sin(Date.now()/270));
    if(swipeReturn){const elapsed=Math.min(1,(Date.now()-swipeReturn.at)/180);const remain=(1-elapsed)**3;setSwipeOffset(swipeReturn.start*remain);if(elapsed>=1)resetSwipe();}
    if(!dragKey()||!scroller)return;
    if(touchY<42)scroller.scrollBy(-6,{immediate:true});else if(touchY>props.height-42)scroller.scrollBy(6,{immediate:true});
  });
  const lines=(text:string,size:number,width:number,maxLines:number)=>measuredLines(text,width,t=>getOps().measureText(t,size===17?22:size===14?1:0),maxLines).join("\n");
  const oneLine=(text:string,size:number,width:number)=>lines(text,size,width,1);
  const card=(item:SavedDisplayItem,floating=false)=><View onPress={floating?undefined:()=>{if(!dragKey()&&!swipeKey())props.onOpen(item);}} focusable={!floating} accessibilityHidden={floating} accessibilityRole="button" accessibilityLabel={`文章：${item.title}，${item.channelTitle} · ${savedTime(item.savedAt)}，${item.summary||"暂无摘要"}`} accessibilityHint="长按可拖动排序，左滑移除" class="absolute inset-0 rounded-[16]" style={{translateX:floating?0:swipeKey()===item.key?swipeOffset():0,bgColor:floating?"#2a2a2a":"#1c1f21"}}><Text class="absolute left-[14] right-[6] top-[14] text-[17px] leading-[21] text-[#f5f5f5]">{oneLine(item.title,17,props.width-2*SAFE-20)}</Text><Text class="absolute left-[14] right-[6] top-[35] text-sm leading-[17] text-[#b6b6b6]">{oneLine(`${item.channelTitle} · ${savedTime(item.savedAt)}`,14,props.width-2*SAFE-20)}{"\n"}{oneLine(item.summary||"暂无摘要",14,props.width-2*SAFE-20)}</Text></View>;
  const skeleton=(index:number):ScrollEntry=>({height:ROW_HEIGHT,render:()=> <View class="absolute inset-0 rounded-[16] bg-[#1c1f21]" style={{opacity:skeletonAlpha()}}>
    <View class="absolute left-[10] top-[11] h-[10] rounded-[6] bg-[#484b4d]" style={{width:(props.width-2*SAFE-20)*(index%2===0?.78:.66)}}/>
    <View class="absolute left-[10] top-[35] h-[8] rounded-[6] bg-[#3a3d3f]" style={{width:(props.width-2*SAFE-20)*(index%3===0?.72:index%3===1?.64:.81)}}/>
    <View class="absolute left-[10] top-[48] h-[8] rounded-[6] bg-[#3a3d3f]" style={{width:(props.width-2*SAFE-20)*(index%3===0?.88:index%3===1?.82:.58)}}/>
  </View>});
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:HEADER_HEIGHT,render:()=> <View class="absolute inset-0"><Text accessibilityRole="header" class="absolute left-[0] right-[0] top-[3] text-center text-[21px] leading-[26] text-[#f5f5f5]">{title()}</Text><Text class="absolute left-[4] right-[4] top-[30] text-xs leading-[17] text-[#b6b6b6]">{lines("保存在本地，离线可读，长按可拖动排序",12,props.width-2*SAFE-8,2)}</Text></View>},
    ...(!props.loading?[{height:PROMPT_HEIGHT,render:()=> <View onPress={()=>setDownload(true)} focusable accessibilityRole="button" accessibilityLabel="下载手机端app以在手机上编辑和同步内容" class="absolute left-[0] right-[0] top-[1] h-[57] rounded-[16] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] top-[10] text-[17px] leading-[20] text-[#f5f5f5]">{lines("下载手机端app以在手机上编辑和同步内容",17,props.width-2*SAFE-20,2)}</Text></View>}]:[]),
    ...(props.loading?[0,1,2,3].map(skeleton):display().map(item=>({height:ROW_HEIGHT,render:()=> <View class="absolute inset-0 overflow-hidden rounded-[16] bg-black">{dragKey()===item.key?null:card(item)}</View>}))),
    ...(!props.loading&&!display().length?[{height:48,render:()=> <Text class="absolute left-[0] right-[0] top-[8] text-sm leading-[18] text-center text-[#b6b6b6]">{props.type==="favorite"?"暂无收藏":"暂无稍后再看"}</Text>}]:[]),
    {height:40,render:()=> <View/>}
  ]);
  return <View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} padding={SAFE} verticalPadding={SAFE} gap={GAP} inputActive={()=>props.active} accessibilityLabel={`${title()}页面`} onScrollStateChange={scrolling=>{if(scrolling)resetSwipe();}} ref={handle=>{scroller=handle.scroller;props.ref?.(handle);}}/>
    <Show when={dragKey()}>{key=>{const item=()=>display().find(value=>value.key===key());const index=()=>display().findIndex(value=>value.key===key());return <Show when={item()}>{value=><View class="absolute rounded-[16] overflow-hidden" style={{insetL:SAFE,width:props.width-2*SAFE,height:ROW_HEIGHT,insetT:ITEM_START+index()*STEP-(scroller?.offset()??0)+dragOffset()}}>{card(value(),true)}</View>}</Show>;}}</Show>
    <Show when={props.undoVisible}><View onPress={props.onUndo} focusable accessibilityRole="button" accessibilityLabel="撤回按钮" class="absolute top-[18] w-[48] h-[48] rounded-[16] bg-[#2a2a2a] items-center justify-center" style={{insetL:(props.width-48)/2}}><Image src="../assets/icons/undo.svg" class="w-[20] h-[20]"/></View></Show>
    <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation={operation()} onDismiss={()=>setDownload(false)} onError={props.onError}/></Show>
  </View>;
}
