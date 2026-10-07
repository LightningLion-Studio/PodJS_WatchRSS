import {kv} from '@podjs/framework/watch';
const KEY='watchrss.temporary-original-hints.v1',WINDOW=12*60*60*1000;
type Hint={attempts?:string;lastToast?:number};
/** SettingsRepository temporary-original toast throttling, including migrated state. */
export class TemporaryOriginalHintStore {
 constructor(private readonly storage:Pick<typeof kv,'get'|'set'>=kv){}
 record(channelId:number,now=Date.now()):boolean {
  if(!Number.isSafeInteger(channelId)||channelId<=0)return false;
  const rows=this.storage.get<Record<string,Hint>>(KEY)??{},row=rows[channelId]??{},start=now-WINDOW;
  const attempts=(row.attempts??'').split(',').map(v=>v.trim()).filter(v=>/^-?\d+$/.test(v)).map(Number).filter(v=>Number.isSafeInteger(v)&&v>=start).sort((a,b)=>a-b);
  attempts.push(now);while(attempts.length>3)attempts.shift();
  const show=attempts.length>=3&&(row.lastToast??0)<start;
  this.storage.set(KEY,{...rows,[channelId]:{attempts:attempts.join(','),lastToast:show?now:row.lastToast??0}});return show;
 }
}
