import {prepareNotePreview} from './preview.ts';
import {noteTextRows} from './presentation.ts';
import type {ContentBlock} from '../reader/content.ts';

/** Text presented by Compose's rich note view; fenced code leaves one blank line. */
export function noteBodyLayoutBlocks(markup:string):Extract<ContentBlock,{type:'text'}>[] {
 const result:Extract<ContentBlock,{type:'text'}>[]=[],seen=new Set<string>();
 let hasCodeFence=false;
 for(const block of prepareNotePreview(markup)){
  if(block.kind!=='rich')continue;
  for(const row of noteTextRows(block.markup,block.html)){
   if(row.role==='code'){hasCodeFence=true;continue;}
   if((row.role!=='body'&&row.role!=='quote')||!row.text||seen.has(row.text))continue;
   seen.add(row.text);result.push({type:'text',style:'body',text:row.text});
  }
 }
 if(hasCodeFence&&!seen.has(' '))result.push({type:'text',style:'body',text:' '});
 return result;
}
