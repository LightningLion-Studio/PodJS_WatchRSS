export interface DiagnosticStorage {get(key:string):string|undefined;set(key:string,value:string):void}
export interface DebugLogReply { [key:string]:unknown;success:true;action:"pullDebugLog";log:string;truncated:boolean;totalChars:number}

const KEY="watchrss.sync.diagnostics.v1";
const MAX_STORED_CHARS=700_000;
const allowedActions=new Set(["ping","remoteInput","pullSavedItems","syncAccount","syncReader","previewReader","syncLlmTokenUsage","pullDebugLog","clearLibrary","syncLibrary","syncNotes","syncNoteAsset","syncSession"]);
const safeToken=(value:string)=>/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value)?value:"unknown";

/** A bounded, persistent sync timeline. Payloads, peer IDs, URLs and exception messages never enter it. */
export class SyncDiagnosticLog {
  constructor(private readonly storage:DiagnosticStorage,private readonly now:()=>Date=()=>new Date()){}
  private append(message:string){
    const previous=this.storage.get(KEY)??"";
    const next=(previous+`[${this.now().toISOString()}] ${message}\n`).slice(-MAX_STORED_CHARS);
    this.storage.set(KEY,next);
  }
  state(source:"bluetooth"|"ip",state:string){this.append(`${source} state=${safeToken(state)}`);}
  action(action:string,success:boolean){this.append(`action=${allowedActions.has(action)?action:"unknown"} success=${success}`);}
  failure(source:"bluetooth"|"ip"){this.append(`${source} failure`);}
  pull(requested:unknown):DebugLogReply {
    const number=typeof requested==="number"?requested:typeof requested==="string"&&requested.trim()?Number(requested):NaN;
    const maxChars=Number.isFinite(number)?Math.max(1,Math.min(700_000,Math.trunc(number))):700_000;
    const raw=this.storage.get(KEY)??"";
    const log=raw.slice(-maxChars);
    return {success:true,action:"pullDebugLog",log,truncated:log.length<raw.length,totalChars:raw.length};
  }
}
