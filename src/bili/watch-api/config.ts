import {bundledWatchConfig} from './build-config.ts';
/** Rotatable configuration snapshot supplied by trusted release/remote tooling.
 * Client identifiers are deliberately absent from checked-in defaults. */
export interface BiliWatchConfig {
  biliWatchApi?: boolean;
  appkey?: string;
  mobiApp?: string;
  platform?: string;
  device?: string;
  build?: string;
  webCookieVerified?: boolean;
}
export interface WatchConfigStore {
  get<T>(key:string):T|undefined|null;
  set<T>(key:string,value:T):unknown;
}
export const WATCH_CONFIG_KEY='watchrss.bili.watch-api.remote.v1';
export const WATCH_LOCAL_SWITCH='biliWatchApi';
export const WATCH_COOLDOWN_KEY='watchrss.bili.watch-api.cooldown-until';
export const WATCH_COOLDOWN_MS=2*60*60*1000;
export function readWatchConfig(store:WatchConfigStore):BiliWatchConfig {
  const raw=store.get<BiliWatchConfig>(WATCH_CONFIG_KEY);
  const remote={...bundledWatchConfig,...(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{})};
  // Either local or remote false is a kill switch. Missing flags default on.
  return {...remote,biliWatchApi:remote.biliWatchApi!==false&&store.get<boolean>(WATCH_LOCAL_SWITCH)!==false};
}
/** No network discovery, token, arbitrary host, or secret fields are accepted. */
export function applyWatchConfig(store:WatchConfigStore,value:BiliWatchConfig) {
  const clean:BiliWatchConfig={};
  for(const key of ['appkey','mobiApp','platform','device','build'] as const){
    if(value[key]!==undefined){
      if(typeof value[key]!=='string'||!value[key]!.trim()||value[key]!.length>128||/[\r\n]/.test(value[key]!))throw Error('invalid_watch_config');
      clean[key]=value[key]!.trim();
    }
  }
  for(const key of ['biliWatchApi','webCookieVerified'] as const){
    if(value[key]!==undefined){if(typeof value[key]!=='boolean')throw Error('invalid_watch_config');clean[key]=value[key];}
  }
  store.set(WATCH_CONFIG_KEY,clean);
}
