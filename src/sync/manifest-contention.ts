import type {SqlDatabase} from '../core/types';

/** Expected write contention is not a corrupt library or a successful exchange.
 * A peer must retry the library action, without acknowledging this window. */
export class LibrarySnapshotBusyError extends Error {
 readonly code='library_busy';readonly retryable=true;readonly retryAfterMillis=500;
 constructor(){super('Library is busy while preparing sync; retry synchronization');this.name='LibrarySnapshotBusyError';}
}
interface Witness {revision:number;sequence:number}
/** Do not repeatedly rebuild a large inventory while a finite import is still
 * writing. Keep the original three attempts and all publication guards; spend
 * at most two additional seconds yielding between them. No database lock is
 * held over JS/codec/file work. A sample cap also bounds broken/frozen clocks. */
export class ManifestContention {
 private waited=0;private samples=0;
 constructor(private readonly db:SqlDatabase,private readonly yieldTurn:()=>Promise<unknown>,private readonly diagnostic?:(fields:Record<string,string|number>)=>void,
  private readonly clock=()=>globalThis.performance?.now?.()??Date.now(),private readonly pause:(ms:number)=>Promise<unknown>=ms=>new Promise(resolve=>setTimeout(resolve,ms))){}
 private async witness():Promise<Witness>{
  const row=(await this.db.query("SELECT revision,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_projection_events'),0) AS projection_seq FROM sync_library_revision WHERE id=1"))[0];
  if(!row||!Number.isSafeInteger(Number(row.revision))||!Number.isSafeInteger(Number(row.projection_seq)))throw Error('Missing or invalid library witness');
  return {revision:Number(row.revision),sequence:Number(row.projection_seq)};
 }
 async settle(attempt:number,check?:()=>void):Promise<void>{
  check?.();const started=this.clock();let since=started,previous=await this.witness(),changed=0;
  const remaining=2000-this.waited;
  while(this.samples<128&&this.clock()-started<remaining){
   check?.();await this.yieldTurn();check?.();
   await this.pause(Math.min(16,Math.max(0,remaining-(this.clock()-started))));check?.();
   const current=await this.witness();check?.();this.samples++;
   if(this.clock()-started>=remaining)break;
   if(current.revision!==previous.revision||current.sequence!==previous.sequence){previous=current;since=this.clock();changed++;}
   if(this.clock()-since>=32){this.waited+=Math.max(0,this.clock()-started);this.emit(attempt,changed,0);return;}
  }
  this.waited+=Math.max(0,this.clock()-started);this.emit(attempt,changed,1);throw new LibrarySnapshotBusyError();
 }
 private emit(attempt:number,changes:number,busy:number){try{this.diagnostic?.({stage:'repository.contention',attempt,changes,waitMs:this.waited,samples:this.samples,busy});}catch{}}
}
