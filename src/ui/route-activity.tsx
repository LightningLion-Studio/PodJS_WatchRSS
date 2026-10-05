import {createContext,useContext,createSignal,type JSX,type Signal} from 'solid-js';
import {routeMemory,type ActivityRoute} from '../navigation/activity-navigation.ts';

interface RouteActivity {entry:ActivityRoute;changed:()=>void;checkpoints:Set<()=>void>;scrollSlots:Set<number>}
const Context=createContext<RouteActivity>();
export function RouteActivityProvider(props:RouteActivity&{children:JSX.Element}){return <Context.Provider value={props}>{props.children}</Context.Provider>;}
export function routeActivity(){return useContext(Context);}
/** Only serializable state is recorded. Every reader validates its own schema;
 * stale or malformed fields default independently instead of crashing startup. */
export function restoredSignal<T>(channel:'saved'|'retained',key:string,initial:T,valid:(value:unknown)=>value is T,enabled=true):Signal<T>{
 const context=enabled?routeActivity():undefined,memory=context?routeMemory(context.entry):undefined;
 const restored=memory?.[channel][key];
 const [read,write]=createSignal<T>(valid(restored)?restored:initial);
 const setter:Signal<T>[1]=((value:unknown)=>{
  const result=write(value as never);
  if(memory){memory[channel][key]=result;context!.changed();}
  return result;
 }) as Signal<T>[1];
 return [read,setter];
}
export const booleanState=(v:unknown):v is boolean=>typeof v==='boolean';
export const stringState=(v:unknown):v is string=>typeof v==='string'&&v.length<=8192;
export const finiteState=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
