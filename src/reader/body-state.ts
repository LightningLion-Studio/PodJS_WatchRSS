import type {SqlDatabase} from '../core/types.ts';
import {isImportedContentUrl} from '../core/imported-content.ts';
import type {Article} from '../ui/service.ts';
import type {ImportedTextStore} from './imported-text.ts';
import {importedReaderHandle} from './imported-speech.ts';

/** Metadata-only restores must not display an excerpt as the chapter body. */
export async function readReaderBody(db:SqlDatabase,store:ImportedTextStore,id:string,link:string,
 getBody:()=>Promise<string|null>,description:unknown):Promise<{rawContent:string;importedText?:Article['importedText'];readerBodyState?:Article['readerBodyState']}>{
 const imported=isImportedContentUrl(link);
 if(imported&&(await db.query('SELECT 1 FROM article_register_state WHERE item_id=? AND body_pending=1 LIMIT 1',[Number(id)])).length)
  return {rawContent:'',readerBodyState:'restoring'};
 const marker=await importedReaderHandle(db,store,id);
 if(marker.hasMarker)return marker.handle&&marker.handle.byteLength>0
  ?{rawContent:'',importedText:marker.handle}:{rawContent:'',readerBodyState:'failed'};
 const body=await getBody();
 if(imported&&!body?.trim())return {rawContent:'',readerBodyState:'failed'};
 return {rawContent:String(body??description??'')};
}

export function readerBodyState(article:Article):Article['readerBodyState']{
 const available=article.importedText||article.content.trim()||article.contentBlocks?.some(block=>block.type!=='text'||block.text.trim());
 return article.readerBodyState??(isImportedContentUrl(article.link)&&!available?'failed':undefined);
}
