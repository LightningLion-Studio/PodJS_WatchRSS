import type {DebugExternalEvent} from '@podjs/framework/services';
import type {DebugGate} from './gate.ts';
import type {DouyinDebugController} from './douyin.ts';
export const DEBUG_ACTION='com.lightningstudio.watchrss.debug.action.';
export interface ExternalDebugPorts {
 douyin:DouyinDebugController; openDouyin:(resumeAwemeId?:string)=>void; openSummary:(id:string)=>void;
 applyCookie:(raw:string)=>Promise<{ok:boolean;message?:string}>;
 dumpLogs:()=>string;clearLogs:()=>void;
}
/** Application ABI; transport and bounded replies belong to the framework. */
export class ExternalDebugActions {
 constructor(private gate:DebugGate,private ports:ExternalDebugPorts){}
 async handle(event:DebugExternalEvent):Promise<{code:number;data:string}>{
  this.gate.require();const p=this.ports;
  if(event.kind==='dump'){
   if(event.args.includes('--douyin-playback'))return {code:0,data:p.douyin.dumpPlayback()};
   if(event.args.includes('--clear')){p.clearLogs();return {code:0,data:'DebugLogBuffer cleared.'};}
   return {code:0,data:p.dumpLogs()};
  }
  const action=event.action;
  if(action===DEBUG_ACTION+'OPEN_DOUYIN'){p.openDouyin(typeof event.extras.resume_aweme_id==='string'?event.extras.resume_aweme_id.trim()||undefined:undefined);return {code:0,data:'ok'};}
  if(action===DEBUG_ACTION+'OPEN_LLM_SUMMARY'){
   const id=String(event.extras.item_id??'');if(!/^[1-9][0-9]*$/.test(id)||!Number.isSafeInteger(Number(id)))return {code:1,data:'invalid_item_id'};
   p.openSummary(id);return {code:0,data:'ok'};
  }
  if(action===DEBUG_ACTION+'REPORT_DOUYIN_PLAYBACK_CONTEXT'){const c=p.douyin.snapshot();return {code:0,data:`activeAwemeId=${c.activeAwemeId};nextAwemeId=${c.nextAwemeId};inVideoFlow=${c.inVideoFlow}`};}
  if(action===DEBUG_ACTION+'ADVANCE_TO_NEXT_DOUYIN_VIDEO'){const c=p.douyin.snapshot();if(c.inVideoFlow)p.douyin.requestAdvance();return {code:0,data:''};}
  if(action===DEBUG_ACTION+'FORCE_FAIL_NEXT_DOUYIN_VIDEO'||action===DEBUG_ACTION+'FORCE_FAIL_CURRENT_DOUYIN_VIDEO'){const c=p.douyin.snapshot();if(c.nextAwemeId)p.douyin.poison(c.nextAwemeId);return {code:0,data:''};}
  if(action===DEBUG_ACTION+'IMPORT_DOUYIN_COOKIE'){
   const raw=typeof event.extras.raw_cookie==='string'?event.extras.raw_cookie.trim():'';
   if(!raw)return {code:1,data:'missing_cookie'};
   try{await p.douyin.importCookie(raw,p.applyCookie);return {code:0,data:'ok'};}catch{return {code:2,data:'apply_failed'};}
  }
  return {code:1,data:'unsupported_action'};
 }
}
