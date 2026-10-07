import {wrapAtlasText} from '@podjs/framework/text-wrap';
import {createKeyedMemo} from '@podjs/framework/keyed-memo';
import {For,Show,createSignal,onCleanup} from 'solid-js';
import {View,Text,type NodeMirror} from '@pocketjs/framework/components';
import {createGesture} from '@pocketjs/framework/gesture';
import {createScroller} from '@pocketjs/framework/kinetics';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {getOps} from '@pocketjs/framework/host';
import {layoutText} from '../reader/index.ts';
import {prepareNotePreview,noteBlockSourceOffsets,type NotePreviewBlock} from '../notes/preview.ts';
import type {NoteLineAnchor,NotePositionedAnchor} from '../notes/editor-anchor.ts';
import {noteImageSource,noteTableCellText,noteTableCellPresentation,noteTableCodeFragments,noteTextRows} from '../notes/presentation.ts';
import {RemoteImage} from './RemoteImage.tsx';
import type {ScrollEntry} from './ScrollEntries.tsx';
import {presetContentFont,readerColor} from '../reader/content-layout.ts';
import {readerFontPixels} from '../reader/font-assets.ts';
import {resolvedReaderStyle} from '../reader/preset.ts';
import type {ReaderPreset} from '../reader/preset.ts';
import type {NoteTextRow} from '../notes/presentation.ts';
import type {ParagraphLine} from '../reader/content-layout.ts';
import {SystemTextLine} from '@podjs/framework/text';
import {getDisplayMetrics,hasCapability} from '@podjs/framework/watch';
type NoteImage=Extract<NotePreviewBlock,{kind:'image'}>;
type NoteTable=Extract<NotePreviewBlock,{kind:'table'}>;
export interface NotePreviewEntry extends ScrollEntry {anchor?:NoteLineAnchor;positionedAnchors?:()=>readonly NotePositionedAnchor[]}
const fontSlot=(size:number)=>size===13?21:size===15?2:size===17?22:size===19?4:size===21?23:1;
interface NoteFont {fontSlot:number;scale:number;lineHeight:number;color:string;tracking:number}
function rowFont(row:NoteTextRow,preset?:ReaderPreset):NoteFont {
 if(!preset)return {fontSlot:fontSlot(row.size),scale:1,lineHeight:row.lineHeight,color:'#e5e5e5',tracking:0};
 const role=row.role==='code'?'code':'body';
 const base=presetContentFont(preset,role),factor=row.role==='heading'?row.size/14:1;
 return {fontSlot:base.fontSlot,scale:base.scale*factor,lineHeight:base.lineHeight*factor,color:base.color,tracking:base.tracking};
}
const wrap=(text:string,width:number,font:NoteFont)=>wrapAtlasText(text,{width,fontSlot:font.fontSlot,scale:font.scale,tracking:font.tracking,measure:s=>getOps().measureText(s,font.fontSlot)*font.scale+(font.tracking?Math.max(0,Array.from(s).length-1)*font.tracking:0)});
function NotePreviewImage(props:{block:NoteImage;width:number;height:number;onOpen?:(path:string)=>void;onDownload?:()=>void;onSize?:(path:string,width:number,height:number)=>void;textColor:string;preset?:ReaderPreset}){
 const [failed,setFailed]=createSignal(false),[loaded,setLoaded]=createSignal(false),source=()=>noteImageSource(props.block.path);
 const subtitle=props.preset?presetContentFont(props.preset,'subtitle'):{fontSlot:22,scale:1,lineHeight:23};
 const muted=`${props.textColor.slice(0,7)}c2`;
 const pixelScale=getDisplayMetrics().physicalWidth/getDisplayMetrics().logicalWidth;
 const fontSizePx=props.preset?readerFontPixels(resolvedReaderStyle(props.preset,'subtitle'),pixelScale):17*pixelScale;
 const colorArgb=parseInt(`c2${props.textColor.slice(1,7)}`,16);
 const line=(value:string,index:number)=>{
  const fallback=<Text class="absolute text-center" style={{width:props.width/subtitle.scale,height:subtitle.lineHeight/subtitle.scale,lineHeight:subtitle.lineHeight/subtitle.scale,fontSlot:subtitle.fontSlot,scale:subtitle.scale,originX:-.5,originY:-.5,textColor:muted}}>{value}</Text>;
  return <View class="absolute left-[0] right-[0]" style={{insetT:(failed()?85:112)+index*subtitle.lineHeight+(index>0?0.5:0),height:subtitle.lineHeight}}>{hasCapability('text.raster')?<SystemTextLine pixelScale={pixelScale} options={{text:value,widthPx:Math.ceil(props.width*pixelScale),heightPx:Math.ceil(subtitle.lineHeight*pixelScale),baselinePx:Math.ceil(subtitle.lineHeight*.8*pixelScale),fontSizePx,colorArgb,align:'center',textMotion:'static'}} fallback={fallback}/>:fallback}</View>;
 };
 return <View class="absolute inset-0"><View onPress={()=>props.onOpen?.(props.block.path)} focusable class="absolute left-[0] right-[0] top-[0] items-center justify-center" style={{height:props.height}}><RemoteImage {...source()} width={props.width} height={props.height} fit="contain" onSize={(width,height)=>{setLoaded(true);props.onSize?.(props.block.path,width,height);}} onError={()=>setFailed(true)}/><Show when={!loaded()}>{(failed()?['图片未同步','请在手机端重新同步']:['加载中…']).map(line)}</Show></View><Show when={failed()&&props.onDownload}><View onPress={props.onDownload} focusable accessibilityRole="button" accessibilityLabel="下载手机端app以在手机上编辑和同步内容" class="absolute left-[0] right-[0] h-[46] items-center justify-center" style={{insetT:136.5}}><Text class="text-xs text-center leading-[14]" style={{textColor:'#b6b6b6'}}>{'下载手机端app以在手机上编辑和同步\n内容'}</Text><View class="absolute" style={{insetL:3,insetT:22,width:props.width-6,height:.5,bgColor:'#b6b6b6'}}/><View class="absolute" style={{insetL:(props.width-24)/2,insetT:36,width:24,height:.5,bgColor:'#b6b6b6'}}/></View></Show><Show when={props.block.description}><Text class="absolute left-[0] right-[0] text-xs" style={{insetT:props.height+4,textColor:props.textColor}}>{props.block.description}</Text></Show></View>;
}
function tableRows(block:NoteTable,font:NoteFont,headerFont:NoteFont){return block.rows.map((row,index)=>row.map(value=>wrap(noteTableCellText(value),112,index<block.headerRows?headerFont:font)));}
function tableHeights(rows:string[][][],lineHeight:number,headerRows:number){return rows.map((row,index)=>Math.max(1,...row.map(cell=>cell.length))*lineHeight+(index<headerRows?13:14));}
function noteSizeClass(size:number){return size===13?'absolute text-[13px]':size===15?'absolute text-base':size===17?'absolute text-[17px]':size===19?'absolute text-xl':size===21?'absolute text-[21px]':'absolute text-sm';}
function tableWidth(text:string,font:NoteFont){return getOps().measureText(text,font.fontSlot)*font.scale+Math.max(0,Array.from(text).length-1)*font.tracking;}
function NotePreviewTableCell(props:{source:string;lines:string[];column:number;top:number;height:number;header:boolean;alignment:'Start'|'Center'|'End';font:NoteFont;textColor:string;headerColor:string;cellBorder:string;codeColor:string;codeBackground:string}){
 const presentation=noteTableCellPresentation(props.source),fragments=noteTableCodeFragments(props.lines,presentation.codes);
 const aligned=props.alignment==='Center'?'absolute left-[8] top-[7] text-center':props.alignment==='End'?'absolute left-[8] top-[7] text-right':'absolute left-[8] top-[7]';
 return <View class="absolute" style={{insetL:props.column*128,insetT:props.top,width:128,height:props.height,borderWidth:0.5,borderColor:props.cellBorder,...(props.header?{bgColor:props.headerColor}:{})}}>
  <Text class={aligned} style={{width:112/props.font.scale,height:(props.height-13)/props.font.scale,lineHeight:props.font.lineHeight/props.font.scale,fontSlot:props.font.fontSlot,scale:props.font.scale,originX:-.5,originY:-.5,textColor:props.textColor}}>{props.lines.join('\n')}</Text>
  {fragments.map(fragment=>{
   const line=props.lines[fragment.line]??'',lineWidth=tableWidth(line,props.font);
   const alignment=props.alignment==='Center'?(112-lineWidth)/2:props.alignment==='End'?112-lineWidth:0;
   const x=8+alignment+tableWidth(line.slice(0,fragment.start),props.font),width=Math.max(1,tableWidth(fragment.text,props.font));
   return <View class="absolute" style={{insetL:x,insetT:7+fragment.line*props.font.lineHeight,width,height:props.font.lineHeight}}>
    <View class="absolute left-[0]" style={{insetT:.5,width,height:props.font.lineHeight-.5,bgColor:props.codeBackground}}/>
    <Text class="absolute left-[0] top-[0]" style={{width:width/props.font.scale,height:props.font.lineHeight/props.font.scale,lineHeight:props.font.lineHeight/props.font.scale,fontSlot:props.font.fontSlot,scale:props.font.scale,originX:-.5,originY:-.5,textColor:props.codeColor}}>{fragment.text}</Text>
   </View>;
  })}
 </View>;
}
function NotePreviewTable(props:{block:NoteTable;width:number;height:number;rows:string[][][];heights:number[];font:NoteFont;headerFont:NoteFont;textColor:string;codeColor:string;codeBackground:string;registerOffset?:(read:()=>number)=>void}){
 let node:NodeMirror|undefined;const rows=props.rows,heights=props.heights,columns=Math.max(...props.block.rows.map(r=>r.length)),scroller=createScroller({max:()=>Math.max(0,columns*128-props.width)});let top=0;const offsets=heights.map(h=>{const p=top;top+=h;return p;});
 props.registerOffset?.(()=>scroller.offset());
 createGesture({region:{node:()=>node},axis:'x',onDown:()=>scroller.stop(),onPanStart:()=>scroller.beginDrag(),onPanMove:c=>scroller.drag(-c.fdx),onPanEnd:c=>scroller.endDrag(-c.vx),onCancel:()=>{if(scroller.state()==='tracking')scroller.endDrag(0);}});onFrame(()=>scroller.step());onCleanup(()=>scroller.stop());
 const body=props.textColor.slice(0,7),outerBorder=`${body}3d`,cellBorder=`${body}33`,headerColor=`${body}1a`;
 return <View ref={n=>node=n} class="absolute inset-0 overflow-hidden rounded-[12]" style={{borderWidth:1,borderColor:outerBorder}}><View class="absolute left-[0] top-[0]" style={{width:columns*128,height:props.height,translateX:-scroller.offset()}}><For each={rows}>{(row,index)=><For each={row}>{(lines,column)=><NotePreviewTableCell source={props.block.rows[index()]?.[column()]??''} lines={lines} column={column()} top={offsets[index()]!} height={heights[index()]!} header={index()<props.block.headerRows} alignment={props.block.alignments[column()]??'Start'} font={index()<props.block.headerRows?props.headerFont:props.font} textColor={props.textColor} headerColor={headerColor} cellBorder={cellBorder} codeColor={props.codeColor} codeBackground={props.codeBackground}/>}</For>}</For></View></View>;
}
export function* notePreviewEntrySteps(markup:string,width:number,onImage?:(path:string)=>void,preset?:ReaderPreset,nativeBody?:ReadonlyMap<string,readonly ParagraphLine[]>,onDownload?:()=>void,imageHeights?:ReadonlyMap<string,number>,onImageSize?:(path:string,width:number,height:number)=>void,cache?:ReturnType<typeof createKeyedMemo<string>>,preparedPrefix?:{blocks:NotePreviewBlock[];offsets:(number|null)[]}):Generator<NotePreviewEntry,void> {
 const bodyColor=preset?readerColor(preset.body.colorArgb):'#e5e5e5';
 const codeColor=preset?presetContentFont(preset,'code').color:'#e5e5e5';
 const codeBackground=preset?readerColor(preset.codeBackgroundColorArgb):'#202427';
 const tableFont=rowFont({text:'',role:'body',size:14,lineHeight:20,sourceMarkup:'',sourceStart:0,mappingText:'',mappingStart:0},preset);
 const tableHeaderFont=preset?{...tableFont,...presetContentFont({...preset,body:{...preset.body,fontWeight:600}},'body')}:tableFont;
 const prepared=preparedPrefix??(cache?cache.get('parse',[markup],()=>{const blocks=prepareNotePreview(markup);return {blocks,offsets:noteBlockSourceOffsets(markup,blocks)};}):(()=>{const blocks=prepareNotePreview(markup);return {blocks,offsets:noteBlockSourceOffsets(markup,blocks)};})());
 const {blocks,offsets}=prepared;let emitted=0;
 const spacer=(height:number):NotePreviewEntry=>({height,render:()=>null});
 for(let blockIndex=0;blockIndex<blocks.length;blockIndex++){
  const block=blocks[blockIndex]!,blockStart=offsets[blockIndex]??null;
  const textRows=block.kind==='rich'?(cache?cache.get('text:'+blockIndex,[block],()=>noteTextRows(block.markup,block.html)):noteTextRows(block.markup,block.html)):[];
  const dependencies=[block,width,preset,onImage,onDownload,onImageSize,block.kind==='image'?imageHeights?.get(block.path):undefined,...textRows.map(row=>nativeBody?.get(row.text)),textRows.some(row=>row.role==='code')?nativeBody?.get(' '):undefined];
  const cached=cache?.peek<NotePreviewEntry[]>('block:'+blockIndex,dependencies);
  if(cached){for(const entry of cached){emitted++;yield entry;}continue;}
  const entries:NotePreviewEntry[]=[];
  (()=>{
  if(blockIndex)entries.push(spacer(10));
  entries.push(spacer(5));
  if(block.kind==='image'){const height=imageHeights?.get(block.path)??260;entries.push({key:cache?.get('image-key:'+blockIndex,[block,width,preset],()=>({})),data:height,height:height+(block.description?34:4),render:current=> <NotePreviewImage block={block} width={width} height={current?Number(current().data):height} onOpen={onImage} onDownload={onDownload} onSize={onImageSize} textColor={bodyColor} preset={preset}/>});entries.push(spacer(5));return;}
  if(block.kind==='table'){
   const rows=tableRows(block,tableFont,tableHeaderFont),heights=tableHeights(rows,tableFont.lineHeight,block.headerRows),height=heights.reduce((a,b)=>a+b,0);
   let readHorizontalOffset=()=>0;
   const positionedAnchors=():NotePositionedAnchor[]=>{
    const result:NotePositionedAnchor[]=[];let rowTop=0;
    rows.forEach((row,rowIndex)=>{
     row.forEach((lines,column)=>lines.forEach((line,lineIndex)=>{
      const sourceMarkup=block.rows[rowIndex]?.[column]??'',mappingText=noteTableCellText(sourceMarkup),font=rowIndex<block.headerRows?tableHeaderFont:tableFont;
      const consumed=lines.slice(0,lineIndex).join('').length,found=mappingText.indexOf(line,consumed);
      result.push({
      anchor:{renderedText:line,mappingText,renderedStart:found>=0?found:consumed,sourceMarkup,sourceStart:null,fontSlot:font.fontSlot,scale:font.scale,tracking:font.tracking,inset:0},
      x:column*128+8-readHorizontalOffset(),y:rowTop+7+lineIndex*tableFont.lineHeight,width:112,height:tableFont.lineHeight
     });}));
     rowTop+=heights[rowIndex]!;
    });
    return result;
   };
   entries.push({height,positionedAnchors,render:()=> <NotePreviewTable block={block} width={width} height={height} rows={rows} heights={heights} font={tableFont} headerFont={tableHeaderFont} textColor={bodyColor} codeColor={codeColor} codeBackground={codeBackground} registerOffset={read=>{readHorizontalOffset=read;}}/>});
   entries.push(spacer(5));
   return;
  }
  let inCodeFence=false;
  for(const row of textRows){
   if(row.role==='code'){
    if(!inCodeFence)entries.push(spacer(nativeBody?.get(' ')?.[0]?.height??rowFont(row,preset).lineHeight));
    inCodeFence=true;continue;
   }
   inCodeFence=false;
   const inset=0,font=rowFont(row,preset),native=row.role==='body'||row.role==='quote'?nativeBody?.get(row.text):undefined;
   const fallback=native?.length?[]:wrap(row.text,width-inset*2,font);
   let cursor=0;
   const visualLines=native?.length?native.map(line=>({text:row.text.slice(line.start,line.visibleEnd),start:line.start,height:line.height??font.lineHeight,baseline:line.baseline,paragraph:line.paragraph})):fallback.length?fallback.map(text=>{const start=cursor;cursor+=text.length;return {text,start,height:font.lineHeight,baseline:undefined,paragraph:undefined};}):[{text:'',start:0,height:font.lineHeight,baseline:undefined,paragraph:undefined}];
   for(const visual of visualLines){
    const line=visual.text,lineHeight=visual.height,pixelScale=getDisplayMetrics().physicalWidth/getDisplayMetrics().logicalWidth;
    entries.push({height:lineHeight,anchor:{renderedText:line,mappingText:row.mappingText,renderedStart:row.mappingStart+visual.start,sourceMarkup:row.sourceMarkup,sourceStart:blockStart===null?null:blockStart+row.sourceStart,fontSlot:font.fontSlot,scale:font.scale,tracking:font.tracking,inset},render:()=> {
     const atlas=<Text class={noteSizeClass(row.size)} style={{insetL:inset,width:(width-inset*2)/font.scale,height:lineHeight/font.scale,lineHeight:lineHeight/font.scale,fontSlot:font.fontSlot,scale:font.scale,originX:-.5,originY:-.5,textColor:bodyColor}}>{line||' '}</Text>;
     return <View class="absolute inset-0">{visual.paragraph&&hasCapability('text.raster')?<SystemTextLine pixelScale={pixelScale} options={{...visual.paragraph,text:line,widthPx:Math.ceil((width-inset*2)*pixelScale),heightPx:Math.ceil(lineHeight*pixelScale),baselinePx:Math.ceil((visual.baseline??lineHeight*.8)*pixelScale),paragraph:visual.paragraph}} fallback={atlas}/>:atlas}</View>;
    }});
   }
  }
  entries.push(spacer(5));
  })();
  cache?.get('block:'+blockIndex,dependencies,()=>entries);
  for(const entry of entries){emitted++;yield entry;}
 }
 if(!emitted)yield {height:32,render:()=> <Text class="text-sm" style={{textColor:bodyColor}}>这条备忘录还没有正文。</Text>};
}

/** Compatibility synchronous collector; screen jobs consume the sliced iterator. */
export function notePreviewEntries(...args:Parameters<typeof notePreviewEntrySteps>):NotePreviewEntry[]{return [...notePreviewEntrySteps(...args)];}
