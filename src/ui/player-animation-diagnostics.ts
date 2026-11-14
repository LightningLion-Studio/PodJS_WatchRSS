import type {PlayerScaleMode} from './video-player.ts';
export type PlayerAnimationKind='scale'|'swipe'|'rotation';
type Sample={mode:PlayerScaleMode;angle:number;started:number;last:number;frames:number;maxFrameMs:number;droppedFrames:number};
/** Guest frame cadence, not decoded-video FPS or proof of native presentation.
 * Keep only three counters and emit once when each operation ends. */
export class PlayerAnimationDiagnostics {
 private samples=new Map<PlayerAnimationKind,Sample>();
 constructor(private readonly emit:(line:string)=>void,private readonly now=Date.now,private readonly frameMs=1000/60){}
 begin(kind:PlayerAnimationKind,mode:PlayerScaleMode,angle:number){
  this.end(kind,'interrupted');const now=this.now();
  this.samples.set(kind,{mode,angle,started:now,last:now,frames:0,maxFrameMs:0,droppedFrames:0});
 }
 frame(now=this.now()){
  for(const sample of this.samples.values()){
   const elapsed=Math.max(0,now-sample.last);sample.frames++;sample.last=now;
   sample.maxFrameMs=Math.max(sample.maxFrameMs,elapsed);
   sample.droppedFrames+=Math.max(0,Math.round(elapsed/this.frameMs)-1);
  }
 }
 end(kind:PlayerAnimationKind,outcome='complete'){
  const sample=this.samples.get(kind);if(!sample)return;this.samples.delete(kind);
  this.emit(JSON.stringify({kind,mode:sample.mode,angle:sample.angle,frames:sample.frames,maxFrameMs:Math.round(sample.maxFrameMs),droppedFrames:sample.droppedFrames,elapsedMs:Math.max(0,this.now()-sample.started),outcome,clock:'guest-frame',frameBudgetMs:Math.round(this.frameMs*100)/100}));
 }
 close(){for(const kind of this.samples.keys())this.end(kind,'exit');}
}
