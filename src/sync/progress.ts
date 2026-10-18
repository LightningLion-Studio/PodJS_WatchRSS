import type {SyncSessionStatus,TransferByteProgress} from './session.ts';
export interface LibraryProgress {phase:SyncSessionStatus['phase'];message:string;bytes:number;receivedArticles:number;sentArticles:number;totalArticles:number;elapsedMs:number}
const observers=new Set<(value:Readonly<LibraryProgress>)=>void>();
let active=false,started=0,current:LibraryProgress={phase:'request',message:'等待手机同步',bytes:0,receivedArticles:0,sentArticles:0,totalArticles:0,elapsedMs:0};
export function syncFailureReason(error:unknown):string {
 const message=error instanceof Error?error.message:String(error);
 if(/permission|权限/i.test(message))return '缺少连接权限，请允许后重试';
 if(/hash|checksum|正文|chunk|分块|manifest|checkpoint|acknowledgement/i.test(message))return '同步数据校验失败，请重试';
 if(/timed out|timeout|超时/i.test(message))return '连接超时，已确认的文章会保留';
 if(/cancel/i.test(message))return '同步已取消，已确认的文章会保留';
 return '连接中断，已确认的文章会保留；请在手机重试';
}
export function libraryProgressSnapshot(){return Object.freeze({...current});}
export function subscribeLibraryProgress(observer:(value:Readonly<LibraryProgress>)=>void){observers.add(observer);observer(libraryProgressSnapshot());return ()=>{observers.delete(observer);};}
function publish(){current.elapsedMs=Math.max(0,Date.now()-started);const snapshot=libraryProgressSnapshot();for(const observer of observers)try{observer(snapshot);}catch{}}
export function updateLibraryProgress(status:SyncSessionStatus){
 if(status.phase==='request')return;
 if(status.phase==='cursor'||status.phase==='manifest')active=true;
 if(!active)return;
 if(status.phase==='complete'&&status.applied===false){current={...current,phase:'error',message:'手机未确认应用结果，已接收文章保留；请重新同步'};active=false;publish();return;}
 if(status.phase==='cursor'||status.phase==='manifest'&&(current.phase==='complete'||current.phase==='error'||current.phase==='request')){started=Date.now();current={phase:status.phase,message:'',bytes:0,receivedArticles:0,sentArticles:0,totalArticles:0,elapsedMs:0};}
 current={...current,...status,message:status.phase==='error'?syncFailureReason(status.message):status.message??''};if(status.phase==='complete'||status.phase==='error')active=false;publish();
}
export function updateLibraryBytes(progress:TransferByteProgress){if(!active)return;current.bytes+=progress.bytes;publish();}
export function libraryProgressText(p:Readonly<LibraryProgress>):string {
 const labels={request:'等待手机同步',cursor:'正在协商同步游标',manifest:'正在比较资料库',receiving:'正在接收并应用文章',sending:'正在发送文章',ack:'正在等待手机确认',complete:'资料库同步完成',error:'资料库同步失败'};
 return labels[p.phase];
}
export function libraryProgressDetail(p:Readonly<LibraryProgress>):string {
 if(p.message)return p.message;
 const count=p.phase==='sending'?`已发送 ${p.sentArticles}/${p.totalArticles} 篇`:`已接收 ${p.receivedArticles} 篇`;
 return `${count} · ${(p.bytes/1024).toFixed(0)} KiB · ${(p.elapsedMs/1000).toFixed(0)} 秒`;
}
