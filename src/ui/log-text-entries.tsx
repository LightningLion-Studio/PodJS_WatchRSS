import {Text,View} from '@pocketjs/framework/components';
import {layoutAtlasText} from '@podjs/framework/atlas-text';
import {chunkLines} from './round-rows.tsx';
import type {ScrollEntry} from './ScrollEntries.tsx';

/** Keep each part of a long status message reachable as the list scrolls. */
export function logTextEntries(text:string,rowWidth:number,minHeight:number):ScrollEntry[] {
  const width=rowWidth-16, lineHeight=22;
  const {lines,style}=layoutAtlasText(text,{width,fontSlot:2,lineHeight});
  return chunkLines(lines,lineHeight,width).map(chunk=>{
    const textHeight=chunk.length*lineHeight;
    const height=Math.max(minHeight,textHeight);
    const top=(height-textHeight)/2;
    return {
      height,
      visibleBounds:{x:8,y:top,width,height:textHeight},
      render:()=> <View class="absolute inset-0">
        <Text class="absolute left-[8] overflow-hidden text-base leading-[22] text-center text-[#f5f5f5]"
          style={{...style,insetT:top,height:textHeight}}>{chunk.join('\n')}</Text>
      </View>,
    };
  });
}
