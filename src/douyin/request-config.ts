import type {DouyinSecureStorage} from './types.ts';
import {sm3} from './signing.ts';

export const DOUYIN_USER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
export const DOUYIN_REFERER='https://www.douyin.com/';
export const DOUYIN_REQUEST_REMOTE_KEY='watchrss.douyin.request.remote.v1';
export const DOUYIN_REQUEST_LOCAL_KEY='watchrss.douyin.request.local.v1';
export interface DouyinRequestConfig {
  versionCode?:string; versionName?:string; userAgent?:string; browserVersion?:string;
  verifyFp?:string; fp?:string; msToken?:string; webid?:string; uifid?:string;
  /** Requires an independently verified webFeedPagination adapter. Default off. */
  webPagination?:boolean;
  isNewNotice?:string; needSocialCount?:string;
}
export interface DouyinRequestConfigStore {get<T>(key:string):T|undefined|null;set<T>(key:string,value:T):unknown}
export type DouyinRequestConfigSource=()=>DouyinRequestConfig|Promise<DouyinRequestConfig>;
const publicFields=['versionCode','versionName','userAgent','browserVersion','isNewNotice','needSocialCount'] as const;
const privateFields=['verifyFp','fp','msToken','webid','uifid'] as const;
const secretKey=(source:'local'|'remote')=>`douyin.request.${source}.private.v1`;
const cookieScope=(cookie:string|null)=>cookie?sm3(cookie.trim()).map(v=>v.toString(16).padStart(2,'0')).join(''):null;
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function valid(key:string,value:unknown):value is string {
  if(typeof value!=='string'||value.length>2048||/[^\x20-\x7e]/.test(value))return false;
  if(key==='versionCode')return /^\d{1,9}$/.test(value);
  if(key==='versionName'||key==='browserVersion')return /^\d{1,4}(\.\d{1,4}){1,3}$/.test(value);
  if(key==='userAgent')return value.length>0&&value.length<=512;
  if(key==='isNewNotice'||key==='needSocialCount')return /^[01]$/.test(value);
  return !/\s/.test(value); // Empty private values explicitly disable a remote override.
}
export function sanitizeDouyinRequestConfig(raw:unknown):DouyinRequestConfig {
  const input=record(raw),clean:Record<string,unknown>={};
  for(const key of [...publicFields,...privateFields])if(valid(key,input[key]))clean[key]=input[key];
  if(typeof input.webPagination==='boolean')clean.webPagination=input.webPagination;
  return clean as DouyinRequestConfig;
}
/** Remote tooling writes a trusted snapshot; this module never fetches a URL.
 * Session identifiers stay in secure storage, never in ordinary KV or logs. */
export async function applyDouyinRequestConfig(store:DouyinRequestConfigStore,secure:DouyinSecureStorage,value:DouyinRequestConfig,source:'local'|'remote'='local') {
  const input=record(value),clean=sanitizeDouyinRequestConfig(value);
  for(const key of [...publicFields,...privateFields,'webPagination'])if(key in input&&!(key in clean))throw Error('invalid_douyin_request_config');
  const visible:Record<string,unknown>={},privateValues:Record<string,string>={};
  for(const key of publicFields)if(clean[key]!==undefined)visible[key]=clean[key];
  if(clean.webPagination!==undefined)visible.webPagination=clean.webPagination;
  for(const key of privateFields)if(clean[key]!==undefined)privateValues[key]=clean[key]!;
  const scope=cookieScope(await secure.get('douyin.cookie'));
  await secure.set(secretKey(source),JSON.stringify({scope,values:privateValues}));
  store.set(source==='local'?DOUYIN_REQUEST_LOCAL_KEY:DOUYIN_REQUEST_REMOTE_KEY,visible);
}
export async function readDouyinRequestConfig(store:DouyinRequestConfigStore,secure:DouyinSecureStorage):Promise<DouyinRequestConfig> {
  const result:DouyinRequestConfig={};
  let scope:string|null=null;try{scope=cookieScope(await secure.get('douyin.cookie'));}catch{}
  for(const source of ['remote','local'] as const){
    let visible:Record<string,unknown>={},hidden:Record<string,unknown>={};
    try{visible=record(store.get(source==='local'?DOUYIN_REQUEST_LOCAL_KEY:DOUYIN_REQUEST_REMOTE_KEY));}catch{}
    try{const raw=await secure.get(secretKey(source));if(raw&&raw.length<=16_384){const stored=record(JSON.parse(raw));if(scope&&stored.scope===scope)hidden=record(stored.values);}}catch{}
    const values:Record<string,unknown>={};
    for(const key of [...publicFields,'webPagination'])if(key in visible)values[key]=visible[key];
    for(const key of privateFields)if(key in hidden)values[key]=hidden[key];
    Object.assign(result,sanitizeDouyinRequestConfig(values));
  }
  return result;
}
export async function resolveDouyinRequestConfig(source?:DouyinRequestConfigSource):Promise<DouyinRequestConfig>{try{return sanitizeDouyinRequestConfig(await source?.());}catch{return {};}}
const baseParams:Readonly<Record<string,string>>={device_platform:'webapp',aid:'6383',channel:'channel_pc_web',pc_client_type:'1',version_code:'170400',version_name:'17.4.0',cookie_enabled:'true',screen_width:'680',screen_height:'907',browser_language:'zh-CN',browser_platform:'Win32',browser_name:'Chrome',browser_version:'155.0.0.0',browser_online:'true',engine_name:'Blink',engine_version:'155.0.0.0',os_name:'Windows',os_version:'10',cpu_core_num:'12',device_memory:'8',platform:'PC',downlink:'10',effective_type:'4g',from_user_page:'1',locate_query:'false',need_time_list:'1',pc_libra_divert:'Windows',publish_video_strategy_type:'2',round_trip_time:'0',show_live_replay_strategy:'1',time_list_query:'0',whale_cut_token:'',update_version_code:'170400',msToken:''};
export function douyinRequestProfile(config:DouyinRequestConfig={}) {
  const c=sanitizeDouyinRequestConfig(config),params:Record<string,string>={...baseParams};
  for(const [field,key] of [['versionCode','version_code'],['versionName','version_name'],['browserVersion','browser_version'],['browserVersion','engine_version'],['verifyFp','verifyFp'],['fp','fp'],['msToken','msToken'],['webid','webid'],['uifid','uifid']] as const)if(c[field]!==undefined)params[key]=c[field]!;
  if(c.verifyFp!==undefined&&c.fp===undefined)params.fp=c.verifyFp;
  if(c.fp!==undefined&&c.verifyFp===undefined)params.verifyFp=c.fp;
  return {params,headers:{'User-Agent':c.userAgent??DOUYIN_USER_AGENT,Referer:DOUYIN_REFERER}};
}
