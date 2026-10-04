import {For,createEffect,onCleanup} from "solid-js";
import {View,Image,type NodeMirror} from "@pocketjs/framework/components";
import {getOps} from "@pocketjs/framework/host";
import {getDisplayMetrics} from "@podjs/framework/watch";
import type {UsageGroup,UsageDay} from "../llm/usage.ts";
export const USAGE_COLORS=["#ff6026","#ed4735","#333333","#ef5350","#66bb6a","#ffca28"];
export function UsageTrend(props:{daily:UsageDay[];width:number}){
 const points=()=>{const max=Math.max(1,...props.daily.map(d=>d.total));return props.daily.map((d,i)=>({x:8+i*(props.width-16)/Math.max(1,props.daily.length-1),y:60-d.total/max*51.2}));};
 return <View class="relative h-[64]" style={{width:props.width}}><For each={points().slice(1)}>{(point,index)=>{const a=()=>points()[index()],length=()=>Math.hypot(point.x-a().x,point.y-a().y);return <View class="absolute h-[2] rounded-[1] bg-[#ff6026]" style={{insetL:(point.x+a().x-length())/2,insetT:(point.y+a().y)/2-1,width:length(),rotate:Math.atan2(point.y-a().y,point.x-a().x)*180/Math.PI}}/>;}}</For><For each={points()}>{p=><View class="absolute w-[4] h-[4] rounded-full bg-[#ff6026]" style={{insetL:p.x-2,insetT:p.y-2}}/>}</For></View>;
}
export function UsageBars(props:{daily:UsageDay[];width:number}){
 const max=()=>Math.max(1,...props.daily.map(d=>d.prompt+d.completion)),group=()=>(props.width-16)/Math.max(1,props.daily.length);
 return <View class="relative h-[64]" style={{width:props.width}}><For each={props.daily}>{(d,index)=><><View class="absolute bg-[#ff6026]" style={{insetL:8+(index()+.15)*group(),insetT:52-d.prompt/max()*52,width:group()*.35,height:d.prompt/max()*52}}/><View class="absolute bg-[#333333]" style={{insetL:8+(index()+.55)*group(),insetT:52-d.completion/max()*52,width:group()*.35,height:d.completion/max()*52}}/></>}</For></View>;
}
/** Small density-matched analytic ring, with antialiased edges and no external assets. */
export function UsageDonut(props:{providers:UsageGroup[]}){
 let node:NodeMirror|undefined,handle=-1;
 createEffect(()=>{const providers=props.providers,density=getDisplayMetrics().density,size=Math.ceil(64*density),bytes=new Uint8Array(size*size*4),total=Math.max(1,providers.reduce((s,p)=>s+p.total,0));let sum=0;const stops=providers.map((p,i)=>{sum+=p.total/total;return {end:sum,rgb:USAGE_COLORS[i%6].slice(1).match(/../g)!.map(x=>parseInt(x,16))};});
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const dx=(x+.5)/density-32,dy=(y+.5)/density-32,r=Math.hypot(dx,dy),angle=(Math.atan2(dy,dx)/(Math.PI*2)+1.25)%1,color=stops.find(s=>angle<s.end)?.rgb;if(!color)continue;const coverage=Math.max(0,Math.min(1,(32-r)*density+.5,(r-17.6)*density+.5)),offset=(y*size+x)*4;bytes[offset]=color[0];bytes[offset+1]=color[1];bytes[offset+2]=color[2];bytes[offset+3]=Math.round(255*coverage);}
  const next=getOps().uploadTexture(bytes,size,size,3);if(node)getOps().setImage(node.id,next);if(handle>=0)getOps().freeTexture?.(handle);handle=next;
 });
 onCleanup(()=>{if(handle>=0)getOps().freeTexture?.(handle);});return <Image ref={n=>{node=n;if(handle>=0)getOps().setImage(n.id,handle);}} class="w-[64] h-[64]"/>;
}
