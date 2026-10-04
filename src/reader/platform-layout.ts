import type {TextLayoutOptions} from "@podjs/framework/services";
import {readerFontPixels,readerLinePixels} from "./font-assets.ts";
import type {ReaderFontResolver,ReaderFontOptions} from "./font-assets.ts";
import type {ContentBlock} from "./content.ts";
import {DEFAULT_READER_TEXT, resolvedReaderStyle, type ReaderPreset} from "./preset.ts";
import type {NativeBlockLayouts, ParagraphLine} from "./content-layout.ts";
export interface ParagraphRequest extends TextLayoutOptions {lineHeightPx:number;fontWeight:number;italic:boolean;letterSpacingEm:number;lineBreak:"simple"|"paragraph"|"balanced"}
export interface PlatformParagraphLine extends ParagraphLine {topPx?:number;bottomPx?:number;baselinePx?:number}
export interface ParagraphOperation {result:Promise<{lines:PlatformParagraphLine[]}>;cancel():void}
export interface ParagraphBatchOperation {result:Promise<{results:({lines:PlatformParagraphLine[]}|{error:string})[]}>;cancel():void}
export interface LayoutPublication {firstBlocks:number;batchBlocks:number}
type TextBlock=Extract<ContentBlock,{type:'text'}>;
function paragraphArgs(block:TextBlock,width:number,fontSize:number,pixelScale:number,preset:ReaderPreset|undefined,resolveFont:ReaderFontResolver|undefined,profile:"compose"|"preview"){
  const style=preset?(block.style==="body"?preset.body:resolvedReaderStyle(preset,block.style)):{...DEFAULT_READER_TEXT,fontSizeSp:fontSize*(block.style==="title"?1.55:block.style==="subtitle"?1.12:block.style==="code"?.9:1),fontWeight:block.style==="title"?700:400};
  const text=block.text.replace(/\r\n?/g,"\n");
  const args:ParagraphRequest={...resolveFont?.(style),text,widthPx:Math.max(1,Math.ceil(width*pixelScale)),fontSizePx:readerFontPixels(style,pixelScale),lineHeightPx:readerLinePixels(style,pixelScale),fontWeight:style.fontWeight,italic:style.italic,letterSpacingEm:style.letterSpacingEm,hyphenation:style.hyphenation==="AUTO"?"full":"none",justify:style.alignment==="JUSTIFY",align:style.alignment==="CENTER"||profile==="preview"&&block.style==="title"?"center":"left",textMotion:profile==="preview"?"subpixel":style.renderMode==="LINEAR_SMOOTH"?"animated":"static",colorArgb:style.colorArgb,underline:style.underline,strikethrough:style.strikethrough,...(profile==="preview"?{lineHeightMode:"spacing" as const,fallbackLineSpacing:false,lineBreak:style.lineBreakMode==="PARAGRAPH"?"balanced" as const:style.lineBreakMode==="SYSTEM"?"paragraph" as const:"simple" as const}:{lineBreak:style.lineBreakMode==="PARAGRAPH"?"paragraph" as const:"simple" as const})};
  return {text,args};
}
function readParagraphLines(text:string,args:ParagraphRequest,lines:PlatformParagraphLine[],pixelScale:number):readonly ParagraphLine[]{
  validateParagraphLines(text,lines);
  return lines.map((line,lineIndex)=>{
    if(line.topPx===undefined&&line.bottomPx===undefined&&line.baselinePx===undefined)return line;
    if(![line.topPx,line.bottomPx,line.baselinePx].every(Number.isFinite)||line.bottomPx!<=line.topPx!)throw new Error("Invalid paragraph line metrics");
    return {...line,paragraph:{...args,lineIndex},height:(line.bottomPx!-line.topPx!)/pixelScale,baseline:(line.baselinePx!-line.topPx!)/pixelScale};
  });
}
/** One request in flight per reader; cancellation also suppresses already queued replies. */
export function requestReaderLayout(blocks:readonly ContentBlock[],width:number,fontSize:number,pixelScale:number,preset:ReaderPreset|undefined,
  request:(args:ParagraphRequest)=>ParagraphOperation,update:(layouts:NativeBlockLayouts)=>void,onError:(error:unknown)=>void,resolveFont?:ReaderFontResolver,profile:"compose"|"preview"="compose",publication?:LayoutPublication) {
  let cancelled=false,current:ParagraphOperation|undefined;
  const layouts=new Map<ContentBlock,readonly ParagraphLine[]>();
  let lastPublished=0;
  const publish=()=>{if(!cancelled&&layouts.size>lastPublished){lastPublished=layouts.size;update(new Map(layouts));}};
  const done=(async()=>{
    for(const block of blocks) {
      if(cancelled)return;
      if(block.type!=="text")continue;
      try {
        const {text,args}=paragraphArgs(block,width,fontSize,pixelScale,preset,resolveFont,profile);
        current=request(args);
        const result=await current.result;
        if(cancelled)return;
        layouts.set(block,readParagraphLines(text,args,result.lines,pixelScale));
        if(publication&&layouts.size>=publication.firstBlocks&&(lastPublished===0||layouts.size-lastPublished>=publication.batchBlocks))publish();
      }catch(error){if(cancelled)return;onError(error);}
      current=undefined;
    }
    // Default readers keep one coherent document layout. Long note previews opt in
    // to small first-screen and larger later batches, bounding repeated reflows.
    publish();
  })();
  return {done,cancel(){cancelled=true;current?.cancel();}};
}
/** Long documents keep one host operation in flight, with bounded first-screen and later batches. */
export function requestReaderLayoutBatched(blocks:readonly ContentBlock[],width:number,fontSize:number,pixelScale:number,preset:ReaderPreset|undefined,
  requestBatch:(args:readonly ParagraphRequest[])=>ParagraphBatchOperation,update:(layouts:NativeBlockLayouts)=>void,onError:(error:unknown)=>void,
  resolveFont?:ReaderFontResolver,publication:LayoutPublication={firstBlocks:4,batchBlocks:16}){
  let cancelled=false,current:ParagraphBatchOperation|undefined;
  const layouts=new Map<ContentBlock,readonly ParagraphLine[]>(),texts=blocks.filter((block):block is TextBlock=>block.type==='text');
  const done=(async()=>{
    for(let offset=0;offset<texts.length;){
      if(cancelled)return;
      const target=Math.min(offset===0?publication.firstBlocks:publication.batchBlocks,32,texts.length-offset);
      let size=0,units=0;
      while(size<target){
        const length=texts[offset+size]!.text.replace(/\r\n?/g,'\n').length;
        if(size&&units+length>262144)break;
        units+=length;size++;
      }
      if(size<1)throw new Error('Invalid paragraph batch size');
      const batch=texts.slice(offset,offset+size).map(block=>({block,...paragraphArgs(block,width,fontSize,pixelScale,preset,resolveFont,'compose')}));
      try{
        current=requestBatch(batch.map(item=>item.args));
        const result=await current.result;
        if(cancelled)return;
        if(!Array.isArray(result.results)||result.results.length!==batch.length)throw new Error('Invalid paragraph batch result count');
        result.results.forEach((item,index)=>{
          if('error' in item){onError(new Error(item.error));return;}
          const entry=batch[index]!;
          try{layouts.set(entry.block,readParagraphLines(entry.text,entry.args,item.lines,pixelScale));}
          catch(error){onError(error);}
        });
        if(layouts.size)update(new Map(layouts));
      }catch(error){if(cancelled)return;onError(error);}
      current=undefined;offset+=size;
    }
  })();
  return {done,cancel(){cancelled=true;current?.cancel();}};
}
export function validateParagraphLines(text:string,lines:readonly ParagraphLine[]):void {
  if(!Array.isArray(lines)||!lines.length)throw new Error("Paragraph layout returned no lines");
  let cursor=0;
  for(let index=0;index<lines.length;index++) {
    const line=lines[index];
    if(!Number.isInteger(line.start)||!Number.isInteger(line.end)||!Number.isInteger(line.visibleEnd)||line.start!==cursor||line.end<line.start||line.end>text.length||line.visibleEnd<line.start||line.visibleEnd>line.end||(line.end===line.start&&index!==lines.length-1))throw new Error("Invalid paragraph source offsets");
    cursor=line.end;
  }
  if(cursor!==text.length)throw new Error("Paragraph layout omitted source text");
}
