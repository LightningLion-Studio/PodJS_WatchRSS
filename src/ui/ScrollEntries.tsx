import {mergeProps} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {debugGate} from '../debug/gate.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import {VariableList} from "@podjs/framework/variable-list";
import {routeActivity} from './route-activity.tsx';
import {routeMemory} from '../navigation/activity-navigation.ts';
export type {ScrollEntry,PositionedScrollEntry,IndexedScrollEntries} from "@podjs/framework/variable-list";
type Props=Omit<Parameters<typeof VariableList>[0],"restorationOwner"|"overscan"|"refreshDistance">;
export function ScrollEntries(props:Props) {
 const metrics=getDisplayMetrics();
 // These page lists fill a bottom-aligned viewport (including title/notice headers).
 // Document controllers own their text anchors and max offset; fixed QR/input
 // layouts own their geometry. Callers can opt out with round=null or supply
 // explicit viewport geometry for a differently positioned list.
 return traceServiceWork("navigation.ScrollEntries",()=>VariableList(mergeProps({padding:18,gap:6,overscan:80,refreshDistance:48,get round(){
  return metrics.shape==='round'&&!props.controller&&!props.fixed?{
   width:metrics.logicalWidth,height:metrics.logicalHeight,
   viewport:{x:metrics.safeInsets.left,y:metrics.logicalHeight-metrics.safeInsets.bottom-props.height,width:metrics.logicalWidth-metrics.safeInsets.left-metrics.safeInsets.right},
   development:debugGate.allowed
  }:null;
 }},props,{restorationOwner(){
  const activity=routeActivity();
  // Document controllers already own text/byte/document anchors.
  const ownsDocument=!!props.controller&&['reader','information','bili','douyin'].includes(activity?.entry.page??'');
  return activity&&!ownsDocument?{memory:routeMemory(activity.entry),checkpoints:activity.checkpoints,scrollSlots:activity.scrollSlots,changed:()=>activity.changed()}:undefined;
 }})));
}
