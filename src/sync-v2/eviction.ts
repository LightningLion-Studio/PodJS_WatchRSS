/** P3B policy. Normalized proofs are local authenticated results, never wire DTOs. */
import {canonical,type Scope} from './protocol';
export const SEVEN_DAYS=604800000;
export interface EvictionItem {
 entityKey:string;bodyRevision:string;recipeOid:string;scope:Scope;kind:string;parentKind?:string;
 addedAtMillis:number;addedAtSource:'original'|'unknown';lastOpenedAtMillis:number|null;
 localBytes:number;openedNow:boolean;dirty:boolean;remoteCopy?:any;
}
export function eligible(item:EvictionItem,now:number){
 const boundary=now-SEVEN_DAYS;
 return Number.isSafeInteger(now)&&now>=0&&['rss','import'].includes(item.kind)&&item.parentKind!=='memo'&&item.parentKind!=='note'&&!item.openedNow&&!item.dirty&&
  Number.isSafeInteger(item.localBytes)&&item.localBytes>0&&Number.isSafeInteger(item.addedAtMillis)&&item.addedAtMillis>=0&&
  (item.lastOpenedAtMillis===null||Number.isSafeInteger(item.lastOpenedAtMillis)&&item.lastOpenedAtMillis>=0&&item.lastOpenedAtMillis<boundary)&&
  (item.kind!=='rss'||item.addedAtSource==='original'&&item.addedAtMillis<boundary);
}
export function currentCopy(item:EvictionItem){const p=item.remoteCopy;return !!p&&p.kind==='cloud-current'&&p.verified===true&&p.complete===true&&p.inCurrentClosure===true&&p.entityKey===item.entityKey&&p.bodyRevision===item.bodyRevision&&p.recipeOid===item.recipeOid&&canonical(p.scope)===canonical(item.scope);}
export function evictionSort(item:EvictionItem){const n=(v:number)=>String(v).padStart(16,'0');return (item.kind==='rss'?'0:'+n(item.addedAtMillis):'1:'+(item.lastOpenedAtMillis===null?'0:':'1:'+n(item.lastOpenedAtMillis)+':')+n(item.addedAtMillis))+':'+item.entityKey;}
/** Fixed vector adapter only. Production requires the signed proof path. */
export function planEviction(items:EvictionItem[],now:number,needed:number){let freed=0;const out:string[]=[];for(const item of items.filter(i=>eligible(i,now)&&currentCopy(i)).sort((a,b)=>evictionSort(a)<evictionSort(b)?-1:evictionSort(a)>evictionSort(b)?1:0)){if(freed>=needed)break;out.push(item.entityKey);freed+=item.localBytes;}return out;}
