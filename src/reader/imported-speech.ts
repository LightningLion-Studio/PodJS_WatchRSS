import { isImportedTextItemUrl } from "../core/imported-content.ts";
import type { SqlDatabase } from "../core/types.ts";
import type { Article } from "../ui/service.ts";
import { importedTextFileName, type ImportedTextHandle, type ImportedTextStore } from "./imported-text.ts";
import type { SpeechAnchor } from "./speech-segments.ts";
import { ImportedSpeechSegmentSource } from "./speech-source.ts";

/** Resolve native markers without loading an entire original or RSS body into JS. */
export async function importedSpeechSource(db: SqlDatabase, store: ImportedTextStore, article: Article, anchor?: SpeechAnchor): Promise<ImportedSpeechSegmentSource | null> {
  const {handle} = await importedReaderHandle(db,store,article.id);
  if (!handle) return null;
  return new ImportedSpeechSegmentSource(article.title, handle.chunkCount, index => store.chunk(handle, index), anchor);
}

export async function importedReaderHandle(db:SqlDatabase,store:ImportedTextStore,id:string):Promise<{hasMarker:boolean;handle:ImportedTextHandle|null}> {
  const row = (await db.query(`SELECT link,substr(content,1,512) content,
    (SELECT substr(body,1,512) FROM article_original_chunks WHERE article_id=a.id AND chunk_index=0) original
    FROM articles a WHERE id=?`, [Number(id)],"reader.importedMarker"))[0];
  if (!row || !isImportedTextItemUrl(String(row.link ?? ""))) return {hasMarker:false,handle:null};
  const original = String(row.original ?? ""), content = String(row.content ?? "");
  const marker = importedTextFileName(original) ? original : importedTextFileName(content) ? content : null;
  return {hasMarker:!!marker,handle:marker?await store.handle(marker):null};
}
