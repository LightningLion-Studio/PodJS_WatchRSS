import {stringToUtf8} from '@podjs/framework/bytes';
import {debugLogReply} from '../sync/diagnostic-log.ts';

export const APP_LOG_FILE='app_log.txt';
export const MAX_LOG_BYTES=5*1024*1024;
export type LogLevel='V'|'D'|'I'|'W'|'E';
const sensitive='access_token|api_key|apiKey|appRefreshToken|bili_jct|csrf_session_id|DedeUserID|DedeUserID__ckMd5|msToken|n_mh|odin_tt|passport_csrf_token|passport_csrf_token_default|refresh_token|refreshToken|SESSDATA|sessionid|sessionid_ss|sid|sid_guard|sid_tt|sid_ucp_v1|s_v_web_id|ssid_ucp_v1|ttwid|uid_tt|uid_tt_ss|watchrss_pair|[A-Za-z0-9_-]*token|password|secret|signature|sign|a_bogus|x_bogus|X-Bogus|w_rid';
/** Native header/Bearer/cookie rules, extended to JSON credentials and all URL queries. */
export function redactSensitiveLogContent(raw:string):string {
 return raw
  .replace(/\b((?:set-)?cookie|authorization|proxy-authorization|x-watchrss-pairing-auth)["']?\s*([:=])\s*[^\r\n]*/gi,'$1$2<redacted>')
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/\-=]+/gi,'$1<redacted>')
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:<redacted>|[^\s<>"'])+/gi,url=>url.replace(/\/\/[^/@]+@/,'//<redacted>@').replace(/[?#].*$/,'?<redacted>'))
  .replace(/(\/(?:<redacted>|[^\s<>"'?])+)[?](?:<redacted>|[^\s<>"'])*/g,'$1?<redacted>')
  .replace(new RegExp(`\\b(${sensitive})["']?\\s*[:=]\\s*(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^;\\s,\\]\\)}]+)`,'gi'),'$1=<redacted>');
}
export interface LogFile {
 read():Promise<string|null>;
 size():Promise<number>;
 replace(text:string):Promise<void>;
 append(text:string,offset:number):Promise<void>;
}
function timestamp(d:Date):string {
 const p=(n:number,width=2)=>String(n).padStart(width,'0');
 return `${p(d.getFullYear(),4)}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`;
}
/** A single FIFO owns every read/write/trim. Logging never rejects into application code. */
export class AppLogger {
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private readonly file:LogFile,private readonly now=()=>new Date(),private readonly output:(level:LogLevel,line:string)=>void=()=>{}){}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.queue.then(work);this.queue=next.catch(()=>{});return next;}
 /** `scanExisting=false` skips the one-time full-file redaction of logs written by older builds
  * (every new line is already redacted in write()). */
 init(legacyTimeline?:string,scanExisting=true):Promise<void>{
  const ready=this.serial(async()=>{const raw=scanExisting?await this.file.read():(legacyTimeline&&await this.file.size()>0?'present':null);if(raw){if(scanExisting){const safe=redactSensitiveLogContent(raw);if(safe!==raw)await this.file.replace(safe);}}else if(legacyTimeline){await this.file.replace(redactSensitiveLogContent(legacyTimeline));}});
  this.d('AppLogger','日志系统初始化完成');
  return ready;
 }
 log(tag:string,message:string){this.d(tag,message);}
 v(tag:string,message:string){this.write('V',tag,message);}
 d(tag:string,message:string){this.write('D',tag,message);}
 i(tag:string,message:string){this.write('I',tag,message);}
 w(tag:string,message:string,error?:unknown){this.write('W',tag,message,error);}
 e(tag:string,message:string,error?:unknown){this.write('E',tag,message,error);}
 private write(level:LogLevel,tag:string,message:string,error?:unknown){
  try {
   const stack=error==null?'':error instanceof Error?error.stack||String(error):String(error);
   const line=redactSensitiveLogContent(`[${timestamp(this.now())}] [${level}] [${tag}] ${message}${stack?'\n'+stack:''}`);
   try{this.output(level,line);}catch{}
   void this.serial(async()=>{
    let size=await this.file.size();
    // Native trims once BEFORE append, only when strictly over 5 MiB.
    if(size>MAX_LOG_BYTES){
     const lines=(await this.file.read()??'').split(/\r\n|\n|\r/);if(lines.at(-1)==='')lines.pop();
     const text=lines.slice(Math.floor(lines.length*.2)).join('\n')+'\n';
     await this.file.replace(text);size=stringToUtf8(text).length;
    }
    await this.file.append(line+'\n',size);
   }).catch(()=>{try{this.output('E','AppLogger: 写入日志失败');}catch{}});
  }catch{} // Formatting or console failures must not change application behavior.
 }
 readLogs():Promise<string|null>{return this.serial(async()=>{const raw=await this.file.read();return raw?redactSensitiveLogContent(raw):null;});}
 async pull(maxChars:unknown){return debugLogReply(await this.readLogs(),{maxChars});}
 clearLogs():Promise<void>{return this.serial(async()=>{await this.file.replace('');}).then(()=>{this.d('AppLogger','日志已清空');});}
 flush():Promise<void>{return this.serial(async()=>{});}
}
// Host-free facade lets domain modules log without importing platform services.
let active:AppLogger|undefined;
export function installAppLogger(logger:AppLogger|undefined){active=logger;}
export const appLogger={
 v:(tag:string,message:string)=>active?.v(tag,message),
 d:(tag:string,message:string)=>active?.d(tag,message),
 i:(tag:string,message:string)=>active?.i(tag,message),
 w:(tag:string,message:string,error?:unknown)=>active?.w(tag,message,error),
 e:(tag:string,message:string,error?:unknown)=>active?.e(tag,message,error),
};

/** Compatibility diagnostics keep their fixed first message. Error details may contain
 * body/user input without a credential key, so warn/error never serialize extra args. */
export function createLogConsole(tag:string){
 const emit=(level:LogLevel,args:unknown[])=>{
  try{const message=(level==='W'||level==='E')?(typeof args[0]==='string'?args[0]:'<redacted>'):args.map(String).join(' ');
   if(level==='E')appLogger.e(tag,message);else if(level==='W')appLogger.w(tag,message);else if(level==='I')appLogger.i(tag,message);else appLogger.d(tag,message);
  }catch{}
 };
 return {warn:(...args:unknown[])=>emit('W',args),error:(...args:unknown[])=>emit('E',args),info:(...args:unknown[])=>emit('I',args),log:(...args:unknown[])=>emit('D',args),debug:(...args:unknown[])=>emit('D',args)};
}
