import type {ActivityState} from '@podjs/framework/services';
import {routeMemory,type ActivityRoute} from './activity-navigation.ts';
import {createLegalRecoveryFiles,type LegalRecoveryFiles} from '../onboarding/legal-recovery-files.ts';
import {captureLegalNavigation,hydrateLegalNavigation,prepareLegalNavigation,STARTUP_LEGAL_KEY,type LegalNavigation} from '../onboarding/legal-restoration.ts';
import {createLegalSnapshotWriter,type LegalSnapshotWriter} from '../onboarding/legal-snapshot-writer.ts';
import type {InformationSnapshot} from '../ui/InformationScreens.tsx';
const BASE='https://sly-data-plane.watchrss.cn';
const legalPage=(entry:ActivityRoute)=>entry.informationPage==='privacy'||entry.informationPage==='useragreement';
function state(entry:ActivityRoute):ActivityState{const m=routeMemory(entry);return {saved:{[STARTUP_LEGAL_KEY]:m.saved.legal},retained:m.retained.legal===undefined?{}:{[STARTUP_LEGAL_KEY]:m.retained.legal}};}

/** Main-content Info activities use the same authenticated immutable body files
 * as startup legal pages, but keep references in their own route namespace. */
export class InformationActivity {
 private files:LegalRecoveryFiles;
 private previous=new WeakMap<ActivityRoute,LegalNavigation>();
 private writers=new Map<ActivityRoute,LegalSnapshotWriter>();
 constructor(private readonly changed:()=>void,private readonly report:(error:unknown)=>void,files?:LegalRecoveryFiles){this.files=files??createLegalRecoveryFiles();}
 async restore(entry:ActivityRoute){
  if(!legalPage(entry)){
   const value=routeMemory(entry).saved.information;
   if(value&&typeof value==='object'&&!Array.isArray(value)){
    const s=value as Partial<InformationSnapshot>;
    if(typeof s.scrollOffset==='number'&&Number.isFinite(s.scrollOffset)&&s.scrollOffset>=0
      &&Number.isSafeInteger(s.reloadKey)&&Number(s.reloadKey)>=0&&(s.listAnchor===null||s.listAnchor&&Number.isSafeInteger(s.listAnchor.index)&&s.listAnchor.index>=0&&Number.isSafeInteger(s.listAnchor.offsetPx)&&s.listAnchor.offsetPx>=0))
     entry.informationSnapshot={content:null,error:null,isLoading:false,reloadKey:s.reloadKey!,listAnchor:s.listAnchor!,scrollOffset:s.scrollOffset};
   }return;
  }
  if(routeMemory(entry).saved.legal===undefined)return;
  try{
   const value=await hydrateLegalNavigation(state(entry),this.files,BASE,this.report);
   if(value.pages.length!==1||value.pages[0]!==entry.informationPage)throw Error('information_route_identity');
   entry.informationSnapshot=value.snapshots[0]??undefined;this.previous.set(entry,value);
  }catch(error){delete routeMemory(entry).saved.legal;delete routeMemory(entry).retained.legal;this.report(error);}
 }
 save(entry:ActivityRoute,snapshot:InformationSnapshot){
  if(!legalPage(entry)){routeMemory(entry).saved.information={scrollOffset:snapshot.scrollOffset,listAnchor:snapshot.listAnchor,reloadKey:snapshot.reloadKey};this.changed();return;}
  let writer=this.writers.get(entry);
  if(!writer){
   const initial=this.previous.get(entry),owner=initial?.owner??`content-${Date.now().toString(36)}-${routeMemory(entry).id}`;
   writer=createLegalSnapshotWriter({initial,
    prepare:(next,previous)=>prepareLegalNavigation({...next,owner},this.files,BASE,owner,previous),
    publish:next=>{
     const captured=captureLegalNavigation({saved:{},retained:{}},next),memory=routeMemory(entry);
     for(const ref of next.bodyReferences??[])if(ref)this.files.markPublished(ref);
     memory.saved.legal=captured.saved[STARTUP_LEGAL_KEY];memory.retained.legal=captured.retained[STARTUP_LEGAL_KEY];
     this.changed();
    },discard:ref=>this.files.discardUnpublished(ref),onError:this.report,
   });this.writers.set(entry,writer);
  }
  writer.save({pages:[entry.informationPage as 'privacy'|'useragreement'],snapshots:[snapshot]});
 }
 prune(entries:readonly ActivityRoute[]){for(const [entry,writer] of this.writers)if(!entries.includes(entry)){writer.close();this.writers.delete(entry);}}
 close(){for(const writer of this.writers.values())writer.close();this.writers.clear();}
}
