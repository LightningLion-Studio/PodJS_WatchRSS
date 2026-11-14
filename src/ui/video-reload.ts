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
