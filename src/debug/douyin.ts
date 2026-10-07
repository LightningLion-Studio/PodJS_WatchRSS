import {playbackDiagnosticLines,type PlaybackCacheDiagnostics,type PlaybackQueueDiagnostics,type SessionDiagnostics} from './playback-diagnostics.ts';
import {appLogger} from '../logs/app-logger.ts';
import {logPlatformId} from '../logs/fields.ts';
import type {DebugGate} from './gate.ts';
export class DouyinDebugController {
 private poisoned=new Set<string>();private autoMs=0;private last=0;private advancing=false;private poisonNext=false;private advancePending=false;private context={activeAwemeId:"",nextAwemeId:"",inVideoFlow:false};
 private queue?:{diagnostics():PlaybackQueueDiagnostics};private sessionReader?:()=>Promise<SessionDiagnostics>;
 constructor(private gate:DebugGate){}
 get allowed(){return this.gate.allowed;}
 bindSessions(reader:()=>Promise<SessionDiagnostics>):()=>void {if(!this.gate.allowed)return ()=>{};this.sessionReader=reader;return ()=>{if(this.sessionReader===reader)this.sessionReader=undefined;};}
 updateContext(activeAwemeId:string,nextAwemeId:string,inVideoFlow:boolean,queue?:{diagnostics():PlaybackQueueDiagnostics}){if(this.gate.allowed){this.context={activeAwemeId,nextAwemeId,inVideoFlow};this.queue=queue;}}
 async dumpPlayback(readCache?:()=>Promise<PlaybackCacheDiagnostics>){
  this.gate.require();const c=this.context;if(!c.inVideoFlow)return "DOUYIN_PLAYBACK_DEBUG\nstate=unavailable";
  const reader=this.sessionReader,queue=this.queue;
  const [cache,sessions]=await Promise.all([readCache?readCache().catch(()=>({} as PlaybackCacheDiagnostics)):Promise.resolve({}),reader?reader().catch(()=>undefined):Promise.resolve(undefined)]);
  this.gate.require();if(!this.context.inVideoFlow||this.context.activeAwemeId!==c.activeAwemeId||this.queue!==queue||this.sessionReader!==reader)return "DOUYIN_PLAYBACK_DEBUG\nstate=unavailable (playback owner changed)";
  return [`DOUYIN_PLAYBACK_DEBUG`,`activeAwemeId=${c.activeAwemeId}`,`nextAwemeId=${c.nextAwemeId}`,`inVideoFlow=${c.inVideoFlow}`,...playbackDiagnosticLines(cache,queue?.diagnostics(),sessions),`injectedFaults=${[...this.poisoned].join(',')||'none'}`].join('\n');
 }
 snapshot(){this.gate.require();return {...this.context};}
 requestAdvance(){this.gate.require();this.advancePending=true;appLogger.d("DouyinPlaybackDebug",`request advance next video emitted=true source=debug_ui activeAwemeId=${logPlatformId(this.context.activeAwemeId)} nextAwemeId=${logPlatformId(this.context.nextAwemeId)}`);}
 armNext(){this.gate.require();if(this.context.nextAwemeId){this.poisoned.add(this.context.nextAwemeId);appLogger.d("DouyinPlaybackDebug",`request poison next video awemeId=${logPlatformId(this.context.nextAwemeId)} source=debug_ui activeAwemeId=${logPlatformId(this.context.activeAwemeId)}`);}else this.poisonNext=true;}
 playbackUrl(id:string,url:string,adjacent=false){return this.fail(id,adjacent)?`watchrss-debug://douyin/force-fail/${encodeURIComponent(id)}`:url;}
 poison(id:string){this.gate.require();if(id.trim())this.poisoned.add(id.trim());}
 fail(id:string,adjacent=false){if(!this.gate.allowed)return false;if(adjacent&&this.poisonNext){this.poisonNext=false;this.poisoned.add(id);}return this.poisoned.has(id);}
 setAuto(milliseconds:number){this.gate.require();if(!Number.isSafeInteger(milliseconds)||milliseconds<0)throw Error('自动换片间隔无效');this.autoMs=milliseconds;this.last=0;}
 get interval(){return this.gate.allowed?this.autoMs:0;}
 async tick(now:number,active:boolean,advance:()=>Promise<void>){if(!this.gate.allowed||!active||(!this.autoMs&&!this.advancePending)){this.last=0;return;}if(!this.last&&!this.advancePending){this.last=now;return;}if(this.advancing||(!this.advancePending&&now-this.last<this.autoMs))return;this.advancePending=false;this.last=now;this.advancing=true;try{await advance();}finally{this.advancing=false;}}
 async importCookie(raw:string,apply:(cookie:string)=>Promise<{ok:boolean;message?:string}>){this.gate.require();const cookie=raw.trim();if(!cookie){appLogger.w('DouyinPlaybackDebug','import cookie broadcast ignored: missing cookie extra');throw Error('missing_cookie');}try{const result=await apply(cookie);if(!result.ok)throw Error(result.message||'apply_failed');appLogger.d('DouyinPlaybackDebug',`import cookie broadcast applied length=${raw.length}`);return 'Cookie 已导入';}catch(error){appLogger.w('DouyinPlaybackDebug','import cookie broadcast failed message=<redacted>');throw error;}}
 reset(){this.poisoned.clear();this.poisonNext=false;this.advancePending=false;this.autoMs=this.last=0;}
}
