import {mergeProps} from 'solid-js';
import {traceServiceWork} from "@podjs/framework/service-trace";
import {VariableList} from "@podjs/framework/variable-list";
import {routeActivity} from './route-activity.tsx';
import {routeMemory} from '../navigation/activity-navigation.ts';
export type {ScrollEntry,PositionedScrollEntry,IndexedScrollEntries} from "@podjs/framework/variable-list";
type Props=Omit<Parameters<typeof VariableList>[0],"restorationOwner"|"overscan"|"refreshDistance">;
export function ScrollEntries(props:Props) {
 return traceServiceWork("navigation.ScrollEntries",()=>VariableList(mergeProps({padding:18,gap:6,overscan:80,refreshDistance:48},props,{restorationOwner(){
  const activity=routeActivity();
  // Document controllers already own text/byte/document anchors.
  const ownsDocument=!!props.controller&&['reader','information','bili','douyin'].includes(activity?.entry.page??'');
  return activity&&!ownsDocument?{memory:routeMemory(activity.entry),checkpoints:activity.checkpoints,scrollSlots:activity.scrollSlots,changed:()=>activity.changed()}:undefined;
 }})));
}
