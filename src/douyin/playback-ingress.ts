import {DOUYIN_MAX_SHORT_EDGE,labeledResolution,normalizedDouyinResolution,applyPreferredDouyinPlayback} from './playback-selector.ts';
import type {DouyinItem,DouyinVideoVariant} from './types.ts';

/** Use canonical HTTP address identity for ownership; preserve signed transport URLs. */
function address(value:unknown):string {
  if(typeof value!=='string')return '';
  const url=value.trim().split('#',1)[0]!;
  const parts=/^(https?):\/\/([^/?]+)([^?]*)(.*)$/i.exec(url);
  if(!parts)return url;
  const scheme=parts[1]!.toLowerCase();
  let host:string;
  try{host=decodeURIComponent(parts[2]!).toLowerCase();}catch{return '';}
  host=host.replace(/:(\d+)$/,(_port,digits:string)=>{
    const port=Number(digits);
    return port===(scheme==='https'?443:80)?'':':'+port;
  });
  const path:string[]=[];
  const segments=(parts[3]||'/').split('/');
  for(const [i,segment] of segments.entries()){
    const dots=segment.replace(/%2e/ig,'.');
    if(dots==='..'&&path.length>1)path.pop();
    if(dots!=='.'&&dots!=='..')path.push(segment);
    else if(i===segments.length-1)path.push('');
  }
  return scheme+'://'+host+path.join('/')+parts[4];
}

function oversized(variant:DouyinVideoVariant):boolean {
  const sides=[variant.width,variant.height].filter(n=>Number.isFinite(n)&&n>0);
  const label=labeledResolution(variant);
  const edge=sides.length===2?Math.min(...sides):normalizedDouyinResolution(variant)??0;
  return edge>DOUYIN_MAX_SHORT_EDGE||(label??0)>DOUYIN_MAX_SHORT_EDGE;
}

/** Shared by wire DTOs and legacy playback records before they enter the app. */
export function admitDouyinItem<T extends DouyinItem>(item:T):T|undefined {
  if(!item||typeof item.playUrl!=='string'||!Array.isArray(item.variants)||!item.variants.length)return item;
  const variants=item.variants.filter(v=>!!address(v?.playUrl));
  if(!variants.length)return item;
  const unsafe=variants.filter(oversized),unsafePrimary=new Set(unsafe.map(v=>address(v.playUrl)));
  // An independent primary owns its address even when other rows list it as a mirror.
  const primary=new Map<string,DouyinVideoVariant>();
  for(const v of variants){
    const key=address(v.playUrl);
    if(!unsafePrimary.has(key)&&!primary.has(key))primary.set(key,v);
  }
  if(!primary.size)return;
  const unsafeAliases=new Set<string>();
  for(const v of variants)if(unsafePrimary.has(address(v.playUrl))){
    for(const url of Array.isArray(v.playUrls)?v.playUrls:[])unsafeAliases.add(address(url));
  }
  const mirrorOwners=new Map<string,DouyinVideoVariant|null>();
  for(const [key,v] of primary)for(const url of Array.isArray(v.playUrls)?v.playUrls:[]){
    const mirror=address(url);
    if(!mirror||mirror===key||primary.has(mirror)||unsafePrimary.has(mirror)||unsafeAliases.has(mirror))continue;
    const owner=mirrorOwners.get(mirror);
    mirrorOwners.set(mirror,owner===undefined||owner===v?v:null);
  }
  let changed=primary.size!==item.variants.length;
  const admitted=[...primary].map(([key,v])=>{
    if(!Array.isArray(v.playUrls))return v;
    const seen=new Set<string>();
    const mirrors=v.playUrls.filter(url=>{
      const mirror=address(url);
      if(!mirror||seen.has(mirror)||mirror!==key&&mirrorOwners.get(mirror)!==v)return false;
      seen.add(mirror);
      return true;
    });
    if(mirrors.length===v.playUrls.length)return v;
    changed=true;
    return {...v,playUrls:mirrors};
  });
  const current=address(item.playUrl);
  // Older snapshots may have kept a legacy play_addr unrelated to their variants.
  const allowed=primary.has(current)||!!mirrorOwners.get(current);
  if(!changed&&(allowed||!item.playUrl))return item;
  return {...item,variants:admitted,playUrl:allowed?item.playUrl:''};
}

/** Remove the native-tested primary or the exact mirror that supplied the bytes. */
export function withoutDouyinSource(item:DouyinItem,url:string):DouyinItem|undefined {
  const key=address(url);
  if(!key)return item;
  const variants=Array.isArray(item.variants)?item.variants:[];
  const remaining=variants.flatMap(v=>{
    if(address(v?.playUrl)===key)return [];
    const mirrors=Array.isArray(v?.playUrls)?v.playUrls.filter(mirror=>address(mirror)!==key):undefined;
    return [mirrors&&mirrors.length!==v.playUrls?.length?{...v,playUrls:mirrors}:v];
  });
  const selected=address(item.playUrl)===key;
  if(!selected&&remaining.length===variants.length&&remaining.every((v,i)=>v===variants[i]))return item;
  if(!remaining.length)return;
  const retained=remaining.some(v=>address(v?.playUrl)===address(item.playUrl)
    ||Array.isArray(v?.playUrls)&&v.playUrls.some(mirror=>address(mirror)===address(item.playUrl)));
  return retained?{...item,variants:remaining}:applyPreferredDouyinPlayback({...item,playUrl:'',variants:remaining});
}
