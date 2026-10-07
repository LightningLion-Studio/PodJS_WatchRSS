import {prepareNotePreview,type NotePreviewBlock} from './preview.ts';
import {noteTextRows} from './presentation.ts';
import type {ContentBlock} from '../reader/content.ts';

/** Text presented by Compose's rich note view; fenced code leaves one blank line. */
export function* noteBodyLayoutSteps(markup:string,blocks:readonly NotePreviewBlock[],rows:(block:Extract<NotePreviewBlock,{kind:'rich'}>,index:number)=>ReturnType<typeof noteTextRows>=(block)=>noteTextRows(block.markup,block.html)):Generator<Extract<ContentBlock,{type:'text'}>,void> {
 const seen=new Set<string>();
 let hasCodeFence=false;
 for(let index=0;index<blocks.length;index++){
  const block=blocks[index]!;
  if(block.kind!=='rich')continue;
  for(const row of rows(block,index)){
   if(row.role==='code'){hasCodeFence=true;continue;}
   if((row.role!=='body'&&row.role!=='quote')||!row.text||seen.has(row.text))continue;
   seen.add(row.text);yield {type:'text',style:'body',text:row.text};
  }
 }
 if(hasCodeFence&&!seen.has(' '))yield {type:'text',style:'body',text:' '};
}

export function noteBodyLayoutBlocks(markup:string):Extract<ContentBlock,{type:'text'}>[]{return [...noteBodyLayoutSteps(markup,prepareNotePreview(markup))];}
