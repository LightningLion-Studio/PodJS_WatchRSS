import {FileLogger,createLogRedactor,type LogFile,type LogLevel} from '@podjs/framework/logging';
import {debugLogReply} from '../sync/diagnostic-log.ts';
export type {LogFile,LogLevel} from '@podjs/framework/logging';
export const APP_LOG_FILE='app_log.txt';
export const MAX_LOG_BYTES=5*1024*1024;
const sensitive='access_token|api_key|apiKey|appRefreshToken|bili_jct|csrf_session_id|DedeUserID|DedeUserID__ckMd5|msToken|n_mh|odin_tt|passport_csrf_token|passport_csrf_token_default|refresh_token|refreshToken|SESSDATA|sessionid|sessionid_ss|sid|sid_guard|sid_tt|sid_ucp_v1|s_v_web_id|ssid_ucp_v1|ttwid|uid_tt|uid_tt_ss|watchrss_pair|[A-Za-z0-9_-]*token|password|secret|signature|sign|a_bogus|x_bogus|X-Bogus|w_rid';
export const redactSensitiveLogContent=createLogRedactor({sensitivePattern:sensitive,headerPattern:'(?:set-)?cookie|authorization|proxy-authorization|x-watchrss-pairing-auth'});
export class AppLogger extends FileLogger {
 constructor(file:LogFile,now=()=>new Date(),output:(level:LogLevel,line:string)=>void=()=>{}){
  super(file,{redact:redactSensitiveLogContent,maxBytes:MAX_LOG_BYTES,trim:lines=>lines.slice(Math.floor(lines.length*.2)).join('\n')+'\n',writeFailureMessage:'AppLogger: 写入日志失败'},now,output);
 }
 override init(legacyTimeline?:string,scanExisting=true):Promise<void>{
  const ready=super.init(legacyTimeline,scanExisting);
  this.d('AppLogger','日志系统初始化完成');
  return ready;
 }
 async pull(maxChars:unknown){return debugLogReply(await this.readLogs(),{maxChars});}
 override clearLogs():Promise<void>{return super.clearLogs().then(()=>{this.d('AppLogger','日志已清空');});}
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
