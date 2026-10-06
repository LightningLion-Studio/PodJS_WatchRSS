import type {Channel} from "./service.ts";
import type {ResumeTarget,ResumeStorage} from "../navigation/resume-state.ts";
const HOME_SNAPSHOT_KEY="watchrss.home.channels.v1";
/** Only reuse actual cached channels when the saved destination is home. */
export function readHomeChannelSnapshot(storage:Pick<ResumeStorage,"get">,resume:ResumeTarget|null):Channel[]|undefined {
 if(resume&&resume.kind!=="home")return undefined;
 try {
  const value=storage.get<Channel[]>(HOME_SNAPSHOT_KEY);
  return Array.isArray(value)&&value.length&&value.every(item=>item&&typeof item.id==="string"&&typeof item.title==="string"&&typeof item.url==="string")?value:undefined;
 }catch{return undefined;}
}
export function writeHomeChannelSnapshot(storage:Pick<ResumeStorage,"set">,list:Channel[]):void {
 try{storage.set(HOME_SNAPSHOT_KEY,list);}catch{/* Snapshot is only a startup hint. */}
}
