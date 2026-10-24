export type VideoLoopMode = "off" | "single" | "next";
export type VideoLoopPlatform = "bili" | "douyin" | "rss";
export interface LoopModeStorage { get<T>(key:string):T|undefined; set(key:string,value:unknown):unknown }

/** Only Douyin has an implemented adjacent-item playback action. */
export function availableLoopModes(platform:VideoLoopPlatform|undefined,hasNext=false):readonly VideoLoopMode[] {
  return platform==="douyin"&&hasNext ? ["off","single","next"] : ["off","single"];
}
export class VideoLoopPreferences {
  constructor(private readonly storage:LoopModeStorage){}
  load(platform:VideoLoopPlatform|undefined,modes:readonly VideoLoopMode[]):VideoLoopMode {
    const value=this.storage.get<VideoLoopMode>(this.key(platform));
    return value&&modes.includes(value)?value:"off";
  }
  save(platform:VideoLoopPlatform|undefined,mode:VideoLoopMode):void {this.storage.set(this.key(platform),mode);}
  private key(platform:VideoLoopPlatform|undefined){return `watchrss.${platform??"rss"}.loop-mode`;}
}
export function nextLoopMode(mode:VideoLoopMode,modes:readonly VideoLoopMode[]):VideoLoopMode {
  return modes[(modes.indexOf(mode)+1)%modes.length]??"off";
}

/** A native repeat is still the same viewing. Complete/checkpoint once, keeping
 * subsequent loop positions from replacing the completed first pass with zero.
 * Native counters distinguish a repeat from a user's backward seek. */
export class VideoViewingProgress {
  private complete=false;
  private endObserved=false;
  private position=0;
  private duration=0;
  reset(){this.complete=false;this.endObserved=false;this.position=0;this.duration=0;}
  observe(state:{state:string;positionMs:number;durationMs:number;completedLoops?:number}) {
    const ended=state.state==="ended",firstEnd=ended&&!this.endObserved;
    this.endObserved=ended;
    const completed=!this.complete&&(ended||(state.completedLoops??0)>0);
    this.duration=Math.max(0,state.durationMs);
    if(completed)this.complete=true;
    this.position=this.complete&&this.duration>0?this.duration:Math.max(0,state.positionMs);
    return {positionMs:this.position,durationMs:this.duration,completed,firstEnd,reportProgress:!this.complete};
  }
  checkpoint(positionMs:number,durationMs:number) {
    return this.complete?{positionMs:Math.max(this.duration,durationMs),durationMs:Math.max(this.duration,durationMs)}:{positionMs,durationMs};
  }
}

/** End events are polled repeatedly. Claim one automatic transition per source,
 * and invalidate a pending preview when the source/mode/lifecycle changes. */
export class VideoAutoAdvance {
  private revision=0;
  private claimed=false;
  reset(){this.revision++;this.claimed=false;}
  cancel(){this.revision++;}
  async ended(mode:VideoLoopMode,preview:()=>Promise<boolean>,advance:(current:()=>boolean)=>Promise<void>):Promise<void> {
    if(mode!=="next"||this.claimed)return;
    this.claimed=true;const own=this.revision,current=()=>own===this.revision;
    if(await preview()&&current())await advance(current);
  }
}
