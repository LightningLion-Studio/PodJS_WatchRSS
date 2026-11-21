import {getDisplayMetrics} from '@podjs/framework/watch';
import {roundRowRange} from '@podjs/framework/round-list';
import type {QrRect} from '@podjs/framework/round-layout';
import type {PositionedScrollEntry,ScrollEntry} from './ScrollEntries.tsx';

/** Keep a complete line visible while scrolling past the round edge. */
export function scrollTextVisibility(bounds:QrRect, viewportHeight:number, offset:()=>number, padding:number) {
  const metrics=getDisplayMetrics();
  if(metrics.shape!=='round')return ()=>true;
  const {logicalWidth:width,logicalHeight:height,safeInsets}=metrics;
  const viewport={x:safeInsets.left,y:height-safeInsets.bottom-viewportHeight,width:width-safeInsets.left-safeInsets.right};
  const range=roundRowRange({height:bounds.height,visibleBounds:bounds},{width,height,viewport},viewportHeight,padding);
  return (row?:()=>ScrollEntry)=> {
    const top=(row?.() as PositionedScrollEntry|undefined)?.top;
    return top===undefined||!!range&&top-offset()>=range.min&&top-offset()<=range.max;
  };
}
