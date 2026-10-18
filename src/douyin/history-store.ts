import {projectJsonAsync} from '@podjs/framework/json';
import {yieldWorkTurn} from '@podjs/framework/text-layout';
import {applyPreferredDouyinPlayback} from './playback-selector.ts';
import {applyDouyinState,readDouyinState,type DouyinStateStorage,type DouyinStateChange} from './state-storage.ts';
import type {DouyinHistoryEntry,DouyinItem} from './types.ts';

export const HISTORY_INDEX_KEY='douyin.history.index.v2';
export const HISTORY_LIMIT=200,WATCHED_LIMIT=1000;
const LEGACY_HISTORY='douyin.history.v1',LEGACY_WATCHED='douyin.watched.v1';
export const historyRowKey=(slot:number)=>`douyin.history.row.v2.${slot}`;
interface HistoryRow {awemeId:string;title:string;author:string;coverUrl?:string;playUrl:string;likeCount:number;watchedAt:number}
interface HistoryIndex {version:2;entries:{id:string;slot:number}[];watched:string[]}
const empty=():HistoryIndex=>({version:2,entries:[],watched:[]});
const text=(value:unknown)=>typeof value==='string'?value:'';
/** Same durable display fields and limits as DouyinWatchHistoryStore. Playback
 * variants are deliberately not history data; opening playback still resolves TTL. */
export function compactDouyinHistory(item:DouyinItem,watchedAt:number):HistoryRow|null{
  const awemeId=text(item?.awemeId).trim(),originalUrl=text(item?.playUrl).trim();
  if(!awemeId||!originalUrl||!Number.isFinite(watchedAt))return null;
  // History is display metadata, never a fresh playback cache. Retain native
  // history even when an old HEVC-only record has no currently playable variant.
  const selected=applyPreferredDouyinPlayback(item),playUrl=text(selected.playUrl).trim()||originalUrl;
  return {awemeId,title:text(item.description),author:text(item.authorName),coverUrl:typeof item.coverUrl==='string'?item.coverUrl:undefined,playUrl,likeCount:Number(item.likeCount)||0,watchedAt};
}
function unpack(row:HistoryRow):DouyinHistoryEntry{return {watchedAtMillis:row.watchedAt,item:{awemeId:row.awemeId,description:row.title,authorName:row.author,coverUrl:row.coverUrl,playUrl:row.playUrl,likeCount:row.likeCount,createdAtSeconds:0,authorId:'',commentCount:0,shareCount:0,collectCount:0,durationMs:0,variants:[]}};}
function parseIndex(raw:string):HistoryIndex{
  const v=JSON.parse(raw);if(v?.version!==2||!Array.isArray(v.entries)||!Array.isArray(v.watched)||v.entries.length>HISTORY_LIMIT||v.watched.length>WATCHED_LIMIT)throw Error('Invalid Douyin history index');
  const ids=new Set<string>(),slots=new Set<number>();
  for(const e of v.entries){if(typeof e?.id!=='string'||!e.id.trim()||!Number.isInteger(e.slot)||e.slot<0||e.slot>=HISTORY_LIMIT||ids.has(e.id)||slots.has(e.slot))throw Error('Invalid Douyin history row');ids.add(e.id);slots.add(e.slot);}
  if(v.watched.some((id:unknown)=>typeof id!=='string'||!id.trim())||new Set(v.watched).size!==v.watched.length)throw Error('Invalid Douyin watched IDs');return v;
}
export class DouyinHistoryStore {
  private ready?:Promise<HistoryIndex>;
  private writes:Promise<void>=Promise.resolve();
  constructor(private readonly storage:DouyinStateStorage){}
  initialize():Promise<HistoryIndex>{return this.ready??=this.load().catch(error=>{this.ready=undefined;throw error;});}
  private async load():Promise<HistoryIndex>{
    const current=await this.storage.get(HISTORY_INDEX_KEY);if(current!==null){const index=parseIndex(current);await applyDouyinState(this.storage,[{key:LEGACY_HISTORY,value:null},{key:LEGACY_WATCHED,value:null}]);return index;}
    await yieldWorkTurn().result;
    const raw=await this.storage.get(LEGACY_HISTORY),watched=await this.storage.get(LEGACY_WATCHED);
    const index=empty(),seen=new Set<string>();
    // Native projection adopts one selected legacy row per slice, instead of
    // parsing/retaining every variant of the full history in one guest task.
    const value=raw?await projectJsonAsync('{"entries":'+raw+'}',{entries:[{item:{awemeId:null,description:null,authorName:null,coverUrl:null,playUrl:null,likeCount:null,variants:null},watchedAtMillis:null}]}):{entries:[]};
    const entries=(value as {entries?:unknown}).entries;
    if(!Array.isArray(entries))throw Error('Invalid legacy Douyin history');
    const changes:DouyinStateChange[]=[];
    for(const entry of entries){
      if(index.entries.length===HISTORY_LIMIT)break;
      const row=entry?.item&&compactDouyinHistory(entry.item,Number(entry.watchedAtMillis));
      if(!row||seen.has(row.awemeId))continue;seen.add(row.awemeId);
      const slot=index.entries.length;index.entries.push({id:row.awemeId,slot});changes.push({key:historyRowKey(slot),value:JSON.stringify(row)});
      if(changes.length===8){await applyDouyinState(this.storage,changes.splice(0));await yieldWorkTurn().result;}
    }
    if(watched){const ids=JSON.parse(watched);if(!Array.isArray(ids))throw Error('Invalid legacy Douyin watched IDs');
      for(const value of ids){const id=String(value).trim();if(id){const old=index.watched.indexOf(id);if(old>=0)index.watched.splice(old,1);index.watched.push(id);}}
      index.watched=index.watched.slice(-WATCHED_LIMIT);
    }
    // Partial row migration is invisible until this index is durably published;
    // retry overwrites fixed slots. Legacy input survives every earlier failure.
    await applyDouyinState(this.storage,[...changes,{key:HISTORY_INDEX_KEY,value:JSON.stringify(index)}]);
    await applyDouyinState(this.storage,[{key:LEGACY_HISTORY,value:null},{key:LEGACY_WATCHED,value:null}]);return index;
  }
  private enqueue<T>(work:()=>Promise<T>):Promise<T>{const pending=this.writes.catch(()=>{}).then(work);this.writes=pending.then(()=>{},()=>{});return pending;}
  record(item:DouyinItem,watchedAt:number):Promise<void>{
    const row=compactDouyinHistory(item,watchedAt);if(!row)return Promise.resolve();
    return this.enqueue(async()=>{
      const old=await this.initialize(),prior=old.entries.find(entry=>entry.id===row.awemeId);
      const entries=old.entries.filter(entry=>entry.id!==row.awemeId),used=new Set(entries.map(entry=>entry.slot));
      const slot=prior?.slot??(entries.length===HISTORY_LIMIT?entries.pop()!.slot:Array.from({length:HISTORY_LIMIT},(_,i)=>i).find(i=>!used.has(i))!);
      const index:HistoryIndex={version:2,entries:[{id:row.awemeId,slot},...entries],watched:[...old.watched.filter(id=>id!==row.awemeId),row.awemeId].slice(-WATCHED_LIMIT)};
      await applyDouyinState(this.storage,[{key:historyRowKey(slot),value:JSON.stringify(row)},{key:HISTORY_INDEX_KEY,value:JSON.stringify(index)}]);this.ready=Promise.resolve(index);
    });
  }
  mark(id:string):Promise<void>{id=id.trim();if(!id)return Promise.resolve();return this.enqueue(async()=>{const old=await this.initialize(),index={...old,watched:[...old.watched.filter(value=>value!==id),id].slice(-WATCHED_LIMIT)};await this.storage.set(HISTORY_INDEX_KEY,JSON.stringify(index));this.ready=Promise.resolve(index);});}
  list():Promise<DouyinHistoryEntry[]>{return this.enqueue(async()=>{
    const index=await this.initialize(),result:DouyinHistoryEntry[]=[];
    for(let start=0;start<index.entries.length;start+=8){
      const refs=index.entries.slice(start,start+8),rows=await readDouyinState(this.storage,refs.map(e=>historyRowKey(e.slot)));
      for(let i=0;i<rows.length;i++){if(rows[i]===null)throw Error('Missing Douyin history row');const row=JSON.parse(rows[i]!);if(row.awemeId!==refs[i]!.id||!row.playUrl||!Number.isFinite(row.watchedAt))throw Error('Invalid Douyin history row');result.push(unpack(row));}
      await yieldWorkTurn().result;
    }return result;
  });}
  async watched():Promise<string[]>{await this.writes;return [...(await this.initialize()).watched];}
  clear():Promise<void>{return this.enqueue(async()=>{const index=empty();await applyDouyinState(this.storage,[...Array.from({length:HISTORY_LIMIT},(_,slot)=>({key:historyRowKey(slot),value:null})),{key:HISTORY_INDEX_KEY,value:JSON.stringify(index)}]);this.ready=Promise.resolve(index);await applyDouyinState(this.storage,[{key:LEGACY_HISTORY,value:null},{key:LEGACY_WATCHED,value:null}]);});}
}
