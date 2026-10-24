/** A decoded local-sync session pauses its optional foreground cloud follower.
 * Listening alone is idle. Nested IP/RFCOMM leases release independently. */
export class LocalTransferActivity {
 private leases=0;private observers=new Set<(active:boolean)=>void>();
 get active(){return this.leases>0;}
 subscribe(fn:(active:boolean)=>void){this.observers.add(fn);return()=>{this.observers.delete(fn);};}
 private emit(){for(const fn of this.observers)try{fn(this.active);}catch{}}
 acquire(){if(this.leases++===0)this.emit();let released=false;return()=>{if(released)return;released=true;if(--this.leases===0)this.emit();};}
}
export const localTransferActivity=new LocalTransferActivity();
