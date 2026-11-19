import type {SystemTextLineOptions} from '@podjs/framework/text';
import type {BookPage} from './pagination.ts';
import type {ContentBlock} from './content.ts';
import type {ReaderPreset} from './preset.ts';
import type {ReaderFontResolver} from './font-assets.ts';
import type {ReaderTextEnvironment} from '../ui/ReaderTextRow.tsx';
import {readerTextLineOptions,requiresReaderSystemText} from './system-text.ts';

/** Only one already laid-out page in the direction of travel. */
export function adjacentPageTextOptions(pages:readonly BookPage[],index:number,blocks:readonly ContentBlock[],fontSize:number,preset:ReaderPreset|undefined,fonts:ReaderFontResolver,environment:ReaderTextEnvironment,direction:1|-1=1):SystemTextLineOptions[] {
 const page=pages[index+direction];
 if(!environment.rasterSupported||!page||page.loading!==undefined)return [];
 const result:SystemTextLineOptions[]=[];
 for(const line of page.lines){
  const row=line.row;if(row.kind!=='text')continue;
  const block=blocks[row.blockIndex],style=block?.type==='text'?block.style:'body';
  if(requiresReaderSystemText(row.text,preset,style))result.push(readerTextLineOptions(row,style,fontSize,line.width,environment.pixelScale,preset,environment.fontMetrics(row.fontSlot),fonts,undefined,0,environment.revision));
 }
 return result;
}
