export type RssFetchPurpose='add'|'refresh';
export type RssAcquisitionMode='local'|'pool';
export class RssLocalAccess extends Error {constructor(readonly reason:'unbound'|'expired'){super('rss_local_access_'+reason);}}
export interface RssAcquisitionState {url:string;purpose:RssFetchPurpose;mode:RssAcquisitionMode;reason?:'unbound'|'expired';phase:'loading'|'ready'|'failed';message:string;}
const listeners=new Set<(state:RssAcquisitionState)=>void>();
let latest:RssAcquisitionState|undefined;
export function rssAcquisitionState(){return latest;}
export function subscribeRssAcquisition(listener:(state:RssAcquisitionState)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export const LOCAL_RSS_SCHEMA=`CREATE TABLE IF NOT EXISTS rss_local_sources(url TEXT PRIMARY KEY REFERENCES channels(url) ON DELETE CASCADE)`;
/** Public sources stay local only for unavailable login; network/server errors retain their meaning. */
export async function acquireRssFeed(url:string,purpose:RssFetchPurpose,eligible:boolean,ports:{pool():Promise<string>;direct():Promise<string>;cancelled?:()=>boolean;publish?:(state:RssAcquisitionState)=>void}):Promise<{xml:string;mode:RssAcquisitionMode}> {
 let mode:RssAcquisitionMode=eligible?'pool':'local',reason:'unbound'|'expired'|undefined;
 const publish=(phase:RssAcquisitionState['phase'])=>{const verb=purpose==='add'?'添加':'刷新';latest={url,purpose,mode,...(reason?{reason}:{}),phase,message:mode==='pool'?`通过公共 RSS 池${verb}`:`在手表本机${verb} RSS${reason==='expired'?'（登录已失效）':reason==='unbound'?'（未绑定账号）':''}${eligible?'，绑定后自动并入公共池':'（本地专用源）'}`};ports.publish?.(latest);for(const listener of listeners)try{listener(latest);}catch{}};
 publish('loading');
 try{
  let xml:string;
  if(eligible){try{xml=await ports.pool();}catch(error){if(!(error instanceof RssLocalAccess)||ports.cancelled?.())throw error;mode='local';reason=error.reason;publish('loading');xml=await ports.direct();}}
  else xml=await ports.direct();
  if(ports.cancelled?.())throw Error('刷新已取消');publish('ready');return {xml,mode};
 }catch(error){publish('failed');throw error;}
}
