import {createEffect,createMemo,createSignal,onCleanup,Show} from 'solid-js';
import {Image,Text,View} from '@pocketjs/framework/components';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {delay} from '@podjs/framework/services';

export type VideoLoadingPhase='fetching'|'reconnecting'|'preparing'|'buffering';
/** Geometry is specified on a 466 canvas; the runtime uses logical units. */
export function PlayerLoadingIndicator(props:{visible:boolean;phase:VideoLoadingPhase;width:number;height:number}){
  const [angle,setAngle]=createSignal(0),[slow,setSlow]=createSignal(false);
  const visibleState=createMemo(()=>props.visible),phaseState=createMemo(()=>props.phase);
  createEffect(()=>{
    const visible=visibleState(),phase=phaseState();setSlow(false);
    if(!visible)return;
    let live=true;
    const started=Date.now();
    onFrame(()=>setAngle(((Date.now()-started)%900)/900*360));
    const timer=(phase==='buffering'||phase==='preparing')?delay(3000):undefined;
    void timer?.result.then(()=>{if(live)setSlow(true);}).catch(()=>{});
    onCleanup(()=>{live=false;timer?.cancel();});
  });
  const scale=()=>Math.min(props.width,props.height)/466;
  const label=()=>props.phase==='fetching'?'正在获取视频':props.phase==='reconnecting'?'正在重新连接':slow()?'网络较慢':'';
  return <Show when={props.visible}><View class="absolute" style={{insetL:props.width/2-110*scale(),insetT:props.height/2-22*scale(),width:220*scale(),height:94*scale()}}>
    <Image src="../assets/icons/video-loading-ring.svg" class="absolute" style={{insetL:88*scale(),insetT:0,width:44*scale(),height:44*scale()}}/>
    <Image src="../assets/icons/video-loading-arc.svg" class="absolute" style={{insetL:88*scale(),insetT:0,width:44*scale(),height:44*scale(),rotate:angle()}}/>
    <Show when={label()}><Text class="absolute text-xs text-white text-center" style={{insetL:0,insetT:58*scale(),width:220*scale(),lineHeight:28*scale()}}>{label()}</Text></Show>
  </View></Show>;
}
