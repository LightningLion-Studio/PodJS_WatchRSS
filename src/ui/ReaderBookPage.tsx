import {createMemo} from 'solid-js';
import {View,Text,Image,type NodeMirror} from '@pocketjs/framework/components';
import {createGesture} from '@pocketjs/framework/gesture';
import {hitNode,pressNode} from '@pocketjs/framework/input';
import type {BookPage,PageLine} from '../reader/pagination.ts';
import type {ContentBlock} from '../reader/content.ts';
import type {ReaderPreset} from '../reader/preset.ts';
import type {ReaderFontResolver} from '../reader/font-assets.ts';
import type {ScrollEntry} from './ScrollEntries.tsx';
import {ReaderTextRow,type ReaderTextEnvironment} from './ReaderTextRow.tsx';
import {RemoteImage} from './RemoteImage.tsx';
import {resolveUrl} from '../core/parser.ts';
import {novelPageDirection} from '../reader/novel.ts';

/** A page has no scroller or pan handler. Only its current lines are mounted. */
export function ReaderBookPage(props:{page:BookPage;width:number;height:number;round:boolean;active:boolean;touchOrigin?:{left:number;top:number};header:ScrollEntry[];footer:ScrollEntry[];blocks:ContentBlock[];preset?:ReaderPreset;fontSize:number;fonts?:ReaderFontResolver;environment:ReaderTextEnvironment;offlineMedia?:Record<string,string>;baseUrl?:string;onImageSize?:(index:number,width:number,height:number)=>void;onTap:(direction:number)=>void;onMedia:(block:Exclude<ContentBlock,{type:'text'}>)=>void;onLongPress?:(line?:PageLine)=>void}){
 let viewport:NodeMirror|undefined;
 const safe=()=>props.round?Math.floor((Math.min(props.width,props.height)-16)/Math.SQRT2):props.width-28;
 const controls=createMemo(()=>{let top=(props.height-(props.page.controls??[]).reduce((sum,part)=>sum+part.height,0))/2;return (props.page.controls??[]).map(part=>{const value={...part,top};top+=part.height;return value;});});
 createGesture({region:{node:()=>props.active?viewport:undefined},onTap:contact=>{
  if(!props.active)return;
  // Real buttons keep their own actions; blank areas and text use the paging gesture.
  const hit=hitNode(contact.x,contact.y,contact.surface);
  if(hit){let node:NodeMirror|null=hit;while(node&&node!==viewport){if(node.focusable&&node.onPress){pressNode(hit);return;}node=node.parent;}}
  props.onTap(novelPageDirection(contact.x-(props.touchOrigin?.left??0),props.width));
 },onLongPress:props.onLongPress?contact=>{const y=contact.startY-(props.touchOrigin?.top??0);props.onLongPress?.(props.page.lines.find(line=>y>=line.top&&y<line.top+line.row.height));}:undefined});
 return <View ref={node=>{viewport=node;}} debugName="ReaderBookPage" class="absolute inset-0 overflow-hidden">
  {controls().map(part=><View class="absolute overflow-hidden" style={{insetL:(props.width-safe())/2,insetT:part.top,width:safe(),height:part.height}}><View class="absolute left-[0] right-[0]" style={{insetT:-part.offset,height:(props.page.anchor.section==='header'?props.header:props.footer)[part.index]?.height}}>{(props.page.anchor.section==='header'?props.header:props.footer)[part.index]?.render()}</View></View>)}
  {props.page.lines.map(line=><View debugName="ReaderPageLine" class="absolute overflow-hidden" style={{insetL:line.left,insetT:line.top,width:line.width,height:line.row.height}}>
   {line.row.kind==='text'?<ReaderTextRow row={line.row} width={line.width} environment={props.environment} style={props.blocks[line.row.blockIndex]?.type==='text'?(props.blocks[line.row.blockIndex] as ContentBlock&{type:'text'}).style:'body'} fontSize={props.fontSize} preset={props.preset} fonts={props.fonts}/>:<View onPress={()=>{if(line.row.kind!=='text')props.onMedia(line.row.block);}} focusable class="absolute inset-0">
    {line.row.kind==='image'?<RemoteImage inline url={resolveUrl(line.row.block.url,props.baseUrl)??''} filePath={props.offlineMedia?.[line.row.block.url]} width={line.width} height={line.row.height} fit="contain" onSize={(width,height)=>props.onImageSize?.(line.row.blockIndex,width,height)}/>:<><Text class="absolute inset-0 text-center text-sm text-white">视频</Text><Image src="../assets/icons/play-circle.svg" class="absolute w-[24] h-[24]" style={{insetL:(line.width-24)/2,insetT:(line.row.height-24)/2}}/></>}
   </View>}
  </View>)}
  {props.page.loading!==undefined?<Text class="absolute text-xs text-center text-[#aaaaaa]" style={{insetL:(props.width-100)/2,insetT:props.height/2-7,width:100}}>正在排版…</Text>:null}
 </View>;
}
