import {douyinMediaExpiry} from './media-expiry.ts';
import {playbackFailure} from '../media/playback-failure.ts';
import {videoNetworkEpoch} from '../media/video-opt.ts';
import {PlaybackRecoveryBudget} from '@podjs/framework/media-policy';
import * as services from '@podjs/framework/services';
import type {DouyinItem} from './types.ts';
import type {PlaybackSource} from '../ui/VideoPlayerScreen.tsx';
import {selectPreferredDouyinVariant,douyinPlaybackAudio} from './playback-selector.ts';

type PlaybackItem=Pick<DouyinItem,'awemeId'|'playUrl'|'variants'>;
/** Same track only: changing CDN must never silently change codec or quality. */
export function douyinPlaybackCandidates(item:PlaybackItem):string[] {
  const selected = item.variants?.find(v => v.playUrl === item.playUrl || v.playUrls?.includes(item.playUrl)) ?? selectPreferredDouyinVariant(item.variants ?? []);
  return [...new Set([item.playUrl,...(selected?.playUrls ?? [])].map(v=>v.trim()).filter(Boolean))].slice(0,8);
}
export class DouyinPlaybackRecovery {
  private failed = new Set<string>();
  private refreshed = false;
  private running = false;
  private budget:PlaybackRecoveryBudget;
  private epoch:number;
  constructor(private item:PlaybackItem, private refresh:()=>Promise<PlaybackItem>, private now=Date.now, private timer:(ms:number)=>{result:Promise<unknown>;cancel():void}=(ms)=>services.delay(ms),private networkEpoch=videoNetworkEpoch) { this.budget=new PlaybackRecoveryBudget(this.now);this.epoch=networkEpoch(); }
  async recover(source:PlaybackSource, current:()=>boolean, manual=false, error?:unknown):Promise<PlaybackSource|undefined> {
    if (!current() || this.running) return;
    const category=playbackFailure(error);
    if (category==='restricted' || category==='decode') throw new Error('playback_recovery_not_retryable');
    this.running=true;
    try {
      if(manual){this.budget.reset();this.failed.clear();this.refreshed=false;}
      if(source.url)this.failed.add(source.url);
      const network=this.networkEpoch(),networkChanged=network!==this.epoch;this.epoch=network;
      let next=category==='expired'||networkChanged?undefined:douyinPlaybackCandidates(this.item).find(url=>!this.failed.has(url)&&douyinMediaExpiry(url,this.now())>this.now());
      if(!next&&!this.refreshed){
        this.budget.claim(true);this.refreshed=true;
        const item=await this.budget.run(this.refresh,this.timer);
        if(!current())return;
        if(network!==this.networkEpoch())throw new Error('playback_network_changed');
        if(item.awemeId!==this.item.awemeId)throw new Error('playback_recovery_source_changed');
        if(manual)this.failed.clear();
        this.item=item;next=douyinPlaybackCandidates(item).find(url=>!this.failed.has(url)&&douyinMediaExpiry(url,this.now())>this.now());
      } else this.budget.claim();
      this.budget.check();
      if(!current())return;
      if(!next)throw new Error('playback_recovery_exhausted');
      return {...source,url:next,audioUrl:douyinPlaybackAudio(this.item,next),previewOnly:false,recoveryDeadlineMs:this.now()+this.budget.remaining()};
    } finally {this.running=false;}
  }
}
