import type {SyncDiagnosticLog} from '../sync/diagnostic-log.ts';
import {encryptLog, type LogCrypto} from './encryption.ts';

export type LogSource=()=>Promise<string|null>;
/** Deliberately exports only the already-redacted sync timeline, never SQL data. */
export function diagnosticLogSource(log:Pick<SyncDiagnosticLog,'pull'>):LogSource {
  return async()=>log.pull(700_000).log||null;
}
export interface LogRecord {code:string;encryptedAesKey:string;fileSize:number;charCount:number;createdAt:string;userId:string}
export interface LogBackend {
  upload(path:string,bytes:Uint8Array):Promise<string>;
  save(id:string,record:LogRecord,fileId:string):Promise<void>;
}
export type LogUploadState =
  | {phase:'loading'|'empty'|'load-error'|'encrypting'|'uploading'|'saving'|'upload-error';message:string}
  | {phase:'success';message:string;code:string;record:LogRecord};
export function parsePickupCode(value:unknown):string|null {
  if(typeof value!=='string')return null;
  const match=/^(?:上传成功！取件码：)?([1-9][0-9]{5})$/.exec(value);
  return match?.[1]??null;
}
// Avoid Intl/time-zone availability assumptions in QuickJS. Same Shanghai wall time
// as native's en-US -> zh-CN conversion, including midnight as 00 rather than 24.
export function shanghaiLogTime(epoch:number):string {
  const d=new Date(epoch+8*60*60*1000),pad=(n:number)=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
export interface LogUploadOptions {
  source:LogSource;crypto:LogCrypto;backend:LogBackend;uuid:()=>Promise<string>;
  userId?:string;now?:()=>number;random?:()=>number;
}
/** One attempt per mounted screen; no automatic retry after an ambiguous write.
 * dispose suppresses late UI delivery and prevents subsequent upload/save stages. */
export class LogUploadController {
  private running=false;
  private disposed=false;
  private started=false;
  private readonly now:()=>number;
  private readonly random:()=>number;
  private readonly userId:string;
  constructor(private readonly options:LogUploadOptions,private readonly changed:(state:LogUploadState)=>void) {
    this.now=options.now??Date.now;this.random=options.random??Math.random;
    this.userId=options.userId??`test-user-${this.now()}`;
  }
  dispose(){this.disposed=true;}
  async start():Promise<void> {
    if(this.running||this.disposed||this.started)return;
    this.running=true;this.started=true;
    const emit=(state:LogUploadState)=>{if(!this.disposed)this.changed(state);};
    let loaded=false;
    try {
      emit({phase:'loading',message:'加载中...'});
      const text=await this.options.source();if(this.disposed)return;
      if(text===null||text===''){emit({phase:'empty',message:'暂无日志'});return;}
      loaded=true;
      if(!text.trim()){emit({phase:'upload-error',message:'日志内容为空'});return;}
      emit({phase:'encrypting',message:'正在加密和压缩...'});
      const encrypted=await encryptLog(text,this.options.crypto);if(this.disposed)return;
      emit({phase:'uploading',message:'正在上传文件...'});
      const path=`${this.userId}/log_${this.now()}_${this.random().toString(36).substring(7)}.enc`;
      const fileId=await this.options.backend.upload(path,encrypted.bytes);if(this.disposed)return;
      emit({phase:'saving',message:'正在保存记录...'});
      const code=parsePickupCode(String(Math.floor(1e5+this.random()*9e5)));
      if(!code)throw Error('取件码无效');
      const record:LogRecord={code,encryptedAesKey:encrypted.encryptedAesKey,fileSize:encrypted.bytes.length,charCount:text.length,createdAt:shanghaiLogTime(this.now()),userId:this.userId};
      const id=await this.options.uuid();if(this.disposed)return;
      await this.options.backend.save(id,record,fileId);if(this.disposed)return;
      emit({phase:'success',message:`上传成功！取件码：${code}`,code,record});
    } catch(error) {
      emit({phase:loaded?'upload-error':'load-error',message:`${loaded?'上传失败：':'加载日志失败: '}${error instanceof Error?error.message:String(error)}`});
    } finally {this.running=false;}
  }
}
