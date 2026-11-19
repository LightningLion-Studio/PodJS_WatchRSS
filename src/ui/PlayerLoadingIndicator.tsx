import {createEffect,createMemo,createSignal,onCleanup,Show} from 'solid-js';
import {Image,Text,View} from '@pocketjs/framework/components';
import {delay} from '@podjs/framework/services';

export type VideoLoadingPhase='fetching'|'reconnecting'|'preparing'|'buffering';
/** Clip the padded sprite at a fixed position so rotating its UVs does not snap the circle's edges. */
export function PlayerSpinner(props:{src:string;left:number;top:number;size:number}){
  return <View class="absolute overflow-hidden" style={{insetL:props.left,insetT:props.top,width:props.size,height:props.size}}>
    <Image src={props.src} class="absolute animate-spin" style={{insetL:-props.size/2,insetT:-props.size/2,width:props.size*2,height:props.size*2}}/>
  </View>;
}

/** Geometry is specified on a 466 canvas; the runtime uses logical units. */
export function PlayerLoadingIndicator(props:{visible:boolean;phase:VideoLoadingPhase;width:number;height:number}){
  const [slow,setSlow]=createSignal(false);
  const visibleState=createMemo(()=>props.visible),phaseState=createMemo(()=>props.phase);
  createEffect(()=>{
    const visible=visibleState(),phase=phaseState();setSlow(false);
    if(!visible)return;
    let live=true;
    const timer=(phase==='buffering'||phase==='preparing')?delay(3000):undefined;
    void timer?.result.then(()=>{if(live)setSlow(true);}).catch(()=>{});
    onCleanup(()=>{live=false;timer?.cancel();});
  });
  const scale=()=>Math.min(props.width,props.height)/466;
  const label=()=>props.phase==='fetching'?'正在获取视频':props.phase==='reconnecting'?'正在重新连接':slow()?'网络较慢':'';
  return <Show when={props.visible}><View class="absolute" style={{insetL:props.width/2-110*scale(),insetT:props.height/2-22*scale(),width:220*scale(),height:94*scale()}}>
    <Image src="../assets/icons/video-loading-ring.svg" class="absolute" style={{insetL:88*scale(),insetT:0,width:44*scale(),height:44*scale()}}/>
    <PlayerSpinner src="../assets/icons/video-loading-arc.svg" left={88*scale()} top={0} size={44*scale()}/>
    <Show when={label()}><Text class="absolute text-xs text-white text-center" style={{insetL:0,insetT:58*scale(),width:220*scale(),lineHeight:28*scale()}}>{label()}</Text></Show>
  </View></Show>;
}
