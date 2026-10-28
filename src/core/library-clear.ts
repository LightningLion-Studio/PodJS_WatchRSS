/** Local library destruction is independent of cloud login and never revokes credentials. */
export type LibraryClearPhase='idle'|'waiting'|'quiescing'|'database'|'files'|'verification'|'complete'|'cancelled'|'failed';
export type LibraryClearCode='clear_library_cancelled'|'clear_library_timeout'|'clear_library_busy'|'clear_library_database'|'clear_library_files'|'clear_library_changed'|'clear_library_cleanup';
export interface LibraryClearProgress {phase:LibraryClearPhase;deletedFiles:number;databaseCommitted:boolean;errorCode?:LibraryClearCode}
export interface LibraryClearOptions {timeoutMs?:number;check?:()=>void;onCancel?:(cancel:()=>void)=>()=>void;onProgress?:(progress:Readonly<LibraryClearProgress>)=>void}
/** Stable public text; never forward exception paths or host arguments to a peer. */
export function libraryClearMessage(code:LibraryClearCode):string {
 return {clear_library_cancelled:'清库已取消，可以重试继续清理',clear_library_timeout:'清库超时，请稍后重试',clear_library_busy:'资料正在同步，请稍后重试',clear_library_database:'数据库清理失败，请重试',clear_library_files:'文件清理未完成，请重试继续清理',clear_library_changed:'清理期间资料发生变化，请重试',clear_library_cleanup:'缓存清理未完成，请重试'}[code];
}
export class LibraryClearError extends Error {
 constructor(readonly code:LibraryClearCode,message:string=libraryClearMessage(code),readonly cause?:unknown){super(message);this.name='LibraryClearError';}
}
export function classifyLibraryClear(error:unknown,phase:LibraryClearPhase):LibraryClearError {
 if(error instanceof LibraryClearError)return error;
 const code=phase==='database'?'clear_library_database':phase==='files'?'clear_library_files':'clear_library_cleanup';
 return new LibraryClearError(code,error instanceof Error?error.message:code,error);
}
export interface LibraryClearControl {check():void;progress(phase:LibraryClearPhase,deletedFiles?:number):void}
/** A timed-out non-cooperative IO keeps the writer barrier until it actually settles.
 * The caller gets a bounded error, while late continuations must pass check(). */
export class LibraryClearOperation {
 private active:{scope:boolean;promise:Promise<void>;cancel:()=>void}|undefined;
 private state:LibraryClearProgress={phase:'idle',deletedFiles:0,databaseCommitted:false};
 private observers=new Set<(progress:Readonly<LibraryClearProgress>)=>void>();
 constructor(private readonly timer:(ms:number)=>{result:Promise<unknown>;cancel():void},private readonly now=Date.now){}
 snapshot(){return Object.freeze({...this.state});}
 subscribe(observer:(progress:Readonly<LibraryClearProgress>)=>void){this.observers.add(observer);observer(this.snapshot());return()=>{this.observers.delete(observer);};}
 cancel(){this.active?.cancel();}
 get running(){return !!this.active;}
 run(scope:boolean,options:LibraryClearOptions,work:(control:LibraryClearControl)=>Promise<void>):Promise<void>{
  if(this.active)return this.active.scope===scope?this.active.promise:Promise.reject(new LibraryClearError('clear_library_busy'));
  const budget=options.timeoutMs??60000;
  if(!Number.isFinite(budget)||budget<1||budget>120000)return Promise.reject(new LibraryClearError('clear_library_timeout'));
  const deadline=this.now()+budget;let finished=false,cancelled:LibraryClearError|undefined,rejectStop!:(error:unknown)=>void;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});
  const publish=()=>{for(const observer of [...this.observers,...(options.onProgress?[options.onProgress]:[])])try{observer(this.snapshot());}catch{/* Presentation cannot alter deletion. */}};
  const stop=(code:'clear_library_cancelled'|'clear_library_timeout')=>{if(cancelled||finished||this.state.phase==='complete')return;cancelled=new LibraryClearError(code);this.state={...this.state,phase:code==='clear_library_cancelled'?'cancelled':'failed',errorCode:code};publish();rejectStop(cancelled);};
  const control:LibraryClearControl={check:()=>{if(cancelled)throw cancelled;if(this.now()>=deadline){stop('clear_library_timeout');throw cancelled;}try{options.check?.();}catch{stop('clear_library_cancelled');throw cancelled;}},progress:(phase,deletedFiles)=>{if(phase==='files'&&!this.state.databaseCommitted){this.state={...this.state,databaseCommitted:true};publish();}control.check();this.state={phase,deletedFiles:deletedFiles??this.state.deletedFiles,databaseCommitted:this.state.databaseCommitted||phase==='files'||phase==='verification'};publish();}};
  this.state={phase:'waiting',deletedFiles:0,databaseCommitted:false};
  const timeout=this.timer(budget);
  let unsubscribe=()=>{};
  const worker=Promise.resolve().then(()=>{control.check();return work(control);}).then(()=>{control.check();control.progress('complete');},error=>{const classified=classifyLibraryClear(error,this.state.phase);if(!cancelled){this.state={...this.state,phase:'failed',errorCode:classified.code};publish();}throw classified;}).finally(()=>{finished=true;timeout.cancel();unsubscribe();if(this.active?.promise===result)this.active=undefined;});
  const result=Promise.race([worker,stopped]);
  this.active={scope,promise:result,cancel:()=>stop('clear_library_cancelled')};publish();
  unsubscribe=options.onCancel?.(()=>stop('clear_library_cancelled'))??(()=>{});
  void timeout.result.then(()=>stop('clear_library_timeout'),()=>{});
  return result;
 }
}
