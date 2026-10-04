import {ReaderBackground,useReaderBackgrounds} from "./ReaderBackground.tsx";
import {useReaderTitle} from "./reader-title.ts";
import {useReaderFonts} from "./reader-fonts.ts";
import {createEffect,createMemo,createSignal,onCleanup} from 'solid-js';
import {Text,View,Image} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {getDisplayMetrics,getFontMetrics,hasCapability} from '@podjs/framework/watch';
import {textLayout,hostOperation} from '@podjs/framework/services';
import {SystemTextLine} from '@podjs/framework/text';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import type {VirtualListHandle} from '@pocketjs/framework/virtual-list';
import type {ReaderPreviewState} from '../reader/preview-session.ts';
import {resolvedReaderStyle} from '../reader/preset.ts';
import {createContentLayouter,readerColor,type NativeBlockLayouts} from '../reader/content-layout.ts';
import {requestReaderLayout} from '../reader/platform-layout.ts';
import {systemTextOptions} from '../reader/system-text.ts';
import type {ContentBlock} from '../reader/content.ts';
export const READER_PREVIEW_PARAGRAPHS=[
 ['title','阅读，让时间慢下来'],['subtitle','标题、副标题与正文会分别使用分类样式'],
 ['body','这是手表端的实时正文预览。你在手机上调整字体、字号、颜色、排版或背景后，这里会自动更新。'],
 ['quote','“好的排版让文字安静地抵达读者。”'],['code','val preview = ReaderPreset.live'],['link','链接样式预览 · watchrss.app'],
 ['body','继续向下阅读时，可以观察正文在圆形屏幕不同高度上的换行和边缘留白。预览内容会保留足够长度，方便检查滚动过程。'],
 ['body','较长文章往往包含多个段落。这里再加入一段常规文字，用来确认段间距、首行缩进和两端对齐在连续内容中的实际效果。'],
 ['body','到达文章结尾前，还应留出收藏与分享操作的位置，使最后一段文字能够完整滚动到圆屏中央，而不是停留在底部曲面区域。'],
] as const;
export function ReaderPreviewScreen(props:{state:ReaderPreviewState;width:number;height:number;active:boolean;ref:(value:Pick<VirtualListHandle,'scroller'>)=>void}){
 const fonts=useReaderFonts(),backgrounds=useReaderBackgrounds();
 const [visibleBackgrounds,setVisibleBackgrounds]=createSignal(backgrounds());
 const [visibleFonts,setVisibleFonts]=createSignal(fonts());
 const [visible,setVisible]=createSignal<ReaderPreviewState|null>(props.state.resourceTransferInProgress?null:props.state);
 createEffect(()=>{const state=props.state;if(!state.resourceTransferInProgress){setVisible(state);setVisibleFonts(()=>fonts());setVisibleBackgrounds(backgrounds());}});
 const preset=()=>visible()?.preset??props.state.preset;
 const title=useReaderTitle(()=>READER_PREVIEW_PARAGRAPHS[0][1],()=>props.width-28,preset,visibleFonts,"preview");
 const blocks=createMemo<ContentBlock[]>(()=>{const state=visible();if(!state)return [];return READER_PREVIEW_PARAGRAPHS.map(([style,text])=>({type:'text',style,text:style==='title'?title().join('\n'):text}));});
 const [native,setNative]=createSignal<NativeBlockLayouts>(new Map());const layOut=createContentLayouter((text,slot)=>getOps().measureText(text,slot),undefined,getFontMetrics);
 createEffect(()=>{const content=blocks(),current=preset();setNative(new Map());if(!content.length||!hasCapability('text.layout'))return;const metrics=getDisplayMetrics(),task=requestReaderLayout(content,props.width-28,current.body.fontSizeSp,metrics.physicalWidth/metrics.logicalWidth,current,args=>textLayout.layout(args),setNative,error=>console.warn('Reader preview layout',String(error)),visibleFonts(),"preview");onCleanup(()=>task.cancel());});
 const layout=createMemo(()=>layOut(blocks(),props.width-28,preset().body.fontSizeSp,{},preset(),native()));
 const unsupported=()=>{void hostOperation('ui.toast',{message:'预览页面不支持收藏/分享'}).result.catch(()=>{});};
 // Keep two physical coverage pixels below each preview line: native StaticLayout
 // can draw antialiased descenders past its line box. Row height and baseline stay unchanged.
 const entries=createMemo<ScrollEntry[]>(()=>{
  const p=preset(),width=props.width-28,metrics=getDisplayMetrics(),pixelScale=metrics.physicalWidth/metrics.logicalWidth;
  return [{height:22,render:()=>null},...layout().rows.flatMap(row=>{if(row.kind!=='text')return [];const block=blocks()[row.blockIndex];if(block?.type!=='text')return [];const style=block.style==='body'?p.body:resolvedReaderStyle(p,block.style),align=block.style==='title'?1:(row.textAlign??0),textRow={...row,textAlign:align};
   return [{height:row.height,render:()=>{const fallback=<Text class="absolute" style={{insetL:0,insetT:row.textOffsetY??0,width:width/row.scale,fontSlot:row.fontSlot,scale:row.scale,originX:-.5,originY:-.5,lineHeight:row.lineHeight/row.scale,textColor:row.color,textAlign:align}}>{row.text}</Text>;const textWidth=Math.min(width,getOps().measureText(row.text,row.fontSlot)*row.scale),left=align===1?(width-textWidth)/2:0;return <View class="absolute" style={{insetL:0,insetT:row.gap,width,height:row.lineHeight}}>{hasCapability('text.raster')?<SystemTextLine options={{...systemTextOptions(textRow,block.style,p.body.fontSizeSp,width,pixelScale,p,getFontMetrics(row.fontSlot),visibleFonts(),"preview"),heightPx:Math.min(1024,Math.ceil(row.lineHeight*pixelScale)+(row.nativeParagraph&&row.nativeParagraph.lineIndex+1<(native().get(block)?.length??0)?0:2))}} pixelScale={pixelScale} fallback={fallback}/>:fallback}{!hasCapability('text.raster')&&style.underline&&<View class="absolute" style={{insetL:left,insetT:(row.nativeBaseline??row.lineHeight*.8)+2,width:textWidth,height:1,bgColor:row.color}}/>}{!hasCapability('text.raster')&&style.strikethrough&&<View class="absolute" style={{insetL:left,insetT:(row.nativeBaseline??row.lineHeight*.8)-style.fontSizeSp*.3,width:textWidth,height:1,bgColor:row.color}}/>}</View>;}}];}),
   {height:15,render:()=>null},{height:32,render:()=> <View class="absolute" style={{insetL:(width-76)/2,insetT:0,width:76,height:32}}>{[0,1].map(index=><View onPress={unsupported} accessibilityLabel={index?'分享':'收藏'} focusable class="absolute rounded-[999] items-center justify-center bg-[#23272a]" style={{insetL:index*44,insetT:0,width:32,height:32}}><Image src={index?'../assets/icons/share.svg':'../assets/icons/favorite-border.svg'} style={{width:20,height:20}}/></View>)}</View>},{height:15,render:()=>null}];
 });
 return <View class="absolute inset-0" style={{bgColor:readerColor(preset().background.colorArgb)}}><ReaderBackground background={preset().background} snapshot={visibleBackgrounds()} width={props.width} height={props.height} active={props.active}/><View class="absolute" style={{insetL:14,insetT:0,width:props.width-28,height:props.height}}><ScrollEntries entries={entries()} height={props.height} padding={0} verticalPadding={0} gap={0} inputActive={()=>props.active} ref={props.ref}/></View><View class="absolute rounded-[50] items-center justify-center" style={{insetT:2,insetL:(props.width-100)/2,width:100,height:17,bgColor:'#23272ae0'}}><Text class="text-[11px]" style={{fontSlot:20,scale:1,lineHeight:13,textColor:'#f2f2f2'}}>{props.state.resourceTransferInProgress?'资源文件传输中':'预设实时预览'}</Text></View></View>;
}
