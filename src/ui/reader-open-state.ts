import type {Article} from "./service.ts";
/** Preserve the retained feed when marking an already-read row is a no-op. */
export function markFeedArticleRead(items:Article[],id:string):Article[] {
  if(!items.some(item=>item.id===id&&!item.read))return items;
  return items.map(item=>item.id===id?{...item,read:true}:item);
}
