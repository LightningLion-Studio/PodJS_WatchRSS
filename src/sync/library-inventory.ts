import type {ExportedArticle} from './article-export';
export interface LibraryInventoryBucket {total:number;live:number;deleted:number}
export interface LibraryBookInventory extends LibraryInventoryBucket {kind:'txt'|'epub';title:string}
/** Diagnostics only: classify the actual emitted entries, rather than every RSS
 * cache row. No body, account field, URL or persistent ID leaves this summary. */
export function libraryInventory(articles:readonly ExportedArticle[]){
 const categories:Record<string,LibraryInventoryBucket>={},books=new Map<string,LibraryBookInventory>();let ordinaryRssWithoutSaveHistory=0;
 const add=(bucket:LibraryInventoryBucket,a:ExportedArticle)=>{bucket.total++;bucket[a.deleted?'deleted':'live']++;};
 for(const a of articles){
  const source=(a.rssSourceUrl??'').trim().toLowerCase(),url=a.url.trim().toLowerCase();
  const txt=source.startsWith('https://watchrss.local/import-txt-novel')||url.startsWith('https://watchrss.local/import-txt-novel');
  const epub=source.startsWith('https://watchrss.local/import-epub')||url.startsWith('https://watchrss.local/import-epub');
  const txtFile=source.startsWith('https://watchrss.local/import-content/txt/')||url.startsWith('https://watchrss.local/import-content/txt/');
  let category:string;
  if(txt||epub||txtFile){
   category=epub?'epubChapters':txt?'txtChapters':'txtFile';const key=txtFile?a.url:a.rssSourceUrl||a.url.split('/chapter/')[0]!;
   let book=books.get(key);if(!book){book={kind:epub?'epub':'txt',title:txtFile?a.title:a.rssSourceTitle||a.siteName,total:0,live:0,deleted:0};books.set(key,book);}add(book,a);
  }else if(source.startsWith('https://watchrss.local/import-content')||url.startsWith('https://watchrss.local/import-content'))category='importedArticle';
  else if(a.independentSaved||!source||source==='watchrss://phone-imports')category='independentWeb';
  else if(/^https?:\/\//.test(source)){
   category=a.favoriteSaved?(a.watchLaterSaved?'rssFavoriteAndLater':'rssFavorite'):a.watchLaterSaved?'rssLater':'rssOrdinary';
   if(category==='rssOrdinary'&&!a.deleted&&a.favoriteChangedAt===0&&a.watchLaterChangedAt===0&&a.independentChangedAt===0)ordinaryRssWithoutSaveHistory++;
  }else category='other';
  add(categories[category]??=( {total:0,live:0,deleted:0}),a);
 }
 return {total:articles.length,categories,books:[...books.values()],ordinaryRssWithoutSaveHistory};
}
