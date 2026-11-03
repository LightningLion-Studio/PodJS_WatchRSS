import type {VideoFrame,NetworkSnapshot} from '@podjs/framework/services';
import type {DouyinItem} from './types.ts';
import {douyinPreviewBytes} from './proxy-policy.ts';
import {douyinMediaExpiry} from './media-expiry.ts';

export function stockNetworkAllowed(network:NetworkSnapshot,trafficSaving:boolean,wifiOnly=true):boolean {
 return !trafficSaving&&network.active&&network.internet&&network.validated&&network.metered===false&&(!wifiOnly||network.wifi);
}
export const DOUYIN_STOCK_KEY='watchrss.douyin.stock.v1';
export const STOCK_COUNT=3,STOCK_ENTRY_BYTES=4*1024*1024;
export function stockPreviewBytes(item:DouyinItem):number {
 const bitrate=item.variants.find(v=>v.playUrl===item.playUrl||v.playUrls?.includes(item.playUrl))?.bitrate??0;
 return douyinPreviewBytes(undefined,item.durationMs,bitrate);
}
export interface StockEntry {item:DouyinItem;expiresAt:number;prefixBytes:number;tailBytes:number;}
export interface StockReadySource {uri:string;frame?:VideoFrame;item?:DouyinItem}
export interface StockPorts {
 read():unknown;write(entries:StockEntry[]):void;
 allowed():Promise<boolean>;watched():Promise<readonly string[]>;
 feed():Promise<readonly DouyinItem[]>;
 prepare(item:DouyinItem,bytes:number):Promise<{ready:boolean;prefixBytes:number;tailBytes:number}>;
 lookup(entry:StockEntry,headers?:Record<string,string>):Promise<string|StockReadySource|undefined>;
 cancel():void;
 now():number;
}
export function stockContentKey(item:DouyinItem):string {
 const variant=item.variants.find(v=>v.playUrl===item.playUrl||v.playUrls?.includes(item.playUrl));
 // Explicit rendition identity; signed URL and authorization never form the key.
 return ['douyin-stock-v1',item.awemeId,variant?.codec??'unknown',variant?.width??0,variant?.height??0,variant?.bitrate??0,item.durationMs,...(!variant?['unidentified']:[])].join(':');
}
function validEntry(value:unknown):value is StockEntry {
 const e=value as StockEntry;
 return !!e&&Number.isFinite(e.expiresAt)&&Number.isSafeInteger(e.prefixBytes)&&e.prefixBytes>0&&Number.isSafeInteger(e.tailBytes)&&e.tailBytes>=0&&e.prefixBytes+e.tailBytes<=STOCK_ENTRY_BYTES&&typeof e.item?.awemeId==='string'&&!!e.item.awemeId&&typeof e.item?.playUrl==='string'&&/^https?:\/\//.test(e.item.playUrl)&&Number.isFinite(e.item.durationMs)&&Array.isArray(e.item.variants);
}
/** Only verified prefixes with a decoded local first frame become stock. */
export class DouyinStock {
 private entries:StockEntry[]=[];
 private epoch=0;private running?:Promise<void>;private enabled=false;
 private consumed=new Set<string>();
 // Removing durable inventory must not revoke the playing/previous cache source.
 private playbackEntries=new Map<string,StockEntry>();
 constructor(private ports:StockPorts){
  const saved=ports.read();if(Array.isArray(saved))this.entries=saved.filter(validEntry).slice(0,STOCK_COUNT);
 }
 private save(){this.ports.write(this.entries);}
 private fresh(entry:StockEntry){return !this.consumed.has(entry.item.awemeId)&&this.ports.now()<entry.expiresAt;}
 async restore():Promise<DouyinItem[]> {
  const watched=new Set(await this.ports.watched());
  const original=this.entries;
  const ready:StockEntry[]=[];
  // Three independent bounded reads share in-flight auth work and retain feed order.
  const restored=await Promise.all(original.map(async entry=>{if(!this.fresh(entry)||watched.has(entry.item.awemeId))return undefined;try{return await this.ports.lookup(entry)?entry:undefined;}catch{return undefined;}}));
  ready.push(...restored.filter((entry):entry is StockEntry=>!!entry));
  // Merge with a concurrent completed refill; never overwrite newer state.
  if(original===this.entries){this.entries=ready.filter(e=>this.fresh(e));this.save();}
  return ready.filter(e=>this.entries.includes(e)&&this.fresh(e)).map(e=>e.item);
 }
 async ready(id:string,headers?:Record<string,string>):Promise<StockReadySource|undefined>{
  const entry=this.entries.find(e=>e.item.awemeId===id&&this.fresh(e));
  if(!entry)return undefined;
  try{const value=await this.ports.lookup(entry,headers);return this.entries.includes(entry)&&this.fresh(entry)&&value?{...(typeof value==='string'?{uri:value}:value),item:entry.item}:undefined;}catch{return undefined;}
 }
 async lookup(id:string):Promise<string|undefined>{return (await this.ready(id))?.uri;}
 async playbackReady(id:string,headers?:Record<string,string>):Promise<StockReadySource|undefined>{
  const stocked=await this.ready(id,headers);if(stocked)return stocked;
  const entry=this.playbackEntries.get(id);if(!entry)return undefined;
  const current=()=>this.playbackEntries.get(id)===entry&&this.ports.now()<entry.expiresAt;
  if(!current()){this.playbackEntries.delete(id);return undefined;}
  try{const value=await this.ports.lookup(entry,headers);return current()&&value?{...(typeof value==='string'?{uri:value}:value),item:entry.item}:undefined;}catch{return undefined;}
 }
 consume(id:string){
  const entry=this.entries.find(e=>e.item.awemeId===id&&this.fresh(e));
  if(entry){this.playbackEntries.delete(id);this.playbackEntries.set(id,entry);while(this.playbackEntries.size>STOCK_COUNT*2)this.playbackEntries.delete(this.playbackEntries.keys().next().value!);}
  this.consumed.add(id);this.entries=this.entries.filter(e=>e.item.awemeId!==id);this.save();
 }
 clear(){this.suspend();this.entries=[];this.playbackEntries.clear();this.consumed.clear();this.save();}
 suspend(){this.enabled=false;this.epoch++;this.ports.cancel();}
 async networkChanged():Promise<void>{
  const own=this.epoch,allowed=await this.ports.allowed();
  if(own!==this.epoch)return;
  if(!allowed){this.suspend();return;}
  await this.resume();
 }
 resume():Promise<void>{const wasEnabled=this.enabled;this.enabled=true;if(this.running)return wasEnabled?this.running:this.running.catch(()=>{}).then(()=>this.enabled?this.resume():undefined);const own=++this.epoch;const work=this.refill(own);this.running=work;return work.finally(()=>{if(this.running===work)this.running=undefined;});}
 private async refill(own:number){
  const current=()=>this.enabled&&own===this.epoch;
  if(!await this.ports.allowed()||!current())return;
  await this.restore();if(!current()||this.entries.length>=STOCK_COUNT)return;
  const watched=new Set(await this.ports.watched());if(!current()||!await this.ports.allowed())return;
  // Expired sources are replaced exclusively by a feed response. No detail fallback.
  const candidates=await this.ports.feed();if(!current())return;
  for(const item of candidates.slice(0,12)){
   if(!current()||!await this.ports.allowed())return;
   if(this.entries.length>=STOCK_COUNT)return;
   if(watched.has(item.awemeId)||this.consumed.has(item.awemeId)||this.entries.some(e=>e.item.awemeId===item.awemeId)||!item.playUrl)continue;
   const expiresAt=douyinMediaExpiry(item.playUrl,this.ports.now());if(expiresAt<=this.ports.now())continue;
   const result=await this.ports.prepare(item,stockPreviewBytes(item));
   if(!current()||!await this.ports.allowed())return;
   if(!result.ready||this.consumed.has(item.awemeId))continue;
   this.entries.push({item,expiresAt,prefixBytes:result.prefixBytes,tailBytes:result.tailBytes});this.save();
  }
 }
}

export type DouyinStockService=Pick<DouyinStock,'restore'|'ready'|'lookup'|'playbackReady'|'consume'|'clear'|'suspend'|'networkChanged'|'resume'>&{offer?(items:readonly DouyinItem[],anchor?:string):void;
 present?:typeof import('@podjs/framework/media-prefix-cache').localMediaStore.present;
 hide?:typeof import('@podjs/framework/media-prefix-cache').localMediaStore.hide;
};
