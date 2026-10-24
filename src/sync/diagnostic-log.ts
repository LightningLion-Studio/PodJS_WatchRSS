import {tokenUsageOptInt} from './token-usage.ts';
import type {JsonObject} from './protocol.ts';
export interface DiagnosticStorage {get(key:string):string|undefined;set(key:string,value:string):void}
export interface DebugLogReply { [key:string]:unknown;success:true;action:"pullDebugLog";log:string;truncated:boolean;totalChars:number}

const KEY="watchrss.sync.diagnostics.v1";
const MAX_STORED_CHARS=700_000;
const allowedActions=new Set(["syncDomains","ping","remoteInput","pullSavedItems","syncAccount","syncReader","previewReader","syncLlmTokenUsage","pullDebugLog","clearLibrary","syncLibrary","syncNotes","syncNoteAsset","syncSession","openPairing"]);
const safeToken=(value:string)=>/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value)?value:"unknown";

/** A bounded, persistent sync timeline. Payloads, peer IDs, URLs and exception messages never enter it. */
export class SyncDiagnosticLog {
  constructor(private readonly storage:DiagnosticStorage,private readonly now:()=>Date=()=>new Date(),private readonly sink?:(message:string)=>void){}
  private append(message:string){
    if(this.sink){this.sink(message);return;}
    const previous=this.storage.get(KEY)??"";
    const next=(previous+`[${this.now().toISOString()}] ${message}\n`).slice(-MAX_STORED_CHARS);
    this.storage.set(KEY,next);
  }
  state(source:"bluetooth"|"ip",state:string){this.append(`${source} state=${safeToken(state)}`);}
  action(action:string,success:boolean){this.append(`action=${allowedActions.has(action)?action:"unknown"} success=${success}`);}
  failure(source:"bluetooth"|"ip"){this.append(`${source} failure`);}
  pull(requested:unknown):DebugLogReply {
    return debugLogReply(this.storage.get(KEY), {maxChars:requested});
  }
}

/** Normalize on the original wire object: JSONObject distinguishes Long from Double. */
export function debugLogMaxChars(request:JsonObject):number {
  return Math.max(1,Math.min(700_000,tokenUsageOptInt(request,'maxChars',700_000)));
}

/** Count the complete source before truncating, in UTF-16 code units (Kotlin String). */
export function debugLogReply(raw:string|null|undefined,request:JsonObject):DebugLogReply {
  const text=raw??'',log=text.slice(-debugLogMaxChars(request));
  return {success:true,action:'pullDebugLog',log,truncated:log.length<text.length,totalChars:text.length};
}
