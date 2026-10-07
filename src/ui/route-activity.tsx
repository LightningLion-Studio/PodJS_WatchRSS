import {createComponent,mergeProps,type JSX} from 'solid-js';
import {RouteStateProvider,routeState,stringState as isString,type RouteStateOwner} from '@podjs/framework/navigation';
import {routeMemory,type ActivityRoute} from '../navigation/activity-navigation.ts';
export {restoredSignal,booleanState,finiteState} from '@podjs/framework/navigation';
interface RouteActivity {entry:ActivityRoute;changed:()=>void;checkpoints:Set<()=>void>;scrollSlots:Set<number>}
export function RouteActivityProvider(props:RouteActivity&{children:JSX.Element}){
 return createComponent(RouteStateProvider,mergeProps(props,{memory:()=>routeMemory(props.entry)}));
}
export function routeActivity(){return routeState() as (RouteStateOwner&RouteActivity)|undefined;}

export const stringState=(v:unknown):v is string=>isString(v)&&v.length<=8192;
