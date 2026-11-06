/** Local authenticated business metadata only. Never serialized into cloud IO. */
export interface PriorityItem {entityKey:string;kind:'file'|'memo'|'rss';parentKind?:string;parentEntityKey?:string;importedFile?:boolean;addedAtMillis:number;complete?:boolean;deleted?:boolean;index?:number;demand?:{demandAtMillis:number;expiresAtMillis:number};}
export function contentPriority(items:readonly PriorityItem[],now:number){
 const byAdded=(a:PriorityItem,b:PriorityItem)=>b.addedAtMillis-a.addedAtMillis||(a.entityKey<b.entityKey?-1:a.entityKey>b.entityKey?1:0);
 const recent=new Set(items.filter(i=>!i.deleted&&i.kind==='file'&&i.importedFile&&!i.parentEntityKey).slice().sort(byAdded).slice(0,2).map(i=>i.entityKey));
 return items.filter(i=>!i.complete&&!i.deleted).map(i=>({...i,rank:i.demand&&i.demand.expiresAtMillis>now?0:i.kind==='memo'||i.parentKind==='memo'?1:recent.has(i.parentEntityKey??i.entityKey)?2:i.kind==='rss'?3:4})).sort((a,b)=>a.rank-b.rank||(a.rank===0?(b.demand!.demandAtMillis-a.demand!.demandAtMillis||(a.entityKey<b.entityKey?-1:a.entityKey>b.entityKey?1:0)):byAdded(a,b))||(a.index??0)-(b.index??0));
}
