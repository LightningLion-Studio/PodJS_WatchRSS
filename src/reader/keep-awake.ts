export interface AutoScrollAwakeState { enabled:boolean; scrolling:boolean; active:boolean; foreground:boolean }
let nextOwner=0;

/** One reader owns one display lease. Serialize asynchronous host operations so
 * a late acquire cannot overtake pause/background/disposal's release. */
export class AutoScrollAwakeLease {
  readonly owner=`watchrss.reader.autoscroll.${++nextOwner}`;
  private desired=false;
  private applied:boolean|undefined=false;
  private disposed=false;
  private pending:Promise<void>|undefined;
  constructor(private readonly keepAwake:(owner:string,active:boolean)=>Promise<unknown>,private readonly onError:(error:unknown)=>void=()=>{}){}
  update(state:AutoScrollAwakeState):Promise<void> {
    this.desired=!this.disposed&&state.enabled&&state.scrolling&&state.active&&state.foreground;
    return this.reconcile();
  }
  close():Promise<void>{this.disposed=true;this.desired=false;return this.reconcile();}
  private reconcile():Promise<void> {
    if(this.pending)return this.pending;
    if(this.applied===this.desired)return Promise.resolve();
    let failedIntent:boolean|undefined;
    this.pending=(async()=>{
      let releaseFailures=0;
      while(this.applied!==this.desired){
        const active=this.desired;
        try{await this.keepAwake(this.owner,active);this.applied=active;}
        catch(error){
          this.applied=undefined;this.onError(error);
          if(active&&!this.desired)continue;
          // A transient failed release on unmount has no later render to retry it.
          if(!active&&releaseFailures++===0)continue;
          failedIntent=active;
          break;
        }
      }
    })().finally(()=>{
      this.pending=undefined;
      // Intent can change after the async loop returns but before finally runs.
      // Include that last update in this drain rather than dropping its release.
      if(this.applied!==this.desired&&failedIntent!==this.desired)return this.reconcile();
    });
    return this.pending;
  }
}
