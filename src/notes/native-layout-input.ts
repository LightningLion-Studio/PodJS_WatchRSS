import {prepareNotePreview,type NotePreviewBlock} from './preview.ts';
import {noteTextRows} from './presentation.ts';
import type {ContentBlock} from '../reader/content.ts';

/** Body/quote input for native layout; code uses its own font in NotePreview. */
export function* noteBodyLayoutSteps(markup:string,blocks:readonly NotePreviewBlock[],rows:(block:Extract<NotePreviewBlock,{kind:'rich'}>,index:number)=>ReturnType<typeof noteTextRows>=(block)=>noteTextRows(block.markup,block.html,block.htmlContext)):Generator<Extract<ContentBlock,{type:'text'}>,void> {
 const seen=new Set<string>();
 for(let index=0;index<blocks.length;index++){
  const block=blocks[index]!;
  if(block.kind!=='rich')continue;
  for(const row of rows(block,index)){
   if((row.role!=='body'&&row.role!=='quote')||!row.text||seen.has(row.text))continue;
   seen.add(row.text);yield {type:'text',style:'body',text:row.text};
  }
 }
}

export function noteBodyLayoutBlocks(markup:string):Extract<ContentBlock,{type:'text'}>[]{return [...noteBodyLayoutSteps(markup,prepareNotePreview(markup))];}
