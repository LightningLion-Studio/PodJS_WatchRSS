/** Playback routes hold expensive derived-state work. IO yields remain intact. */
export class PlaybackWork {
 private owners=new Set<object>();private listeners=new Set<(active:boolean)=>void>();
 get active(){return this.owners.size>0;}
 hold(){const owner={};this.owners.add(owner);this.notify();let released=false;return ()=>{if(released)return;released=true;this.owners.delete(owner);this.notify();};}
 subscribe(fn:(active:boolean)=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
 private notify(){for(const fn of [...this.listeners])try{fn(this.active);}catch{/* An observer must never prevent owner release or another waiter. */}}
 async wait(check:()=>void=()=>{}){while(this.active){check();await new Promise<void>(resolve=>{const off=this.subscribe(active=>{if(!active){off();resolve();}});});}check();}
}
export const playbackWork=new PlaybackWork();
