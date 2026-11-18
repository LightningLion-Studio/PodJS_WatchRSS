import {mediaSourceExpiry} from '@podjs/framework/media-policy';

export interface ReloadSource { platform?:string; awemeId?:string; webUrl?:string; title:string; url?:string; videoUrl?:string; audioUrl?:string; expiresAtMs?:number }
export function reloadSourceKey(source:ReloadSource):string {
  return JSON.stringify([source.platform,source.awemeId??source.webUrl??source.title]);
}
/** Only explicit source expiry fields count. Do not invent a sliding TTL at resume. */
export function videoSourceExpired(source:ReloadSource,now=Date.now()):boolean {
  if(source.expiresAtMs!==undefined&&source.expiresAtMs<=now)return true;
  return mediaSourceExpiry([source.url??source.videoUrl??'',source.audioUrl??''].map(url=>url.replace(/([?&])x-expires=/ig,'$1expires=')),now) <= now;
}
export interface ReloadTicket { revision:number; waitMs:number }
export interface BufferedStallState {positionMs:number;bufferedMs?:number;nativePlaybackState?:number;playWhenReady?:boolean;loading?:boolean;hasRenderedFirstFrame?:boolean;hasCachedFirstFrame?:boolean;sourceGeneration?:number}
export interface BufferedStallTicket {revision:number;generation:number;sourceGeneration?:number;positionMs:number;bufferedMs:number}
/** A decoded picture is not proof of a running Media3 clock. Only a buffered,
 * nonloading foreground player can enter this narrowly bounded recovery. */
export class VideoBufferedStallWait {
  private revision=0;
  private ticket?:BufferedStallTicket;
  private timer?:{cancel():void};
  private eligible(value:BufferedStallState|undefined,enabled:boolean):value is BufferedStallState {
    return !!value&&enabled&&value.playWhenReady===true&&value.nativePlaybackState===2&&value.loading===false&&
      (value.hasRenderedFirstFrame===true||value.hasCachedFirstFrame===true)&&(value.bufferedMs??0)>=1000;
  }
  cancel(){this.revision++;this.timer?.cancel();this.timer=undefined;this.ticket=undefined;}
  observe(value:BufferedStallState|undefined,generation:number,enabled:boolean,timer:(ms:number)=>{result:Promise<unknown>;cancel():void},expire:(ticket:BufferedStallTicket)=>void){
    if(!this.eligible(value,enabled)){this.cancel();return;}
    const previous=this.ticket;
    if(previous&&previous.generation===generation&&previous.sourceGeneration===value.sourceGeneration&&value.positionMs<=previous.positionMs&&(value.bufferedMs??0)<=previous.bufferedMs)return;
    this.cancel();const ticket:BufferedStallTicket={revision:this.revision,generation,sourceGeneration:value.sourceGeneration,positionMs:value.positionMs,bufferedMs:value.bufferedMs??0};
    this.ticket=ticket;const operation=timer(20_000);this.timer=operation;
    void operation.result.then(()=>{if(this.current(ticket)){this.timer=undefined;expire(ticket);}},()=>{});
  }
  current(ticket:BufferedStallTicket){return this.ticket===ticket&&ticket.revision===this.revision;}
  matches(ticket:BufferedStallTicket,value:BufferedStallState,generation:number,enabled:boolean){
    return this.current(ticket)&&this.eligible(value,enabled)&&ticket.generation===generation&&ticket.sourceGeneration===value.sourceGeneration&&
      value.positionMs<=ticket.positionMs&&(value.bufferedMs??0)<=ticket.bufferedMs;
  }
}
/** Budget survives newly resolved source objects and first frames. Only real
 * playback progress, a different video, or an explicit user action resets it. */
export class VideoReloadPolicy {
  private key='';
  private revision=0;
  private attempts=0;
  private running=false;
  private automatic=false;
  private requestStarted=false;
  private progress?:{generation:number;positionMs:number};
  select(source:ReloadSource){const key=reloadSourceKey(source);if(key!==this.key){this.cancel();this.key=key;this.attempts=0;this.progress=undefined;return true;}return false;}
  begin(manual:boolean):ReloadTicket|undefined {
    if(this.running)return;
    if(manual)this.attempts=0;
    if(!manual&&this.attempts>=2)return;
    this.running=true;this.automatic=!manual;this.requestStarted=false;this.progress=undefined;
    return {revision:++this.revision,waitMs:manual?0:350*Math.pow(2,this.attempts++)};
  }
  current(ticket:ReloadTicket){return this.running&&ticket.revision===this.revision;}
  markRequest(ticket:ReloadTicket){if(this.current(ticket))this.requestStarted=true;}
  finish(ticket:ReloadTicket){if(this.current(ticket))this.running=false;}
  cancel(){if(this.running&&this.automatic&&!this.requestStarted)this.attempts=Math.max(0,this.attempts-1);this.revision++;this.running=false;}
  get busy(){return this.running;}
  observe(generation:number,positionMs:number,playing:boolean){
    if(!playing){this.progress=undefined;return;}
    if(!this.progress||this.progress.generation!==generation||positionMs<this.progress.positionMs)this.progress={generation,positionMs};
    else if(positionMs-this.progress.positionMs>=10_000)this.attempts=0;
  }
}
