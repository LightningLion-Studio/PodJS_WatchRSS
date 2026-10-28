/** Only existing list endpoints; paths and credentials never leave this function. */
export function videoResponseBudget(url:string, enabled:boolean):number {
  const path=/^https?:\/\/[^/]+([^?#]*)/.exec(url)?.[1];
  return enabled && ['/x/web-interface/history/cursor','/x/web-interface/wbi/index/top/feed/rcmd','/aweme/v2/web/module/feed/'].includes(path??'') ? 2*1024*1024 : 8*1024*1024;
}
export function boundedVideoPageSize(value:number|undefined,enabled:boolean,fallback=20):number {
  if(!enabled)return value??fallback;
  return Number.isFinite(value)?Math.max(1,Math.min(12,Math.floor(value!))):12;
}
