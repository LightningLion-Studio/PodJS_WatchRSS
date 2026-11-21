/** A decoded local-sync session pauses its optional foreground cloud follower.
 * Listening alone is idle. Nested IP/RFCOMM leases release independently. */
export class LocalTransferActivity {
 private leases=0;private guardedReceivers=0;private observers=new Set<(active:boolean)=>void>();
 get active(){return this.leases>this.guardedReceivers;}
 /** An identified receiver has a manifest the cloud body worker can check. */
 allowCloudControl(){
  const before=this.active;this.guardedReceivers++;if(this.active!==before)this.emit();
  let released=false;return()=>{if(released)return;released=true;const before=this.active;this.guardedReceivers--;if(this.active!==before)this.emit();};
 }
 subscribe(fn:(active:boolean)=>void){this.observers.add(fn);return()=>{this.observers.delete(fn);};}
 private emit(){for(const fn of this.observers)try{fn(this.active);}catch{}}
 acquire(){const before=this.active;this.leases++;if(this.active!==before)this.emit();let released=false;return()=>{if(released)return;released=true;const before=this.active;this.leases--;if(this.active!==before)this.emit();};}
}
export const localTransferActivity=new LocalTransferActivity();
