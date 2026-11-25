import {NoteDraftAutosave,type NoteDraftSaveState} from "./draft-autosave.ts";
import type {MemoNote} from "./types.ts";

type NoteStore=ConstructorParameters<typeof NoteDraftAutosave>[0];
type Observer={
 state:(state:NoteDraftSaveState)=>void;
 saved:(note:MemoNote)=>void;
 error:(error:unknown)=>void;
};

class NoteDraftSession {
 readonly draft:NoteDraftAutosave;
 private observer?:Observer;
 private saving?:Promise<MemoNote|null>;
 private queued=false;

 constructor(store:NoteStore,initial:MemoNote|null,
   private readonly retain:(session:NoteDraftSession)=>void,
   private readonly complete:(session:NoteDraftSession)=>void,
   private readonly publish:()=>void){
  this.draft=new NoteDraftAutosave(store,initial,
   state=>this.observer?.state(state),
   note=>{
    if(this.queued){this.retain(this);this.publish();}
    this.observer?.saved(note);
   },
   error=>this.observer?.error(error));
 }

 observe(observer:Observer){
  this.observer=observer;
  observer.state(this.draft.state);
  return ()=>{
   if(this.observer!==observer)return;
   this.observer=undefined;
   this.draft.dispose();
  };
 }

 close(){
  this.queued=true;
  this.retain(this);
  return this.flush();
 }

 flush():Promise<MemoNote|null>{
  if(this.saving)return this.saving;
  this.saving=this.draft.flush().then(note=>{
   if(this.queued){this.queued=false;this.complete(this);}
   return note;
  }).finally(()=>{this.saving=undefined;});
  return this.saving;
 }

 retryDetached(){
  if(!this.observer)void this.flush().catch(()=>{});
 }
}

/** One retained editor snapshot per note, scoped to the application repository. */
class NoteDraftQueue {
 private readonly pending=new Map<string|undefined,NoteDraftSession>();
 private readonly listeners=new Set<()=>void>();

 constructor(private readonly store:NoteStore){}

 open(initial:MemoNote|null){
  return this.pending.get(initial?.noteId)??new NoteDraftSession(this.store,initial,
   session=>{
    this.remove(session);
    this.pending.set(session.draft.note?.noteId,session);
   },
   session=>this.remove(session),
   ()=>{for(const listener of this.listeners)listener();});
 }

 subscribe(listener:()=>void){
  this.listeners.add(listener);
  return ()=>{this.listeners.delete(listener);};
 }

 retryDetached(){
  for(const session of this.pending.values())session.retryDetached();
 }

 private remove(session:NoteDraftSession){
  for(const [key,value] of this.pending)if(value===session)this.pending.delete(key);
 }
}

const queues=new WeakMap<NoteStore,NoteDraftQueue>();
export function noteDraftQueue(store:NoteStore){
 let queue=queues.get(store);
 if(!queue){queue=new NoteDraftQueue(store);queues.set(store,queue);}
 return queue;
}
