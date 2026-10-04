import type {LegalBodyReference} from './legal-recovery-files.ts';
import type {LegalNavigation} from './legal-restoration.ts';

export interface LegalSnapshotWriterOptions {
 prepare:(navigation:LegalNavigation,previous?:LegalNavigation)=>Promise<LegalNavigation>;
 /** Use this exact prepared object. Mark its references published before dispatching a host write. */
 publish:(prepared:LegalNavigation)=>void|Promise<void>;
 /** Must protect already-published files, including writes whose acknowledgement was lost. */
 discard:(reference:LegalBodyReference)=>Promise<void>;
 onError:(error:unknown)=>void;
 initial?:LegalNavigation;
}

export interface LegalSnapshotWriter {
 save:(navigation:LegalNavigation)=>void;
 close:()=>void;
 /** Wait for the active drain, including requests queued while it is running. Errors use onError. */
 idle:()=>Promise<void>;
}

/** Serial preparation and publication with one replaceable pending request.
 * A superseded preparation is still the next preparation's previous value, so
 * scrolling the same body reuses its file. prepare owns cleanup if it rejects
 * before returning references. This writer never clones prepared objects or refs.
 */
export function createLegalSnapshotWriter(options:LegalSnapshotWriterOptions):LegalSnapshotWriter {
 let previous=options.initial;
 let pending:{navigation:LegalNavigation;revision:number}|undefined;
 let revision=0,closed=false;
 let running:Promise<void>|undefined;
 // Retain original reference objects: discardUnpublished uses allocation identity.
 const known=new Map<string,LegalBodyReference>();
 const remember=(navigation:LegalNavigation|undefined)=>{
  for(const reference of navigation?.bodyReferences??[]){
   if(reference&&!known.has(reference.path))known.set(reference.path,reference);
  }
 };
 remember(previous);
 const contains=(navigation:LegalNavigation|undefined,path:string)=>
  navigation?.bodyReferences?.some(reference=>reference?.path===path)??false;
 const report=(error:unknown)=>{
  if(closed)return;
  try {
   // A throwing (or accidentally async) error reporter cannot reject the drain
   // or recursively invoke itself with its own failure.
   void Promise.resolve(options.onError(error)).catch(()=>{});
  }catch{/* The original operation has already been reported once. */}
 };
 const discardUnused=async()=>{
  for(const [path,reference] of known){
   // Re-evaluate pending for each file: save/close can run during a prior await.
   if(!closed&&(contains(previous,path)||contains(pending?.navigation,path)))continue;
   known.delete(path);
   try {await options.discard(reference);}catch(error){report(error);}
  }
 };
 const drain=async()=>{
  while(true){
   if(closed){previous=undefined;pending=undefined;await discardUnused();return;}
   const request=pending;
   if(!request){
    await discardUnused();
    if(closed||pending)continue;
    return;
   }
   pending=undefined;
   let prepared:LegalNavigation;
   try {prepared=await options.prepare(request.navigation,previous);}
   catch(error){report(error);await discardUnused();continue;}
   previous=prepared;
   remember(prepared);
   await discardUnused();
   if(closed||request.revision!==revision)continue;
   try {await options.publish(prepared);}catch(error){report(error);}
   // Already-dispatched host writes cannot be recalled. Awaiting each publish
   // ensures any newer navigation is written after it, never concurrently.
  }
 };
 const start=()=>{
  if(running||(!pending&&!(closed&&known.size)))return;
  // Deferring the first callback also makes synchronous, reentrant save safe.
  running=Promise.resolve().then(drain).catch(report).then(()=>{
   running=undefined;
   // close can arrive after drain returned but before this promise settled.
   // Re-check both pending work and closed-file cleanup through start's guard.
   start();
  });
 };
 return {
  save(navigation){if(closed)return;pending={navigation,revision:++revision};start();},
  close(){if(closed)return;closed=true;revision++;pending=undefined;start();},
  async idle(){while(running)await running;},
 };
}
